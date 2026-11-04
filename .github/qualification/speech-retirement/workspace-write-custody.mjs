/** Stream retained-workspace custody; never import SDK or retain the full record array. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const mode=process.argv[2];if(!['before','verify'].includes(mode))throw new Error('Unknown custody mode');
const graph=JSON.parse(fs.readFileSync('/results/EXPECTED-GRAPH.json','utf8'));
const budget=JSON.parse(fs.readFileSync('/results/TEST-RESOURCE-POLICY.json','utf8')).workspaceInventory;
for(const key of ['maxEntries','maxFileBytes','maxDirectoryEntries','maxDepth','maxRecordBytes','maxReceiptBytes','phaseSeconds'])if(!Number.isSafeInteger(budget?.[key])||budget[key]<=0)throw new Error('Missing reviewed workspace inventory budget');
const roots=Object.values(graph.nodes).filter(x=>x.script).map(x=>x.path+'/dist');
const allowed=[...roots,'.turbo',...Object.values(graph.nodes).map(x=>x.path+'/.turbo')];
const excluded=p=>p.split('/').some(x=>x==='.git'||x==='node_modules')||allowed.some(x=>p===x||p.startsWith(x+'/'));
const fileChunk=Buffer.alloc(1048576);
const digest=createHash('sha256'),entryTypes={file:0,directory:0,link:0},topCounts={};
let bytes=0,entries=0,lastPath=null;
function failure(message){throw new Error(message+' '+JSON.stringify({entries,bytes,lastPath,topCounts}));}
function record(row){
 lastPath=row.path;entries++;if(entries>budget.maxEntries)failure('Workspace inventory entry bound');
 const encoded=JSON.stringify(row)+'\n';if(Buffer.byteLength(encoded)>budget.maxRecordBytes)failure('Workspace record byte bound');
 digest.update(encoded);entryTypes[row.type]++;const top=row.path.split('/')[0];topCounts[top]=(topCounts[top]??0)+1;
}
function walk(dir,depth){
 if(depth>budget.maxDepth)failure('Workspace depth bound');
 const children=fs.readdirSync('/workspace/'+dir,{withFileTypes:true});
 if(children.length>budget.maxDirectoryEntries)failure('Workspace single-directory bound');
 children.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
 for(const e of children){
  const p=path.posix.join(dir,e.name);if(excluded(p))continue;
  lastPath=p;const f='/workspace/'+p,s=fs.lstatSync(f),row={path:p,mode:s.mode&0o7777};
  if(s.isSymbolicLink()){row.type='link';row.target=fs.readlinkSync(f);}
  else if(s.isDirectory()){row.type='directory';}
  else if(s.isFile()){
   bytes+=s.size;if(bytes>budget.maxFileBytes)failure('Workspace file byte bound');
   const fd=fs.openSync(f,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),h=createHash('sha256'),chunk=fileChunk;let n;
   try{
    const opened=fs.fstatSync(fd);if(opened.dev!==s.dev||opened.ino!==s.ino||opened.size!==s.size||opened.mtimeMs!==s.mtimeMs)failure('Workspace open race');
    while((n=fs.readSync(fd,chunk,0,chunk.length,null)))h.update(chunk.subarray(0,n));
    const end=fs.fstatSync(fd);if(end.dev!==s.dev||end.ino!==s.ino||end.size!==s.size||end.mtimeMs!==s.mtimeMs)failure('Workspace read race');
   }finally{fs.closeSync(fd);}
   row.type='file';row.bytes=s.size;row.sha256=h.digest('hex');
  }else failure('Special workspace entry');
  record(row);if(s.isDirectory())walk(p,depth+1);
 }
}
walk('',0);
const value=digest.digest('hex'),format='sorted-depth-first-NDJSON-records-sha256-v1';
const result={sourceCommit:graph.source,format,sha256:value,entries,bytes,entryTypes,topCounts,excludedGeneratedRoots:allowed,installedDependencies:'Separate complete immutable dependency census',fullRecordArrayRetained:false,reviewedBudget:budget};
const baseline='/results/WORKSPACE-WRITE-BASELINE.json';
if(mode==='before'){
 const text=JSON.stringify(result)+'\n';if(Buffer.byteLength(text)>budget.maxReceiptBytes)failure('Workspace receipt byte bound');
 fs.writeFileSync(baseline,text,{flag:'wx'});
}else{
 if(!fs.lstatSync(baseline).isFile()||fs.lstatSync(baseline).isSymbolicLink()||fs.statSync(baseline).size>budget.maxReceiptBytes)failure('Wrong baseline metadata');
 const before=JSON.parse(fs.readFileSync(baseline,'utf8'));
 for(const key of ['sourceCommit','format','sha256','entries','bytes','entryTypes','topCounts','excludedGeneratedRoots','reviewedBudget'])if(JSON.stringify(before[key])!==JSON.stringify(result[key]))failure('Undeclared retained workspace drift at '+key);
 const text=JSON.stringify({...result,undeclaredRetainedWrites:0,transientWritesNotObserved:true})+'\n';if(Buffer.byteLength(text)>budget.maxReceiptBytes)failure('Workspace verify receipt byte bound');
 fs.writeFileSync('/results/WORKSPACE-WRITE-VERIFIED.json',text);
}
console.log(JSON.stringify({mode,sourceCommit:graph.source,entries,bytes,sha256:value,entryTypes,topCounts}));
