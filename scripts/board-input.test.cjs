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
  vm.runInNewContext(source.replace('draw();connect();','draw();receiveState(__TEST_STATE__);globalThis.__TEST_API__={atGoal,legalMoves,legalWall,startingPawn};'),sandbox);
  const event=(u,v,extra={})=>({clientX:57+u*54,clientY:57+v*54,pointerType:'mouse',pointerId:1,...extra});
  const pointEvent=(x,y,extra={})=>({clientX:x,clientY:y,pointerType:'mouse',pointerId:1,...extra});
  return {handlers,sent,event,pointEvent,state,elements,api:sandbox.__TEST_API__};
}

test('classic multiplayer and pentagon modes use their center goals',()=>{
  const {api}=setup();
  assert.equal(api.atGoal(0,{x:4,y:0},{mode:'classic',maxPlayers:2}),true);
  assert.equal(api.atGoal(0,{x:4,y:0},{mode:'classic',maxPlayers:3}),false);
  assert.equal(api.atGoal(3,{x:4,y:4},{mode:'classic',maxPlayers:4}),true);
  assert.equal(api.atGoal(4,{x:5,y:0},{mode:'pentagon',maxPlayers:5}),true);
  assert.equal(api.atGoal(4,{x:4,y:1},{mode:'pentagon',maxPlayers:5}),false);
});

test('pentagon mode supports five starts, connected-node moves and edge walls',()=>{
  const players=Array.from({length:5},(_,seat)=>({seat,name:`P${seat+1}`,connected:true,walls:5,pawn:{x:seat,y:4}}));
  const {handlers,sent,pointEvent,api}=setup({mode:'pentagon',maxPlayers:5,players});
  assert.equal(JSON.stringify(Array.from({length:5},(_,seat)=>api.startingPawn(seat,'pentagon'))),JSON.stringify(Array.from({length:5},(_,x)=>({x,y:4}))));
  handlers.click(pointEvent(300,124.5));
  handlers.click(pointEvent(300,95));
  assert.deepEqual(sent,[{type:'move',x:0,y:3},{type:'wall',orientation:'r',x:0,y:4}]);
});

test('pentagon walls cannot close every route to the center',()=>{
  const players=[{seat:0,name:'Host',connected:true,walls:5,pawn:{x:0,y:4}}];
  const walls=Array.from({length:4},(_,x)=>({orientation:'r',x,y:1,owner:0}));
  const {api,state}=setup({mode:'pentagon',maxPlayers:5,players,walls});
  assert.equal(api.legalWall({orientation:'r',x:4,y:1},state),false);
});

test('Firebase database rules remain valid JSON',()=>{
  assert.doesNotThrow(()=>JSON.parse(fs.readFileSync(path.join(__dirname,'..','database.rules.json'),'utf8')));
});

test('pentagon host can start before all five seats are filled',()=>{
  const players=[{seat:0,name:'Host',connected:true,walls:5,pawn:{x:0,y:4}}];
  const {elements,sent}=setup({mode:'pentagon',maxPlayers:5,started:false,players});
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
test('turn and wall collision checks still reject invalid actions',()=>{
  const blocked=setup({walls:[{x:3,y:3,orientation:'h'}]});blocked.handlers.click(blocked.event(3.5,4));
  const waiting=setup({turn:1});waiting.handlers.click(waiting.event(4.5,7.5));
  assert.equal(blocked.sent.length+waiting.sent.length,0);
});
