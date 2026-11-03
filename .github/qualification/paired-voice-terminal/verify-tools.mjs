// Trusted operator metadata probe for a separately admitted readonly/no-network container.
import fs from "node:fs";import path from "node:path";import crypto from "node:crypto";import {execFileSync} from "node:child_process";
const policy=JSON.parse(fs.readFileSync("/operator/TOOLCHAIN.json","utf8"));
if(process.env.ALPHA_PRIVATE_CARTESIA_TEST_CASE!==undefined)throw Error("Top-level child selector must be unset");
const hash=filename=>{const s=fs.statSync(filename);if(!s.isFile()||s.size>268435456)throw Error("Tool file is absent/nonregular or exceeds byte bound");return crypto.createHash("sha256").update(fs.readFileSync(filename)).digest("hex");};
const run=(file,args)=>execFileSync(file,args,{encoding:"utf8",timeout:10000,maxBuffer:131072}).trim();
const nodePath=fs.realpathSync(process.execPath),bunPath=fs.realpathSync("/usr/local/bin/bun"),gitPath=fs.realpathSync("/usr/bin/git");
if(nodePath!=="/usr/local/bin/node"||bunPath!=="/usr/local/bin/bun"||!gitPath.startsWith("/usr/bin/"))throw Error("Unexpected immutable image tool path");
const versions={node:process.versions.node,bun:run(bunPath,["--version"]),nodeSHA256:hash(nodePath),bunSHA256:hash(bunPath)};
for(const [key,value]of Object.entries(policy.expectedTools))if(versions[key]!==value)throw Error("Existing Node/Bun tool pin mismatch");
const npmPackage="/usr/local/lib/node_modules/npm/package.json",npmCli="/usr/local/lib/node_modules/npm/bin/npm-cli.js";
const npmVersion=run(nodePath,[npmCli,"--version"]),npmManifest=JSON.parse(fs.readFileSync(npmPackage,"utf8"));
if(npmManifest.version!==npmVersion||!/^\d+\.\d+\.\d+/.test(npmVersion))throw Error("Actual npm package/CLI version mismatch");
const gitVersion=run(gitPath,["--version"]);if(!/^git version \d+\.\d+\.\d+/.test(gitVersion))throw Error("Git version probe failed");
const gitSHA256=hash(gitPath);
const elf=fs.readFileSync(gitPath,{encoding:null});if(elf.subarray(0,4).toString("hex")!=="7f454c46")throw Error("Expected pinned image ELF Git tool");
const ldd=run("/usr/bin/ldd",[gitPath]);if(ldd.includes("not found"))throw Error("Git shared library missing");
const libraries=[];for(const line of ldd.split("\n")){const match=line.match(/(?:=>\s+|^\s*)(\/\S+)/);if(!match)continue;const filename=fs.realpathSync(match[1]);if(!filename.startsWith("/usr/lib/")&&!filename.startsWith("/lib/"))throw Error("Git library outside immutable image paths");libraries.push({path:filename,sha256:hash(filename)});}
if(!libraries.length)throw Error("No Git dynamic library provenance observed");
fs.writeFileSync("/results/TOOLS.json",JSON.stringify({accepted:true,scope:"Actual same-container metadata for frozen image tools only; not provider/model/projection/test/type/runtime acceptance",versions,git:{path:gitPath,version:gitVersion,sha256:gitSHA256,libraries},npm:{version:npmVersion,packagePath:npmPackage,packageSHA256:hash(npmPackage),cliPath:npmCli,cliSHA256:hash(npmCli)},nodeImageDigest:policy.nodeImageDigest,bunImageDigest:policy.bunImageDigest,topLevelAdapterSelectorUnset:true},null,2)+"\n");
