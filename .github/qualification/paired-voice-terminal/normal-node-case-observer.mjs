// Normal Node24 event observer. Exact own file envelope, source parents and two reviewed children only.
import fs from "node:fs";import crypto from "node:crypto";
export default async function* normalNodeCases(source){
 const group=process.env.ELIZA_QUALIFICATION_GROUP;if(!/^owning-\d{1,2}$/.test(group||""))throw Error("Missing exact normal Node group");
 if(process.env.ALPHA_PRIVATE_CARTESIA_TEST_CASE!==undefined)throw Error("Top-level adapter child selector must be unset");
 const raw=fs.readFileSync("/operator/ORACLES.json"),expected=JSON.parse(raw).groups[group];if(!expected||expected.repository!=="Alpha")throw Error("Wrong normal Node oracle");
 const oracleSHA256=crypto.createHash("sha256").update(raw).digest("hex"),registered=[],results=[],failures=[],diagnostics=[],summaries=[],envelopes=[];let activeParent=null;
 const nested=expected.expectedNestedCases||[],parentNames=expected.cases.map(row=>row.leafTitle);
 const marked=(d,key)=>Object.hasOwn(d,key)&&d[key]!==undefined&&d[key]!==false;
 // Retain ordinary failures without serializing arbitrary graphs or unbounded child output.
 const errorDetail=(error,depth=0)=>{
  if(error===undefined||error===null)return null;
  if(typeof error!=="object"&&typeof error!=="function")return {message:String(error).slice(0,8192)};
  const value={};
  for(const [field,limit] of [["name",256],["code",256],["failureType",256],["message",8192],["stack",4096]]){
   const text=error[field];if(typeof text==="string"){value[field]=text.slice(0,limit);if(text.length>limit)(value.truncatedFields??=[]).push(field);}
  }
  if(error.cause!==undefined){if(depth<2)value.cause=errorDetail(error.cause,depth+1);else value.causeOmittedAtDepthLimit=true;}
  return value;
 };
 const location=d=>({file:d.file??null,line:d.line??null,column:d.column??null,nesting:d.nesting});
 const scope=d=>{
  if(d.nesting===0&&(d.name===expected.expectedModule||d.name===expected.file)&&(d.file===undefined||d.file===null||d.file===expected.expectedModule))return "runner-file-envelope";
  if(d.file!==expected.expectedModule)throw Error("Foreign or unattributed normal test event");
  if(d.nesting===0&&parentNames.includes(d.name))return "source-parent";
  if(nested.some(row=>row.name===d.name&&row.nesting===d.nesting&&row.sourceLine===d.line&&row.parentName===activeParent))return "reviewed-nested-child";
  throw Error("Unknown normal test/suite/nested identity");
 };
 const key=row=>JSON.stringify([row.scope,row.name,row.file,row.line,row.column,row.nesting]);
 const counts=names=>{const m=new Map();for(const name of names)m.set(name,(m.get(name)||0)+1);return JSON.stringify([...m].sort((a,b)=>a[0].localeCompare(b[0])));};
 for await(const event of source){
  const d=event.data;if(!d)continue;
  if(event.type==="test:dequeue"&&d.nesting===0&&d.file===expected.expectedModule&&parentNames.includes(d.name))activeParent=d.name;
  if(event.type==="test:enqueue"){
   const classification=scope(d);const row={name:d.name,...location(d),scope:classification,type:d.type,registrationIndex:registered.length};
   if(classification==="runner-file-envelope")envelopes.push({event:event.type,...row});
   else{if(d.type!=="test")throw Error("Unreviewed owning suite declaration");registered.push(row);}
  }
  if(event.type==="test:pass"||event.type==="test:fail"){
   const classification=scope(d),row={name:d.name,...location(d),scope:classification,testNumber:d.testNumber,passed:event.type==="test:pass",skip:marked(d,"skip"),todo:marked(d,"todo"),type:d.details?.type??null,...(event.type==="test:fail"?{error:errorDetail(d.details?.error)}:{})};
   if(!row.passed||row.skip||row.todo)failures.push(row);
   if(classification==="runner-file-envelope")envelopes.push({event:event.type,...row});
   else{if(row.type!=="test")throw Error("Unreviewed successful suite");results.push(row);}
  }
  if(event.type==="test:diagnostic"&&typeof d.message==="string"&&d.message.startsWith("adapter-child ")){
   if(expected.file!=="test/private-preview-cartesia-route.test.mjs")throw Error("Adapter diagnostic outside admitted owner");
   const value=JSON.parse(d.message.slice("adapter-child ".length));
   if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).some(k=>!["name","status","signal","error"].includes(k))||!expected.adapterParentNames.includes(value.name))throw Error("Unknown adapter diagnostic");
   if(d.file!==undefined&&d.file!==expected.expectedModule)throw Error("Foreign adapter diagnostic location");
   diagnostics.push({name:value.name,status:value.status,signal:value.signal,error:value.error,location:location(d),activeParent});
  }
  if(event.type==="test:summary"){
   if(d.file!==undefined&&d.file!==expected.expectedModule)throw Error("Foreign file summary");
   summaries.push({file:d.file??null,success:d.success,counts:d.counts});
  }
  if(registered.length>10000||results.length>10000||diagnostics.length>100||summaries.length>10||envelopes.length>10)throw Error("Normal event receipt row bound");
 }
 const parents=registered.filter(row=>row.scope==="source-parent"),children=registered.filter(row=>row.scope==="reviewed-nested-child"),parentResults=results.filter(row=>row.scope==="source-parent");
 const summary=summaries.at(-1),totalExpected=expected.expectedSourceCaseCount+nested.length;
 let accepted=failures.length===0&&parents.length===expected.expectedSourceCaseCount&&parentResults.length===parents.length&&counts(parents.map(r=>r.name))===counts(parentNames)&&counts(parentResults.map(r=>r.name))===counts(parentNames)&&children.length===nested.length&&counts(children.map(r=>r.name))===counts(nested.map(r=>r.name))&&counts(registered.map(key))===counts(results.map(key));
 accepted=accepted&&summaries.length>0&&summaries.every(row=>row.success===true&&row.counts.skipped===0&&row.counts.todo===0&&row.counts.cancelled===0)&&summary.counts.tests===totalExpected&&summary.counts.passed===totalExpected&&summary.counts.topLevel===expected.expectedSourceCaseCount;
 if(expected.file==="test/private-preview-cartesia-route.test.mjs")accepted=accepted&&expected.adapterParentNames.length===9&&diagnostics.length===9&&counts(diagnostics.map(r=>r.name))===counts(expected.adapterParentNames)&&diagnostics.every(r=>r.status===0&&r.signal===null&&r.error===null);
 const value={state:accepted?"ACTUAL_NORMAL_NODE_PARENT_AND_SUBTEST_RESULTS_ACCEPTED":"NODE_CASE_RECONCILIATION_FAILED",accepted,group,oracleSHA256,topLevelAdapterSelectorUnset:true,registered,results,failures,runnerFileEnvelopes:envelopes,summaries,adapterDiagnostics:diagnostics,adapterPass1Evidence:"All nine parent passes prove their unchanged positive child TAPpass1 assertions; raw child stdout is not separately archived.",sourceLabelPolicy:"Exact source names and explicit nested scope; no foreign successful event ignored."};
 const bytes=JSON.stringify(value,null,2)+"\n";if(Buffer.byteLength(bytes)>8388608)throw Error("Actual formatted Node event receipt byte bound");fs.writeFileSync("/results/"+group+"-node-cases.json",bytes,{flag:"wx"});if(!accepted){process.exitCode=1;yield "Normal Node observer rejected registration/execution attribution; see the failure receipt.\n";return;}
 yield "Normal Node observer accepted "+parents.length+" parents and "+children.length+" reviewed children.\n";
}
