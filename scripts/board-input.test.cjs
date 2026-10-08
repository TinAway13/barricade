const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '..', 'example.html'), 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function setup() {
  const handlers = {}, sent = [], elements = new Map();
  const ctx = new Proxy({}, { get: (_, name) => name.startsWith('create') ? () => ({addColorStop(){}}) : () => {} });
  const element = () => ({ value:'', content:'', style:{}, classList:{add(){},remove(){},toggle(){}},
    querySelector:()=>element(), appendChild(){}, addEventListener(){}, getContext:()=>ctx,
    getBoundingClientRect:()=>({left:0,top:0,width:600,height:600}), setPointerCapture(){}, hasPointerCapture:()=>true, releasePointerCapture(){} });
  const board=element();board.addEventListener=(name,fn)=>handlers[name]=fn;elements.set('board',board);
  class WebSocket {
    static OPEN=1;
    constructor(){this.readyState=1;WebSocket.instance=this}
    send(message){sent.push(JSON.parse(message))}
  }
  const sandbox={document:{getElementById:id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id)},querySelector:()=>element(),querySelectorAll:()=>[],createElement:element},
    WebSocket,localStorage:{getItem:()=>null,setItem(){}},location:{protocol:'http:',host:'localhost',hash:''},
    ResizeObserver:class{constructor(callback){this.callback=callback}observe(){this.callback()}},devicePixelRatio:1,
    addEventListener(){},clearTimeout(){},setTimeout(){},Date,console};
  vm.runInNewContext(source,sandbox);
  const state={type:'state',room:'ABCDE',maxPlayers:2,started:true,winner:-1,turn:0,you:0,host:true,walls:null,
    players:[{seat:0,name:'Host',connected:true,walls:10,pawn:{x:4,y:8}},{seat:1,name:'Guest',connected:true,walls:10,pawn:{x:4,y:0}}]};
  WebSocket.instance.onmessage({data:JSON.stringify(state)});
  const event=(u,v,extra={})=>({clientX:57+u*54,clientY:57+v*54,pointerType:'mouse',pointerId:1,...extra});
  return {handlers,sent,event,state,ws:WebSocket.instance};
}

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
  const {handlers,sent,event,state,ws}=setup();
  state.walls=[{x:3,y:3,orientation:'h'}];ws.onmessage({data:JSON.stringify(state)});handlers.click(event(3.5,4));
  state.turn=1;ws.onmessage({data:JSON.stringify(state)});handlers.click(event(4.5,7.5));
  assert.equal(sent.length,0);
});
