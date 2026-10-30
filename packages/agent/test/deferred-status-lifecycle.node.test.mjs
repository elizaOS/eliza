import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  markDeferredBootPhase, getDeferredBootStatus, subscribeDeferredBootStatus,
  _resetDeferredBootStatusForTest,
} from '../src/runtime/deferred-boot-status.ts';

const health=fs.readFileSync(new URL('../src/api/health-routes.ts',import.meta.url),'utf8');
const server=fs.readFileSync(new URL('../src/api/server.ts',import.meta.url),'utf8');
function method(source,signature){
 const start=source.indexOf(signature);assert.ok(start>=0);const open=source.indexOf('{',start);let depth=1,end=open+1;
 for(;depth;end++){if(source[end]==='{')depth++;else if(source[end]==='}')depth--;assert.ok(end<source.length);}
 return source.slice(start,end);
}
const readinessSource=method(health,'export async function responseReadinessFields(')
 .replace('export ','').replace('runtime: AgentRuntime | null','runtime').replace('agentState: string','agentState');
const readiness=Function('readLocalTextModelReadiness','computeCanRespond','cloudModelReadinessField','getDeferredBootStatus',readinessSource+';return responseReadinessFields;')(
 async()=>null,(_runtime,state)=>state==='running',()=>({}),getDeferredBootStatus,
);
const broadcastSource=method(server,'const broadcastStatus = async () =>');
function host(owner,read=readiness){
 const state={runtime:{owner},agentState:'running',agentName:owner,pendingRestartReasons:[]};const frames=[];
 const broadcast=Function('state','wsSessions','wsClients','responseReadinessFields','broadcastWs','let statusReadinessSequence=0;'+broadcastSource+';return broadcastStatus;')(
 state,new Map(),new Set([owner]),read,frame=>frames.push(frame),
 );
 return {state,frames,broadcast};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('actual existing status projection broadcasts deferred completion while preserving chat readiness',async()=>{
 _resetDeferredBootStatusForTest();markDeferredBootPhase('agent-deferred-boot','pending');
 const h=host('owner-a');const stop=subscribeDeferredBootStatus(()=>{void h.broadcast();});
 try{
  await h.broadcast();assert.equal(h.frames[0].canRespond,true);assert.equal(h.frames[0].localModelReadiness,null);assert.equal(h.frames[0].deferredBoot.settled,false);
  markDeferredBootPhase('agent-deferred-boot','complete');await tick();
  assert.equal(h.frames.length,2);assert.equal(h.frames[1].deferredBoot.settled,true);assert.equal(h.frames[1].deferredBoot.phases['agent-deferred-boot'],'complete');
 }finally{stop();}
});
test('failed phases settle explicitly, duplicate phase writes do not rebroadcast and unsubscribe removes observation',()=>{
 _resetDeferredBootStatusForTest();let calls=0;const stop=subscribeDeferredBootStatus(()=>calls++);
 markDeferredBootPhase('app-route-tail','pending');markDeferredBootPhase('app-route-tail','pending');assert.equal(calls,1);
 markDeferredBootPhase('app-route-tail','failed');assert.deepEqual(getDeferredBootStatus(),{phases:{'app-route-tail':'failed'},settled:true});assert.equal(calls,2);
 stop();markDeferredBootPhase('app-route-tail','complete');assert.equal(calls,2);
});
test('status subscriptions retain distinct host identity and disposed hosts receive no completion',async()=>{
 _resetDeferredBootStatusForTest();const a=host('owner-a'),b=host('owner-b');const stopA=subscribeDeferredBootStatus(()=>{void a.broadcast();});const stopB=subscribeDeferredBootStatus(()=>{void b.broadcast();});
 try{
  markDeferredBootPhase('agent-deferred-boot','pending');await tick();stopA();markDeferredBootPhase('agent-deferred-boot','complete');await tick();
  assert.equal(a.frames.length,1);assert.equal(b.frames.length,2);assert.ok(a.frames.every(x=>x.agentName==='owner-a'));assert.ok(b.frames.every(x=>x.agentName==='owner-b'));
 }finally{stopA();stopB();}
});
test('existing asynchronous runtime fence discards a status computed for a replaced runtime',async()=>{
 let release;const h=host('old-owner',()=>new Promise(resolve=>release=resolve));const pending=h.broadcast();h.state.runtime={owner:'new-owner'};h.state.agentName='new-owner';release({canRespond:true,deferredBoot:{settled:true,phases:{}}});await pending;assert.deepEqual(h.frames,[]);
});
test('HTTP, initial websocket and broadcast reuse the same projection and server close disposes the listener',()=>{
 assert.match(server,/const readiness = await responseReadinessFields\(runtime, agentState\)/);
 assert.match(server,/const unsubscribeDeferredBootStatus = subscribeDeferredBootStatus/);
 assert.match(server,/name: "deferred boot status listener",\s*dispose: unsubscribeDeferredBootStatus/);
 assert.match(health,/\.\.\.\(await responseReadinessFields\(state\.runtime, state\.agentState\)\)/);
});
