import {test,expect} from 'vitest';
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {createServer,request as httpRequest} from 'node:http';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import vm from 'node:vm';
import {transformSync} from 'esbuild';
import {readDirectRecording,transcribeDirectRecording,DirectTranscriptionError} from './self-hosted-transcription.ts';
class Ws extends EventEmitter {clients=new Set();close(){}}
function wav(){const b=Buffer.alloc(1644);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVE',8);b.write('fmt ',12);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(1600,40);for(let i=44;i<b.length;i+=2)b.writeInt16LE(i%4?12000:-12000,i);return b;}
async function fixture(provider:typeof fetch){
 let valid=true;const env:Record<string,string>={ELIZA_SELF_HOSTED_VOICE_ENABLED:'1',CARTESIA_API_KEY:'synthetic-provider-key'},runtime={agentId:randomUUID(),reportError:()=>{}},state={current:runtime};
 const store={findIdentity:async()=>({kind:'owner'}),findActiveSession:async()=>valid?{identityId:'owner'}:null};
 const code=readFileSync(new URL('./self-hosted-voice.ts',import.meta.url),'utf8').replace(/^import\b[\s\S]*?;\s*$/gm,'').replace(/^export /gm,'');
 const box:any={createHash,randomBytes,randomUUID,readDirectRecording,transcribeDirectRecording,DirectTranscriptionError,process:{env},Date,URL,Buffer,AbortController,AbortSignal,setTimeout,clearTimeout,setInterval,clearInterval,
  createVoiceSessionRegistry:()=>({}),InMemoryVoiceUsageStore:class{},WebSocketServer:Ws,
  authStoreForRuntime:()=>store,findActiveSession:async(_store:any,id:string)=>valid&&id==='owner-session'?{identityId:'owner'}:null,
  resolveAuthorizedRouteRole:async(req:any)=>req.headers.authorization==='Bearer owner-session'?{ok:true,role:'OWNER',identityId:'owner'}:{ok:false,status:403},
  ensureSessionForRequest:async()=>({session:{id:'owner-session',csrfSecret:'csrf'},identity:{id:'owner',kind:'owner'},source:'bearer'}),
  isCredentialedCorsOrigin:()=>true,getCloudSecret:()=>env.ELIZAOS_CLOUD_API_KEY,resolveDevCloudEnvAuthority:()=>false,resolveCloudApiBaseUrl:()=> 'https://api.eliza.app/api/v1',
  sendJson:(res:any,status:number,data:unknown)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));},logger:{warn(){},error(){}}};
 vm.runInNewContext(transformSync(code,{loader:'ts',format:'cjs'}).code+';globalThis.factory=createSelfHostedVoice;',box);
 const host=box.factory(state,{fetchImpl:provider});
 const server=createServer((req,res)=>{void host.handleRequest(req,res).then((handled:boolean)=>{if(!handled){res.statusCode=404;res.end();}});});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin=`http://127.0.0.1:${(server.address() as any).port}`;
 const request=(options:{authorized?:boolean;signal?:AbortSignal;mime?:string;body?:Buffer}={})=>fetch(origin+'/api/v1/voice/session/transcribe',{method:'POST',headers:{...(options.authorized===false?{}:{Authorization:'Bearer owner-session'}),'Content-Type':options.mime??'audio/wav','X-Request-Id':randomUUID()},body:options.body??wav(),signal:options.signal});
 return {host,env,state,origin,request,invalidate(){valid=false;},async close(){host.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}
test('actual shared route authorizes owner and returns only direct transcript/attestation',async()=>{
 let calls=0;const f=await fixture(async url=>{calls++;expect(url).toBe('https://api.cartesia.ai/stt');return Response.json({text:'dictation result',apiKey:'must-not-escape'});});
 try{const response=await f.request();expect(response.status).toBe(200);expect(response.headers.get('x-eliza-stt-provider')).toBe('cartesia');expect(response.headers.get('x-eliza-speech-route')).toBe('direct');expect(await response.json()).toEqual({text:'dictation result'});expect(calls).toBe(1);}finally{await f.close();}
});
test('route refuses unauthenticated, malformed, keyless and Cloud-selected requests before provider call',async()=>{
 let calls=0;const f=await fixture(async()=>{calls++;return Response.json({text:'bad'});});
 try{expect((await f.request({authorized:false})).status).toBe(403);expect((await f.request({mime:'audio/mp4'})).status).toBe(415);expect((await f.request({body:Buffer.alloc(12)})).status).toBe(422);f.env.CARTESIA_API_KEY='';expect((await f.request()).status).toBe(503);f.env.ELIZA_SELF_HOSTED_VOICE_CLOUD_RELAY_ENABLED='1';f.env.ELIZAOS_CLOUD_API_KEY='synthetic-cloud-key';expect((await f.request()).status).toBe(409);expect(calls).toBe(0);}finally{await f.close();}
});
test('provider or owner change before completion prevents stale transcript publication',async()=>{
 for(const change of ['provider','owner']){
  let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>entered=r),wait=new Promise<void>(r=>release=r);
  const f=await fixture(async()=>{entered();await wait;return Response.json({text:'must not publish'});});
  try{const pending=f.request();await ready;if(change==='owner')f.invalidate();else f.env.CARTESIA_API_KEY='new-synthetic-provider-key';release();const response=await pending;expect(response.status).toBe(change==='owner'?401:409);expect(await response.text()).not.toContain('must not publish');}finally{await f.close();}
 }
});
test('normal HTTP disconnect propagates abort to the in-flight provider request',async()=>{
 let entered!:()=>void,aborted!:()=>void;const ready=new Promise<void>(r=>entered=r),done=new Promise<void>(r=>aborted=r);
 const f=await fixture(async(_url,init)=>{entered();return new Promise((_resolve,reject)=>{init!.signal!.addEventListener('abort',()=>{aborted();reject(new DOMException('Cancelled','AbortError'));},{once:true});});});
 try{const client=httpRequest(f.origin+'/api/v1/voice/session/transcribe',{method:'POST',headers:{Authorization:'Bearer owner-session','Content-Type':'audio/wav','X-Request-Id':randomUUID()}});client.on('error',()=>{});client.end(wav());await ready;client.destroy();await done;}finally{await f.close();}
});
