const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '..', 'example.html'), 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function setup(overrides={}) {
  const handlers = {}, sent = [], elements = new Map();
  const ctx = new Proxy({}, { get: (_, name) => name.startsWith('create') ? () => ({addColorStop(){}}) : () => {} });
  const element = () => ({ value:'', content:'', style:{}, classList:{add(){},remove(){},toggle(){}},
    querySelector:()=>element(), appendChild(){}, addEventListener(){}, getContext:()=>ctx,
    getBoundingClientRect:()=>({left:0,top:0,width:600,height:600}), setPointerCapture(){}, hasPointerCapture:()=>true, releasePointerCapture(){} });
  const board=element();board.addEventListener=(name,fn)=>handlers[name]=fn;elements.set('board',board);
  const state={type:'state',room:'ABCDE',maxPlayers:2,started:true,winner:-1,turn:0,you:0,host:true,walls:null,
    players:[{seat:0,name:'Host',connected:true,walls:10,pawn:{x:4,y:8}},{seat:1,name:'Guest',connected:true,walls:10,pawn:{x:4,y:0}}]};
  Object.assign(state,overrides);
  const sandbox={document:{getElementById:id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id)},querySelector:()=>element(),querySelectorAll:()=>[],createElement:element},
    localStorage:{getItem:()=>null,setItem(){}},location:{protocol:'http:',host:'localhost',hash:''},
    ResizeObserver:class{constructor(callback){this.callback=callback}observe(){this.callback()}},devicePixelRatio:1,
    addEventListener(){},clearTimeout(){},setTimeout(){},Date,console,__TEST_STATE__:state,
    __BLOCKLINE_SEND_OVERRIDE__:payload=>sent.push(JSON.parse(JSON.stringify(payload)))};
  sandbox.globalThis=sandbox;
  vm.runInNewContext(source.replace('draw();connect();','draw();receiveState(__TEST_STATE__);globalThis.__TEST_API__={atGoal,legalMoves,legalWall,startingPawn,randomBorderPawns,resetRawGame,boardSize,wallsPerPlayer};'),sandbox);
  const event=(u,v,extra={})=>({clientX:57+u*54,clientY:57+v*54,pointerType:'mouse',pointerId:1,...extra});
  const boardEvent=(size,u,v,extra={})=>({clientX:57+u*486/size,clientY:57+v*486/size,pointerType:'mouse',pointerId:1,...extra});
  return {handlers,sent,event,boardEvent,state,elements,api:sandbox.__TEST_API__};
}

test('classic multiplayer and Crown mode use the correct goals',()=>{
  const {api}=setup();
  assert.equal(api.atGoal(0,{x:4,y:0},{mode:'classic',maxPlayers:2}),true);
  assert.equal(api.atGoal(0,{x:4,y:0},{mode:'classic',maxPlayers:3}),true);
  assert.equal(api.atGoal(0,{x:4,y:0},{mode:'classic',maxPlayers:4}),true);
  assert.equal(api.atGoal(1,{x:4,y:8},{mode:'classic',maxPlayers:4}),true);
  assert.equal(api.atGoal(2,{x:8,y:4},{mode:'classic',maxPlayers:4}),true);
  assert.equal(api.atGoal(3,{x:0,y:4},{mode:'classic',maxPlayers:4}),true);
  assert.equal(api.atGoal(3,{x:4,y:4},{mode:'classic',maxPlayers:4}),false);
  assert.equal(api.atGoal(4,{x:5,y:5},{mode:'crown',maxPlayers:5}),true);
  assert.equal(api.atGoal(4,{x:4,y:1},{mode:'crown',maxPlayers:5}),false);
  assert.equal(api.boardSize({maxPlayers:5}),11);
  assert.equal(api.wallsPerPlayer(5,'crown'),8);
});

test('Crown mode uses the square board for moves and walls',()=>{
  const pawns=[{x:2,y:0},{x:10,y:2},{x:6,y:10},{x:0,y:6},{x:4,y:0}];
  const players=pawns.map((pawn,seat)=>({seat,name:`P${seat+1}`,connected:true,walls:5,pawn}));
  const {handlers,sent,boardEvent}=setup({mode:'crown',maxPlayers:5,players});
  handlers.click(boardEvent(11,2.5,1.5));
  handlers.click(boardEvent(11,3.5,4));
  assert.deepEqual(sent,[{type:'move',x:2,y:1},{type:'wall',x:3,y:3,orientation:'h'}]);
});

