/** Diagnostic-only realtime arrival observations. No audio, transcript or server IDs persist. */
export const REALTIME_TIMING_LIMIT = 262144;
export const REALTIME_TIMING_FORMAT = "alpha-realtime-voice-timing-v1";
const sessionMarks = ["client-start", "hello-sent", "ready-received", "stopped"] as const;
const turnMarks = ["stt-final-received", "llm-first-text-received", "speaking-start-received", "first-downlink-pcm-received", "speaking-end-received", "reply-complete-received", "usage-received", "interrupted", "fatal-error"] as const;
const outcomes = ["active", "server-terminal-observed", "interrupted", "error", "stopped", "superseded"];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export type RealtimeTimingRoute = "direct-cartesia" | "cloud-cartesia";
type Row = {version:1; id:string; recordedAt:number; route:RealtimeTimingRoute; kind:"session"|"turn"; basis:"client-start"|"accepted-stt-final-received"; cold:boolean; coldBasis:"client-session-order"; marks:Record<string,number>; outcome:string; firstAudioKind:"unknown"};
type Store = {getItem(key:string):string|null;setItem(key:string,value:string):void};
const object = (v:unknown):v is Record<string,unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const bytes = (v:string) => new TextEncoder().encode(v).byteLength;
/** A raw string is bounded before JSON.parse. Output copies allowlisted fields only. */
export function sanitizeRealtimeTiming(raw:unknown):{format:typeof REALTIME_TIMING_FORMAT;clock:"client-performance-ms";units:"ms";records:Row[]} {
 const empty = () => ({format:REALTIME_TIMING_FORMAT,clock:"client-performance-ms" as const,units:"ms" as const,records:[] as Row[]});
 try {
  if(typeof raw !== "string" || raw.length > REALTIME_TIMING_LIMIT || bytes(raw)>REALTIME_TIMING_LIMIT)return empty();
  const doc:unknown=JSON.parse(raw);
  if(!object(doc)||doc.format!==REALTIME_TIMING_FORMAT||doc.clock!=="client-performance-ms"||doc.units!=="ms"||!Array.isArray(doc.records)||doc.records.length>200)return empty();
  const records:Row[]=[];const ids=new Set<string>();
  for(const row of doc.records){
   if(!object(row)||row.version!==1||typeof row.id!=="string"||!uuid.test(row.id)||ids.has(row.id)||!Number.isSafeInteger(row.recordedAt)||(row.recordedAt as number)<0||(row.recordedAt as number)>8640000000000000||(typeof row.route!=="string"||!["direct-cartesia","cloud-cartesia"].includes(row.route))||(typeof row.kind!=="string"||!["session","turn"].includes(row.kind))||row.basis!==(row.kind==="session"?"client-start":"accepted-stt-final-received")||typeof row.cold!=="boolean"||row.coldBasis!=="client-session-order"||(typeof row.outcome!=="string"||!outcomes.includes(row.outcome))||row.firstAudioKind!=="unknown"||!object(row.marks))continue;
   const marks:Record<string,number>={};
   for(const key of row.kind==="session"?sessionMarks:turnMarks){const at=row.marks[key];if(typeof at==="number"&&Number.isFinite(at)&&at>=0&&at<3600000)marks[key]=Math.min(3599999,Math.round(at));}
   ids.add(row.id);records.push({version:1,id:row.id,recordedAt:row.recordedAt as number,route:row.route as RealtimeTimingRoute,kind:row.kind as Row["kind"],basis:row.basis as Row["basis"],cold:row.cold,coldBasis:"client-session-order",marks,outcome:row.outcome as string,firstAudioKind:"unknown"});
  }
  return {...empty(),records};
 }catch{return empty();}
}
export function createRealtimeVoiceTiming(options:{storageKey:string;storage:()=>Store|undefined;now?:()=>number;epoch?:()=>number;id?:()=>string}) {
 const now=options.now??(()=>performance.now()),epoch=options.epoch??Date.now,id=options.id??(()=>crypto.randomUUID());
 const read=()=>{try{return sanitizeRealtimeTiming(options.storage()?.getItem(options.storageKey));}catch{return sanitizeRealtimeTiming(undefined);}};
 const save=(row:Row)=>{try{const doc=read();const index=doc.records.findIndex(r=>r.id===row.id);if(index<0)doc.records.push(row);else doc.records[index]=row;doc.records=doc.records.slice(-200);let raw=JSON.stringify(doc);while(bytes(raw)>REALTIME_TIMING_LIMIT&&doc.records.length){doc.records.shift();raw=JSON.stringify(doc);}options.storage()?.setItem(options.storageKey,raw);}catch{/* Diagnostics never change the voice result. */}};
 const safely=(fn:()=>void)=>{try{fn();}catch{/* Diagnostic only. */}};
 return {exportJson:()=>JSON.stringify(read()),start(route:RealtimeTimingRoute){
  let open=true;let session:Row|undefined,turn:Row|undefined;let sessionBase=0,turnBase=0;let activeTrace:string|undefined;const seen=new Set<string>();
  const row=(kind:Row["kind"],cold:boolean):Row=>({version:1,id:id(),recordedAt:epoch(),route,kind,basis:kind==="session"?"client-start":"accepted-stt-final-received",cold,coldBasis:"client-session-order",marks:{},outcome:"active",firstAudioKind:"unknown"});
  const mark=(r:Row|undefined,key:string,base:number)=>{if(!r||r.marks[key]!==undefined)return;const at=now()-base;if(!Number.isFinite(at)||at<0||at>=3600000)return;r.marks[key]=Math.min(3599999,Math.round(at));save(r);};
  safely(()=>{sessionBase=now();session=row("session",true);mark(session,"client-start",sessionBase);});
  return {
   acceptedFinal(trace:string){safely(()=>{if(!open||!trace||trace.length>160||seen.has(trace)||seen.size>=32)return;if(turn&&turn.outcome==="active"){turn.outcome="superseded";save(turn);}seen.add(trace);activeTrace=trace;turnBase=now();turn=row("turn",seen.size===1);mark(turn,"stt-final-received",turnBase);});},
   trace(name:string,trace:string|null){safely(()=>{if(!open)return;if(name==="hello_sent"||name==="ready"){if(turn&&activeTrace){if(turn.outcome==="active"){turn.outcome="superseded";save(turn);}activeTrace=undefined;}mark(session,name==="ready"?"ready-received":"hello-sent",sessionBase);return;}if(!trace||trace!==activeTrace)return;const keys:Record<string,string>={llm_first_text:"llm-first-text-received",speaking_start:"speaking-start-received",downlink_audio:"first-downlink-pcm-received",speaking_end:"speaking-end-received"};if(keys[name])mark(turn,keys[name],turnBase);});},
   control(name:string,trace?:string){safely(()=>{if(!open||!turn||!trace||trace!==activeTrace)return;const key=name==="reply_complete"?"reply-complete-received":name==="usage"?"usage-received":name==="interrupted"?"interrupted":name==="fatal-error"?"fatal-error":undefined;if(!key)return;mark(turn,key,turnBase);turn.outcome=name==="interrupted"?"interrupted":name==="fatal-error"?"error":"server-terminal-observed";save(turn);if(name==="interrupted"||name==="fatal-error")activeTrace=undefined;});},
   error(){safely(()=>{if(!open)return;open=false;if(turn){turn.outcome="error";mark(turn,"fatal-error",turnBase);save(turn);}if(session){session.outcome="error";save(session);}activeTrace=undefined;seen.clear();});},
   stop(){safely(()=>{if(!open)return;open=false;if(turn){if(turn.outcome==="active")turn.outcome="stopped";save(turn);}if(session){mark(session,"stopped",sessionBase);session.outcome="stopped";save(session);}activeTrace=undefined;seen.clear();});},
  };
 }};
}
