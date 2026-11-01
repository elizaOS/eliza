import type http from 'node:http';
import { readMonoPcm16Wav, AsrAudioError } from './standalone-asr-service';

export const DIRECT_RECORDING_LIMIT = 2 * 1024 * 1024;
const PROVIDER_RESPONSE_LIMIT = 256 * 1024;
const CARTESIA_STT_URL = 'https://api.cartesia.ai/stt';
const CARTESIA_VERSION = '2026-03-01';

/** Renderer-safe failure; provider response bodies and credentials never become error text. */
export class DirectTranscriptionError extends Error {
 constructor(readonly status:number,readonly code:string){super(code);}
}
/** The same PCM decoder and recording limits used by the normal resident ASR route. */
export async function readDirectRecording(req:http.IncomingMessage,signal:AbortSignal):Promise<Buffer>{
 if(!/^audio\/(?:x-)?wav(?:;|$)/i.test(req.headers['content-type']??''))throw new DirectTranscriptionError(415,'pcm_wav_required');
 const declared=Number(req.headers['content-length']);if(Number.isFinite(declared)&&declared>DIRECT_RECORDING_LIMIT)throw new DirectTranscriptionError(413,'audio_too_large');
 signal.throwIfAborted();
 // A pending IncomingMessage read does not observe AbortSignal on its own.
 // Destroy only while reading the body so revocation/reset releases the slot
 // even when the client sends no further bytes.
 const abortRead=()=>{req.destroy();};
 signal.addEventListener('abort',abortRead,{once:true});
 try{
  signal.throwIfAborted();
  let size=0;const parts:Buffer[]=[];
  for await(const part of req){signal.throwIfAborted();size+=part.length;if(size>DIRECT_RECORDING_LIMIT)throw new DirectTranscriptionError(413,'audio_too_large');parts.push(Buffer.from(part));}
  signal.throwIfAborted();const audio=Buffer.concat(parts);
  try{readMonoPcm16Wav(audio);}catch(error){if(error instanceof AsrAudioError)throw new DirectTranscriptionError(error.status,error.code);throw error;}
  return audio;
 }catch(error){signal.throwIfAborted();throw error;}
 finally{signal.removeEventListener('abort',abortRead);}
}
/** Batch transport for the already-authorized resident's selected direct provider.
 * No model turn, automatic retry, alternate provider, Cloud billing or credential storage. */
export async function transcribeDirectRecording(input:{audio:Buffer;apiKey:string;signal:AbortSignal;current:()=>Promise<void>;fetchImpl?:typeof fetch}):Promise<string>{
 const {audio,signal,current}=input;
 signal.throwIfAborted();
 if(!input.apiKey||!/^[!-~]{8,1024}$/.test(input.apiKey))throw new DirectTranscriptionError(503,'voice_provider_not_configured');
 if(audio.length>DIRECT_RECORDING_LIMIT)throw new DirectTranscriptionError(413,'audio_too_large');
 await current();signal.throwIfAborted();
 const form=new FormData();form.append('model','ink-whisper');form.append('file',new Blob([new Uint8Array(audio)],{type:'audio/wav'}),'recording.wav');
 const response=await (input.fetchImpl??fetch)(CARTESIA_STT_URL,{method:'POST',headers:{Authorization:'Bearer '+input.apiKey,'Cartesia-Version':CARTESIA_VERSION},body:form,redirect:'error',signal});
 signal.throwIfAborted();
 if(!response.ok){await response.body?.cancel();throw new DirectTranscriptionError(response.status>=400&&response.status<=599?response.status:502,'voice_provider_refused');}
 const reader=response.body?.getReader();if(!reader)throw new DirectTranscriptionError(502,'voice_invalid_transcript');
 let size=0;const chunks:Uint8Array[]=[];
 try{for(;;){signal.throwIfAborted();const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>PROVIDER_RESPONSE_LIMIT)throw new DirectTranscriptionError(502,'voice_invalid_transcript');chunks.push(part.value);}}finally{await reader.cancel().catch(()=>{});}
 await current();signal.throwIfAborted();
 let result:unknown;try{result=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new DirectTranscriptionError(502,'voice_invalid_transcript');}
 const text=result&&typeof result==='object'&&!Array.isArray(result)?Reflect.get(result,'text'):undefined;
 if(typeof text!=='string'||text.length>16000)throw new DirectTranscriptionError(502,'voice_invalid_transcript');
 return text;
}
