// Run an isolated Edge/Chrome with --headless=new --remote-debugging-port=9222 first.
// Requires the local Go server on port 8080. Creates and then closes two test contexts.
const assert=require('node:assert/strict');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function connect(url){
  const socket=new WebSocket(url);await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j});
  let id=0;const pending=new Map(),errors=[];
  socket.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result)}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params)};
  return {socket,errors,send:(method,params={})=>new Promise((resolve,reject)=>{pending.set(++id,{resolve,reject});socket.send(JSON.stringify({id,method,params}))})};
}
async function evaluate(c,expression){const r=await c.send('Runtime.evaluate',{expression,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value}
async function wait(c,expression){for(let i=0;i<100;i++){if(await evaluate(c,expression))return;await delay(100)}throw Error('Timed out: '+expression)}
async function point(c,u,v){return evaluate(c,`(()=>{const r=document.getElementById('board').getBoundingClientRect();return{x:r.left+r.width*(.095+${u}*.09),y:r.top+r.width*(.095+${v}*.09)}})()`)}
async function click(c,p){await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',...p});await c.send('Input.dispatchMouseEvent',{type:'mousePressed',...p,button:'left',clickCount:1});await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',...p,button:'left',clickCount:1})}
(async()=>{
  const info=await fetch('http://localhost:9222/json/version').then(r=>r.json()),browser=await connect(info.webSocketDebuggerUrl),contexts=[],clients=[];
  try{
    async function page(){const {browserContextId}=await browser.send('Target.createBrowserContext');contexts.push(browserContextId);const {targetId}=await browser.send('Target.createTarget',{url:'http://localhost:8080',browserContextId});const targets=await fetch('http://localhost:9222/json').then(r=>r.json());const c=await connect(targets.find(t=>t.id===targetId).webSocketDebuggerUrl);clients.push(c);await c.send('Runtime.enable');await wait(c,"document.getElementById('connectionText')?.textContent==='ONLINE'");return c}
    const host=await page(),guest=await page();
    await host.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    await evaluate(host,"document.getElementById('createBtn').click()");await wait(host,"document.getElementById('roomCode').textContent.length===5");
    const room=await evaluate(host,"document.getElementById('roomCode').textContent");
    await evaluate(guest,`document.getElementById('roomInput').value='${room}';document.getElementById('joinBtn').click()`);
    await wait(host,"document.getElementById('turnText').textContent==='YOUR TURN'");
    assert.equal(await evaluate(host,"document.querySelectorAll('[data-action]').length"),0);
    await click(host,await point(host,3.5,4));await wait(guest,"document.getElementById('turnText').textContent==='YOUR TURN'");
    await guest.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:3,mobile:true});
    await guest.send('Emulation.setTouchEmulationEnabled',{enabled:true});await delay(100);
    const from=await point(guest,5,3.5),to=await point(guest,6,4.5);
    await guest.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[from]});
    await guest.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[to]});
    await guest.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await wait(host,"document.getElementById('turnText').textContent==='YOUR TURN'");
    await click(host,await point(host,4.5,7.5));await wait(guest,"document.getElementById('turnText').textContent==='YOUR TURN'");
    assert.equal(await evaluate(host,"document.getElementById('playerStrip').textContent"),'Player · 9Player · 9');
    assert.equal(clients.flatMap(c=>c.errors).length,0);
    console.log('PASS: desktop gap wall, mobile drag/release wall, tile pawn move, no action buttons or browser exceptions.');
  }finally{for(const id of contexts)await browser.send('Target.disposeBrowserContext',{browserContextId:id});clients.forEach(c=>c.socket.close());browser.socket.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
