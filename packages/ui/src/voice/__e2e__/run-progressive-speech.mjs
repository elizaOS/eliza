/** Actual Chromium MP3/MediaSource playback with synthetic encoded audio.
 * This proves media/transport behavior, not provider timing or audible quality. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
const bundle = await build({ entryPoints:[fileURLToPath(new URL("../progressive-speech-playback.ts",import.meta.url))], bundle:true,format:"esm",platform:"browser",write:false });
const mp3=await readFile(new URL("fixtures/synthetic-tone.mp3",import.meta.url));
const server=createServer((req,res)=>{
  res.setHeader("Content-Type", req.url==="/player.js"?"text/javascript":req.url==="/tone.mp3"?"audio/mpeg":"text/html");
  res.end(req.url==="/player.js"?bundle.outputFiles[0].contents:req.url==="/tone.mp3"?mp3:"<!doctype html><title>Progressive speech verification</title>");
});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const browser=await chromium.launch({headless:true,args:["--autoplay-policy=no-user-gesture-required"]});
const results=[];
try {
 for(const mode of ["progressive","cancel","fallback","failure"]) {
  const page=await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const result=await page.evaluate(async(mode)=>{
    const {attachProgressiveSpeech}=await import("/player.js");
    if(mode==="fallback")Object.defineProperty(window,"MediaSource",{value:undefined});
    const bytes=new Uint8Array(await(await fetch("/tone.mp3")).arrayBuffer());
    const middle=Math.floor(bytes.length/2);
    const player=new Audio();document.body.append(player);
    let release;const gate=new Promise(resolve=>{release=resolve;});
    let calls=0,cancelled=0,ready=0,done=false,playError;
    const frames=[];
    const source={renderedSpeed:0.8,open:async()=>{},cancel:async()=>{cancelled++;},pull:async()=>{
      const cursor=calls++;
      if(cursor===1){await gate;if(mode==="failure")throw Error("Synthetic source failure");}
      if(cursor===2){done=true;return {type:"done",frames:2,audioBytes:bytes.length};}
      return {type:"audio",sequence:cursor,audio:cursor===0?bytes.slice(0,middle):bytes.slice(middle),mimeType:"audio/mpeg",alignment:null,normalizedAlignment:null};
    }};
    const attachment=attachProgressiveSpeech(player,source,{onReady:()=>{ready++;void player.play().catch(e=>{playError=e.message;});},onFrame:f=>frames.push(f.sequence)});
    // Attach the handler immediately: cancellation can reject before assertions finish.
    const outcome=attachment.loaded.then(value=>({value}),error=>({error:error.name}));
    const wait=async check=>{const until=performance.now()+8000;while(!check()){if(performance.now()>until)throw Error("Playback condition timed out: "+playError);await new Promise(r=>setTimeout(r,20));}};
    if(mode==="fallback"){
      await wait(()=>calls===2);if(ready!==0)throw Error("Fallback started before completion");release();
    }else{
      await wait(()=>player.currentTime>0.15&&!player.paused);
      if(done)throw Error("Playback did not precede EOF");
      if(mode==="cancel"){
        attachment.dispose();attachment.dispose();
        if(!player.paused||player.getAttribute("src")!==null)throw Error("Stop retained audio source");
        release();const result=await outcome;
        if(!result.error||cancelled!==1)throw Error("Late audio or repeated cancellation");
        return {mode,progressive:attachment.progressive,cancelled,frames};
      }
      release();
      if(mode==="failure") {
        const result=await outcome;
        if(!result.error||cancelled!==1||!player.paused||player.getAttribute("src")!==null)throw Error("Failed stream retained media");
        return {mode,progressive:attachment.progressive,cancelled,frames};
      }
    }
    const result=await outcome;if(result.error)throw Error(result.error);
    await wait(()=>player.currentTime>0.2&&!player.paused);
    if(result.value.audio.size!==bytes.length||ready!==1||frames.join()!=="0,1")throw Error("Incomplete media result");
    attachment.dispose();
    // Replay the completed bytes without touching the source transport again.
    const replay=new Audio(URL.createObjectURL(result.value.audio));await replay.play();
    await wait(()=>replay.currentTime>0.1);replay.pause();URL.revokeObjectURL(replay.src);
    if(calls!==3)throw Error("Replay resynthesized audio");
    return {mode,progressive:attachment.progressive,bytes:result.value.audio.size,ready,calls,replay:true};
  },mode);
  results.push(result);await page.close();
 }
 assert.equal(results[0].progressive,true);assert.equal(results[2].progressive,false);
 const output=process.env.PLAYBACK_EVIDENCE_DIR;
 if(output){await mkdir(output,{recursive:true});await writeFile(`${output}/browser.json`,JSON.stringify({browser:browser.version(),syntheticMP3:true,autoplayPolicyOverride:true,results},null,2));}
 console.log(JSON.stringify(results,null,2));
}finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
