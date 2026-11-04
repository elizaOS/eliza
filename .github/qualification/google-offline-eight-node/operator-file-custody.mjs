// Linux trusted-operator bounded FD reads and no-follow directory custody. Candidate modules never evaluated.
import fs from "node:fs";import path from "node:path";import crypto from "node:crypto";
const F=fs.constants;
const inode=s=>[s.dev,s.ino,s.mode].map(String).join(":");
const identity=s=>[s.dev,s.ino,s.mode,s.size,s.mtimeNs,s.ctimeNs].map(String).join(":");
function closeAll(fds){let first;for(const fd of [...fds].reverse())try{fs.closeSync(fd);}catch(error){first??=error;}if(first)throw first;}
function components(filename){if(process.platform!=="linux"||filename.length>4096||!path.isAbsolute(filename)||filename.includes("\0")||filename.split("/").some(p=>p===".."||p==="."))throw Error("Invalid admitted source path");const parts=filename.split("/").filter(Boolean);if(parts.length>128)throw Error("Source path component bound");return parts;}
function directoryChain(parts){
 const fds=[],links=[];
 try{
  let parent=fs.openSync("/",F.O_RDONLY|F.O_DIRECTORY|F.O_NOFOLLOW|F.O_NONBLOCK);fds.push(parent);
  for(const component of parts){
   const lookup="/proc/self/fd/"+parent+"/"+component,before=fs.lstatSync(lookup,{bigint:true});
   if(!before.isDirectory()||before.isSymbolicLink())throw Error("Source ancestor is not a regular directory");
   const child=fs.openSync(lookup,F.O_RDONLY|F.O_DIRECTORY|F.O_NOFOLLOW|F.O_NONBLOCK);fds.push(child);const actual=fs.fstatSync(child,{bigint:true});
   if(!actual.isDirectory()||inode(actual)!==inode(before))throw Error("Source ancestor changed while opening");
   links.push({lookup,fd:child,inode:inode(actual)});parent=child;
  }
  return{fd:parent,assertStable(){for(const link of links){const current=fs.lstatSync(link.lookup,{bigint:true});if(!current.isDirectory()||current.isSymbolicLink()||inode(current)!==link.inode||inode(fs.fstatSync(link.fd,{bigint:true}))!==link.inode)throw Error("Source ancestor link changed");}},close(){closeAll(fds);}};
 }catch(error){closeAll(fds);throw error;}
}
function readAt(parent,name,maxBytes){
 if(!name||name==="."||name===".."||name.includes("/")||name.includes("\0")||!Number.isSafeInteger(maxBytes)||maxBytes<0||maxBytes>67108864)throw Error("Invalid bounded file component/budget");
 const lookup="/proc/self/fd/"+parent+"/"+name,pathBefore=fs.lstatSync(lookup,{bigint:true});if(!pathBefore.isFile()||pathBefore.isSymbolicLink())throw Error("Nonregular source file");
 let fd;
 try{
  fd=fs.openSync(lookup,F.O_RDONLY|F.O_NOFOLLOW|F.O_NONBLOCK);const before=fs.fstatSync(fd,{bigint:true});
  if(!before.isFile()||inode(before)!==inode(pathBefore)||before.size>BigInt(maxBytes))throw Error("Changed or oversized source file");
  const chunk=Buffer.allocUnsafe(Math.min(65536,maxBytes+1)),chunks=[];let total=0;
  while(total<=maxBytes){const read=fs.readSync(fd,chunk,0,Math.min(chunk.length,maxBytes+1-total),null);if(!read)break;total+=read;if(total>maxBytes)throw Error("Source grew past byte bound");chunks.push(Buffer.from(chunk.subarray(0,read)));}
  const after=fs.fstatSync(fd,{bigint:true}),pathAfter=fs.lstatSync(lookup,{bigint:true});
  if(identity(before)!==identity(after)||identity(pathAfter)!==identity(after)||BigInt(total)!==after.size)throw Error("Source changed while reading");
  return{bytes:Buffer.concat(chunks,total),mode:Number(after.mode&0o7777n)};
 }finally{if(fd!==undefined)fs.closeSync(fd);}
}
export function readBoundedSourceFile(filename,maxBytes=8388608){
 const parts=components(filename);if(!parts.length)throw Error("Source path must name a file");const chain=directoryChain(parts.slice(0,-1));
 try{const result=readAt(chain.fd,parts.at(-1),maxBytes);chain.assertStable();return result.bytes;}finally{chain.close();}
}
export function sha256SourceFile(filename,maxBytes=8388608){return crypto.createHash("sha256").update(readBoundedSourceFile(filename,maxBytes)).digest("hex");}
export function inventoryRegularSourceFiles(root){
 const chain=directoryChain(components(root)),files=Object.create(null),modes=Object.create(null);let totalBytes=0,fileCount=0,entryCount=0;
 function visit(fd,relative,depth){
  if(depth>64)throw Error("Projection directory depth bound");const before=fs.fstatSync(fd,{bigint:true});let iterator;
  try{
   iterator=fs.opendirSync("/proc/self/fd/"+fd);let entry;
   while((entry=iterator.readSync())){
    if(++entryCount>20000)throw Error("Projection directory entry bound");const name=relative?relative+"/"+entry.name:entry.name,lookup="/proc/self/fd/"+fd+"/"+entry.name;
    const old=fs.lstatSync(lookup,{bigint:true});if(old.isSymbolicLink())throw Error("Projection symlink");
    if(old.isDirectory()){
     let child;try{child=fs.openSync(lookup,F.O_RDONLY|F.O_DIRECTORY|F.O_NOFOLLOW|F.O_NONBLOCK);const opened=fs.fstatSync(child,{bigint:true});if(inode(opened)!==inode(old))throw Error("Projection directory changed");visit(child,name,depth+1);if(inode(fs.lstatSync(lookup,{bigint:true}))!==inode(opened))throw Error("Projection directory link changed");}finally{if(child!==undefined)fs.closeSync(child);}
    }else{
     if(!old.isFile())throw Error("Projection nonregular leaf");if(name===".source.json")continue;
     const result=readAt(fd,entry.name,8388608);totalBytes+=result.bytes.length;if(++fileCount>10000||totalBytes>67108864)throw Error("Projection inventory resource bound");files[name]=crypto.createHash("sha256").update(result.bytes).digest("hex");modes[name]=result.mode;
    }
   }
   if(identity(before)!==identity(fs.fstatSync(fd,{bigint:true})))throw Error("Projection directory changed during inventory");
  }finally{if(iterator)iterator.closeSync();}
 }
 try{visit(chain.fd,"",0);chain.assertStable();return{files,modes,totalBytes,fileCount,entryCount};}finally{chain.close();}
}
