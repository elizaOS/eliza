/** Source/dependency-independent ignored-write custody; reads files, never imports SDK. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const mode=process.argv[2];if(!['before','verify'].includes(mode))throw new Error('Unknown custody mode');
const graph=JSON.parse(fs.readFileSync('/results/EXPECTED-GRAPH.json','utf8'));
const roots=Object.values(graph.nodes).filter(x=>x.script).map(x=>x.path+'/dist');
const allowed=[...roots,'.turbo',...Object.values(graph.nodes).map(x=>x.path+'/.turbo')];
const exclude=p=>p.split('/').some(x=>x==='.git'||x==='node_modules')||allowed.some(x=>p===x||p.startsWith(x+'/'));
let bytes=0;const records=[];
function walk(dir){
 for(const e of fs.readdirSync('/workspace/'+dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
  const p=path.posix.join(dir,e.name);if(exclude(p))continue;
  const f='/workspace/'+p,s=fs.lstatSync(f);let row={path:p,mode:s.mode&0o7777};
  if(s.isSymbolicLink()){row.type='link';row.target=fs.readlinkSync(f);}
  else if(s.isDirectory()){row.type='directory';}
  else if(s.isFile()){
   bytes+=s.size;if(bytes>34359738368)throw new Error('Workspace custody byte cap');
   const fd=fs.openSync(f,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),h=createHash('sha256'),b=Buffer.alloc(1048576);let n;
   try{while((n=fs.readSync(fd,b,0,b.length,null)))h.update(b.subarray(0,n));const end=fs.fstatSync(fd);if(end.dev!==s.dev||end.ino!==s.ino||end.size!==s.size||end.mtimeMs!==s.mtimeMs)throw new Error('Workspace custody race');}finally{fs.closeSync(fd);}
   row.type='file';row.bytes=s.size;row.sha256=h.digest('hex');
  }else throw new Error('Special workspace entry');
  records.push(row);if(records.length>100000)throw new Error('Workspace custody entry cap');
  if(s.isDirectory())walk(p);
 }
}
walk('');records.sort((a,b)=>a.path.localeCompare(b.path));
const encoded=JSON.stringify(records);if(Buffer.byteLength(encoded)>16777216)throw new Error('Workspace custody metadata cap');
const digest=createHash('sha256').update(encoded).digest('hex');
if(mode==='before')fs.writeFileSync('/results/WORKSPACE-WRITE-BASELINE.json',JSON.stringify({sourceCommit:graph.source,excludedGeneratedRoots:allowed,installedDependencies:'Separate complete immutable dependency census',bytes,records,sha256:digest})+'\n',{flag:'wx'});
else{
 const before=JSON.parse(fs.readFileSync('/results/WORKSPACE-WRITE-BASELINE.json','utf8'));
 if(before.sourceCommit!==graph.source||before.sha256!==digest||JSON.stringify(before.records)!==encoded)throw new Error('Undeclared retained workspace write/deletion/mode change outside normal generated roots');
 fs.writeFileSync('/results/WORKSPACE-WRITE-VERIFIED.json',JSON.stringify({sourceCommit:graph.source,sha256:digest,bytes,entries:records.length,undeclaredRetainedWrites:0,transientWritesNotObserved:true})+'\n');
}
console.log(JSON.stringify({mode,sourceCommit:graph.source,entries:records.length,bytes,sha256:digest}));
