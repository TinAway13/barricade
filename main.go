package main

import (
	"crypto/rand"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const boardSize = 9

type Point struct {
	X int `json:"x"`
	Y int `json:"y"`
}

type Wall struct {
	X           int    `json:"x"`
	Y           int    `json:"y"`
	Orientation string `json:"orientation"`
	Owner       int    `json:"owner"`
}

type Player struct {
	Name      string
	Seat      int
	Token     string
	Connected bool
	Client    *Client
}

type Room struct {
	mu         sync.Mutex
	Code       string
	MaxPlayers int
	Players    []*Player
	Pawns      []Point
	WallsLeft  []int
	Walls      []Wall
	Turn       int
	Winner     int
	Started    bool
}

type Client struct {
	conn   *websocket.Conn
	send   chan any
	room   *Room
	player *Player
}

type clientMessage struct {
	Type        string `json:"type"`
	Name        string `json:"name"`
	Room        string `json:"room"`
	Token       string `json:"token"`
	MaxPlayers  int    `json:"maxPlayers"`
	X           int    `json:"x"`
	Y           int    `json:"y"`
	Orientation string `json:"orientation"`
}

type playerView struct {
	Name      string `json:"name"`
	Seat      int    `json:"seat"`
	Color     string `json:"color"`
	Connected bool   `json:"connected"`
	Walls     int    `json:"walls"`
	Pawn      Point  `json:"pawn"`
}

type stateMessage struct {
	Type       string       `json:"type"`
	Room       string       `json:"room"`
	MaxPlayers int          `json:"maxPlayers"`
	Started    bool         `json:"started"`
	Turn       int          `json:"turn"`
	Winner     int          `json:"winner"`
	You        int          `json:"you"`
	Host       bool         `json:"host"`
	Token      string       `json:"token,omitempty"`
	Players    []playerView `json:"players"`
	Walls      []Wall       `json:"walls"`
}

var (
	rooms    = map[string]*Room{}
	roomsMu  sync.RWMutex
	upgrader = websocket.Upgrader{
		ReadBufferSize:  1024,
		WriteBufferSize: 1024,
		CheckOrigin:     func(r *http.Request) bool { return true },
	}
)

func main() {
	http.HandleFunc("/ws", serveWebSocket)
	http.HandleFunc("/", servePage)
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	addr := ":" + port
	log.Printf("Blockline is running at http://localhost%s", addr)
	log.Fatal(http.ListenAndServe(addr, nil))
}

func servePage(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" && r.URL.Path != "/example.html" {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	http.ServeFile(w, r, "example.html")
}

func serveWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	c := &Client{conn: conn, send: make(chan any, 16)}
	go c.writePump()
	c.send <- map[string]any{"type": "connected"}
	c.readPump()
}

func (c *Client) readPump() {
	defer c.disconnect()
	c.conn.SetReadLimit(4096)
	c.conn.SetReadDeadline(time.Now().Add(70 * time.Second))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(70 * time.Second))
		return nil
	})
	for {
		var msg clientMessage
		if err := c.conn.ReadJSON(&msg); err != nil {
			return
		}
		switch msg.Type {
		case "create":
			c.createRoom(msg)
		case "join":
			c.joinRoom(msg)
		case "move":
			c.makeMove(msg.X, msg.Y)
		case "wall":
			c.placeWall(msg.X, msg.Y, msg.Orientation)
		case "new_round":
			c.newRound()
		default:
			c.fail("Unknown message type.")
		}
	}
}

