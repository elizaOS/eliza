import {readBoundedSourceFile,inventoryRegularSourceFiles} from "./operator-file-custody.mjs";
// Trusted admitted-job verifier: Git raw identities, exact producer stamp and full no-symlink projection inventory.
import fs from "node:fs";import path from "node:path";import crypto from "node:crypto";import {execFileSync} from "node:child_process";
const phase=process.argv[2];if(!["baseline","post"].includes(phase))throw Error("Projection phase must be controller-bound baseline or post");
const policy=JSON.parse(readBoundedSourceFile("/operator/PROJECTION-INPUTS.json").toString()),sdk="/workspace/sdk",alpha="/workspace/alpha",root=alpha+"/.eliza/client-features";
const sha=bytes=>crypto.createHash("sha256").update(bytes).digest("hex");
const readBounded=readBoundedSourceFile;
const git=args=>execFileSync("/usr/bin/git",["--literal-pathspecs","-C",sdk,...args],{timeout:20000,maxBuffer:67108864});
if(git(["rev-parse","HEAD"]).toString().trim()!==policy.SDK)throw Error("Actual raw SDK pin mismatch");
const requested=[...policy.canonicalRawPaths,...policy.additionalReadPaths];if(new Set(requested).size!==364||policy.canonicalRawPaths.length!==339)throw Error("Incomplete source-input set");
const entries=new Map();for(const line of git(["ls-tree","-r","-z",policy.SDK,"--",...requested]).toString().split("\0")){
 if(!line)continue;const match=line.match(/^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/);if(!match)throw Error("Nonregular source-input tree entry");entries.set(match[3],{mode:match[1],oid:match[2]});
}
if(entries.size!==requested.length||requested.some(name=>!entries.has(name)))throw Error("Actual source-input tree mismatch");
const ordered=[...entries.keys()].sort(),request="/results/raw-input-request-"+phase+".txt";
fs.writeFileSync(request,ordered.map(name=>entries.get(name).oid+"\n").join(""),{flag:"wx"});
let fd,bytes;try{fd=fs.openSync(request,"r");bytes=execFileSync("/usr/bin/git",["-C",sdk,"cat-file","--batch"],{stdio:[fd,"pipe","pipe"],timeout:20000,maxBuffer:67108864});}finally{if(fd!==undefined)fs.closeSync(fd);}
const raw=Object.create(null);let offset=0;for(const name of ordered){
 const end=bytes.indexOf(10,offset);if(end<0)throw Error("Missing Git batch frame");const [oid,kind,sizeText]=bytes.subarray(offset,end).toString().split(" "),size=Number(sizeText);
 if(oid!==entries.get(name).oid||kind!=="blob"||!Number.isSafeInteger(size)||size<0||size>8388608)throw Error("Wrong bounded Git source frame");
 const body=bytes.subarray(end+1,end+1+size);if(body.length!==size||bytes[end+1+size]!==10)throw Error("Truncated Git source bytes");
 if(crypto.createHash("sha1").update(Buffer.from("blob "+size+"\0")).update(body).digest("hex")!==oid)throw Error("Git source blob identity mismatch");raw[name]={gitBlob:oid,sha256:sha(body),bytes:size};offset=end+2+size;
}if(offset!==bytes.length)throw Error("Unexpected trailing source batch bytes");
const stampBytes=readBounded(root+"/.source.json"),stamp=JSON.parse(stampBytes);
if(stamp.baseCommit!==policy.SDK||stamp.projectionVersion!==policy.projectionVersion)throw Error("Wrong normal producer source/version stamp");
if(sha(readBounded(alpha+"/scripts/prepare-client-features.mjs"))!==policy.sameCanonicalPreparerSHA256)throw Error("Canonical normal producer code changed");
if(Object.keys(stamp.sourceFiles).length!==339||policy.canonicalRawPaths.some(name=>stamp.sourceFiles[name]!==raw[name].sha256))throw Error("Normal producer raw source map differs from exact SDK");
const {files,modes,fileCount,totalBytes,entryCount}=inventoryRegularSourceFiles(root);
const names=Object.keys(files).sort(),claimed=Object.keys(stamp.files).sort();if(JSON.stringify(names)!==JSON.stringify(claimed)||names.some(name=>files[name]!==stamp.files[name]))throw Error("Normal projection physical bytes differ from complete stamp");
const snapshot={accepted:true,phase,SDK:policy.SDK,Alpha:policy.Alpha,projectionVersion:stamp.projectionVersion,stampSHA256:sha(stampBytes),rawSourceCount:339,additionalReadOnlySourceCount:25,raw,files,modes,fileCount,totalBytes,entryCount,scope:"Actual frozen normal producer output and raw Git identities only; normal module consumers/tests/types/model/voice/Calendar/device remain separate."};
const stable=value=>JSON.stringify(Object.keys(value).sort().map(name=>[name,value[name]]));
const prior="/results/PROJECTION-BASELINE.json";
if(phase==="post"){
 if(!fs.existsSync(prior))throw Error("Required projection baseline disappeared");
 const baseline=JSON.parse(readBounded(prior));if(baseline.stampSHA256!==snapshot.stampSHA256||stable(baseline.files)!==stable(snapshot.files)||stable(baseline.raw)!==stable(snapshot.raw)||stable(baseline.modes)!==stable(snapshot.modes))throw Error("Projection/raw source bytes changed after owning tests");
 fs.writeFileSync("/results/PROJECTION-POSTVERIFY.json",JSON.stringify(snapshot,null,2)+"\n",{flag:"wx"});
}else{if(fs.existsSync(prior))throw Error("Baseline phase cannot reuse previous source proof");fs.writeFileSync(prior,JSON.stringify(snapshot,null,2)+"\n",{flag:"wx"});}
