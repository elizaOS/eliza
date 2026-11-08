// Server-side device-key proof verification. Not WebAuthn and not a session issuer.
import {randomBytes,createHash,createPublicKey,verify as verifySignature} from 'node:crypto';
const DOMAIN='ValhallaOS/Web3Vault/device-proof/v1';
const digest=value=>createHash('sha256').update(value).digest('hex');
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const b64=(value,size)=>typeof value==='string'&&/^[A-Za-z0-9_-]+$/.test(value)&&value.length<=256&&Buffer.from(value,'base64url').length===size&&Buffer.from(value,'base64url').toString('base64url')===value;
async function bounded(fn,deadline){
  const remaining=deadline-Date.now();if(remaining<=0)throw Error('VAULT_AUTH_TIMEOUT');
  const controller=new AbortController();let timer;
  try{return await Promise.race([Promise.resolve().then(()=>fn(controller.signal)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('VAULT_AUTH_TIMEOUT')),remaining);})]);}finally{clearTimeout(timer);controller.abort();}
}
function signingBytes(record){return Buffer.from(JSON.stringify([DOMAIN,record.audience,record.scope,record.vaultId,record.credentialId,record.challengeId,record.nonce,record.keyHash,record.issuedAt,record.expiresAt]));}
export function createVaultDeviceAuth({audience,resolveContext,canUnlock,rateLimit,getCredential,challengeStore,ttlMs=60000,timeoutMs=5000,now=Date.now}={}){
  let parsed;try{parsed=new URL(audience);}catch{throw Error('VAULT_CONFIG_REQUIRED');}
  if(parsed.protocol!=='https:'||parsed.origin!==audience||[resolveContext,canUnlock,rateLimit,getCredential,now].some(fn=>typeof fn!=='function')||typeof challengeStore?.put!=='function'||typeof challengeStore?.take!=='function'||!Number.isInteger(ttlMs)||ttlMs<1000||ttlMs>120000||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw Error('VAULT_CONFIG_REQUIRED');
  async function scope(request,vaultId,operation,deadline){
    const context=await bounded(signal=>resolveContext(request,signal),deadline);
    if(!context||![context.tenantId,context.subject,context.sessionId].every(id)||!id(vaultId))throw Error('VAULT_DENIED');
    if((await bounded(signal=>rateLimit(context,operation,signal),deadline))!==true||(await bounded(signal=>canUnlock(context,vaultId,signal),deadline))!==true)throw Error('VAULT_DENIED');
    return {context,key:JSON.stringify([context.tenantId,context.subject,context.sessionId])};
  }
  async function credential(context,vaultId,credentialId,deadline){
    if(!id(credentialId))throw Error('VAULT_DENIED');
    const record=await bounded(signal=>getCredential(context,vaultId,credentialId,signal),deadline);
    if(!record||record.enabled!==true||record.id!==credentialId||record.tenantId!==context.tenantId||record.subject!==context.subject||record.vaultId!==vaultId||typeof record.publicKeyDer!=='string'||record.publicKeyDer.length>256)throw Error('VAULT_DENIED');
    const bytes=Buffer.from(record.publicKeyDer,'base64url');
    if(bytes.toString('base64url')!==record.publicKeyDer)throw Error('VAULT_DENIED');
    const key=createPublicKey({key:bytes,format:'der',type:'spki'});
    if(key.asymmetricKeyType!=='ed25519')throw Error('VAULT_DENIED');
    return {key,keyHash:digest(bytes)};
  }
  const storeKey=(scopeKey,challengeId)=>'v38:vault:challenge:'+digest(scopeKey)+':'+challengeId;
  return Object.freeze({
    async issue(request,vaultId,credentialId){
      const deadline=Date.now()+timeoutMs;
      try{
        const {context,key:scopeKey}=await scope(request,vaultId,'issue',deadline);
        const {keyHash}=await credential(context,vaultId,credentialId,deadline);
        const issuedAt=now();if(!Number.isSafeInteger(issuedAt))throw Error();
        const record={v:1,audience,scope:scopeKey,vaultId,credentialId,challengeId:randomBytes(32).toString('base64url'),nonce:randomBytes(32).toString('base64url'),keyHash,issuedAt,expiresAt:issuedAt+ttlMs};
        if((await bounded(signal=>challengeStore.put(storeKey(scopeKey,record.challengeId),JSON.stringify(record),ttlMs,signal),deadline))!==true)throw Error();
        return Object.freeze({challengeId:record.challengeId,audience,vaultId,credentialId,expiresAt:record.expiresAt,payload:signingBytes(record).toString('base64url')});
      }catch{throw Error('VAULT_CHALLENGE_UNAVAILABLE');}
    },
    async verify(request,vaultId,proof){
      const deadline=Date.now()+timeoutMs;
      try{
        if(!proof||!b64(proof.challengeId,32)||!b64(proof.signature,64))return {ok:false};
        const {context,key:scopeKey}=await scope(request,vaultId,'verify',deadline);
        const raw=await bounded(signal=>challengeStore.take(storeKey(scopeKey,proof.challengeId),signal),deadline);
        if(typeof raw!=='string'||Buffer.byteLength(raw)>4096)return {ok:false};
        const record=JSON.parse(raw),time=now();
        if(!Number.isSafeInteger(time)||record.v!==1||record.audience!==audience||record.scope!==scopeKey||record.vaultId!==vaultId||record.challengeId!==proof.challengeId||!id(record.credentialId)||!b64(record.nonce,32)||!Number.isSafeInteger(record.issuedAt)||!Number.isSafeInteger(record.expiresAt)||record.issuedAt>time||record.expiresAt<=time||record.expiresAt-record.issuedAt!==ttlMs)return {ok:false};
        const {key,keyHash}=await credential(context,vaultId,record.credentialId,deadline);
        if(record.keyHash!==keyHash||!verifySignature(null,signingBytes(record),key,Buffer.from(proof.signature,'base64url'))||Date.now()>=deadline)return {ok:false};
        return {ok:true,tenantId:context.tenantId,subject:context.subject,sessionId:context.sessionId,vaultId,credentialId:record.credentialId};
      }catch{return {ok:false};}
    }
  });
}
export function createRedisChallengeStore({url,token,fetcher=globalThis.fetch,timeoutMs=5000}={}){
  let origin;try{const u=new URL(url);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.pathname!=='/')throw Error();origin=u.origin;}catch{throw Error('REDIS_CONFIG_REQUIRED');}
  if(typeof token!=='string'||!token||typeof fetcher!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw Error('REDIS_CONFIG_REQUIRED');
  async function command(parts,signal){
    return bounded(async inner=>{
      if(signal?.aborted)throw Error('REDIS_UNAVAILABLE');
      const abort=()=>innerController.abort();
      const innerController=new AbortController();
      const stop=()=>innerController.abort();inner.addEventListener('abort',stop,{once:true});signal?.addEventListener('abort',abort,{once:true});
      try{
        const response=await fetcher(origin,{method:'POST',redirect:'error',cache:'no-store',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(parts),signal:innerController.signal});
        if(!response.ok)throw Error();
        if(!response.body)throw Error();
        const reader=response.body.getReader(),chunks=[];let size=0;
        try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>16384){await reader.cancel();throw Error();}chunks.push(value);}}finally{reader.releaseLock();}
        const bytes=Buffer.concat(chunks.map(part=>Buffer.from(part)));
        const body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(body.error||!Object.hasOwn(body,'result'))throw Error();return body.result;
      }finally{inner.removeEventListener('abort',stop);signal?.removeEventListener('abort',abort);}
    },Date.now()+timeoutMs).catch(()=>{throw Error('REDIS_UNAVAILABLE');});
  }
  const validKey=key=>typeof key==='string'&&/^v38:vault:challenge:[a-f0-9]{64}:[A-Za-z0-9_-]{43}$/.test(key);
  return Object.freeze({
    async put(key,value,ttl,signal){if(!validKey(key)||typeof value!=='string'||Buffer.byteLength(value)>4096||!Number.isInteger(ttl)||ttl<1000||ttl>120000)throw Error('REDIS_INPUT_INVALID');return (await command(['SET',key,value,'PX',String(ttl),'NX'],signal))==='OK';},
    async take(key,signal){if(!validKey(key))throw Error('REDIS_INPUT_INVALID');const result=await command(['EVAL',"local v = redis.call('GET', KEYS[1]); if v then redis.call('DEL', KEYS[1]) end; return v",'1',key],signal);if(result!==null&&typeof result!=='string')throw Error('REDIS_UNAVAILABLE');return result;}
  });
}