func (c *Client) writePump() {
	ticker := time.NewTicker(25 * time.Second)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()
	for {
		select {
		case message, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if !ok {
				c.conn.WriteMessage(websocket.CloseMessage, nil)
				return
			}
			if err := c.conn.WriteJSON(message); err != nil {
				return
			}
		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (c *Client) createRoom(msg clientMessage) {
	if c.room != nil {
		c.fail("You are already in a room.")
		return
	}
	if msg.MaxPlayers < 2 || msg.MaxPlayers > 4 {
		c.fail("Choose 2, 3, or 4 players.")
		return
	}
	room := &Room{Code: newRoomCode(), MaxPlayers: msg.MaxPlayers, Winner: -1}
	player := &Player{Name: cleanName(msg.Name), Seat: 0, Token: newToken(), Connected: true, Client: c}
	room.Players = []*Player{player}
	room.prepareSeatsLocked()
	c.room, c.player = room, player
	roomsMu.Lock()
	rooms[room.Code] = room
	roomsMu.Unlock()
	room.mu.Lock()
	room.broadcastLocked()
	room.mu.Unlock()
}

func (c *Client) joinRoom(msg clientMessage) {
	if c.room != nil {
		c.fail("You are already in a room.")
		return
	}
	code := strings.ToUpper(strings.TrimSpace(msg.Room))
	roomsMu.RLock()
	room := rooms[code]
	roomsMu.RUnlock()
	if room == nil {
		c.fail("Room not found. Check the code and try again.")
		return
	}

	room.mu.Lock()
	defer room.mu.Unlock()
	if msg.Token != "" {
		for _, p := range room.Players {
			if p.Token == msg.Token {
				oldClient := p.Client
				p.Connected, p.Client = true, c
				c.room, c.player = room, p
				room.broadcastLocked()
				if oldClient != nil && oldClient != c {
					oldClient.conn.Close()
				}
				return
			}
		}
	}
	if room.Started || len(room.Players) >= room.MaxPlayers {
		c.fail("This room is already full or playing.")
		return
	}
	player := &Player{Name: cleanName(msg.Name), Seat: len(room.Players), Token: newToken(), Connected: true, Client: c}
	room.Players = append(room.Players, player)
	c.room, c.player = room, player
	room.prepareSeatsLocked()
	if len(room.Players) == room.MaxPlayers {
		room.resetGameLocked()
		room.Started = true
	}
	room.broadcastLocked()
}

func (c *Client) makeMove(x, y int) {
	room, player := c.room, c.player
	if room == nil || player == nil {
		c.fail("Join a room first.")
		return
	}
	room.mu.Lock()
	defer room.mu.Unlock()
	if err := room.canActLocked(player); err != nil {
		c.fail(err.Error())
		return
	}
	allowed := room.legalMovesLocked(player.Seat)
	if !containsPoint(allowed, Point{x, y}) {
		c.fail("That square is not a legal move.")
		return
	}
	room.Pawns[player.Seat] = Point{x, y}
	if room.atGoalLocked(player.Seat) {
		room.Winner = player.Seat
	} else {
		room.advanceTurnLocked()
	}
	room.broadcastLocked()
}

func (c *Client) placeWall(x, y int, orientation string) {
	room, player := c.room, c.player
	if room == nil || player == nil {
		c.fail("Join a room first.")
		return
	}
	room.mu.Lock()
	defer room.mu.Unlock()
	if err := room.canActLocked(player); err != nil {
		c.fail(err.Error())
		return
	}
	if room.WallsLeft[player.Seat] == 0 {
		c.fail("You have no walls left.")
		return
	}
	wall := Wall{X: x, Y: y, Orientation: orientation, Owner: player.Seat}
	if err := room.validateWallLocked(wall); err != nil {
		c.fail(err.Error())
		return
	}
	room.Walls = append(room.Walls, wall)
	room.WallsLeft[player.Seat]--
	room.advanceTurnLocked()
	room.broadcastLocked()
}

func (c *Client) newRound() {
	room, player := c.room, c.player
	if room == nil || player == nil {
		return
	}
	room.mu.Lock()
	defer room.mu.Unlock()
	if player.Seat != 0 {
		c.fail("Only the room host can start a new round.")
		return
	}
	if len(room.Players) != room.MaxPlayers {
		c.fail("Waiting for every seat to be filled.")
		return
	}
	for _, p := range room.Players {
		if !p.Connected {
			c.fail("Waiting for every player to reconnect.")
			return
		}
	}
	room.resetGameLocked()
	room.Started = true
	room.broadcastLocked()
}

func (c *Client) disconnect() {
	room, player := c.room, c.player
	if room != nil && player != nil {
		room.mu.Lock()
		if player.Client == c {
			player.Connected = false
			player.Client = nil
			if !room.Started {
				for i, p := range room.Players {
					if p == player {
						room.Players = append(room.Players[:i], room.Players[i+1:]...)
						break
					}
				}
				room.prepareSeatsLocked()
			} else {
				connected, last := 0, -1
				for _, p := range room.Players {
					if p.Connected {
						connected++
						last = p.Seat
					}
				}
				if connected == 1 {
					room.Winner = last
				}
				if room.Winner < 0 && room.Turn == player.Seat {
					room.advanceTurnLocked()
				}
			}
			room.broadcastLocked()
		}
		empty := true
		for _, p := range room.Players {
			if p.Connected {
				empty = false
				break
			}
		}
		room.mu.Unlock()
		if empty {
			roomsMu.Lock()
			delete(rooms, room.Code)
			roomsMu.Unlock()
		}
	}
	close(c.send)
}

func (r *Room) prepareSeatsLocked() {
	for i, p := range r.Players {
		p.Seat = i
	}
	r.Pawns = startingPawns(r.MaxPlayers)
	r.WallsLeft = make([]int, r.MaxPlayers)
	walls := wallsPerPlayer(r.MaxPlayers)
	for i := range r.WallsLeft {
		r.WallsLeft[i] = walls
	}
}

func (r *Room) resetGameLocked() {
	r.Pawns = startingPawns(r.MaxPlayers)
	r.Walls = nil
	r.WallsLeft = make([]int, r.MaxPlayers)
	for i := range r.WallsLeft {
		r.WallsLeft[i] = wallsPerPlayer(r.MaxPlayers)
	}
	r.Turn, r.Winner = 0, -1
}

func (r *Room) canActLocked(p *Player) error {
	if !r.Started {
		return errors.New("The game starts when every seat is filled.")
	}
	if r.Winner >= 0 {
		return errors.New("This round is over.")
	}
	if r.Turn != p.Seat {
		return errors.New("Wait for your turn.")
	}
	return nil
}

func (r *Room) legalMovesLocked(seat int) []Point {
	p := r.Pawns[seat]
	var out []Point
	directions := []Point{{0, -1}, {1, 0}, {0, 1}, {-1, 0}}
	for _, d := range directions {
		next := Point{p.X + d.X, p.Y + d.Y}
		if !inside(next) || r.blockedLocked(p, next, r.Walls) {
			continue
		}
		occupant := r.occupantLocked(next, seat)
		if occupant < 0 {
			out = append(out, next)
			continue
		}
		behind := Point{next.X + d.X, next.Y + d.Y}
		if inside(behind) && !r.blockedLocked(next, behind, r.Walls) && r.occupantLocked(behind, seat) < 0 {
			out = append(out, behind)
			continue
		}
		var sides []Point
		if d.X == 0 {
			sides = []Point{{-1, 0}, {1, 0}}
		} else {
			sides = []Point{{0, -1}, {0, 1}}
		}
		for _, side := range sides {
			diag := Point{next.X + side.X, next.Y + side.Y}
			if inside(diag) && !r.blockedLocked(next, diag, r.Walls) && r.occupantLocked(diag, seat) < 0 {
				out = append(out, diag)
			}
		}
	}
	return out
}

func (r *Room) occupantLocked(point Point, except int) int {
	for seat, pawn := range r.Pawns[:len(r.Players)] {
		if seat != except && pawn == point {
			return seat
		}
	}
	return -1
}

func (r *Room) validateWallLocked(w Wall) error {
	if (w.Orientation != "h" && w.Orientation != "v") || w.X < 0 || w.Y < 0 || w.X > 7 || w.Y > 7 {
		return errors.New("That wall is outside the board.")
	}
	for _, e := range r.Walls {
		if e.Orientation == w.Orientation {
			if w.Orientation == "h" && e.Y == w.Y && abs(e.X-w.X) < 2 {
				return errors.New("Walls cannot overlap.")
			}
			if w.Orientation == "v" && e.X == w.X && abs(e.Y-w.Y) < 2 {
				return errors.New("Walls cannot overlap.")
			}
		} else {
			h, v := w, e
			if w.Orientation == "v" {
				h, v = e, w
			}
			if h.X == v.X && h.Y == v.Y {
				return errors.New("Walls cannot cross.")
			}
		}
	}
	test := append(append([]Wall(nil), r.Walls...), w)
	for seat := range r.Players {
		if !r.hasPathLocked(seat, test) {
			return errors.New("Every player must keep a path to goal.")
		}
	}
	return nil
}

func (r *Room) hasPathLocked(seat int, walls []Wall) bool {
	queue := []Point{r.Pawns[seat]}
	seen := map[Point]bool{r.Pawns[seat]: true}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		if atGoal(seat, cur) {
			return true
		}
		for _, d := range []Point{{0, -1}, {1, 0}, {0, 1}, {-1, 0}} {
			next := Point{cur.X + d.X, cur.Y + d.Y}
			if inside(next) && !seen[next] && !r.blockedLocked(cur, next, walls) {
				seen[next] = true
				queue = append(queue, next)
			}
		}
	}
	return false
}

func (r *Room) blockedLocked(a, b Point, walls []Wall) bool {
	for _, w := range walls {
		if a.X == b.X {
			boundary, col := min(a.Y, b.Y), a.X
			if w.Orientation == "h" && w.Y == boundary && (w.X == col || w.X+1 == col) {
				return true
			}
		} else {
			boundary, row := min(a.X, b.X), a.Y
			if w.Orientation == "v" && w.X == boundary && (w.Y == row || w.Y+1 == row) {
				return true
			}
		}
	}
	return false
}

func (r *Room) atGoalLocked(seat int) bool { return atGoal(seat, r.Pawns[seat]) }
func atGoal(seat int, p Point) bool {
	switch seat {
	case 0:
		return p.Y == 0
	case 1:
		return p.Y == 8
	case 2:
		return p.X == 8
	default:
		return p.X == 0
	}
}

func (r *Room) advanceTurnLocked() {
	for i := 1; i <= len(r.Players); i++ {
		next := (r.Turn + i) % len(r.Players)
		if r.Players[next].Connected {
			r.Turn = next
			return
		}
	}
}

func (r *Room) broadcastLocked() {
	for _, recipient := range r.Players {
		if !recipient.Connected || recipient.Client == nil {
			continue
		}
		players := make([]playerView, 0, len(r.Players))
		for _, p := range r.Players {
			pawn, walls := Point{}, 0
			if p.Seat < len(r.Pawns) {
				pawn = r.Pawns[p.Seat]
			}
			if p.Seat < len(r.WallsLeft) {
				walls = r.WallsLeft[p.Seat]
			}
			players = append(players, playerView{Name: p.Name, Seat: p.Seat, Color: colorForSeat(p.Seat), Connected: p.Connected, Walls: walls, Pawn: pawn})
		}
		message := stateMessage{Type: "state", Room: r.Code, MaxPlayers: r.MaxPlayers, Started: r.Started, Turn: r.Turn, Winner: r.Winner, You: recipient.Seat, Host: recipient.Seat == 0, Token: recipient.Token, Players: players, Walls: append([]Wall(nil), r.Walls...)}
		select {
		case recipient.Client.send <- message:
		default:
		}
	}
}

func (c *Client) fail(message string) {
	select {
	case c.send <- map[string]any{"type": "error", "message": message}:
	default:
	}
}

func startingPawns(count int) []Point {
	all := []Point{{4, 8}, {4, 0}, {0, 4}, {8, 4}}
	return append([]Point(nil), all[:count]...)
}
func wallsPerPlayer(count int) int {
	if count == 2 {
		return 10
	}
	if count == 3 {
		return 7
	}
	return 5
}
func colorForSeat(seat int) string { return []string{"#ff7657", "#66a6ff", "#59d5a7", "#b98cff"}[seat] }
func inside(p Point) bool          { return p.X >= 0 && p.Y >= 0 && p.X < boardSize && p.Y < boardSize }
func containsPoint(points []Point, want Point) bool {
	for _, p := range points {
		if p == want {
			return true
		}
	}
	return false
}
func abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}
func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func cleanName(name string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		return "Player"
	}
	runes := []rune(name)
	if len(runes) > 18 {
		runes = runes[:18]
	}
	return string(runes)
}

func newRoomCode() string {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	for {
		buf := make([]byte, 5)
		rand.Read(buf)
		for i := range buf {
			buf[i] = alphabet[int(buf[i])%len(alphabet)]
		}
		code := string(buf)
		roomsMu.RLock()
		_, exists := rooms[code]
		roomsMu.RUnlock()
		if !exists {
			return code
		}
	}
}

func newToken() string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return fmt.Sprintf("%x", buf)
}
