import fs from "node:fs";
import {createRequire} from "node:module";
import {pathToFileURL} from "node:url";
const root="/workspace";
const require=createRequire(root+"/package.json");
const {createVitest}=await import(pathToFileURL(require.resolve("vitest/node")).href);
let ctx;
try{
 ctx=await createVitest("test",{
  root:root+"/packages/host",config:root+"/packages/host/vitest.config.ts",
  configLoader:"runner",watch:false,pool:"forks",maxWorkers:1,maxConcurrency:1,
  fileParallelism:false,cache:false,fsModuleCachePath:"/results/host-preflight-cache"
 });
 const project=ctx.getRootProject();
 const server=project.vite;
 if(!server?.environments?.ssr)throw Error("Missing actual SSR environment");
 const importer=root+"/packages/host/src/voice/speech-retirement-session.test.ts";
 const observed=[];
 for(const [name,expected] of [["@elizaos/core",root+"/packages/core/src/index.ts"],["@elizaos/host",root+"/packages/host/src/index.ts"]]){
  const resolved=await server.environments.ssr.pluginContainer.resolveId(name,importer);
  if(!resolved||resolved.id.split("?")[0]!==expected)throw Error("Wrong normal owning source resolution: "+name);
  const fetched=await server.environments.ssr.fetchModule(name,importer);
  // External routes must name that same current-source entry; no donor/dist.
  if(fetched.externalize&&new URL(fetched.externalize).pathname!==expected)throw Error("Wrong external owning source resolution: "+name);
  observed.push({name,resolved:resolved.id,externalize:fetched.externalize??null});
 }
 fs.writeFileSync("/results/HOST-PREFLIGHT.json",JSON.stringify({config:server.config.configFile,
  conditions:server.environments.ssr.config.resolve.conditions,
  externalConditions:server.environments.ssr.config.resolve.externalConditions,
  observed,testsStarted:false,limits:"Resolver/bootstrap only, no owning pass"},null,2)+"\n");
}finally{if(ctx)await ctx.close();}
