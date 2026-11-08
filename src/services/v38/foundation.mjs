import { createHash, randomUUID, verify } from 'node:crypto';
export class RoutingError extends Error { constructor(code) { super(code); this.code = code; } }
const ORDERS = {CHAT:['ollama','workers-ai','groq','deepseek'],TRIAGE:['ollama','workers-ai','groq','deepseek'],EXTRACTION:['ollama','workers-ai','groq','deepseek'],REASONING:['ollama','deepseek','workers-ai','groq'],SEARCH:['sonar']};
function valid(result, grounding) {
  if (!result || typeof result.content !== 'string' || !result.content.trim()) return false;
  if (!grounding) return true;
  return result.grounded === true && Array.isArray(result.sources) && result.sources.length > 0
    && result.sources.every(source => { try { const u = new URL(source.url); return u.protocol === 'https:' && !u.username && !u.password; } catch { return false; } });
}
export class ModelStackRouter {
  constructor({providers=[],authorize,validate,cache,timeoutMs=15000,cacheTtlMs=30000}={}) {
    if(typeof authorize!=='function'||typeof validate!=='function')throw new RoutingError('POLICY_REQUIRED');
    this.providers=new Map(providers.map(p=>[p.id,p]));
    Object.assign(this,{authorize,validate,cache,timeoutMs,cacheTtlMs});
  }
  async execute(prompt,type,context) {
    if(typeof prompt!=='string'||!prompt.trim()||Buffer.byteLength(prompt)>65536||typeof type!=='string'||!Object.hasOwn(ORDERS,type))throw new RoutingError('INVALID_TASK');
    if(!context||typeof context.scopeKey!=='string'||!context.scopeKey||!['local-only','cloud-allowed'].includes(context.privacy)||(await this.authorize(context))!==true)throw new RoutingError('SCOPE_DENIED');
    const grounding=type==='SEARCH'||context.requireGrounding===true;
    const key=createHash('sha256').update(JSON.stringify([context.scopeKey,context.privacy,context.memoryVersion||'0',context.conversationVersion||'0',type,grounding,prompt])).digest('hex');
    if(this.cache){try{const cached=await this.cache.get(key);if(cached&&cached.expiresAt>Date.now()&&valid(cached.result,grounding)&&(await this.validate(cached.result,{context,type,cached:true}))===true)return {...cached.result,cached:true};}catch{}}
    const deadline=Date.now()+this.timeoutMs;
    for(const id of ORDERS[type]) {
      const provider=this.providers.get(id);
      if(!provider||!provider.tasks?.includes(type)||(context.privacy==='local-only'&&provider.locality!=='local')||(grounding&&provider.grounding!==true))continue;
      if(provider.locality!=='local'&&provider.metered!==false&&context.allowMetered!==true)continue;
      const remaining=deadline-Date.now();if(remaining<=0)break;
      const controller=new AbortController();let timer;
      try {
        const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new RoutingError('ROUTE_TIMEOUT'));},remaining);});
        const result=await Promise.race([provider.run({prompt,type,context,signal:controller.signal,maxOutputTokens:512}),timeout]);
        if(!valid(result,grounding)||(await this.validate(result,{context,type,cached:false}))!==true)continue;
        const accepted={...result,provider:id,grounded:result.grounded===true,cached:false};
        if(this.cache){try{await this.cache.set(key,{expiresAt:Date.now()+this.cacheTtlMs,result:accepted});}catch{accepted.cacheWriteFailed=true;}}
        return accepted;
      } catch {} finally {clearTimeout(timer);}
    }
    throw new RoutingError(grounding?'GROUNDED_PROVIDER_UNAVAILABLE':'MODEL_STACK_EXHAUSTED');
  }
  async routePrompt(prompt,options={}) {const r=await this.execute(prompt,options.taskType||'CHAT',options.context);return {content:r.content,provider:r.provider};}
  async routeAndExecute(prompt,taskType,options={}) {const r=await this.execute(prompt,taskType,options.context);return {output:r.content,tier:r.provider,citations:r.sources?.map(x=>x.url),grounded:r.grounded};}
}
const TYPES=new Set(['DEEP_SCRAPE','DOM_PARSE','VECTOR_EMBED']);
export function resultSigningBytes(frame) {return Buffer.from(JSON.stringify([frame.v,frame.nodeId,frame.taskId,frame.attemptId,frame.scopeKey,frame.taskType,frame.inputHash,frame.issuedAt,frame.expiresAt,frame.data,frame.sources]));}
export class ZeusOrchestrator {
  constructor({authorizeNode,canDispatch,validateProvenance,onQuarantine=()=>{},timeoutMs=15000,maxFrameBytes=1048576}={}) {
    if([authorizeNode,canDispatch,validateProvenance].some(fn=>typeof fn!=='function'))throw new Error('POLICY_REQUIRED');
    Object.assign(this,{authorizeNode,canDispatch,validateProvenance,onQuarantine,timeoutMs,maxFrameBytes});this.workers=new Map();this.pending=new Map();
  }
  async registerWorker(record,transport) {
    if(!record||!/^[A-Za-z0-9_-]{1,64}$/.test(record.id)||!record.publicKey||!Array.isArray(record.capabilities)||(await this.authorizeNode(record))!==true)throw new Error('NODE_DENIED');
    if(this.workers.has(record.id)||typeof transport.addEventListener!=='function'||typeof transport.removeEventListener!=='function'||typeof transport.send!=='function')throw new Error('INVALID_TRANSPORT');
    const worker={...record,transport,busy:false,quarantined:false,failures:0};
    worker.message=event=>{void this.receive(worker,event.data);};
    worker.close=()=>{for(const [id,p] of this.pending)if(p.worker===worker)this.finish(id,new Error('WORKER_DISCONNECTED'));worker.busy=false;worker.quarantined=true;};
    transport.addEventListener('message',worker.message);transport.addEventListener('close',worker.close);this.workers.set(worker.id,worker);
  }
  failure(worker) {
    worker.failures++;
    if(worker.failures>=3&&!worker.quarantined){worker.quarantined=true;for(const [id,p] of this.pending)if(p.worker===worker)this.finish(id,new Error('WORKER_QUARANTINED'));Promise.resolve().then(()=>this.onQuarantine({nodeId:worker.id,reason:'three consecutive failures'})).catch(()=>{});}
  }
  finish(attemptId,error,value) {const p=this.pending.get(attemptId);if(!p)return;clearTimeout(p.timer);this.pending.delete(attemptId);p.worker.busy=false;if(error)p.reject(error);else p.resolve(value);}
  async dispatchTask(task) {
    if(!task||typeof task.id!=='string'||!task.id||!TYPES.has(task.type)||typeof task.payload!=='string'||typeof task.scopeKey!=='string'||!task.scopeKey||Buffer.byteLength(task.payload)>65536)throw new Error('INVALID_TASK');
    let worker;
    for(const candidate of this.workers.values())if(!candidate.busy&&!candidate.quarantined&&candidate.transport.readyState===1&&candidate.capabilities.includes(task.type)&&(await this.canDispatch(candidate,task))===true){worker=candidate;break;}
    if(!worker||worker.busy||worker.quarantined)throw new Error('NO_ELIGIBLE_WORKER');
    worker.busy=true;const attemptId=randomUUID(),now=Date.now();
    const assignment={v:1,taskId:task.id,attemptId,nodeId:worker.id,taskType:task.type,scopeKey:task.scopeKey,payload:task.payload,inputHash:createHash('sha256').update(task.payload).digest('hex'),issuedAt:now,expiresAt:now+this.timeoutMs};
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.finish(attemptId,new Error('WORKER_TIMEOUT'));this.failure(worker);},this.timeoutMs);this.pending.set(attemptId,{worker,task,assignment,resolve,reject,timer});try{worker.transport.send(JSON.stringify(assignment));}catch{this.finish(attemptId,new Error('WORKER_SEND_FAILED'));this.failure(worker);}});
  }
  async receive(worker,raw) {
    let frame,p;
    try {
      if(typeof raw!=='string'||Buffer.byteLength(raw)>this.maxFrameBytes)throw new Error();frame=JSON.parse(raw);
      if(!frame||typeof frame.attemptId!=='string')throw new Error();p=this.pending.get(frame.attemptId);if(!p)return;
      if(p.worker!==worker)throw new Error();if(p.processing)return;p.processing=true;
      const a=p.assignment,now=Date.now();
      if(frame.v!==1||frame.nodeId!==worker.id||frame.taskId!==a.taskId||frame.scopeKey!==a.scopeKey||frame.taskType!==a.taskType||frame.inputHash!==a.inputHash||typeof frame.signature!=='string'||!/^[A-Za-z0-9_-]{86}$/.test(frame.signature)||!Number.isFinite(frame.issuedAt)||!Number.isFinite(frame.expiresAt)||frame.issuedAt<a.issuedAt-30000||frame.issuedAt>now+30000||frame.expiresAt<=now||frame.expiresAt>a.expiresAt||frame.issuedAt>frame.expiresAt)throw new Error();
      if(worker.publicKey.asymmetricKeyType!=='ed25519'||!verify(null,resultSigningBytes(frame),worker.publicKey,Buffer.from(frame.signature,'base64url')))throw new Error();
      if(frame.taskType==='VECTOR_EMBED'){if(!Array.isArray(frame.data)||!frame.data.length||frame.data.length>65536||!frame.data.every(Number.isFinite)||(p.task.dimensions&&frame.data.length!==p.task.dimensions))throw new Error();}
      else if(typeof frame.data!=='string'||!frame.data.trim()||!Array.isArray(frame.sources)||!frame.sources.length)throw new Error();
      if((await this.validateProvenance(frame,p.task))!==true)throw new Error();if(this.pending.get(frame.attemptId)!==p)return;
      worker.failures=0;this.finish(frame.attemptId,null,{data:frame.data,sources:frame.sources,nodeId:worker.id,attemptId:frame.attemptId});
    } catch {if(p&&p.worker===worker)this.finish(frame.attemptId,new Error('VALIDATION_FAILED'));this.failure(worker);}
  }
  close() {for(const [id] of this.pending)this.finish(id,new Error('ORCHESTRATOR_STOPPED'));for(const worker of this.workers.values()){worker.transport.removeEventListener('message',worker.message);worker.transport.removeEventListener('close',worker.close);}this.workers.clear();}
}
