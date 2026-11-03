import fs from "node:fs";
import path from "node:path";
import {createRequire} from "node:module";
import {createHash} from "node:crypto";
const root="/workspace";
const require=createRequire(root+"/package.json");
const entries=[];
for(const name of ["vitest/node","vite","miniflare"]){
 const file=fs.realpathSync(require.resolve(name));
 if(!file.startsWith(root+"/node_modules/"))throw Error("External dependency origin: "+name);
 entries.push({name,file,sha256:createHash("sha256").update(fs.readFileSync(file)).digest("hex")});
}
const mf=createRequire(entries.find(x=>x.name==="miniflare").file);
const workerd=fs.realpathSync(mf.resolve("workerd"));
if(!workerd.startsWith(root+"/node_modules/"))throw Error("External Workerd origin");
entries.push({name:"workerd",file:workerd,sha256:createHash("sha256").update(fs.readFileSync(workerd)).digest("hex")});
fs.writeFileSync("/results/BOOTSTRAP.json",JSON.stringify({node:process.versions.node,entries,network:"container-none",scope:"Normal package resolution only; not tests/native/financial qualification"},null,2)+"\n");
