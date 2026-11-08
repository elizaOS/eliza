// Experimental linguistic transform only. NOT a KDF, credential, or signature.
export const POLYGLOT_SECURITY_NOTICE='Non-secret inputs only; never grants authentication or vault access.';
const MODEL='qwen3.8:27b',ENDPOINT='http://127.0.0.1:11434/api/chat';
async function readJSON(response){
  if(!response.ok||!response.body)throw Error('POLYGLOT_SERVICE_UNAVAILABLE');
  const reader=response.body.getReader(),parts=[];let size=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>16384){await reader.cancel();throw Error('POLYGLOT_RESPONSE_LIMIT');}parts.push(value);}}finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw Error('POLYGLOT_INVALID_JSON');}
}
async function bounded(fn,deadline){
  const remaining=deadline-Date.now();if(remaining<=0)throw Error('POLYGLOT_TIMEOUT');
  const controller=new AbortController();let timer;
  try{return await Promise.race([Promise.resolve().then(()=>fn(controller.signal)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('POLYGLOT_TIMEOUT')),remaining);})]);}finally{clearTimeout(timer);controller.abort();}
}
function matrix(raw,pattern){
  if(typeof raw!=='string')throw Error('POLYGLOT_INVALID_OUTPUT');
  let words;try{words=JSON.parse(raw);}catch{throw Error('POLYGLOT_INVALID_OUTPUT');}
  if(!Array.isArray(words)||words.length!==9||words.some(word=>typeof word!=='string'||word.length>64||!pattern.test(word))||new Set(words.map(word=>word.normalize('NFKC').toLowerCase())).size!==9)throw Error('POLYGLOT_INVALID_OUTPUT');
  return words;
}
export async function generatePolyglotSignature(seedWords,options={}){
  if(options.enabled!==true||options.inputIsPublic!==true)throw Error('POLYGLOT_EXPERIMENT_DISABLED');
  if(!Array.isArray(seedWords)||seedWords.length!==3||seedWords.some(word=>typeof word!=='string'||! /^[A-Za-z]{1,32}$/.test(word)))throw Error('POLYGLOT_INVALID_INPUT');
  const timeoutMs=options.timeoutMs??30000;if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000)throw Error('POLYGLOT_INVALID_TIMEOUT');
  const fetcher=options.fetcher??globalThis.fetch,deadline=Date.now()+timeoutMs;
  const stages=[
    ['Translate these three PUBLIC English words into nine distinct Cantonese concepts. Return only a JSON array of exactly nine strings; no explanations.',/^[\p{Script=Han}]+$/u],
    ['Translate these nine concepts into nine distinct Greek concepts. Return only a JSON array of exactly nine strings; no explanations.',/^[\p{Script=Greek}\p{M}]+$/u],
    ['Translate these nine Greek concepts into nine distinct English words. Return only a JSON array of exactly nine strings; no explanations.',/^[A-Za-z][A-Za-z-]{0,63}$/]
  ];
  let prompt=JSON.stringify(seedWords);
  for(const [system,pattern] of stages){
    let body;try{body=await bounded(async signal=>readJSON(await fetcher(ENDPOINT,{method:'POST',redirect:'error',cache:'no-store',headers:{'content-type':'application/json'},body:JSON.stringify({model:MODEL,stream:false,format:{type:'array',items:{type:'string'},minItems:9,maxItems:9},options:{temperature:0.1,seed:0,num_predict:256},messages:[{role:'system',content:system},{role:'user',content:prompt}]}),signal})),deadline);}catch(error){if(error.message==='POLYGLOT_TIMEOUT')throw error;throw Error('POLYGLOT_STAGE_FAILED');}
    if(body?.done!==true)throw Error('POLYGLOT_INCOMPLETE_OUTPUT');
    prompt=JSON.stringify(matrix(body.message?.content,pattern));
  }
  return Object.freeze(JSON.parse(prompt));
}
