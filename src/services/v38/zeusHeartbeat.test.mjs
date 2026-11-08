import assert from 'node:assert/strict';
import {generateKeyPairSync,sign,randomUUID} from 'node:crypto';
import net from 'node:net';
import {once} from 'node:events';
import {ZeusHeartbeatOrchestrator,createHeartbeatResponder,heartbeatSigningBytes} from './zeusHeartbeat.mjs';
import {resultSigningBytes} from './foundation.mjs';
const passed=[];
async function check(name,fn){await fn();passed.push(name);}
function fixture(overrides={}) {
 const server=generateKeyPairSync('ed25519'),node=generateKeyPairSync('ed25519');
 const transport=new EventTarget();transport.readyState=1;transport.sent=[];transport.send=raw=>transport.sent.push(raw);
 const z=new ZeusHeartbeatOrchestrator({serverPrivateKey:server.privateKey,authorizeNode:async()=>true,canDispatch:async()=>true,validateProvenance:async()=>true,pingTimeoutMs:40,...overrides});
 return {z,server,node,transport,register:()=>z.registerWorker({id:'fixture-node',publicKey:node.publicKey,capabilities:['DOM_PARSE']},transport)};
}
function pong(f,raw=f.transport.sent.at(-1),key=f.node.privateKey) {
 const frame={...JSON.parse(raw),kind:'node.pong'};frame.signature=sign(null,heartbeatSigningBytes(frame),key).toString('base64url');return frame;
}
await check('valid signed heartbeat records RTT but not model health',async()=>{
 const f=fixture();try{await f.register();const p=f.z.pingNode('fixture-node');await f.z.receive(f.z.workers.get('fixture-node'),JSON.stringify(pong(f)));const health=await p;assert.equal(health.status,'online');assert.ok(health.rttMs>=0);assert.equal(health.modelHealth,'NOT_CHECKED');}finally{f.z.close();}
});
await check('overlapping probes share one pending request',async()=>{
 const f=fixture();try{await f.register();const a=f.z.pingNode('fixture-node'),b=f.z.pingNode('fixture-node');assert.equal(a,b);assert.equal(f.transport.sent.length,1);await f.z.receive(f.z.workers.get('fixture-node'),JSON.stringify(pong(f)));await a;}finally{f.z.close();}
});
await check('forged signature cannot mark node online',async()=>{
 const f=fixture();try{await f.register();const p=f.z.pingNode('fixture-node');const rejection=assert.rejects(p,/PING_TIMEOUT/);await f.z.receive(f.z.workers.get('fixture-node'),JSON.stringify(pong(f,undefined,generateKeyPairSync('ed25519').privateKey)));await rejection;assert.equal(f.z.nodeHealth('fixture-node').status,'suspect');}finally{f.z.close();}
});
await check('connection mismatch cannot satisfy ping',async()=>{
 const f=fixture();try{await f.register();const p=f.z.pingNode('fixture-node'),rejection=assert.rejects(p,/PING_TIMEOUT/);const frame=pong(f);frame.connectionId=randomUUID();frame.signature=sign(null,heartbeatSigningBytes(frame),f.node.privateKey).toString('base64url');await f.z.receive(f.z.workers.get('fixture-node'),JSON.stringify(frame));await rejection;}finally{f.z.close();}
});
await check('worker rejects unsigned server pings and replayed challenges',async()=>{
 const f=fixture();try{await f.register();let replies=[];const responder=createHeartbeatResponder({nodeId:'fixture-node',privateKey:f.node.privateKey,serverPublicKey:f.server.publicKey,send:raw=>replies.push(raw)});const p=f.z.pingNode('fixture-node'),raw=f.transport.sent.at(-1);const altered={...JSON.parse(raw),signature:'x'.repeat(86)};assert.equal(responder(JSON.stringify(altered)),false);assert.equal(responder(raw),true);assert.equal(responder(raw),false);assert.equal(replies.length,1);await f.z.receive(f.z.workers.get('fixture-node'),replies[0]);await p;}finally{f.z.close();}
});
await check('revoked enrollment cannot regain healthy status',async()=>{
 let allowed=true;const f=fixture({authorizeNode:async()=>allowed});try{await f.register();allowed=false;const p=f.z.pingNode('fixture-node'),rejection=assert.rejects(p,/NODE_DENIED/);await f.z.receive(f.z.workers.get('fixture-node'),JSON.stringify(pong(f)));await rejection;assert.equal(f.z.nodeHealth('fixture-node').status,'quarantined');}finally{f.z.close();}
});
await check('unprobed nodes are not eligible for work',async()=>{
 const f=fixture();try{await f.register();await assert.rejects(f.z.dispatchTask({id:'fixture-task',type:'DOM_PARSE',scopeKey:'fixture-tenant',payload:'fixture'}),/NO_ELIGIBLE_WORKER/);}finally{f.z.close();}
});
await check('close cancels pending probes and removes listeners',async()=>{
 const f=fixture();await f.register();const p=f.z.pingNode('fixture-node'),rejection=assert.rejects(p,/ORCHESTRATOR_STOPPED/);f.z.close();await rejection;assert.equal(f.z.pings.size,0);assert.equal(f.z.workers.size,0);
});
await check('successful probes are rate limited',async()=>{
 const f=fixture();try{await f.register();const p=f.z.pingNode('fixture-node');await f.z.receive(f.z.workers.get('fixture-node'),JSON.stringify(pong(f)));await p;await assert.rejects(f.z.pingNode('fixture-node'),/PING_RATE_LIMITED/);}finally{f.z.close();}
});
await check('three missed probes report offline without starting repairs',async()=>{
 const f=fixture({pingTimeoutMs:10});try{await f.register();for(let i=0;i<3;i++){if(i)await new Promise(r=>setTimeout(r,1000));await assert.rejects(f.z.pingNode('fixture-node'),/PING_TIMEOUT/);}assert.equal(f.z.nodeHealth('fixture-node').status,'offline');assert.equal(f.z.workers.get('fixture-node').quarantined,false);}finally{f.z.close();}
});
await check('real loopback TCP ping and signed scoped task both round-trip',async()=>{
 const f=fixture({pingTimeoutMs:1000});let serverSocket,clientSocket;
 const listener=net.createServer(socket=>{serverSocket=socket;});listener.listen(0,'127.0.0.1');await once(listener,'listening');
 try{
  const accepted=once(listener,'connection');clientSocket=net.connect(listener.address().port,'127.0.0.1');await once(clientSocket,'connect');[serverSocket]=await accepted;
  let serverBuffer='',clientBuffer='';f.transport.send=raw=>serverSocket.write(raw+'\n');
  serverSocket.on('data',chunk=>{serverBuffer+=chunk;let n;while((n=serverBuffer.indexOf('\n'))>=0){const raw=serverBuffer.slice(0,n);serverBuffer=serverBuffer.slice(n+1);void f.z.receive(f.z.workers.get('fixture-node'),raw);}});
  const responder=createHeartbeatResponder({nodeId:'fixture-node',privateKey:f.node.privateKey,serverPublicKey:f.server.publicKey,send:raw=>clientSocket.write(raw+'\n')});
  clientSocket.on('data',chunk=>{clientBuffer+=chunk;let n;while((n=clientBuffer.indexOf('\n'))>=0){const raw=clientBuffer.slice(0,n);clientBuffer=clientBuffer.slice(n+1);const frame=JSON.parse(raw);if(frame.kind==='zeus.ping')responder(raw);else{const result={...frame,data:'fixture extracted text',sources:[{url:'https://example.org/fixture'}]};delete result.payload;result.signature=sign(null,resultSigningBytes(result),f.node.privateKey).toString('base64url');clientSocket.write(JSON.stringify(result)+'\n');}}});
  await f.register();const health=await f.z.pingNode('fixture-node');assert.equal(health.status,'online');
  const result=await f.z.dispatchTask({id:'fixture-task',type:'DOM_PARSE',scopeKey:'fixture-tenant',payload:'fixture input'});assert.equal(result.data,'fixture extracted text');
 }finally{f.z.close();clientSocket?.destroy();serverSocket?.destroy();await new Promise(resolve=>listener.close(resolve));}
});
console.log(JSON.stringify({passed:passed.length,checks:passed,scope:'Inspected ZeusOrchestrator class excerpt used as the base. Ephemeral Ed25519 keys; fixture policies; one actual loopback TCP worker and signed task result. No remote hosts, TLS certification, model inference, idle scraping, or deployment.'}));
