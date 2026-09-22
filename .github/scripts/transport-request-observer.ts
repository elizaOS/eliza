/** Record local test request completion and explicit body reads without consuming a response. */
import {appendFileSync} from 'node:fs';
const target=`${process.env.RUNNER_TEMP}/transport-observation/requests.jsonl`;
let next=0;
function record(event:string,fields:Record<string,unknown>){appendFileSync(target,JSON.stringify({event,pid:process.pid,at:new Date().toISOString(),...fields})+'\n');}
const originalFetch=globalThis.fetch;
globalThis.fetch=Object.assign(async (...args:Parameters<typeof fetch>)=>{
 const input=args[0];const url=new URL(input instanceof Request?input.url:String(input));
 if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))return originalFetch(...args);
 const method=args[1]?.method??(input instanceof Request?input.method:'GET');const id=++next;const start=performance.now();
 record('start',{id,method,path:url.pathname});
 let response:Response;
 try{response=await originalFetch(...args);}catch(error){record('fetch-error',{id,durationMs:performance.now()-start,error:error instanceof Error?error.message:String(error)});throw error;}
 record('headers',{id,status:response.status,durationMs:performance.now()-start,headers:Object.fromEntries(['content-type','server','date','x-eliza-trace-id','x-request-id','server-timing'].flatMap(name=>{const value=response.headers.get(name);return value===null?[]:[[name,value]];}))});
 for(const name of ['text','json','arrayBuffer','blob','formData'] as const){const original=response[name].bind(response);Object.defineProperty(response,name,{configurable:true,value:async()=>{record('body-read-start',{id,method:name});try{const value=await original();record('body-read-end',{id,method:name});return value;}catch(error){record('body-read-error',{id,method:name});throw error;}}});}
 return response;
},originalFetch);
