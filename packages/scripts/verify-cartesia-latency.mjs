import {writeFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {randomUUID} from 'node:crypto';
const origin='https://api-staging.eliza.app';
const phrase='The blue notebook is on the table.';
const receipt={schema:1,environment:'staging',requests:[],paidRequests:0,success:false};
const signal=AbortSignal.timeout(150000);
function check(ok,code){if(!ok)throw Object.assign(new Error(code),{safeCode:code});}
async function bytes(response,max){
 const reader=response.body?.getReader();check(reader,'missing_body');const chunks=[];let size=0;
 try{for(;;){const r=await reader.read();if(r.done)break;size+=r.value.length;check(size<=max,'response_too_large');chunks.push(r.value);}}finally{await reader.cancel().catch(()=>{});}
 return Buffer.concat(chunks);
}
function timing(header){
 const result={};check(!header||header.length<=4096,'invalid_timing_header');
 const allowed=new Set(['cloud_worker','entry_dispatch','upload','auth','admission','transcription','synthesis','total','provider']);
 for(const entry of (header??'').split(',').filter(Boolean)){
  const name=entry.trim().split(';',1)[0];if(!allowed.has(name))continue;
  const m=/^\s*([a-z_]+)\s*;\s*dur=(\d+(?:\.\d+)?)\s*$/.exec(entry);
  check(m&&!Object.hasOwn(result,name),'invalid_or_duplicate_timing');
  const n=Number(m[2]);check(Number.isFinite(n)&&n<=150000,'invalid_timing_duration');result[name]=n;
 }return result;
}
function traceHeaders(headers){
 const out={};for(const name of ['x-eliza-trace-id','x-request-id','cf-ray']){
  const value=headers.get(name);if(value===null)continue;
  check(value.length<=128&&/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value),'invalid_trace_header');out[name]=value;
 }return out;
}
async function paid(path,init,attestation,max){
 check(receipt.paidRequests<2,'request_budget');receipt.paidRequests++;
 const started=performance.now();const res=await fetch(origin+path,{...init,redirect:'error',signal});const headersAt=performance.now();
 const row={route:path,status:res.status,headersMs:Math.round(headersAt-started),serverTiming:timing(res.headers.get('server-timing')),trace:traceHeaders(res.headers)};receipt.requests.push(row);
 check(res.ok,'http_refused');check(res.headers.get(attestation)==='cartesia','provider_mismatch');
 check(/^audio\/mpeg(?:;|$)/i.test(res.headers.get('content-type')??'')||path.endsWith('/stt'),'invalid_audio_content_type');
 const data=await bytes(res,max);row.bodyMs=Math.round(performance.now()-headersAt);row.totalMs=Math.round(performance.now()-started);return data;
}
try{
 const expected=process.env.EXPECTED_CLOUD_COMMIT;check(/^[a-f0-9]{40}$/.test(expected??''),'exact_commit_required');
 check(process.env.CARTESIA_CONFIG_COMMIT===expected,'existing_cartesia_configuration_not_confirmed');
 const key=process.env.ELIZAOS_CLOUD_API_KEY;check(typeof key==='string'&&key.length>=8&&!/[\r\n]/.test(key),'missing_runner_credential');
 const health=await fetch(origin+'/api/health',{redirect:'error',signal});check(health.ok,'health_refused');
 const identity=JSON.parse((await bytes(health,65536)).toString());check(identity.commit===expected&&identity.environment==='staging','deployment_mismatch');receipt.commit=expected;receipt.configurationAttested=true;
 const headers={Authorization:'Bearer '+key,'X-Eliza-Trace-Id':randomUUID()};
 // No voiceId/model override: the already configured staging voice must be used.
 const audio=await paid('/api/v1/voice/tts',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({text:phrase,format:'mp3'})},'x-eliza-tts-provider',2097152);
 check(audio.length>0,'empty_audio');
 const form=new FormData();form.append('audio',new Blob([audio],{type:'audio/mpeg'}),'probe.mp3');form.append('provider','cartesia');
 const result=JSON.parse((await paid('/api/v1/voice/stt',{method:'POST',headers:{...headers,'X-Eliza-Trace-Id':randomUUID()},body:form},'x-eliza-stt-provider',65536)).toString());
 const text=result.transcript??result.text;check(typeof text==='string','missing_transcript');
 const normalize=s=>s.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();receipt.transcriptMatch=normalize(text)===normalize(phrase);check(receipt.transcriptMatch,'transcript_mismatch');
 const postHealth=await fetch(origin+'/api/health',{redirect:'error',signal});check(postHealth.ok,'post_health_refused');
 const postIdentity=JSON.parse((await bytes(postHealth,65536)).toString());check(postIdentity.commit===expected&&postIdentity.environment==='staging','post_deployment_mismatch');receipt.postCommitVerified=true;receipt.success=true;
}catch(error){receipt.code=typeof error?.safeCode==='string'?error.safeCode:'request_failed';process.exitCode=1;}
check(process.env.RECEIPT_PATH,'receipt_path_required');await writeFile(process.env.RECEIPT_PATH,JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
