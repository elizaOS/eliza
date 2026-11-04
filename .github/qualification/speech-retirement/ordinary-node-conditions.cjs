/** Passive Node/fork metadata only. Never imports SDK/tests or mutates conditions. */
'use strict';
const fs=require('node:fs');
try {
  const phase=process.env.ORDINAL_DIAGNOSTIC_PHASE;
  if(typeof phase!=='string'||!/^owning-[0-2]$/.test(phase))throw Error('Unknown diagnostic phase');
  const dir='/results';
  const names=fs.readdirSync(dir).filter(name=>/^NODE-CONDITIONS-owning-[0-2]-[0-9]+\.json$/.test(name));
  if(names.length>=64)throw Error('Node metadata count bound');
  const args=process.execArgv;
  if(args.length>64||args.some(value=>typeof value!=='string'||value.length>1024))throw Error('Node arg bound');
  const conditions=[];
  for(let i=0;i<args.length;i++){
    if(args[i].startsWith('--conditions='))conditions.push(args[i].slice(13));
    else if(args[i]==='--conditions'||args[i]==='-C')conditions.push(args[i+1]??null);
  }
  const env={};
  for(const name of ['NODE_OPTIONS','VITEST_WORKER_ID','VITEST_POOL_ID','VITEST_MODE']){
    const value=process.env[name];env[name]=value===undefined?null:value.length<=1024?value:{overBound:true,length:value.length};
  }
  const data={state:'OBSERVED_NODE_PROCESS_ARGUMENTS_NOT_VITE_RESOLVER_OR_ASSERTION_PASS',phase,pid:process.pid,ppid:process.ppid,node:process.versions.node,cwd:process.cwd(),entrypoint:process.argv[1]??null,execArgv:args,nodeExplicitConditions:conditions,selectedEnv:env,SDKOrTestImportedByObserver:false};
  const text=JSON.stringify(data)+'\n';
  if(Buffer.byteLength(text)>8192)throw Error('Node metadata byte bound');
  fs.writeFileSync(`${dir}/NODE-CONDITIONS-${phase}-${process.pid}.json`,text,{flag:'wx',mode:0o600});
}catch(error){
  // Observation failure is visible but must not replace the ordinary CLI outcome.
  try{process.stderr.write(`[ORDINAL_NODE_METADATA_UNAVAILABLE] ${String(error?.message??error).slice(0,256)}\n`);}catch{}
}
