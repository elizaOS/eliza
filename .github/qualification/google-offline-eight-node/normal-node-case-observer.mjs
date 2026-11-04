// Source-only proposal. Consume actual Node24 test-runner events, never synthesize passes.
import fs from 'node:fs';
import crypto from 'node:crypto';
export default async function* observe(source){
 const group=process.env.ELIZA_QUALIFICATION_GROUP;
 if(!/^owning-[1-8]$/.test(group||''))throw Error('Missing exact eight-file group');
 for(const key of ['ALPHA_PRESENTATION_SOURCE','ALPHA_PRIVATE_CARTESIA_TEST_CASE','NODE_TEST_NAME_PATTERN'])if(process.env[key]!==undefined)throw Error('Forbidden test selector/override: '+key);
 const bytes=fs.readFileSync('/operator/ORACLES.json'),oracle=JSON.parse(bytes),expected=oracle.groups[group];
 if(!expected||expected.repository!=='Alpha'||expected.expectedNestedCases.length)throw Error('Invalid eight-file source oracle');
 const oracleSHA256=crypto.createHash('sha256').update(bytes).digest('hex');
 const registered=[],results=[],envelopes=[],summaries=[],violations=[];
 const identity=r=>JSON.stringify([r.name,r.file,r.line,r.column,r.nesting]);
 const sourceIdentity=c=>identity({name:c.leafTitle,file:expected.expectedModule,line:c.sourceLine,column:c.sourceColumn,nesting:0});
 const expectedCounts=new Map();for(const c of expected.cases){const k=sourceIdentity(c);expectedCounts.set(k,(expectedCounts.get(k)||0)+1);}
 const counts=rows=>{const m=new Map();for(const r of rows){const k=identity(r);m.set(k,(m.get(k)||0)+1);}return m;};
 const equal=(a,b)=>a.size===b.size&&[...a].every(([k,v])=>b.get(k)===v);
 const errorDetail=(e,depth=0)=>{
  if(e===null||e===undefined)return null;
  if(typeof e!=='object'&&typeof e!=='function')return {message:String(e).slice(0,8192)};
  const out={};for(const [k,n]of [['name',256],['code',256],['failureType',256],['message',8192],['stack',4096]])if(typeof e[k]==='string')out[k]=e[k].slice(0,n);
  if(e.cause!==undefined)out.cause=depth<2?errorDetail(e.cause,depth+1):{omittedAtDepthLimit:true};return out;
 };
 function classify(d){
  if(d.nesting===0&&(d.name===expected.expectedModule||d.name===expected.file)&&(d.file===undefined||d.file===null||d.file===expected.expectedModule))return 'runner-file-envelope';
  if(d.file===expected.expectedModule&&d.nesting===0&&expectedCounts.has(identity(d)))return 'source-parent';
  return 'unknown';
 }
 const marked=(d,k)=>Object.hasOwn(d,k)&&d[k]!==undefined&&d[k]!==false;
 let observerError=null;
 try{
  for await(const event of source){
   const d=event.data;if(!d)continue;
   if(['test:enqueue','test:pass','test:fail'].includes(event.type)){
    const row={name:d.name,file:d.file??null,line:d.line??null,column:d.column??null,nesting:d.nesting,scope:classify(d),event:event.type,type:event.type==='test:enqueue'?d.type:d.details?.type??null};
    if(row.scope==='unknown')violations.push({reason:'foreign/nested/unattributed source event',...row});
    if(row.scope==='runner-file-envelope')envelopes.push({...row,passed:event.type==='test:pass',error:errorDetail(d.details?.error)});
    else if(event.type==='test:enqueue')registered.push({...row,registrationIndex:registered.length});
    else results.push({...row,passed:event.type==='test:pass',skip:marked(d,'skip'),todo:marked(d,'todo'),testNumber:d.testNumber,error:errorDetail(d.details?.error)});
   }
   if(event.type==='test:summary')summaries.push({file:d.file??null,success:d.success,counts:d.counts});
   if(registered.length>1000||results.length>1000||envelopes.length>10||summaries.length>10||violations.length>1000)throw Error('Event receipt bound exceeded');
  }
 }catch(e){observerError=errorDetail(e);}
 const last=summaries.at(-1),n=expected.expectedSourceCaseCount;
 const accepted=!observerError&&!violations.length&&registered.length===n&&results.length===n&&equal(counts(registered),expectedCounts)&&equal(counts(results),expectedCounts)&&registered.every(r=>r.type==='test')&&results.every(r=>r.passed&&!r.skip&&!r.todo&&r.type==='test')&&envelopes.every(r=>r.event==='test:enqueue'||r.passed)&&summaries.length>0&&summaries.every(s=>(s.file===null||s.file===expected.expectedModule)&&s.success===true&&s.counts.skipped===0&&s.counts.todo===0&&s.counts.cancelled===0)&&last.counts.tests===n&&last.counts.passed===n&&last.counts.topLevel===n;
 const receipt={state:accepted?'ACTUAL_NORMAL_NODE_REGISTRATION_AND_RESULTS_ACCEPTED':'NODE_CASE_RECONCILIATION_FAILED',accepted,group,oracleSHA256,forbiddenSelectorsAbsent:true,registered,results,runnerFileEnvelopes:envelopes,summaries,violations,observerError,scope:'Exact file/title/line/column/nesting multisets compared independently for registration and execution. File envelopes never count as cases.'};
 const output=JSON.stringify(receipt,null,2)+'\n';if(Buffer.byteLength(output)>8388608)throw Error('Receipt byte bound exceeded');
 fs.writeFileSync('/results/'+group+'-node-cases.json',output,{flag:'wx'});
 if(!accepted){process.exitCode=1;yield 'Normal Node source registration/result witness rejected; see retained receipt.\n';return;}
 yield 'Normal Node witness accepted '+n+' exact source cases.\n';
}