test('Crown rounds randomize five unique non-corner edge spawns',()=>{
  const {api}=setup(),players=Object.fromEntries(Array.from({length:5},(_,seat)=>[`u${seat}`,{seat,walls:0,pawn:{x:5,y:5}}]));
  const room={maxPlayers:5,mode:'crown',players,walls:[],turn:3,winner:2};
  api.resetRawGame(room);
  const pawns=Object.values(room.players).map(p=>p.pawn),keys=pawns.map(p=>`${p.x},${p.y}`);
  assert.equal(new Set(keys).size,5);
  assert.ok(pawns.every(p=>(p.x===0||p.x===10||p.y===0||p.y===10)&&!((p.x===0||p.x===10)&&(p.y===0||p.y===10))));
  assert.ok(Object.values(room.players).every(p=>p.walls===8));
  assert.equal(room.turn,0);
  assert.equal(room.winner,-1);
});

test('Firebase database rules remain valid JSON',()=>{
  assert.doesNotThrow(()=>JSON.parse(fs.readFileSync(path.join(__dirname,'..','database.rules.json'),'utf8')));
});

test('Crown host can start before all five seats are filled',()=>{
  const players=[{seat:0,name:'Host',connected:true,walls:5,pawn:{x:2,y:0}}];
  const {elements,sent}=setup({mode:'crown',maxPlayers:5,started:false,players});
  const button=elements.get('newRoundBtn');
  assert.equal(button.disabled,false);
  assert.equal(button.textContent,'Start match');
  button.onclick();
  assert.deepEqual(sent,[{type:'new_round'}]);
});

test('one board chooses moves, horizontal walls and vertical walls from position',()=>{
  const {handlers,sent,event}=setup();
  handlers.click(event(4.5,7.5));
  handlers.pointermove(event(3.5,4)); // Also exercises null-wall preview without crashing.
  handlers.click(event(3.5,4));
  handlers.click(event(6,4.5));
  assert.deepEqual(sent,[{type:'move',x:4,y:7},{type:'wall',x:3,y:3,orientation:'h'},{type:'wall',x:5,y:4,orientation:'v'}]);
});
test('touch slides to a wall, releases once, and suppresses the compatibility click',()=>{
  const {handlers,sent,event}=setup(),touch={pointerType:'touch'};
  handlers.pointerdown(event(2.5,3,touch));handlers.pointermove(event(3.5,4,touch));
  handlers.pointerup(event(3.5,4,touch));handlers.click(event(3.5,4,touch));
  assert.deepEqual(sent,[{type:'wall',x:3,y:3,orientation:'h'}]);
});
test('touch cancellation and releases outside the board never place a wall',()=>{
  const {handlers,sent,event}=setup(),touch={pointerType:'touch'};
  handlers.pointerdown(event(3.5,4,touch));handlers.pointercancel();handlers.pointerup(event(3.5,4,touch));
  handlers.pointerdown(event(3.5,4,touch));handlers.pointerup(event(-1,4,touch));
  assert.equal(sent.length,0);
});
test('outermost tile edges map to valid two-tile wall anchors',()=>{
  const {handlers,sent,event}=setup();handlers.click(event(8.5,8));handlers.click(event(8,8.5));
  assert.deepEqual(sent,[{type:'wall',x:7,y:7,orientation:'h'},{type:'wall',x:7,y:7,orientation:'v'}]);
});
test('Crown board accepts wall anchors across the full 11 by 11 board',()=>{
  const players=[{seat:0,name:'Host',connected:true,walls:8,pawn:{x:2,y:0}}];
  const {handlers,sent,boardEvent}=setup({mode:'crown',maxPlayers:5,players});
  handlers.click(boardEvent(11,10.5,10));handlers.click(boardEvent(11,10,10.5));
  assert.deepEqual(sent,[{type:'wall',x:9,y:9,orientation:'h'},{type:'wall',x:9,y:9,orientation:'v'}]);
});
test('turn and wall collision checks still reject invalid actions',()=>{
  const blocked=setup({walls:[{x:3,y:3,orientation:'h'}]});blocked.handlers.click(blocked.event(3.5,4));
  const waiting=setup({turn:1});waiting.handlers.click(waiting.event(4.5,7.5));
  assert.equal(blocked.sent.length+waiting.sent.length,0);
});
