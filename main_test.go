package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gorilla/websocket"
)

func testRoom(players int) *Room {
	r := &Room{MaxPlayers: players, Winner: -1}
	for i := 0; i < players; i++ {
		r.Players = append(r.Players, &Player{Name: "P", Seat: i, Connected: true})
	}
	r.resetGameLocked()
	r.Started = true
	return r
}

func TestPlayerCountsAndStartingResources(t *testing.T) {
	tests := []struct {
		players int
		walls   int
	}{
		{2, 10},
		{3, 7},
		{4, 5},
	}
	for _, tt := range tests {
		r := testRoom(tt.players)
		if len(r.Pawns) != tt.players || len(r.WallsLeft) != tt.players {
			t.Fatalf("%d-player room has incorrect seat data", tt.players)
		}
		for seat, walls := range r.WallsLeft {
			if walls != tt.walls {
				t.Fatalf("seat %d in %d-player room: got %d walls, want %d", seat, tt.players, walls, tt.walls)
			}
		}
	}
}

func TestStraightAndDiagonalJump(t *testing.T) {
	r := testRoom(2)
	r.Pawns[0] = Point{4, 4}
	r.Pawns[1] = Point{4, 3}

	moves := r.legalMovesLocked(0)
	if !containsPoint(moves, Point{4, 2}) {
		t.Fatal("expected a straight jump over the adjacent player")
	}

	r.Walls = []Wall{{X: 4, Y: 2, Orientation: "h", Owner: 1}}
	moves = r.legalMovesLocked(0)
	if containsPoint(moves, Point{4, 2}) {
		t.Fatal("straight jump should be blocked by a wall")
	}
	if !containsPoint(moves, Point{3, 3}) || !containsPoint(moves, Point{5, 3}) {
		t.Fatal("expected both diagonal jumps when the square behind is blocked")
	}
}

func TestWallCollisionAndBlocking(t *testing.T) {
	r := testRoom(4)
	first := Wall{X: 3, Y: 3, Orientation: "h", Owner: 0}
	if err := r.validateWallLocked(first); err != nil {
		t.Fatalf("expected first wall to be legal: %v", err)
	}
	r.Walls = append(r.Walls, first)

	if err := r.validateWallLocked(Wall{X: 4, Y: 3, Orientation: "h", Owner: 1}); err == nil {
		t.Fatal("expected overlapping wall to be rejected")
	}
	if err := r.validateWallLocked(Wall{X: 3, Y: 3, Orientation: "v", Owner: 1}); err == nil {
		t.Fatal("expected crossing wall to be rejected")
	}
	if !r.blockedLocked(Point{3, 3}, Point{3, 4}, r.Walls) {
		t.Fatal("horizontal wall should block vertical movement")
	}
}

func TestEverySeatHasCorrectGoal(t *testing.T) {
	goals := []Point{{2, 0}, {6, 8}, {8, 3}, {0, 5}}
	for seat, goal := range goals {
		if !atGoal(seat, goal) {
			t.Fatalf("seat %d did not recognize its opposite edge", seat)
		}
	}
}

func TestWebSocketRoomLifecycle(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(serveWebSocket))
	defer server.Close()
	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")

	host, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("connect host: %v", err)
	}
	defer host.Close()
	var message map[string]any
	if err := host.ReadJSON(&message); err != nil || message["type"] != "connected" {
		t.Fatalf("host handshake failed: %v, %#v", err, message)
	}
	if err := host.WriteJSON(clientMessage{Type: "create", Name: "Host", MaxPlayers: 2}); err != nil {
		t.Fatal(err)
	}
	var hostState stateMessage
	if err := host.ReadJSON(&hostState); err != nil {
		t.Fatal(err)
	}
	if hostState.Room == "" || hostState.Started || len(hostState.Players) != 1 {
		t.Fatalf("unexpected created-room state: %#v", hostState)
	}

	guest, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("connect guest: %v", err)
	}
	defer guest.Close()
	if err := guest.ReadJSON(&message); err != nil {
		t.Fatal(err)
	}
	if err := guest.WriteJSON(clientMessage{Type: "join", Name: "Guest", Room: hostState.Room}); err != nil {
		t.Fatal(err)
	}
	var guestState stateMessage
	if err := guest.ReadJSON(&guestState); err != nil {
		t.Fatal(err)
	}
	if !guestState.Started || len(guestState.Players) != 2 || guestState.You != 1 {
		t.Fatalf("room did not start after guest joined: %#v", guestState)
	}
	if err := host.ReadJSON(&hostState); err != nil {
		t.Fatal(err)
	}
	if !hostState.Started || len(hostState.Players) != 2 || hostState.You != 0 {
		t.Fatalf("host did not receive started game: %#v", hostState)
	}
	if hostState.Walls == nil {
		t.Fatal("started game must serialize an empty wall list as [] instead of null")
	}

	if err := host.WriteJSON(clientMessage{Type: "wall", X: 3, Y: 3, Orientation: "h"}); err != nil {
		t.Fatal(err)
	}
	if err := host.ReadJSON(&hostState); err != nil {
		t.Fatal(err)
	}
	if err := guest.ReadJSON(&guestState); err != nil {
		t.Fatal(err)
	}
	if len(hostState.Walls) != 1 || hostState.Walls[0].X != 3 || hostState.Walls[0].Y != 3 || hostState.Walls[0].Orientation != "h" {
		t.Fatalf("host wall placement was not broadcast: %#v", hostState.Walls)
	}
	if len(guestState.Walls) != 1 || guestState.Turn != 1 {
		t.Fatalf("guest did not receive wall placement and next turn: %#v", guestState)
	}
}
