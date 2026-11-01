import {test,expect} from 'vitest';
import {Readable} from 'node:stream';
import {readDirectRecording,transcribeDirectRecording,DIRECT_RECORDING_LIMIT} from './self-hosted-transcription.ts';
function wav(){const b=Buffer.alloc(44+1600);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVE',8);b.write('fmt ',12);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(1600,40);for(let i=44;i<b.length;i+=2)b.writeInt16LE(i%4?12000:-12000,i);return b;}
const req=(body:Buffer,mime='audio/wav')=>Object.assign(Readable.from([body]),{headers:{'content-type':mime,'content-length':String(body.length)}}) as any;
test('direct batch upload uses fixed Cartesia contract and projects transcript only',async()=>{
 const audio=await readDirectRecording(req(wav()),new AbortController().signal);let calls=0,checks=0;
 const result=await transcribeDirectRecording({audio,apiKey:'synthetic-provider-key',signal:new AbortController().signal,current:async()=>{checks++;},fetchImpl:async(url,init)=>{
  calls++;expect(url).toBe('https://api.cartesia.ai/stt');expect(init?.method).toBe('POST');expect(init?.redirect).toBe('error');
  expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer synthetic-provider-key');expect(new Headers(init?.headers).get('Cartesia-Version')).toBe('2026-03-01');
  const form=init?.body as FormData;expect(form.get('model')).toBe('ink-whisper');const file=form.get('file') as File;expect(file.type).toBe('audio/wav');expect(Buffer.from(await file.arrayBuffer())).toEqual(audio);
  return Response.json({text:'a dictated note',apiKey:'must-not-escape',ignored:'private'});
 }});
 expect(result).toBe('a dictated note');expect(result.includes('key')).toBe(false);expect(calls).toBe(1);expect(checks).toBe(2);
});
test('normal recording size, MIME and PCM guards reject before any upload',async()=>{
 for(const [body,mime] of [[wav(),'audio/mp4'],[Buffer.alloc(20),'audio/wav'],[Buffer.alloc(DIRECT_RECORDING_LIMIT+1),'audio/wav']] as const)await expect(readDirectRecording(req(body,mime),new AbortController().signal)).rejects.toThrow();
});
test('no key or cancelled operation never dispatches provider request',async()=>{
 let calls=0;const request=async()=>{calls++;return Response.json({text:'no'});};
 await expect(transcribeDirectRecording({audio:wav(),apiKey:'',signal:new AbortController().signal,current:async()=>{},fetchImpl:request})).rejects.toThrow();
 const abort=new AbortController();abort.abort();await expect(transcribeDirectRecording({audio:wav(),apiKey:'synthetic-provider-key',signal:abort.signal,current:async()=>{},fetchImpl:request})).rejects.toThrow();expect(calls).toBe(0);
});
test('abort or owner/provider switch while upload is pending cannot publish late text',async()=>{
 for(const cancel of [true,false]){
  let entered!:()=>void,release!:()=>void,current=true;const waiting=new Promise<void>(r=>entered=r),response=new Promise<void>(r=>release=r),controller=new AbortController();let calls=0;
  const promise=transcribeDirectRecording({audio:wav(),apiKey:'synthetic-provider-key',signal:controller.signal,current:async()=>{if(!current)throw Error('owner/provider changed');},fetchImpl:async()=>{calls++;entered();await response;return Response.json({text:'late private transcript'});}});
  await waiting;if(cancel)controller.abort();else current=false;release();await expect(promise).rejects.toThrow();expect(calls).toBe(1);
 }
});
test('provider failures do not expose response bodies or retry elsewhere',async()=>{
 let calls=0;try{await transcribeDirectRecording({audio:wav(),apiKey:'synthetic-provider-key',signal:new AbortController().signal,current:async()=>{},fetchImpl:async()=>{calls++;return new Response('synthetic-provider-key',{status:401});}});throw Error('unexpected');}catch(error){expect(String(error)).not.toContain('synthetic-provider-key');}expect(calls).toBe(1);
});
