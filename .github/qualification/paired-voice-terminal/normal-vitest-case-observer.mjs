// Trusted observer accompanies the normal Vitest5 JSON reporter. No test selection/formatting.
import fs from "node:fs";import crypto from "node:crypto";
const group=process.env.ELIZA_QUALIFICATION_GROUP;if(!/^owning-\d{1,2}$/.test(group||""))throw Error("Missing exact normal owning group");
const raw=fs.readFileSync("/operator/ORACLES.json"),oracle=JSON.parse(raw),expected=oracle.groups[group];
if(!expected||expected.repository!=="SDK")throw Error("Wrong normal SDK oracle");
const digest=crypto.createHash("sha256").update(raw).digest("hex");
function save(name,value){const bytes=JSON.stringify(value,null,2)+"\n";if(Buffer.byteLength(bytes)>8388608)throw Error("Case receipt exceeds actual formatted byte bound");fs.writeFileSync("/results/"+group+name,bytes,{flag:"wx"});}
export default class NormalCaseObserver{
 constructor(){this.registered=[];this.results=new Map();this.modules=[];this.effective=null;}
 onInit(context){
  const config=context.getRootProject().config,shuffle=config.sequence?.shuffle;
  if(config.testNamePattern!=null||config.shard!=null||config.changed||config.related?.length||shuffle===true||shuffle?.tests||shuffle?.files||(config.retry!==undefined&&config.retry!==0))throw Error("Unreviewed normal case selection/shuffle/retry");
  if(config.includeTaskLocation!==true)throw Error("Normal source locations were not enabled");
  this.effective={testNamePattern:null,shard:null,changed:false,related:[],shuffle:shuffle??false,retry:config.retry??0,includeTaskLocation:true};
 }
 onTestRunStart(specifications){if(!this.effective||specifications.length!==1||specifications[0].moduleId!==expected.expectedModule)throw Error("Normal full-file specification changed");}

 onTestModuleCollected(module){
  if(module.moduleId!==expected.expectedModule||this.modules.length)throw Error("Wrong or duplicate owning module");
  const cases=[...module.children.allTests()];if(cases.length!==expected.expectedSourceCaseCount)throw Error("Normal registration count differs from frozen source ledger");
  const ids=new Set();this.registered=cases.map((test,index)=>{
   if(!test.id||ids.has(test.id))throw Error("Duplicate normal task ID");ids.add(test.id);
   const source=expected.cases[index];if(source.exactSourceLeafTitle&&test.name!==source.leafTitle)throw Error("Literal case position/title differs from frozen source ledger");
   if(test.result().state!=="pending")throw Error("Case did not remain pending at collection");
   return{id:test.id,name:test.name,fullName:test.fullName,location:test.location??null,sourceKey:source.sourceKey,rowIndex:source.rowIndex??null,sourceLabelInference:"frozen source declaration/order; location and hierarchy separately observed, not inferred proof"};
  });this.modules.push(module.moduleId);
  save("-registered.json",{state:"ACTUAL_NORMAL_VITEST_REGISTRATION_BEFORE_RESULTS",group,module:module.moduleId,oracleSHA256:digest,effective:this.effective,cases:this.registered});
 }
 onTestCaseResult(test){
  const registered=this.registered.find(row=>row.id===test.id);if(!registered||this.results.has(test.id)||registered.name!==test.name)throw Error("Unknown/repeated normal task result");
  this.results.set(test.id,{id:test.id,name:test.name,state:test.result().state});
 }
 onTestRunEnd(modules,errors,reason){
  const rows=[...this.results.values()];const accepted=reason==="passed"&&errors.length===0&&modules.length===1&&this.modules.length===1&&rows.length===this.registered.length&&rows.length===expected.expectedSourceCaseCount&&rows.every(row=>row.state==="passed");
  save("-results.json",{state:accepted?"ACTUAL_NORMAL_REGISTERED_TASKS_ALL_PASSED":"NORMAL_CASE_RECONCILIATION_FAILED",accepted,group,oracleSHA256:digest,reason,unhandledErrorCount:errors.length,effective:this.effective,registered:this.registered,results:rows});
  if(!accepted)throw Error("Normal registered/executed task reconciliation failed");
 }
}
