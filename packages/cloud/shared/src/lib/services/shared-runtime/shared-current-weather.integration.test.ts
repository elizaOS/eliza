/** Offline retained public payload -> real history projection/binder/finalizer. */
import { expect, test, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { runCurrentUsWeatherSearch } from "./shared-current-weather";
import { sharedPublicWebGrounding } from "./shared-runtime-history-policy";
import { requireTraceableRealtimeSearch, validateSharedRealtimeReply, finalizeSharedRealtimeReply } from "./shared-realtime-grounding";
const fixture=(name:string)=>JSON.parse(readFileSync(new URL("./fixtures/"+name,import.meta.url),"utf8"));
test("actual NWS source preserves exact C/F facts and rejects city/unit/value swaps or stale observations through production projection/finalizer",async()=>{
 const clock=spyOn(Date,"now").mockReturnValue(Date.parse("2026-10-09T02:16:00Z"));
 try{
  const geo=fixture("usgs-springfield-mo-20261009.json");
  const station=fixture("nws-ksgf-station-20261009.json");
  const obs=fixture("nws-ksgf-observation-20261009.json");
  const fetchImpl=(async(input:any)=>{
   const u=new URL(String(input));let body:unknown;
   if(u.hostname==="dashboard.waterdata.usgs.gov")body=geo;
   else if(u.pathname.startsWith("/points/"))body={geometry:{type:"Point",coordinates:[-93.2982,37.2153]},properties:{observationStations:"https://api.weather.gov/gridpoints/SGF/67,35/stations"}};
   else if(u.pathname==="/gridpoints/SGF/67,35/stations")body={features:[station]};
   else if(u.pathname==="/stations/KSGF/observations/latest")body=obs;
   else throw Error("UNEXPECTED_FIXTURE_URL");
   return new Response(JSON.stringify(body),{headers:{"content-type":"application/geo+json"}});
  }) as typeof fetch;
  const query="current public weather in Springfield, Missouri";
  const result=await runCurrentUsWeatherSearch(query,{fetchImpl,cache:false});
  const checked=requireTraceableRealtimeSearch(result,query,Date.now(),"weather");
  expect(checked.success).toBe(true);
  const grounding=sharedPublicWebGrounding([checked]);
  expect(grounding?.kind).toBe("web_search");
  const url="https://api.weather.gov/stations/KSGF/observations/latest";
  const mark=" [[SOURCE_URL:"+url+"]]";
  for(const correct of ["Springfield, Missouri is 69.8°F and Clear.","Springfield, Missouri is 21°C and Clear.","Springfield, Missouri is 69.8° F and Clear.","Springfield, Missouri is 21° C and Clear.","Springfield, Missouri is 69.8 Fahrenheit and Clear.","Springfield, Missouri is 21 Celsius and Clear."]){
   expect(validateSharedRealtimeReply(correct+mark,grounding!)).toBe(true);
   const final=finalizeSharedRealtimeReply(correct+mark,grounding);
   expect(final).toContain(correct);expect(final).toContain(url);expect(final).toContain(obs.properties.timestamp);
  }
  for(const wrong of ["Springfield, Missouri is 99.8°F and Clear.","Springfield, Missouri is 69.8°C and Clear.","Springfield, Missouri is 69.8° C and Clear.","Springfield, Missouri is 21°F and Clear.","Springfield, Illinois is 69.8°F and Clear.","Springfield, Missouri is 69.8 Celsius and Clear."]){
   expect(validateSharedRealtimeReply(wrong+mark,grounding!)).toBe(false);
   expect(finalizeSharedRealtimeReply(wrong+mark,grounding)).toContain("won’t guess");
  }
  clock.mockReturnValue(Date.parse(obs.properties.timestamp)+91*60*1000);
  expect(requireTraceableRealtimeSearch(result,query,Date.now(),"weather").success).toBe(false);
  expect(finalizeSharedRealtimeReply("Springfield, Missouri is 69.8°F and Clear."+mark,grounding)).toContain("can’t verify");
 }finally{clock.mockRestore();}
});
