import {readBoundedSourceFile,sha256SourceFile} from "./operator-file-custody.mjs";
// Source proposal only. Future admitted normal config/module preflight; no test start.
import fs from "node:fs";import path from "node:path";import crypto from "node:crypto";import {createRequire} from "node:module";import {fileURLToPath,pathToFileURL} from "node:url";
const definition=JSON.parse(readBoundedSourceFile("/operator/PREFLIGHT-DEFINITION.json").toString());
const sdk="/workspace/sdk",alpha="/workspace/alpha",records=[];
const digest=file=>sha256SourceFile(file);
function modulePath(value){if(typeof value!=="string")return null;return(value.startsWith("file:")?fileURLToPath(value):value).split("?")[0];}
async function fetchedEntry(ssr,root,entry){
 const filename=root+"/"+entry.path;if(digest(filename)!==entry.sha256)throw Error("Changed production entry source bytes");
 const fetched=await ssr.fetchModule(filename);const actual=modulePath(fetched.externalize)||modulePath(fetched.file)||modulePath(fetched.id);
 if(!actual||fs.realpathSync(actual)!==fs.realpathSync(filename)||actual.endsWith(".d.ts"))throw Error("Required normal production source substituted");
 const edges=[];
 for(const edge of entry.literalModuleEdges){
  const resolved=await ssr.pluginContainer.resolveId(edge.specifier,filename);
  if(!resolved)throw Error("Unresolved actual normal declaration: "+edge.specifier);
  edges.push({...edge,resolved:resolved.id,external:resolved.external??false});
 }
 return{path:entry.path,sha256:entry.sha256,actualSource:actual,normalResolvedEdges:edges,sourceBytesBoundedReadHashed:true,viteFetchKind:fetched.externalize?"normal-externalization":typeof fetched.code==="string"?"transformed-body-returned":"normal-fetch-without-body",transformedBodyReturned:typeof fetched.code==="string",sourceExecutionClaim:false};
}
const sdkRequire=createRequire(sdk+"/package.json");
if(JSON.parse(readBoundedSourceFile(sdkRequire.resolve("vitest/package.json")).toString()).version!=="5.0.5")throw Error("Wrong normal Vitest dependency");
const {createVitest}=await import(pathToFileURL(sdkRequire.resolve("vitest/node")).href);
for(const owner of definition.projects){
 let context,record;const previousCwd=process.cwd();
 try{
  const root=sdk+"/"+owner.root,config=root+"/"+owner.config;
  if(digest(config)!==owner.configSHA256)throw Error("Actual owning config changed");
  process.chdir(root);
  context=await createVitest("test",{root,config,configLoader:"runner",watch:false,pool:"forks",maxWorkers:1,maxConcurrency:1,fileParallelism:false,cache:false,fsModuleCachePath:"/results/preflight-"+owner.name});
  const project=context.getRootProject(),server=project.vite,ssr=server.environments?.ssr;
  if(!ssr||server.config.configFile!==config)throw Error("Wrong normal owning environment/config");
  record={owner:owner.name,config,configSHA256:owner.configSHA256,conditions:ssr.config.resolve.conditions,externalConditions:ssr.config.resolve.externalConditions,entries:[],testsStarted:false,closed:false};
  for(const entry of owner.entries)record.entries.push(await fetchedEntry(ssr,sdk,entry));
  if(owner.name==="Host"){
   const target=definition.HostContracts,importer=sdk+"/"+target.importer,expected=sdk+"/"+target.expectedTarget;
   const resolved=await ssr.pluginContainer.resolveId(target.specifier,importer);
   if(!resolved||modulePath(resolved.id)!==expected||digest(expected)!==target.targetSHA256||digest(sdk+"/"+target.leaf)!==target.leafSHA256)throw Error("Wrong new Host Contracts supplier");
   const testEnvironment=server.environments.__vitest__;if(!testEnvironment)throw Error("Actual Vitest value environment unavailable");
   const runtimeResolved=await testEnvironment.pluginContainer.resolveId(target.specifier,importer);
   if(!runtimeResolved||modulePath(runtimeResolved.id)!==expected)throw Error("Host test-runner supplier differs from normal SSR source resolution");
   const module=await project.import(runtimeResolved.id);
   if(target.requiredExports.some(name=>typeof module[name]!=="function"))throw Error("New Host Contracts value exports unavailable");
   record.HostContracts={resolverEnvironment:"ssr",valueEnvironment:"__vitest__ via public project.import",runtimeResolved:runtimeResolved.id,importer,specifier:target.specifier,resolved:resolved.id,targetSHA256:target.targetSHA256,leaf:target.leaf,leafSHA256:target.leafSHA256,valueExports:target.requiredExports};
  }
  records.push(record);
 }finally{try{if(context){await context.close();if(record)record.closed=true;}}finally{process.chdir(previousCwd);}}
}
let alphaServer,alphaRecord;const alphaPreviousCwd=process.cwd();
try{
 const cfg=alpha+"/"+definition.AlphaProjection.config;
 if(digest(cfg)!==definition.AlphaProjection.configSHA256)throw Error("Actual Alpha Vite config changed");
 const alphaRequire=createRequire(alpha+"/package.json"),{createServer}=await import(pathToFileURL(alphaRequire.resolve("vite")).href);
 for(const key of ["ELIZA_DEV_ALLOW_TEST_MOCKS","VITE_ELIZA_DEV_ALLOW_TEST_MOCKS","VITE_LOCAL_AGENT","VITE_ALPHA_CLOUD_RESIDENT","ALPHA_PRIVATE_LOCAL_PREVIEW","VITE_ALPHA_PRIVATE_LOCAL_PREVIEW","ALPHA_BROWSER_CLOUD_PROFILE","ALPHA_ELIZA_SOURCE","ALPHA_REMOTE_PROFILE","ALPHA_REMOTE_PORT","ALPHA_LOCAL_AGENT_TOKEN_FILE"]){if(process.env[key]!==undefined)throw Error("Backend/resident/mock environment not admitted for module preflight");}
 for(const folder of [alpha,alpha+"/apps/app"]){for(const name of [".env",".env.local",".env.development",".env.development.local",".env.production",".env.production.local",".dev.vars"]){if(fs.existsSync(folder+"/"+name))throw Error("Credential/development env source not admitted");}}
 process.chdir(alpha);
 alphaServer=await createServer({configFile:cfg,configLoader:"runner",server:{middlewareMode:true,hmr:false,watch:null},cacheDir:"/results/alpha-vite-cache"});
 if(alphaServer.config.configFile!==cfg||alphaServer.config.root!==alpha+"/apps/app"||!alphaServer.environments?.ssr)throw Error("Wrong normal Alpha Vite environment");
 alphaRecord={owner:"AlphaProjection",actualRoot:alphaServer.config.root,operationalOverrides:{middlewareMode:true,hmr:false,watch:null,cacheDir:"/results/alpha-vite-cache"},config:cfg,configSHA256:definition.AlphaProjection.configSHA256,entries:[],closed:false,testsStarted:false};
 for(const entry of definition.AlphaProjection.entries)alphaRecord.entries.push(await fetchedEntry(alphaServer.environments.ssr,alpha,entry));
 const target=definition.AlphaProjection,importer=alpha+"/"+target.consumer,expected=alpha+"/"+target.expectedGeneratedTarget;
 const resolved=await alphaServer.environments.ssr.pluginContainer.resolveId(target.specifier,importer);
 if(!resolved||modulePath(resolved.id)!==expected)throw Error("Alpha normal consumer did not resolve new generated client");
 const stamp=JSON.parse(readBoundedSourceFile(alpha+"/.eliza/client-features/.source.json").toString());
 const relative=target.expectedGeneratedTarget.replace(/^\.eliza\/client-features\//,"");
 if(stamp.baseCommit!==definition.SDK||stamp.files[relative]!==digest(expected))throw Error("Alpha generated source/stamp pin mismatch");
 const browser=alphaServer.environments.client;if(!browser)throw Error("Normal Alpha browser consumer environment unavailable");
 const browserResolved=await browser.pluginContainer.resolveId(target.specifier,importer);if(!browserResolved||modulePath(browserResolved.id)!==expected)throw Error("Browser consumer alias differs from generated source target");
 const module=await alphaServer.ssrLoadModule(resolved.id);
 if(target.requiredExports.some(name=>typeof module[name]!=="function"))throw Error("Actual generated client value export unavailable");
 alphaRecord.consumer={browserResolved:browserResolved.id,valueEnvironment:"normal SSR import; browser execution/audio not claimed",importer,specifier:target.specifier,resolved:resolved.id,generatedSHA256:stamp.files[relative],baseCommit:stamp.baseCommit,valueExports:target.requiredExports};records.push(alphaRecord);
}finally{try{if(alphaServer){await alphaServer.close();if(alphaRecord)alphaRecord.closed=true;}}finally{process.chdir(alphaPreviousCwd);}}
const accepted=records.length===5&&records.every(record=>record.closed)&&records.reduce((n,record)=>n+record.entries.length,0)===13;
fs.writeFileSync("/results/OWNING-PREFLIGHT.json",JSON.stringify({accepted,owners:records.map(row=>row.owner),records,newHostContractsValueExports:definition.HostContracts.requiredExports,testsStarted:false,modelProviderVoiceOrNativeAcceptance:false},null,2)+"\n");if(!accepted)throw Error("Actual paired normal owning module preflight incomplete");
