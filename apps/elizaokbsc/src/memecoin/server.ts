import { readFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import { URL } from "node:url";
import type { AgentRuntime } from "@elizaos/core";
import { ethers } from "ethers";
import { getDiscoveryConfig } from "./config";
import { buildDistributionPlan } from "./distribution";
import { executeDistributionLane } from "./distribution-execution";
// ElizaCloud v1 calls live in ./elizacloud-api.ts (auth header rules, parsers, 429 retry) — why: testability
// and alignment with Cloud’s requireAuthOrApiKey order; see docs/elizacloud-integration.md.
import {
  elizaCloudAuthHeaders,
  fetchElizaCloudPrimaryAgentConfig,
  fetchElizaCloudCreditsBalance,
  fetchElizaCloudCreditsSummary,
  fetchElizaCloudUser,
  type ElizaCloudSummaryFields,
} from "./elizacloud-api";
import { persistDistributionExecutionState } from "./persist";
import { getLatestSnapshot } from "./store";
import type {
  CandidateDetail,
  DashboardSnapshot,
  PortfolioPositionDetail,
} from "./types";

const ELIZAOK_LOGO_ASSET_PATHS = [
  path.resolve(process.cwd(), "apps/elizaokbsc/assets/elizaok-logo.png"),
  "/Users/baoger/.cursor/projects/Users-baoger-polymarket-agent/assets/Untitled-20260401-191459-3424-92579f8c-32e9-492a-b56b-cdefdd4c6858.png",
  "/Users/baoger/.cursor/projects/Users-baoger-polymarket-agent/assets/Untitled-20260401-191459-3424-6b4ab8e2-1062-4421-a562-c21be524f0e5.png",
  "/Users/baoger/.cursor/projects/Users-baoger-polymarket-agent/assets/Untitled-20260401-191459-3424-d9d36740-5e03-42ff-93d1-d93cb2e471ef.png",
];

const ELIZAOK_BANNER_ASSET_PATHS = [
  "/Users/baoger/.cursor/projects/Users-baoger-polymarket-agent/assets/1500x500-8f387aee-fe62-46d8-8506-4aa8e185618b.png",
];

async function loadSnapshotFromDisk(
  reportsDir: string,
): Promise<DashboardSnapshot | null> {
  const snapshotPath = path.join(process.cwd(), reportsDir, "latest.json");
  try {
    const content = await readFile(snapshotPath, "utf8");
    return JSON.parse(content) as DashboardSnapshot;
  } catch {
    return null;
  }
}

async function loadCandidateHistoryFromDisk(
  reportsDir: string,
): Promise<CandidateDetail[]> {
  const historyPath = path.join(
    process.cwd(),
    reportsDir,
    "candidate-history.json",
  );
  try {
    const content = await readFile(historyPath, "utf8");
    return JSON.parse(content) as CandidateDetail[];
  } catch {
    return [];
  }
}

function sendJson(
  res: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(payload, null, 2));
}

function sendBinary(
  res: ServerResponse,
  statusCode: number,
  contentType: string,
  payload: Buffer | Uint8Array,
): void {
  res.writeHead(statusCode, { "content-type": contentType });
  res.end(payload);
}

function sendHtml(
  res: ServerResponse,
  statusCode: number,
  html: string,
  cookieHeaders?: string[],
): void {
  res.writeHead(statusCode, {
    "content-type": "text/html; charset=utf-8",
    ...(cookieHeaders && cookieHeaders.length > 0
      ? { "set-cookie": cookieHeaders }
      : {}),
  });
  res.end(html);
}

function sendRedirect(
  res: ServerResponse,
  location: string,
  cookieHeaders?: string[],
): void {
  res.writeHead(302, {
    location,
    ...(cookieHeaders && cookieHeaders.length > 0
      ? { "set-cookie": cookieHeaders }
      : {}),
  });
  res.end();
}

function renderLandingPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>elizaOK | AI Agent on BNB Chain</title>
  <meta name="description" content="elizaOK — AI-powered memecoin discovery and airdrop flywheel on BNB Chain. Powered by elizaOS." />
  ${renderHeadBrandAssets("elizaOK | AI Agent on BNB Chain")}
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Martian+Mono:wght@100..800&display=swap" rel="stylesheet" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --yellow:#F6E70F;--yellow-dim:rgba(246,231,15,0.70);--yellow-muted:rgba(246,231,15,0.40);
      --yellow-glow:rgba(246,231,15,0.55);--yellow-soft:#ffe94d;--black:#000;
    }
    html, body { width:100%;height:100%;background:var(--black);color:var(--yellow);font-family:'Martian Mono',monospace;overflow:hidden; }
    .video-bg { position:fixed;inset:0;z-index:0;transition:transform 0.8s ease-out; }
    .video-bg video { position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transform-origin:center center;transition:opacity 1.2s ease-in-out;opacity:0; }
    .grid-overlay { position:fixed;inset:0;z-index:1;pointer-events:none;background-image:radial-gradient(circle,rgba(246,231,15,0.18) 1px,transparent 1px);background-size:6px 6px; }
    #grain-canvas { position:fixed;inset:0;z-index:2;pointer-events:none;opacity:0.55;mix-blend-mode:screen; }
    .dark-overlay { position:fixed;inset:0;z-index:1;pointer-events:none;background:rgba(0,0,0,0.45); }
    .vignette { position:fixed;inset:0;z-index:3;pointer-events:none;background:radial-gradient(ellipse at 50% 50%,transparent 35%,rgba(0,0,0,0.72) 100%); }
    .hero { position:relative;width:100%;height:100vh;overflow:hidden;z-index:4; }
    .marquee-wrap { position:absolute;inset-x:0;top:0;padding-top:22px;overflow:hidden;z-index:10; }
    .marquee-track { display:flex;width:max-content;gap:32px;animation:marquee 30s linear infinite; }
    .marquee-track span { font-size:12px;color:var(--yellow);white-space:nowrap;font-weight:400;letter-spacing:0.03em;opacity:0.85; }
    @keyframes marquee { 0%{transform:translateX(0);} 100%{transform:translateX(-50%);} }
    .click-listen { position:absolute;top:50px;left:50%;transform:translateX(-50%);font-size:11px;color:var(--yellow-muted);cursor:pointer;letter-spacing:0.1em;z-index:10;transition:color 0.3s,text-shadow 0.3s,opacity 0.4s;white-space:nowrap; }
    .click-listen:hover { color:var(--yellow);text-shadow:0 0 20px var(--yellow-glow); }
    .music-player { position:absolute;top:44px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:14px;z-index:10;opacity:0;transition:opacity 0.4s;pointer-events:none;white-space:nowrap; }
    .music-player.visible { opacity:1;pointer-events:all; }
    .music-player button { background:none;border:none;cursor:pointer;color:var(--yellow);padding:4px;transition:color 0.3s,transform 0.3s,filter 0.3s;display:flex;align-items:center; }
    .music-player button:hover { color:var(--yellow-soft);transform:scale(1.25);filter:drop-shadow(0 0 8px var(--yellow-glow)); }
    .music-player .track-name { font-size:10px;color:var(--yellow-dim);max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
    #yt-player { position:absolute;width:0;height:0;overflow:hidden; }
    .sound-bars { display:inline-flex;align-items:flex-end;gap:2px;height:14px; }
    .sound-bars span { display:inline-block;width:2px;background:var(--yellow);border-radius:1px;animation:soundbar 1.1s ease-in-out infinite; }
    .sound-bars span:nth-child(1){animation-delay:0s;height:40%;} .sound-bars span:nth-child(2){animation-delay:0.2s;height:75%;}
    .sound-bars span:nth-child(3){animation-delay:0.4s;height:50%;} .sound-bars span:nth-child(4){animation-delay:0.6s;height:85%;}
    @keyframes soundbar { 0%,100%{transform:scaleY(0.3);} 50%{transform:scaleY(1);} }
    .social-icons { position:absolute;right:16px;top:50%;transform:translateY(-50%);display:flex;flex-direction:column;align-items:center;gap:20px;z-index:10; }
    @media(min-width:768px){.social-icons{left:32px;right:auto;top:96px;transform:none;flex-direction:row;gap:20px;}}
    .social-icons a { color:var(--yellow);transition:color 0.3s,transform 0.3s,filter 0.3s;display:flex;opacity:0.85; }
    .social-icons a:hover { color:var(--yellow-soft);transform:scale(1.25);filter:drop-shadow(0 0 20px var(--yellow-glow));opacity:1; }
    .bottom-bar { position:absolute;inset-x:0;bottom:0;display:flex;flex-direction:column;padding:0 16px 32px;gap:12px;z-index:10; }
    @media(min-width:768px){.bottom-bar{flex-direction:row;align-items:flex-end;justify-content:space-between;padding:0 64px 48px;}}
    .bottom-title { font-size:26px;font-weight:400;color:var(--yellow);letter-spacing:-0.02em;cursor:pointer;transition:color 0.4s,text-shadow 0.4s,transform 0.3s;text-shadow:0 0 12px rgba(246,231,15,0.3);animation:title-breathe 3s ease-in-out infinite;user-select:none; }
    @media(min-width:768px){.bottom-title{font-size:32px;width:30%;}}
    .bottom-title:hover { color:var(--yellow-soft);text-shadow:0 0 32px var(--yellow-glow),0 0 60px rgba(246,231,15,0.2);transform:scale(1.03); }
    .bottom-title.flash { animation:title-flash 0.5s ease-out; }
    @keyframes title-breathe { 0%,100%{text-shadow:0 0 10px rgba(246,231,15,0.25);} 50%{text-shadow:0 0 22px rgba(246,231,15,0.5),0 0 44px rgba(246,231,15,0.15);} }
    @keyframes title-flash { 0%{color:#fff;text-shadow:0 0 40px var(--yellow),0 0 80px var(--yellow-glow);transform:scale(1.06);} 100%{color:var(--yellow);text-shadow:0 0 10px rgba(246,231,15,0.25);transform:scale(1);} }
    .center-dots { display:inline-flex;gap:6px;pointer-events:none;margin-left:14px;vertical-align:middle; }
    .center-dots span { display:inline-block;width:4px;height:4px;border-radius:50%;background:var(--yellow-muted);animation:dot-wave 2.4s ease-in-out infinite;transition:background 0.3s; }
    .center-dots span:nth-child(1){animation-delay:0s;} .center-dots span:nth-child(2){animation-delay:0.15s;} .center-dots span:nth-child(3){animation-delay:0.3s;}
    .center-dots span:nth-child(4){animation-delay:0.45s;} .center-dots span:nth-child(5){animation-delay:0.6s;} .center-dots span:nth-child(6){animation-delay:0.75s;}
    .center-dots span:nth-child(7){animation-delay:0.9s;} .center-dots span:nth-child(8){animation-delay:1.05s;} .center-dots span:nth-child(9){animation-delay:1.2s;}
    .center-dots span:nth-child(10){animation-delay:1.35s;} .center-dots span:nth-child(11){animation-delay:1.5s;} .center-dots span:nth-child(12){animation-delay:1.65s;}
    @keyframes dot-wave { 0%,100%{opacity:0.25;transform:scale(0.7);box-shadow:none;} 50%{opacity:1;transform:scale(1.4);box-shadow:0 0 8px var(--yellow-glow),0 0 16px rgba(246,231,15,0.2);background:var(--yellow);} }
    .side-badge { position:fixed;right:0;top:50%;transform:translateY(-50%);z-index:20; }
    .side-badge a { display:flex;flex-direction:column;align-items:center;justify-content:center;background:var(--black);color:var(--yellow);font-family:'Martian Mono',monospace;font-size:9px;letter-spacing:0.15em;text-transform:uppercase;text-decoration:none;writing-mode:vertical-rl;padding:16px 8px;gap:8px;border-left:1px solid rgba(246,231,15,0.2);transition:background 0.3s,color 0.3s; }
    .side-badge a:hover { background:rgba(246,231,15,0.06);color:var(--yellow-soft); }
    .badge-dot { width:6px;height:6px;border-radius:50%;background:var(--yellow);animation:pulse 2s ease-in-out infinite; }
    @keyframes pulse { 0%,100%{opacity:1;transform:scale(1);} 50%{opacity:0.4;transform:scale(0.7);} }
    .enter-btn { position:absolute;bottom:120px;left:50%;transform:translateX(-50%);z-index:10;display:inline-flex;align-items:center;gap:8px;padding:12px 32px;font-family:'Martian Mono',monospace;font-size:12px;font-weight:500;letter-spacing:0.08em;text-transform:uppercase;color:var(--yellow);background:transparent;border:1px solid rgba(246,231,15,0.35);border-radius:8px;cursor:pointer;text-decoration:none;transition:all .3s; }
    .enter-btn:hover { background:rgba(246,231,15,0.08);border-color:var(--yellow);box-shadow:0 0 24px var(--yellow-glow);text-shadow:0 0 12px var(--yellow-glow); }
  </style>
</head>
<body>
  <div class="video-bg" id="videoBg">
    <video id="vid-a" muted playsinline preload="auto"><source src="/assets/videobg.mp4" type="video/mp4" /></video>
    <video id="vid-b" muted playsinline preload="auto"><source src="/assets/videobg.mp4" type="video/mp4" /></video>
  </div>
  <div class="dark-overlay"></div>
  <div class="grid-overlay"></div>
  <canvas id="grain-canvas"></canvas>
  <div class="vignette"></div>
  <div class="hero">
    <div class="marquee-wrap"><div class="marquee-track">
      <span>elizaOK &middot; AI agent on BNB Chain &middot; alpha discovery &middot; value layer &middot; powered by elizaOS &middot; elizaOK &middot; AI agent on BNB Chain &middot; alpha discovery &middot; value layer &middot; powered by elizaOS &middot;&nbsp;&nbsp;&nbsp;&nbsp;</span>
      <span>elizaOK &middot; AI agent on BNB Chain &middot; alpha discovery &middot; value layer &middot; powered by elizaOS &middot; elizaOK &middot; AI agent on BNB Chain &middot; alpha discovery &middot; value layer &middot; powered by elizaOS &middot;&nbsp;&nbsp;&nbsp;&nbsp;</span>
    </div></div>
    <div class="music-player" id="musicPlayer">
      <div id="yt-player"></div>
      <div class="sound-bars" id="soundBars"><span></span><span></span><span></span><span></span></div>
      <button id="btnPrev" aria-label="Previous"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="19 20 9 12 19 4 19 20"/><line x1="5" x2="5" y1="19" y2="5"/></svg></button>
      <button id="btnPlay" aria-label="Play/Pause"><svg id="iconPlay" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg><svg id="iconPause" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg></button>
      <span class="track-name" id="trackName">lofi / ambient</span>
      <button id="btnNext" aria-label="Next"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 4 15 12 5 20 5 4"/><line x1="19" x2="19" y1="5" y2="19"/></svg></button>
      <button id="btnShuffle" aria-label="Shuffle"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 18h1.4c1.3 0 2.5-.6 3.3-1.7l6.1-8.6c.7-1.1 2-1.7 3.3-1.7H22"/><path d="m18 2 4 4-4 4"/><path d="M2 6h1.9c1.5 0 2.9.9 3.6 2.2"/><path d="M22 18h-5.9c-1.3 0-2.6-.7-3.3-1.8l-.5-.8"/><path d="m18 14 4 4-4 4"/></svg></button>
    </div>
    <div class="social-icons">
      <a href="https://github.com/elizaokbsc" target="_blank" rel="noopener noreferrer" aria-label="GitHub"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/></svg></a>
      <a href="https://x.com/elizaok_bsc" target="_blank" rel="noopener noreferrer" aria-label="X / Twitter"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 4s-.7 2.1-2 3.4c1.6 10-9.4 17.3-18 11.6 2.2.1 4.4-.6 6-2C3 15.5.5 9.6 3 5c2.2 2.6 5.6 4.1 9 4-.9-4.2 4-6.6 7-3.8 1.1 0 3-1.2 3-1.2z"/></svg></a>
      <a href="/dashboard" aria-label="Dashboard"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/></svg></a>
      <a href="#" id="landing-cloud-btn" aria-label="ElizaCloud" style="cursor:pointer"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg></a>
    </div>
    <div class="bottom-bar">
      <div class="bottom-title" id="bottomTitle"><span id="bottomText">elizaOK agent</span><span class="center-dots"><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span></span></div>
    </div>
  </div>
  <div class="side-badge"><a href="/dashboard"><div class="badge-dot"></div><span>elizaOK</span><span>BNB</span></a></div>
  <script>
    (function(){var c=document.getElementById('grain-canvas'),x=c.getContext('2d'),W,H;function r(){W=c.width=innerWidth;H=c.height=innerHeight;}addEventListener('resize',r);r();function d(){var img=x.createImageData(W,H),dt=img.data;for(var i=0;i<dt.length;i+=4){var v=(Math.random()*255)|0;dt[i]=v;dt[i+1]=(v*0.88)|0;dt[i+2]=0;dt[i+3]=Math.random()<0.35?28:0;}x.putImageData(img,0,0);requestAnimationFrame(d);}d();})();
    (function(){var a=document.getElementById('vid-a'),b=document.getElementById('vid-b'),CF=1.8,act=a,stb=b;function swap(){stb.currentTime=0;stb.play();stb.style.opacity='1';act.style.opacity='0';setTimeout(function(){act.pause();act.currentTime=0;var t=act;act=stb;stb=t;},1300);}function tick(){if(act.duration&&!isNaN(act.duration)){if(act.duration-act.currentTime<=CF&&stb.paused)swap();}requestAnimationFrame(tick);}a.style.opacity='1';a.play().catch(function(){});b.load();requestAnimationFrame(tick);})();
    var vbg=document.getElementById('videoBg'),px=0,py=0,vs=1.15;function apV(){if(vbg)vbg.style.transform='scale('+vs+') translate('+px+'px,'+py+'px)';}document.addEventListener('mousemove',function(e){var cx=innerWidth/2,cy=innerHeight/2;px=(e.clientX-cx)/cx*-14;py=(e.clientY-cy)/cy*-9;apV();});addEventListener('wheel',function(e){e.preventDefault();vs=Math.min(Math.max(vs+e.deltaY*0.001,1.1),1.5);apV();},{passive:false});
    var TRACKS=[{id:'jfKfPfyJRdk',name:'lofi hip hop radio'},{id:'5qap5aO4i9A',name:'lofi chill beats'},{id:'DWcJFNfaw9c',name:'coding lo-fi'},{id:'rUxyKA_-grg',name:'synthwave / retrowave'},{id:'n61ULEU7CO0',name:'dark ambient'}];var cur=0,yt=null,rdy=false,pl=false,ld=false;var cl=document.getElementById('clickListen'),mp=document.getElementById('musicPlayer'),sb=document.getElementById('soundBars'),tn=document.getElementById('trackName'),bp=document.getElementById('btnPlay'),bpv=document.getElementById('btnPrev'),bn=document.getElementById('btnNext'),bs=document.getElementById('btnShuffle'),ip=document.getElementById('iconPlay'),ipa=document.getElementById('iconPause');function ldYT(){if(ld)return;ld=true;var s=document.createElement('script');s.src='https://www.youtube.com/iframe_api';document.head.appendChild(s);}window.onYouTubeIframeAPIReady=function(){yt=new YT.Player('yt-player',{height:'0',width:'0',videoId:TRACKS[cur].id,playerVars:{autoplay:1,controls:0},events:{onReady:function(e){rdy=true;e.target.playVideo();pl=true;uUI();},onStateChange:function(e){if(e.data===YT.PlayerState.PLAYING){pl=true;uUI();}if(e.data===YT.PlayerState.PAUSED){pl=false;uUI();}if(e.data===YT.PlayerState.ENDED)pT(cur+1);}}});};function uUI(){tn.textContent=TRACKS[cur].name;ip.style.display=pl?'none':'block';ipa.style.display=pl?'block':'none';sb.querySelectorAll('span').forEach(function(s){s.style.animationPlayState=pl?'running':'paused';});}function pT(i){cur=((i%TRACKS.length)+TRACKS.length)%TRACKS.length;if(rdy){yt.loadVideoById(TRACKS[cur].id);pl=true;uUI();}}if(cl){cl.addEventListener('click',function(){ldYT();cl.style.opacity='0';cl.style.pointerEvents='none';setTimeout(function(){cl.style.display='none';},400);mp.classList.add('visible');});}bp.addEventListener('click',function(){if(!rdy)return;pl?yt.pauseVideo():yt.playVideo();});bn.addEventListener('click',function(){pT(cur+1);});bpv.addEventListener('click',function(){pT(cur-1);});bs.addEventListener('click',function(){pT(Math.floor(Math.random()*TRACKS.length));});
    /* Bottom title cycle */
    (function(){
      var titles=['elizaOK agent','alpha discovery','position building','value distribution'];
      var idx=0;
      var wrap=document.getElementById('bottomTitle');
      var txt=document.getElementById('bottomText');
      if(!wrap||!txt)return;
      var actx=null;
      function playClick(){
        if(!actx)actx=new (window.AudioContext||window.webkitAudioContext)();
        var t=actx.currentTime;
        var g1=actx.createGain();g1.connect(actx.destination);g1.gain.setValueAtTime(0.10,t);g1.gain.exponentialRampToValueAtTime(0.001,t+0.18);
        var o1=actx.createOscillator();o1.type='sawtooth';o1.frequency.setValueAtTime(2400,t);o1.frequency.exponentialRampToValueAtTime(200,t+0.15);o1.connect(g1);o1.start(t);o1.stop(t+0.16);
        var g2=actx.createGain();g2.connect(actx.destination);g2.gain.setValueAtTime(0.15,t+0.12);g2.gain.exponentialRampToValueAtTime(0.001,t+0.22);
        var o2=actx.createOscillator();o2.type='sine';o2.frequency.setValueAtTime(1400,t+0.12);o2.connect(g2);o2.start(t+0.12);o2.stop(t+0.22);
        var g3=actx.createGain();g3.connect(actx.destination);g3.gain.setValueAtTime(0.08,t+0.14);g3.gain.exponentialRampToValueAtTime(0.001,t+0.25);
        var o3=actx.createOscillator();o3.type='sine';o3.frequency.setValueAtTime(2100,t+0.14);o3.connect(g3);o3.start(t+0.14);o3.stop(t+0.25);
      }
      wrap.addEventListener('click',function(){
        idx=(idx+1)%titles.length;
        wrap.classList.remove('flash');
        void wrap.offsetWidth;
        txt.textContent=titles[idx];
        wrap.classList.add('flash');
        playClick();
      });
    })();
    /* ElizaCloud connect */
    (function(){
      function doFinalPollThenReload(sid,attempt){
        attempt=attempt||0;
        fetch('/api/eliza-cloud/hosted/poll?session='+encodeURIComponent(sid),{credentials:'same-origin'}).then(function(r){return r.json();}).catch(function(){return {};}).then(function(d){
          if((d&&d.status==='authenticated')||attempt>=5){window.location.href='/cloud/agents';return;}
          setTimeout(function(){doFinalPollThenReload(sid,attempt+1);},1200);
        });
      }
      function openCloudAuth(btn){
        if(btn)btn.style.opacity='0.5';
        fetch('/api/eliza-cloud/hosted/start',{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin'}).then(function(r){return r.json();}).then(function(data){
          if(!data.loginUrl){window.location.href='/auth/eliza-cloud?popup=1';return;}
          var p=window.open(data.loginUrl,'elizacloud-auth','width=500,height=640,scrollbars=yes');
          if(!p){window.location.href=data.loginUrl;return;}
          if(data.mode==='cli-session'){var count=0,closed=false;var ti=setInterval(function(){count++;var c;try{c=p.closed;}catch(e){c=true;}if(c&&!closed){closed=true;clearInterval(ti);if(btn)btn.style.opacity='';doFinalPollThenReload(data.sessionId);return;}if(count>90){clearInterval(ti);if(btn)btn.style.opacity='';doFinalPollThenReload(data.sessionId);return;}fetch('/api/eliza-cloud/hosted/poll?session='+encodeURIComponent(data.sessionId),{credentials:'same-origin'}).then(function(r){return r.json();}).then(function(pd){if(pd.status==='authenticated'){clearInterval(ti);try{p.close();}catch(e){}window.location.href='/cloud/agents';}}).catch(function(){});},1500);}else{var closeTi=setInterval(function(){try{if(p.closed){clearInterval(closeTi);window.location.href='/cloud/agents';}}catch(e){}},800);}
        }).catch(function(){window.location.href='/auth/eliza-cloud?popup=1';});
      }
      var cb=document.getElementById('landing-cloud-btn');
      if(cb){cb.addEventListener('click',function(e){e.preventDefault();openCloudAuth(this);});}
    })();
  </script>
</body>
</html>`;
}

function renderCloudPopupResultHtml(
  status: "success" | "error",
  message: string,
): string {
  const escapedMessage = escapeHtml(message);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ElizaOK | ElizaCloud</title>
  <style>
    :root { color-scheme: dark; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #090909;
      color: #f4ecd2;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .panel {
      width: min(420px, calc(100vw - 32px));
      padding: 24px;
      border-radius: 20px;
      border: 1px solid rgba(255,214,10,0.16);
      background: rgba(255,214,10,0.05);
      box-shadow: 0 24px 64px rgba(0,0,0,0.4);
    }
    .eyebrow {
      color: #ffd60a;
      font-size: 11px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      margin-bottom: 10px;
    }
    h1 { margin: 0 0 10px; font-size: 24px; }
    p { margin: 0; line-height: 1.6; color: rgba(244,236,210,0.82); }
  </style>
</head>
<body>
  <div class="panel">
    <div class="eyebrow">ElizaCloud</div>
    <h1>${status === "success" ? "Authentication Complete" : "Authentication Error"}</h1>
    <p>${escapedMessage}</p>
  </div>
  <script>
    try {
      if (window.opener) {
        window.opener.postMessage(
          { type: "eliza-cloud-auth-complete", status: "${status}", message: ${JSON.stringify(message)} },
          "*"
        );
      }
    } catch {}
    window.setTimeout(function () { window.close(); }, 350);
  </script>
</body>
</html>`;
}

function renderCloudCallbackBridgeHtml(popupMode: boolean): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ElizaOK | ElizaCloud Callback</title>
  <style>
    :root { color-scheme: dark; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #090909;
      color: #f4ecd2;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .panel {
      width: min(440px, calc(100vw - 32px));
      padding: 24px;
      border-radius: 20px;
      border: 1px solid rgba(255,214,10,0.16);
      background: rgba(255,214,10,0.05);
      box-shadow: 0 24px 64px rgba(0,0,0,0.4);
    }
    .eyebrow {
      color: #ffd60a;
      font-size: 11px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      margin-bottom: 10px;
    }
    h1 { margin: 0 0 10px; font-size: 24px; }
    p { margin: 0; line-height: 1.6; color: rgba(244,236,210,0.82); }
  </style>
</head>
<body>
  <div class="panel">
    <div class="eyebrow">ElizaCloud</div>
    <h1>Completing Sign-In</h1>
    <p>Finalizing hosted app authentication for ElizaOK...</p>
  </div>
  <script>
    (function () {
      function toObject(params) {
        var result = {};
        params.forEach(function (value, key) {
          result[key] = value;
        });
        return result;
      }
      var search = new URLSearchParams(window.location.search);
      var hash = new URLSearchParams((window.location.hash || "").replace(/^#/, ""));
      var payload = Object.assign({}, toObject(search), toObject(hash), {
        popup: ${popupMode ? '"1"' : '"0"'}
      });
      fetch("/api/eliza-cloud/app-auth/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(payload)
      })
        .then(function (response) {
          return response.json().then(function (data) {
            if (!response.ok) {
              throw new Error(data && data.error ? data.error : "ElizaCloud app auth failed.");
            }
            return data;
          });
        })
        .then(function () {
          if (${popupMode ? "true" : "false"}) {
            try {
              if (window.opener) {
                window.opener.postMessage(
                  { type: "eliza-cloud-auth-complete", status: "success", message: "ElizaCloud connected." },
                  "*"
                );
              }
            } catch {}
            window.close();
            return;
          }
          window.location.href = "/dashboard?cloud_connected=1";
        })
        .catch(function (error) {
          var message = error && error.message ? error.message : String(error);
          if (${popupMode ? "true" : "false"}) {
            try {
              if (window.opener) {
                window.opener.postMessage(
                  { type: "eliza-cloud-auth-complete", status: "error", message: message },
                  "*"
                );
              }
            } catch {}
            document.body.innerHTML =
              '<div class="panel"><div class="eyebrow">ElizaCloud</div><h1>Authentication Error</h1><p>' +
              message.replace(/[<>&]/g, "") +
              "</p></div>";
            return;
          }
          window.location.href = "/dashboard?cloud_error=" + encodeURIComponent(message);
        });
    })();
  </script>
</body>
</html>`;
}

function escapeHtml(value: string | number | null | undefined): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function recommendationTone(value: string): string {
  if (value.includes("buy") || value.includes("candidate")) return "tone-hot";
  if (value.includes("watch") || value.includes("priority")) return "tone-warm";
  return "tone-cool";
}

function formatUsd(value: number): string {
  return `$${Math.round(value).toLocaleString()}`;
}

function formatBnb(value: number): string {
  return `${value.toFixed(4)} BNB`;
}

function formatCompactNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/a";
  return value.toFixed(2);
}

function getElizaCloudDashboardUrl(): string {
  return `${getElizaCloudBaseUrl().replace(/\/$/, "")}/dashboard`;
}

async function fetchWalletNativeBalanceLabel(
  rpcUrl: string | null,
  walletAddress: string,
): Promise<string> {
  if (!rpcUrl || !walletAddress) return "n/a";
  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const balance = await provider.getBalance(walletAddress);
    return `${Number(ethers.formatEther(balance)).toFixed(4)} BNB`;
  } catch {
    return "n/a";
  }
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

interface ElizaCloudSession {
  provider: "eliza-cloud";
  authMode: "demo" | "siwe" | "app-auth";
  displayName: string;
  email: string;
  credits: string;
  model: string;
  agentId: string;
  agentName: string;
  apiKey: string;
  apiKeyHint: string;
  plan: string;
  avatarUrl: string | null;
  walletAddress: string;
  organizationName: string;
  organizationSlug: string;
  appId: string;
}

const ELIZAOK_CLOUD_COOKIE = "elizaok_cloud_session";
const ELIZAOK_CLOUD_STATE_COOKIE = "elizaok_cloud_state";

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header
      .split(";")
      .map((entry) => {
        const separatorIndex = entry.indexOf("=");
        if (separatorIndex === -1) return null;
        return [
          entry.slice(0, separatorIndex).trim(),
          decodeURIComponent(entry.slice(separatorIndex + 1).trim()),
        ] as const;
      })
      .filter((entry): entry is readonly [string, string] => Boolean(entry)),
  );
}

function readElizaCloudSession(
  header: string | undefined,
): ElizaCloudSession | null {
  const raw = parseCookies(header)[ELIZAOK_CLOUD_COOKIE];
  if (!raw) return null;

  try {
    const parsed = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as ElizaCloudSession;
    return parsed?.provider === "eliza-cloud" ? parsed : null;
  } catch {
    return null;
  }
}

function serializeElizaCloudSession(session: ElizaCloudSession): string {
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
  return `${ELIZAOK_CLOUD_COOKIE}=${payload}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`;
}

function clearElizaCloudSession(): string {
  return `${ELIZAOK_CLOUD_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function readElizaCloudAuthState(header: string | undefined): string | null {
  return parseCookies(header)[ELIZAOK_CLOUD_STATE_COOKIE] || null;
}

function serializeElizaCloudAuthState(state: string): string {
  return `${ELIZAOK_CLOUD_STATE_COOKIE}=${encodeURIComponent(state)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=900`;
}

function clearElizaCloudAuthState(): string {
  return `${ELIZAOK_CLOUD_STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function isElizaCloudDemoEnabled(): boolean {
  return process.env.ELIZAOK_ELIZA_CLOUD_DEMO_ENABLED?.trim() === "true";
}

function inferOrigin(req: IncomingMessage): string {
  const protocol =
    (req.headers["x-forwarded-proto"] as string | undefined)
      ?.split(",")[0]
      ?.trim() || "http";
  const host = req.headers.host || "localhost";
  return `${protocol}://${host}`;
}

function isLocalRequest(req: IncomingMessage): boolean {
  const host = (req.headers.host || "").toLowerCase();
  return host.includes("localhost") || host.includes("127.0.0.1");
}

function buildElizaCloudDemoUrl(req: IncomingMessage): string {
  const callbackUrl = new URL(`${inferOrigin(req)}/auth/eliza-cloud/callback`);
  callbackUrl.searchParams.set("name", "Baoger");
  callbackUrl.searchParams.set("email", "baoger@elizacloud.local");
  callbackUrl.searchParams.set("credits", "10,000");
  callbackUrl.searchParams.set("model", "gpt-4o-mini");
  callbackUrl.searchParams.set("api_key", "eliza_demo_7H3K9A");
  callbackUrl.searchParams.set("plan", "ElizaCloud Alpha");
  callbackUrl.searchParams.set("avatar", "/assets/elizaok-logo.png");
  callbackUrl.searchParams.set("mode", "demo");
  return callbackUrl.toString();
}

function getElizaCloudAppId(): string {
  return process.env.ELIZAOK_ELIZA_CLOUD_APP_ID?.trim() || "";
}

function getElizaCloudAuthorizeUrl(): string {
  return (
    process.env.ELIZAOK_ELIZA_CLOUD_AUTHORIZE_URL?.trim() ||
    `${getElizaCloudBaseUrl().replace(/\/$/, "")}/app-auth/authorize`
  );
}

function buildElizaCloudCliLoginUrl(sessionId: string): string {
  return `${getElizaCloudBaseUrl().replace(/\/$/, "")}/auth/cli-login?session=${encodeURIComponent(sessionId)}`;
}

function getElizaCloudCallbackUrl(req: IncomingMessage, popup = false): string {
  const callbackUrl = new URL(
    process.env.ELIZAOK_ELIZA_CLOUD_CALLBACK_URL?.trim() ||
      `${inferOrigin(req)}/auth/eliza-cloud/callback`,
  );
  if (popup) {
    callbackUrl.searchParams.set("popup", "1");
  }
  return callbackUrl.toString();
}

function hasElizaCloudAppAuthConfig(): boolean {
  return Boolean(getElizaCloudAppId() && getElizaCloudAuthorizeUrl());
}

function buildElizaCloudLoginUrl(
  req: IncomingMessage,
  state?: string,
  popup = false,
): string | null {
  if (hasElizaCloudAppAuthConfig()) {
    const loginUrl = new URL(getElizaCloudAuthorizeUrl());
    const callbackUrl = getElizaCloudCallbackUrl(req, popup);
    const appId = getElizaCloudAppId();
    loginUrl.searchParams.set("appId", appId);
    loginUrl.searchParams.set("app_id", appId);
    loginUrl.searchParams.set("redirect_uri", callbackUrl);
    loginUrl.searchParams.set("return_to", callbackUrl);
    loginUrl.searchParams.set("callback_url", callbackUrl);
    loginUrl.searchParams.set("client", "elizaok");
    if (state) {
      loginUrl.searchParams.set("state", state);
    }
    return loginUrl.toString();
  }

  const configured = process.env.ELIZAOK_ELIZA_CLOUD_LOGIN_URL?.trim() || "";
  if (configured) {
    const loginUrl = new URL(configured);
    const callbackUrl = getElizaCloudCallbackUrl(req, popup);
    loginUrl.searchParams.set("return_to", callbackUrl);
    loginUrl.searchParams.set("redirect_uri", callbackUrl);
    loginUrl.searchParams.set("client", "elizaok");
    if (state) {
      loginUrl.searchParams.set("state", state);
    }
    return loginUrl.toString();
  }

  return isLocalRequest(req) && isElizaCloudDemoEnabled()
    ? buildElizaCloudDemoUrl(req)
    : null;
}

function buildElizaCloudSessionFromQuery(
  requestUrl: URL,
): ElizaCloudSession | null {
  const displayName = requestUrl.searchParams.get("name")?.trim() || "";
  const email = requestUrl.searchParams.get("email")?.trim() || "";
  const credits = requestUrl.searchParams.get("credits")?.trim() || "n/a";
  const apiKeyHint =
    requestUrl.searchParams.get("api_key")?.trim() ||
    requestUrl.searchParams.get("apiKey")?.trim() ||
    "n/a";
  const plan = requestUrl.searchParams.get("plan")?.trim() || "ElizaCloud";
  const avatarUrl =
    requestUrl.searchParams.get("avatar_url")?.trim() ||
    requestUrl.searchParams.get("avatar")?.trim() ||
    null;
  const apiKey =
    requestUrl.searchParams.get("api_key_full")?.trim() ||
    requestUrl.searchParams.get("api_key")?.trim() ||
    requestUrl.searchParams.get("apiKey")?.trim() ||
    "";
  const walletAddress = requestUrl.searchParams.get("wallet")?.trim() || "";
  const organizationName =
    requestUrl.searchParams.get("org_name")?.trim() || "ElizaCloud";
  const organizationSlug =
    requestUrl.searchParams.get("org_slug")?.trim() || "elizacloud";

  if (
    !displayName &&
    !email &&
    credits === "n/a" &&
    apiKeyHint === "n/a"
  ) {
    return null;
  }

  return {
    provider: "eliza-cloud",
    authMode:
      requestUrl.searchParams.get("mode")?.trim() === "demo" ? "demo" : "siwe",
    displayName: displayName || email || "ElizaCloud User",
    email: email || "connected-via-elizacloud",
    credits,
    model: "n/a",
    agentId: "",
    agentName: "Eliza",
    apiKey,
    apiKeyHint,
    plan,
    avatarUrl,
    walletAddress,
    organizationName,
    organizationSlug,
    appId:
      requestUrl.searchParams.get("app_id")?.trim() ||
      requestUrl.searchParams.get("appId")?.trim() ||
      "",
  };
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readRequestJson<T>(req: IncomingMessage): Promise<T | null> {
  const body = await readRequestBody(req);
  if (!body.trim()) return null;
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}

function getElizaCloudBaseUrl(): string {
  return process.env.ELIZAOK_ELIZA_CLOUD_URL?.trim() || "https://elizacloud.ai";
}

function getElizaCloudApiBaseUrl(): string {
  return (
    process.env.ELIZAOK_ELIZA_CLOUD_API_URL?.trim() || "https://cloud.milady.ai"
  );
}

function getElizaOkDocsUrl(): string {
  return process.env.ELIZAOK_DOCS_URL?.trim() || "#";
}

function getElizaOkPrivyUrl(): string {
  return process.env.ELIZAOK_PRIVY_URL?.trim() || "https://privy.io/";
}

function getElizaOkPrivyAppId(): string {
  return process.env.ELIZAOK_PRIVY_APP_ID?.trim() || "";
}

function getElizaOkPrivyClientId(): string {
  return process.env.ELIZAOK_PRIVY_CLIENT_ID?.trim() || "";
}

async function connectElizaCloudAppAuth(
  authToken: string,
  appId: string,
): Promise<Response> {
  const url = `${getElizaCloudApiBaseUrl().replace(/\/$/, "")}/api/v1/app-auth/connect`;
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify({ appId }),
  });
}

async function fetchElizaCloudAppAuthSession(
  authToken: string,
  appId: string,
): Promise<Response> {
  const url = `${getElizaCloudApiBaseUrl().replace(/\/$/, "")}/api/v1/app-auth/session`;
  return fetch(url, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${authToken}`,
      "x-app-id": appId,
    },
  });
}

async function createElizaCloudCliSession(
  sessionId: string,
): Promise<Response> {
  const url = `${getElizaCloudBaseUrl().replace(/\/$/, "")}/api/auth/cli-session`;
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ sessionId }),
  });
}

async function fetchElizaCloudCliSession(sessionId: string): Promise<Response> {
  const url = `${getElizaCloudBaseUrl().replace(/\/$/, "")}/api/auth/cli-session/${encodeURIComponent(
    sessionId,
  )}`;
  return fetch(url, {
    headers: {
      accept: "application/json",
    },
  });
}

async function fetchElizaCloudNonce(req: IncomingMessage): Promise<Response> {
  const url = `${getElizaCloudBaseUrl().replace(/\/$/, "")}/api/auth/siwe/nonce`;
  return fetch(url, {
    headers: {
      accept: "application/json",
      ...(req.headers["user-agent"]
        ? { "user-agent": String(req.headers["user-agent"]) }
        : {}),
    },
  });
}

interface ElizaCloudVerifyResponse {
  apiKey: string;
  address: string;
  isNewAccount: boolean;
  user: {
    id: string;
    wallet_address: string | null;
    organization_id: string | null;
  };
  organization: {
    id: string;
    name: string;
    slug: string;
  } | null;
}

async function verifyElizaCloudSiwe(payload: {
  message: string;
  signature: string;
}): Promise<Response> {
  const url = `${getElizaCloudBaseUrl().replace(/\/$/, "")}/api/auth/siwe/verify`;
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(payload),
  });
}

async function createElizaCloudAgent(
  apiKey: string,
  payload: { name: string; bio?: string },
): Promise<Response> {
  const url = `${elizaCloudApiBase()}/api/v1/app/agents`;
  return fetch(url, {
    method: "POST",
    headers: {
      ...elizaCloudAuthHeaders(apiKey),
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

/** Trailing-slash-normalized `ELIZAOK_ELIZA_CLOUD_API_URL` — why: v1 paths must hit the API host, not SIWE host. */
function elizaCloudApiBase(): string {
  return getElizaCloudApiBaseUrl().replace(/\/$/, "");
}

/** Persists dashboard Cloud identity; apiKeyHint uses "Browser session" when key empty — why: app-auth has no key. */
function buildElizaCloudApiSession(
  apiKey: string,
  profile: Partial<ElizaCloudSession> | null,
  authMode: ElizaCloudSession["authMode"] = "siwe",
  appId = "",
): ElizaCloudSession {
  return {
    provider: "eliza-cloud",
    authMode,
    displayName:
      profile?.displayName || profile?.organizationName || "ElizaCloud User",
    email: profile?.email || "connected-via-elizacloud",
    credits: profile?.credits || "linked",
    model: "n/a",
    agentId: profile?.agentId || "",
    agentName: profile?.agentName || "Eliza",
    apiKey,
    apiKeyHint:
      !apiKey || apiKey.length < 4
        ? "Browser session"
        : `${apiKey.slice(0, 10)}...`,
    plan: profile?.plan || "ElizaCloud",
    avatarUrl: profile?.avatarUrl || "/assets/elizaok-logo.png",
    walletAddress: profile?.walletAddress || "",
    organizationName: profile?.organizationName || "ElizaCloud",
    organizationSlug: profile?.organizationSlug || "elizacloud",
    appId,
  };
}

async function buildElizaCloudSessionFromAppAuth(
  authToken: string,
  appId: string,
): Promise<{ session: ElizaCloudSession | null; error: string | null }> {
  if (!authToken.trim()) {
    return { session: null, error: "Missing ElizaCloud auth token." };
  }
  if (!appId.trim()) {
    return { session: null, error: "Missing ElizaCloud app ID." };
  }

  const connectResponse = await connectElizaCloudAppAuth(authToken, appId);
  const connectPayload = (await connectResponse.json().catch(() => null)) as {
    error?: string;
  } | null;
  if (!connectResponse.ok) {
    return {
      session: null,
      error:
        connectPayload?.error || "Failed to connect ElizaCloud app session.",
    };
  }

  const apiBase = elizaCloudApiBase();
  const [appSessionResponse, primaryAgent, profile, credits, creditSummary] =
    await Promise.all([
      fetchElizaCloudAppAuthSession(authToken, appId),
      fetchElizaCloudPrimaryAgentConfig(apiBase, authToken),
      fetchElizaCloudUser(apiBase, authToken),
      fetchElizaCloudCreditsBalance(apiBase, authToken),
      fetchElizaCloudCreditsSummary(apiBase, authToken),
    ]);

  const appSessionPayload = (await appSessionResponse
    .json()
    .catch(() => null)) as {
    success?: boolean;
    error?: string;
    user?: {
      email?: string | null;
      name?: string | null;
      avatar?: string | null;
    };
    app?: { id?: string | null; name?: string | null };
  } | null;

  if (!appSessionResponse.ok || !appSessionPayload?.success) {
    return {
      session: null,
      error:
        appSessionPayload?.error || "Failed to verify ElizaCloud app session.",
    };
  }

  const session = buildElizaCloudApiSession(
    "",
    {
      ...creditSummary,
      ...profile,
      displayName:
        profile?.displayName ||
        appSessionPayload.user?.name ||
        creditSummary?.displayName ||
        profile?.organizationName ||
        "ElizaCloud User",
      email:
        profile?.email ||
        appSessionPayload.user?.email ||
        "connected-via-elizacloud",
      avatarUrl:
        profile?.avatarUrl ||
        appSessionPayload.user?.avatar ||
        "/assets/elizaok-logo.png",
      organizationName:
        profile?.organizationName ||
        creditSummary?.organizationName ||
        appSessionPayload.app?.name ||
        "ElizaCloud",
      // Balance first, then summary, then user placeholder "linked" — why: profile spread can carry credits: "linked".
      credits:
        credits || creditSummary?.credits || profile?.credits || "linked",
      agentId: primaryAgent?.id || "",
      agentName: primaryAgent?.name || "Eliza",
      model: primaryAgent
        ? primaryAgent.modelProvider
          ? `${primaryAgent.modelProvider}/${primaryAgent.model}`
          : primaryAgent.model
        : "n/a",
    },
    "app-auth",
    appId,
  );
  session.apiKeyHint = "Browser session";
  session.plan = profile?.plan || "ElizaCloud App Auth";
  return { session, error: null };
}

async function refreshElizaCloudSession(
  session: ElizaCloudSession | null,
): Promise<{ session: ElizaCloudSession | null; summary: ElizaCloudSummaryFields | null }> {
  if (!session) {
    return { session: null, summary: null };
  }
  if (!session.apiKey) {
    return { session, summary: null };
  }

  const apiBase = elizaCloudApiBase();
  let primaryAgent = null;
  let profile = null;
  let credits: string | null = null;
  let creditSummary: ElizaCloudSummaryFields | null = null;

  try {
    [primaryAgent, profile, credits, creditSummary] = await Promise.all([
      fetchElizaCloudPrimaryAgentConfig(apiBase, session.apiKey),
      fetchElizaCloudUser(apiBase, session.apiKey),
      fetchElizaCloudCreditsBalance(apiBase, session.apiKey),
      fetchElizaCloudCreditsSummary(apiBase, session.apiKey),
    ]);
  } catch {
    // API unreachable — return stored session as-is so the UI keeps showing real data
    return { session, summary: null };
  }

  // If ALL API calls failed (all null), preserve the stored session unchanged
  // so the UI doesn't degrade to "ElizaCloud User" / "linked"
  if (!profile && !credits && !creditSummary && !primaryAgent) {
    return { session, summary: null };
  }

  const refreshed = buildElizaCloudApiSession(
    session.apiKey,
    {
      ...creditSummary,
      ...profile,
      // Always prefer live API data; fall back to stored session values (never "unknown" defaults)
      displayName:
        profile?.displayName ||
        creditSummary?.displayName ||
        session.displayName ||
        session.organizationName ||
        "ElizaCloud User",
      email: profile?.email || session.email || "connected-via-elizacloud",
      avatarUrl:
        profile?.avatarUrl || session.avatarUrl || "/assets/elizaok-logo.png",
      walletAddress: profile?.walletAddress || session.walletAddress || "",
      organizationName:
        profile?.organizationName ||
        creditSummary?.organizationName ||
        session.organizationName ||
        "ElizaCloud",
      organizationSlug:
        profile?.organizationSlug ||
        session.organizationSlug ||
        "elizacloud",
      credits:
        credits ||
        creditSummary?.credits ||
        profile?.credits ||
        session.credits ||
        "linked",
      plan: profile?.plan || session.plan || "ElizaCloud",
      agentId: primaryAgent?.id || session.agentId || "",
      agentName: primaryAgent?.name || session.agentName || "Eliza",
      model: primaryAgent
        ? primaryAgent.modelProvider
          ? `${primaryAgent.modelProvider}/${primaryAgent.model}`
          : primaryAgent.model
        : session.model || "n/a",
    },
    session.authMode,
    session.appId,
  );
  refreshed.apiKeyHint = session.apiKeyHint || refreshed.apiKeyHint;
  return { session: refreshed, summary: creditSummary };
}

function shortAddress(value: string): string {
  if (value.length < 14) return value;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function candidateHref(tokenAddress: string): string {
  return `/candidate?token=${encodeURIComponent(tokenAddress)}`;
}

function portfolioHref(tokenAddress: string): string {
  return `/api/elizaok/portfolio/positions?token=${encodeURIComponent(tokenAddress)}`;
}

function gooCandidateHref(agentId: string): string {
  return `/goo-candidate?agent=${encodeURIComponent(agentId)}`;
}

function formatSeconds(value: number | null): string {
  if (value === null) return "n/a";
  if (value < 60) return `${value}s`;
  if (value < 3_600) return `${Math.round(value / 60)}m`;
  if (value < 86_400) return `${Math.round(value / 3_600)}h`;
  return `${Math.round(value / 86_400)}d`;
}

function buildGooReadiness(config: ReturnType<typeof getDiscoveryConfig>) {
  const checklist = [
    {
      label: "Module enabled",
      done: config.goo.enabled,
      detail: config.goo.enabled
        ? "Goo scan loop is enabled."
        : "Enable ELIZAOK_GOO_SCAN_ENABLED.",
    },
    {
      label: "RPC configured",
      done: Boolean(config.goo.rpcUrl),
      detail: config.goo.rpcUrl
        ? "RPC endpoint is configured."
        : "Add ELIZAOK_GOO_RPC_URL.",
    },
    {
      label: "Registry configured",
      done: Boolean(config.goo.registryAddress),
      detail: config.goo.registryAddress
        ? "Registry address is configured."
        : "Add ELIZAOK_GOO_REGISTRY_ADDRESS.",
    },
  ];
  const score = checklist.filter((item) => item.done).length;

  return {
    checklist,
    score,
    total: checklist.length,
    configured: score === checklist.length,
    nextAction:
      score === checklist.length
        ? "Live Goo scanning is ready. The operator layer can now be judged on candidate quality."
        : checklist.find((item) => !item.done)?.detail ||
          "Complete remaining Goo configuration checks.",
  };
}

function buildGooCandidateDetail(
  candidate: DashboardSnapshot["topGooCandidates"][number],
  config: ReturnType<typeof getDiscoveryConfig>,
) {
  const readiness = buildGooReadiness(config);
  const treasuryStressGapBnb = Math.max(
    0,
    candidate.starvingThresholdBnb - candidate.treasuryBnb,
  );
  const urgency =
    candidate.status === "DYING"
      ? "critical"
      : candidate.status === "STARVING"
        ? "high"
        : candidate.secondsUntilPulseTimeout !== null &&
            candidate.secondsUntilPulseTimeout < 3_600
          ? "high"
          : candidate.recommendation === "priority_due_diligence"
            ? "medium"
            : "low";
  const operatorAction =
    candidate.recommendation === "cto_candidate"
      ? "Prepare claimCTO parameters, capital guardrails, and post-acquisition genome fusion plan."
      : candidate.recommendation === "priority_due_diligence"
        ? "Run full due diligence on skill overlap, treasury ROI, and rescue timing before any CTO attempt."
        : candidate.recommendation === "monitor"
          ? "Keep the agent in the operator queue and wait for stronger distress or clearer synergy."
          : "Ignore for now and focus operator attention on stronger turnaround targets.";
  const acquisitionFit =
    candidate.minimumCtoBnb <= 0.2
      ? "Low-friction experimental CTO size."
      : candidate.minimumCtoBnb <= 1
        ? "Manageable CTO size with caution."
        : "High CTO floor for MVP treasury deployment.";

  return {
    candidate,
    readiness,
    urgency,
    treasuryStressGapBnb,
    operatorAction,
    acquisitionFit,
    pulseWindowLabel: formatSeconds(candidate.secondsUntilPulseTimeout),
  };
}

function buildPortfolioPositionDetail(
  snapshot: DashboardSnapshot | null,
  tokenAddress: string,
): PortfolioPositionDetail {
  const allPositions = [
    ...(snapshot?.portfolioLifecycle.activePositions ?? []),
    ...(snapshot?.portfolioLifecycle.watchPositions ?? []),
    ...(snapshot?.portfolioLifecycle.exitedPositions ?? []),
  ];
  const position =
    allPositions.find(
      (item) => item.tokenAddress.toLowerCase() === tokenAddress.toLowerCase(),
    ) ?? null;
  const timeline = (snapshot?.portfolioLifecycle.timeline ?? []).filter(
    (event) => event.tokenAddress.toLowerCase() === tokenAddress.toLowerCase(),
  );

  return {
    tokenAddress,
    tokenSymbol: position?.tokenSymbol ?? "Unknown",
    position,
    timeline,
  };
}

function renderBrandLogoImage(className = "brand-image"): string {
  return `<img class="${className}" src="/assets/elizaok-logo.png" alt="ElizaOK logo" />`;
}

function renderHeadBrandAssets(title: string): string {
  const safeTitle = escapeHtml(title);
  return `
  <title>${safeTitle}</title>
  <link rel="icon" type="image/png" href="/assets/elizaok-logo.png" />
  <link rel="apple-touch-icon" href="/assets/elizaok-logo.png" />
  <meta property="og:title" content="${safeTitle}" />
  <meta property="og:image" content="/assets/elizaok-logo.png" />
  <meta name="twitter:card" content="summary" />
  <meta name="twitter:title" content="${safeTitle}" />
  <meta name="twitter:image" content="/assets/elizaok-logo.png" />`;
}

function renderGithubIconSvg(): string {
  return `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5a12 12 0 0 0-3.79 23.39c.6.12.82-.26.82-.58v-2.04c-3.34.73-4.04-1.42-4.04-1.42-.54-1.38-1.34-1.75-1.34-1.75-1.1-.74.08-.73.08-.73 1.22.09 1.86 1.25 1.86 1.25 1.08 1.86 2.84 1.32 3.53 1.01.11-.79.42-1.32.76-1.63-2.67-.3-5.47-1.34-5.47-5.95 0-1.31.47-2.38 1.24-3.22-.13-.31-.54-1.53.12-3.19 0 0 1.01-.32 3.3 1.23a11.4 11.4 0 0 1 6 0c2.28-1.55 3.29-1.23 3.29-1.23.66 1.66.25 2.88.12 3.19.77.84 1.24 1.91 1.24 3.22 0 4.62-2.8 5.65-5.48 5.95.43.37.81 1.1.81 2.23v3.31c0 .32.21.7.82.58A12 12 0 0 0 12 .5Z"/></svg>`;
}

function renderXIconSvg(): string {
  return `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.9 2H22l-6.77 7.74L23.2 22h-6.26l-4.9-7.4L5.53 22H2.4l7.24-8.28L1.2 2H7.6l4.43 6.73L18.9 2Zm-1.1 18h1.73L6.66 3.9H4.8L17.8 20Z"/></svg>`;
}

function renderDocsIconSvg(): string {
  return `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="M7 3.75A2.25 2.25 0 0 0 4.75 6v12A2.25 2.25 0 0 0 7 20.25h10A2.25 2.25 0 0 0 19.25 18V8.56a2.25 2.25 0 0 0-.66-1.59l-2.56-2.56a2.25 2.25 0 0 0-1.59-.66H7Z" stroke="currentColor" stroke-width="1.6"/><path d="M14 3.75V7a1 1 0 0 0 1 1h3.25" stroke="currentColor" stroke-width="1.6"/><path d="M8 11.25h8M8 14.75h8M8 18.25h5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;
}

function renderProgress(
  label: string,
  current: number,
  max: number,
  meta: string,
): string {
  const pct = max > 0 ? clampPercent((current / max) * 100) : 0;
  return `
    <div class="progress-row">
      <span>${escapeHtml(label)}</span>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
      <span class="progress-val">${escapeHtml(meta)}</span>
    </div>`;
}

function renderMetricCard(
  label: string,
  value: string,
  detail: string,
): string {
  return `
    <div class="metric-card">
      <div class="metric-card__label">${escapeHtml(label)}</div>
      <div class="metric-card__val">${escapeHtml(value)}</div>
      <div class="metric-card__desc">${escapeHtml(detail)}</div>
    </div>`;
}

function renderFeatureDockCard(
  targetId: string,
  label: string,
  pctLabel: string,
  value: string,
  meta: string,
  pct: number,
  tone: "hot" | "warm" | "cool" = "cool",
  yesLabel = "SIGNAL",
  noLabel = "TOTAL",
  yesValue = value,
  noValue = meta,
): string {
  const safePct = clampPercent(pct);
  // hermes-agent style card with data-modal for click-to-detail
  return `
    <div
      class="feature-card"
      data-modal="${escapeHtml(targetId)}"
      data-label="${escapeHtml(label)}"
      role="button"
      tabindex="0"
    >
      <div class="feature-card__hover-bg"></div>
      <div class="feature-card__label">${escapeHtml(label)}</div>
      <div class="feature-card__pct">${escapeHtml(pctLabel)}</div>
      <div class="feature-card__val">${escapeHtml(value)}</div>
      <div class="feature-card__meta">${escapeHtml(yesLabel)} ${escapeHtml(yesValue)} · ${escapeHtml(noLabel)} ${escapeHtml(noValue)}</div>
      <div class="feature-card__bar">
        <div class="feature-card__bar-fill" style="width:${safePct}%"></div>
      </div>
    </div>`;
}

function formatPct(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "n/a";
  return `${Math.round(value)}%`;
}

function formatDuration(ms: number | null): string {
  if (ms === null || ms <= 0 || Number.isNaN(ms)) return "n/a";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = ms / 3_600_000;
  if (hours < 24) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

function formatRelativeTime(iso: string | null): string {
  if (!iso) return "n/a";
  const diff = Date.now() - Date.parse(iso);
  if (!Number.isFinite(diff) || diff < 0) return iso;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function renderUsageRow(label: string, pct: number, value: string): string {
  const safePct = clampPercent(pct);
  return `
    <div class="usage-row">
      <span class="usage-label">${escapeHtml(label)}</span>
      <div class="usage-bar"><div class="usage-fill" style="width:${safePct}%"></div></div>
      <span class="usage-val">${escapeHtml(value)}</span>
    </div>`;
}

function renderCandidateDetail(
  detail: CandidateDetail,
  portfolioDetail: PortfolioPositionDetail | null,
): string {
  const historyRows = detail.history
    .map(
      (entry) => `
        <tr>
          <td>${escapeHtml(entry.generatedAt)}</td>
          <td>${entry.score}</td>
          <td>${escapeHtml(entry.recommendation)}</td>
          <td>${formatUsd(entry.reserveUsd)}</td>
          <td>${formatUsd(entry.volumeUsdM5)}</td>
        </tr>`,
    )
    .join("");
  const position = portfolioDetail?.position ?? null;
  const treasuryTimelineRows =
    portfolioDetail?.timeline
      .map(
        (event) => `
        <tr>
          <td>${escapeHtml(event.generatedAt)}</td>
          <td>${escapeHtml(event.type)}</td>
          <td>${escapeHtml(event.stateAfter)}</td>
          <td>${escapeHtml(event.detail)}</td>
        </tr>`,
      )
      .join("") || "";
  const backHref = `/?view=discovery`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  ${renderHeadBrandAssets(`${detail.tokenSymbol} | ElizaOK`)}
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Kode+Mono:wght@400;500;700&display=swap" rel="stylesheet">
  <style>
    :root {
      color-scheme: dark;
      --bg: #16130e;
      --bg-soft: #242017;
      --panel: rgba(24,21,16,.9);
      --border: rgba(215,164,40,.16);
      --border-strong: rgba(240,198,79,.3);
      --text: #f4ecd2;
      --muted: #bca36d;
      --accent: #d7a428;
      --shadow: rgba(0,0,0,.55);
    }
    * { box-sizing:border-box; }
    body {
      margin:0;
      background:
        radial-gradient(circle at 18% 14%, rgba(215,164,40,.08), transparent 18%),
        radial-gradient(circle at 82% 22%, rgba(215,164,40,.04), transparent 16%),
        linear-gradient(180deg, #040404 0%, #080808 55%, #060606 100%);
      color:var(--text);
      font-family:"Kode Mono", monospace;
      padding:24px;
    }
    body::before {
      content:"";
      position:fixed;
      inset:0;
      pointer-events:none;
      background-image:
        linear-gradient(rgba(215,164,40,.018) 1px, transparent 1px),
        linear-gradient(90deg, rgba(215,164,40,.018) 1px, transparent 1px),
        repeating-linear-gradient(180deg, rgba(255,255,255,0.018) 0 1px, transparent 1px 18px);
      background-size:34px 34px, 34px 34px, 100% 18px;
      mask-image:linear-gradient(180deg, rgba(0,0,0,.82), transparent);
    }
    body::after {
      content:"";
      position:fixed;
      inset:0;
      pointer-events:none;
      background:
        radial-gradient(circle at 18% 20%, rgba(255,255,255,.03), transparent 14%),
        radial-gradient(circle at 72% 24%, rgba(215,164,40,.05), transparent 18%),
        radial-gradient(circle at 60% 76%, rgba(215,164,40,.035), transparent 18%);
      opacity:.7;
    }
    a { color:inherit; text-decoration:none; }
    .shell { max-width:1240px; margin:0 auto; position:relative; z-index:1; }
    .topbar {
      display:flex;
      justify-content:space-between;
      align-items:center;
      gap:16px;
      padding:16px 20px;
      margin-bottom:18px;
      border-radius:24px;
      border:1px solid var(--border);
      background:rgba(20,18,14,.82);
      box-shadow:0 18px 48px rgba(0,0,0,.28);
      backdrop-filter:blur(10px);
    }
    .topbar-left { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
    .brand-logo {
      width: 48px;
      height: 48px;
      border-radius: 14px;
      overflow: hidden;
      border: 1px solid rgba(255,214,10,.18);
      box-shadow: 0 0 24px rgba(255,214,10,.12);
      background: rgba(215,164,40,.06);
      display: grid;
      place-items: center;
    }
    .brand-image {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .live-dot {
      width:12px;
      height:12px;
      border-radius:999px;
      background:var(--accent);
      box-shadow:0 0 18px rgba(255,214,10,.72);
    }
    .brand strong { display:block; font-size:14px; text-transform:uppercase; letter-spacing:.08em; }
    .brand small { display:block; color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.12em; }
    .top-chip {
      padding:10px 13px;
      border-radius:999px;
      background:rgba(255,214,10,.07);
      border:1px solid rgba(255,214,10,.14);
      font-size:12px;
    }
    .social-actions { display:flex; gap:10px; }
    .social-link, .back-link {
      display:inline-flex;
      align-items:center;
      justify-content:center;
      gap:8px;
      height:44px;
      padding:0 14px;
      border-radius:14px;
      border:1px solid rgba(255,214,10,.14);
      background:rgba(255,214,10,.04);
      transition:180ms ease;
    }
    .social-link { width:44px; padding:0; }
    .social-link:hover, .back-link:hover {
      color:var(--accent);
      border-color:var(--border-strong);
      box-shadow:0 0 24px rgba(255,214,10,.1);
      transform:translateY(-1px);
    }
    .social-link svg { width:20px; height:20px; }
    .hero, .card {
      border-radius:28px;
      border:1px solid var(--border);
      background:
        linear-gradient(180deg, rgba(255,214,10,.07), rgba(255,214,10,.015)),
        var(--panel);
      box-shadow:0 24px 72px var(--shadow);
      overflow:hidden;
      position:relative;
    }
    .hero {
      padding:28px;
      margin-bottom:18px;
    }
    .hero::before {
      content:"";
      position:absolute;
      inset:-20% auto auto 62%;
      width:300px;
      height:300px;
      border-radius:50%;
      background:radial-gradient(circle, rgba(255,214,10,.18), transparent 68%);
    }
    .eyebrow {
      display:inline-flex;
      align-items:center;
      gap:10px;
      color:var(--accent);
      text-transform:uppercase;
      letter-spacing:.18em;
      font-size:11px;
    }
    .eyebrow::before {
      content:"";
      width:8px;
      height:8px;
      border-radius:999px;
      background:var(--accent);
      box-shadow:0 0 14px rgba(255,214,10,.7);
    }
    h1 {
      margin:16px 0 10px;
      font-size:clamp(40px, 6vw, 72px);
      line-height:.95;
      letter-spacing:-.05em;
      max-width:8ch;
    }
    p { color:var(--muted); line-height:1.8; margin:0; }
    .hero-copy { max-width:760px; }
    .hero-meta {
      display:flex;
      flex-wrap:wrap;
      gap:10px;
      margin-top:18px;
    }
    .hero-meta .top-chip { color:var(--text); }
    .grid, .split-grid {
      display:grid;
      gap:18px;
      margin-bottom:18px;
    }
    .grid { grid-template-columns:repeat(3,minmax(0,1fr)); }
    .split-grid { grid-template-columns:1.15fr .85fr; }
    .card { padding:24px; }
    .metric {
      padding:16px;
      border-radius:18px;
      background:rgba(255,214,10,.05);
      border:1px solid rgba(255,214,10,.12);
    }
    .metric span {
      display:block;
      color:var(--muted);
      font-size:11px;
      text-transform:uppercase;
      letter-spacing:.14em;
      margin-bottom:8px;
    }
    .metric strong { font-size:22px; line-height:1.35; }
    .stack { display:grid; gap:14px; }
    table { width:100%; border-collapse:collapse; }
    th, td {
      padding:12px 10px;
      border-bottom:1px solid rgba(255,214,10,.08);
      text-align:left;
      font-size:13px;
      vertical-align:top;
    }
    th { color:var(--accent); font-size:11px; text-transform:uppercase; letter-spacing:.14em; }
    .table-shell {
      border-radius:18px;
      overflow:hidden;
      border:1px solid rgba(255,214,10,.08);
      background:rgba(255,214,10,.03);
    }
    .footer-note {
      margin-top:16px;
      font-size:12px;
      color:var(--muted);
      line-height:1.8;
      word-break:break-word;
    }
    @media (max-width: 980px) {
      .grid, .split-grid { grid-template-columns:1fr; }
      .topbar { flex-direction:column; align-items:flex-start; }
      .social-actions { width:100%; justify-content:flex-end; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header class="topbar">
      <div class="topbar-left">
        <div class="live-dot" aria-hidden="true"></div>
        <div class="brand-logo">${renderBrandLogoImage()}</div>
        <div class="brand">
          <strong>Candidate Detail</strong>
          <small></small>
        </div>
        <div class="top-chip">${escapeHtml(shortAddress(detail.tokenAddress))}</div>
        <div class="top-chip">${escapeHtml(detail.latest.recommendation)}</div>
      </div>
      <div class="social-actions">
        <a class="back-link" href="${backHref}">Back</a>
        <a class="social-link" href="https://github.com/elizaokbsc" target="_blank" rel="noreferrer" aria-label="GitHub">
          ${renderGithubIconSvg()}
        </a>
        <a class="social-link" href="https://x.com/elizaok_bsc" target="_blank" rel="noreferrer" aria-label="X">
          ${renderXIconSvg()}
        </a>
      </div>
    </header>
    <section class="hero">
      <div class="eyebrow">elizaok</div>
      <h1>${escapeHtml(detail.tokenSymbol)}</h1>
      <div class="hero-meta">
        <div class="top-chip">Latest score ${detail.latest.score}/100</div>
        <div class="top-chip">Conviction ${escapeHtml(detail.latest.conviction)}</div>
        <div class="top-chip">Appearances ${detail.history.length}</div>
      </div>
    </section>
    <div class="grid">
      <div class="grid">
        <div class="metric"><span>Latest score</span><strong>${detail.latest.score}/100</strong></div>
        <div class="metric"><span>Conviction</span><strong>${escapeHtml(detail.latest.conviction)}</strong></div>
        <div class="metric"><span>Appearances</span><strong>${detail.history.length}</strong></div>
      </div>
    </div>
    <section class="split-grid">
    <div class="card">
      <div class="eyebrow">Treasury Position</div>
      <div class="grid">
        <div class="metric"><span>State</span><strong>${escapeHtml(position?.state || "not_in_portfolio")}</strong></div>
        <div class="metric"><span>Lane</span><strong>${escapeHtml(position?.executionSource || "n/a")}</strong></div>
        <div class="metric"><span>Wallet</span><strong>${escapeHtml(position?.walletVerification || "n/a")}</strong></div>
        <div class="metric"><span>Realized PnL</span><strong>${position ? `${position.realizedPnlUsd >= 0 ? "+" : ""}${formatUsd(position.realizedPnlUsd)}` : "n/a"}</strong></div>
        <div class="metric"><span>Unrealized PnL</span><strong>${position ? `${position.unrealizedPnlUsd >= 0 ? "+" : ""}${formatUsd(position.unrealizedPnlUsd)}` : "n/a"}</strong></div>
        <div class="metric"><span>Initial allocation</span><strong>${position ? formatUsd(position.initialAllocationUsd) : "n/a"}</strong></div>
        <div class="metric"><span>Current allocation</span><strong>${position ? formatUsd(position.allocationUsd) : "n/a"}</strong></div>
        <div class="metric"><span>Token balance</span><strong>${escapeHtml(position?.walletTokenBalance || "n/a")}</strong></div>
        <div class="metric"><span>Quote route</span><strong>${escapeHtml(position?.walletQuoteRoute || "n/a")}</strong></div>
        <div class="metric"><span>Quote value</span><strong>${position?.walletQuoteUsd !== null && position?.walletQuoteUsd !== undefined ? formatUsd(position.walletQuoteUsd) : "n/a"}</strong></div>
        <div class="metric"><span>TP stages hit</span><strong>${position ? `${position.takeProfitCount} (${escapeHtml(position.takeProfitStagesHit.join(", ") || "none")})` : "n/a"}</strong></div>
      </div>
      <div class="metric"><span>Portfolio</span><strong><a href="${portfolioHref(detail.tokenAddress)}">open api</a></strong></div>
    </div>
    <div class="card">
      <div class="eyebrow">Latest State</div>
      <div class="grid">
        <div class="metric"><span>Recommendation</span><strong>${escapeHtml(detail.latest.recommendation)}</strong></div>
        <div class="metric"><span>Liquidity</span><strong>${formatUsd(detail.latest.reserveUsd)}</strong></div>
        <div class="metric"><span>Volume 5m</span><strong>${formatUsd(detail.latest.volumeUsdM5)}</strong></div>
        <div class="metric"><span>Age</span><strong>${detail.latest.poolAgeMinutes}m</strong></div>
        <div class="metric"><span>FDV</span><strong>${detail.latest.fdvUsd !== null ? formatUsd(detail.latest.fdvUsd) : "n/a"}</strong></div>
        <div class="metric"><span>Market cap</span><strong>${detail.latest.marketCapUsd !== null ? formatUsd(detail.latest.marketCapUsd) : "n/a"}</strong></div>
      </div>
    </div>
    </section>
    <div class="card">
      <div class="eyebrow">Run history</div>
      <div class="table-shell"><table>
        <thead>
          <tr><th>Generated</th><th>Score</th><th>Recommendation</th><th>Liquidity</th><th>Volume 5m</th></tr>
        </thead>
        <tbody>${historyRows}</tbody>
      </table></div>
    </div>
    <div class="card">
      <div class="eyebrow">Treasury timeline</div>
      <div class="table-shell"><table>
        <thead>
          <tr><th>Generated</th><th>Event</th><th>State after</th><th>Detail</th></tr>
        </thead>
        <tbody>${treasuryTimelineRows || '<tr><td colspan="4">No treasury lifecycle events yet.</td></tr>'}</tbody>
      </table></div>
    </div>
  </main>
</body>
</html>`;
}

function renderGooCandidateDetail(
  detail: ReturnType<typeof buildGooCandidateDetail>,
): string {
  const {
    candidate,
    readiness,
    urgency,
    treasuryStressGapBnb,
    operatorAction,
    acquisitionFit,
    pulseWindowLabel,
  } = detail;
  const backHref = `/?view=goo`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  ${renderHeadBrandAssets(`Goo Agent ${candidate.agentId} | ElizaOK`)}
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Kode+Mono:wght@400;500;700&display=swap" rel="stylesheet">
  <style>
    :root {
      color-scheme: dark;
      --bg: #16130e;
      --bg-soft: #242017;
      --panel: rgba(24,21,16,.9);
      --border: rgba(215,164,40,.16);
      --border-strong: rgba(240,198,79,.3);
      --text: #f4ecd2;
      --muted: #bca36d;
      --accent: #d7a428;
      --shadow: rgba(0,0,0,.55);
    }
    * { box-sizing:border-box; }
    body {
      margin:0;
      background:
        radial-gradient(circle at 8% 18%, rgba(244,239,221,.78), rgba(244,239,221,.12) 18%, transparent 42%),
        linear-gradient(90deg, rgba(244,239,221,.06), transparent 28%),
        linear-gradient(180deg, var(--bg) 0%, var(--bg-soft) 100%);
      color:var(--text);
      font-family:"Kode Mono", monospace;
      padding:24px;
    }
    body::before {
      content:"";
      position:fixed;
      inset:0;
      pointer-events:none;
      background-image:
        linear-gradient(rgba(215,164,40,.022) 1px, transparent 1px),
        linear-gradient(90deg, rgba(215,164,40,.022) 1px, transparent 1px);
      background-size:34px 34px;
      mask-image:linear-gradient(180deg, rgba(0,0,0,.82), transparent);
    }
    body::after {
      content:"";
      position:fixed;
      inset:0;
      pointer-events:none;
      background:
        radial-gradient(circle at 18% 20%, rgba(244,239,221,.08), transparent 14%),
        radial-gradient(circle at 72% 24%, rgba(215,164,40,.05), transparent 18%),
        radial-gradient(circle at 60% 76%, rgba(215,164,40,.04), transparent 18%);
      opacity:.9;
    }
    a { color:inherit; text-decoration:none; }
    .shell { max-width:1240px; margin:0 auto; position:relative; z-index:1; }
    .topbar {
      display:flex;
      justify-content:space-between;
      align-items:center;
      gap:16px;
      padding:16px 20px;
      margin-bottom:18px;
      border-radius:24px;
      border:1px solid var(--border);
      background:rgba(20,18,14,.82);
      box-shadow:0 18px 48px rgba(0,0,0,.28);
      backdrop-filter:blur(10px);
    }
    .topbar-left { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
    .brand-logo {
      width: 48px;
      height: 48px;
      border-radius: 14px;
      overflow: hidden;
      border: 1px solid rgba(255,214,10,.18);
      box-shadow: 0 0 24px rgba(215,164,40,.12);
      background: rgba(215,164,40,.06);
      display: grid;
      place-items: center;
    }
    .brand-image {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .live-dot {
      width:12px;
      height:12px;
      border-radius:999px;
      background:var(--accent);
      box-shadow:0 0 18px rgba(255,214,10,.72);
    }
    .brand strong { display:block; font-size:14px; text-transform:uppercase; letter-spacing:.08em; }
    .brand small { display:block; color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.12em; }
    .top-chip {
      padding:10px 13px;
      border-radius:999px;
      background:rgba(255,214,10,.07);
      border:1px solid rgba(255,214,10,.14);
      font-size:12px;
    }
    .social-actions { display:flex; gap:10px; }
    .social-link, .back-link {
      display:inline-flex;
      align-items:center;
      justify-content:center;
      gap:8px;
      height:44px;
      padding:0 14px;
      border-radius:14px;
      border:1px solid rgba(255,214,10,.14);
      background:rgba(255,214,10,.04);
      transition:180ms ease;
    }
    .social-link { width:44px; padding:0; }
    .social-link:hover, .back-link:hover {
      color:var(--accent);
      border-color:var(--border-strong);
      box-shadow:0 0 24px rgba(255,214,10,.1);
      transform:translateY(-1px);
    }
    .social-link svg { width:20px; height:20px; }
    .hero, .card {
      border-radius:28px;
      border:1px solid var(--border);
      background:
        linear-gradient(180deg, rgba(215,164,40,.08), rgba(215,164,40,.02)),
        var(--panel);
      box-shadow:0 24px 72px var(--shadow);
      overflow:hidden;
      position:relative;
    }
    .hero {
      padding:28px;
      margin-bottom:18px;
    }
    .hero::before {
      content:"";
      position:absolute;
      inset:-20% auto auto 62%;
      width:300px;
      height:300px;
      border-radius:50%;
      background:radial-gradient(circle, rgba(215,164,40,.18), transparent 68%);
    }
    .eyebrow {
      display:inline-flex;
      align-items:center;
      gap:10px;
      color:var(--accent);
      text-transform:uppercase;
      letter-spacing:.18em;
      font-size:11px;
    }
    .eyebrow::before {
      content:"";
      width:8px;
      height:8px;
      border-radius:999px;
      background:var(--accent);
      box-shadow:0 0 14px rgba(255,214,10,.7);
    }
    h1 {
      margin:16px 0 10px;
      font-size:clamp(40px, 6vw, 72px);
      line-height:.95;
      letter-spacing:-.05em;
      max-width:8ch;
    }
    p { color:var(--muted); line-height:1.8; margin:0; }
    .hero-copy { max-width:760px; }
    .hero-meta { display:flex; flex-wrap:wrap; gap:10px; margin-top:18px; }
    .hero-meta .top-chip { color:var(--text); }
    .grid, .split-grid {
      display:grid;
      gap:18px;
      margin-bottom:18px;
    }
    .grid { grid-template-columns:repeat(3,minmax(0,1fr)); }
    .split-grid { grid-template-columns:1.1fr .9fr; }
    .card { padding:24px; }
    .metric {
      padding:16px;
      border-radius:18px;
      background:rgba(255,214,10,.05);
      border:1px solid rgba(255,214,10,.12);
    }
    .metric span {
      display:block;
      color:var(--muted);
      font-size:11px;
      text-transform:uppercase;
      letter-spacing:.14em;
      margin-bottom:8px;
    }
    .metric strong { font-size:22px; line-height:1.35; }
    .progress-track { height:10px; border-radius:999px; background:rgba(255,214,10,.08); overflow:hidden; margin-top:12px; }
    .progress-fill { height:100%; background:linear-gradient(90deg,#9c6a00,#ffd60a); width:${Math.round(
      (readiness.score / readiness.total) * 100,
    )}%; box-shadow:0 0 18px rgba(255,214,10,.45); }
    .table-shell {
      border-radius:18px;
      overflow:hidden;
      border:1px solid rgba(255,214,10,.08);
      background:rgba(255,214,10,.03);
    }
    ul { margin:0; padding-left:18px; }
    li { margin-bottom:10px; color:var(--text); line-height:1.8; }
    @media (max-width:980px) {
      .grid, .split-grid { grid-template-columns:1fr; }
      .topbar { flex-direction:column; align-items:flex-start; }
      .social-actions { width:100%; justify-content:flex-end; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header class="topbar">
      <div class="topbar-left">
        <div class="live-dot" aria-hidden="true"></div>
        <div class="brand-logo">${renderBrandLogoImage()}</div>
        <div class="brand">
          <strong>Goo Operator Detail</strong>
          <small></small>
        </div>
        <div class="top-chip">Agent ${escapeHtml(candidate.agentId)}</div>
        <div class="top-chip">${escapeHtml(candidate.recommendation)}</div>
        <div class="top-chip">${escapeHtml(urgency)} urgency</div>
      </div>
      <div class="social-actions">
        <a class="back-link" href="${backHref}">Back</a>
        <a class="social-link" href="https://github.com/elizaokbsc" target="_blank" rel="noreferrer" aria-label="GitHub">
          ${renderGithubIconSvg()}
        </a>
        <a class="social-link" href="https://x.com/elizaok_bsc" target="_blank" rel="noreferrer" aria-label="X">
          ${renderXIconSvg()}
        </a>
      </div>
    </header>
    <section class="hero">
      <div class="eyebrow">elizaok</div>
      <h1>Agent ${escapeHtml(candidate.agentId)}</h1>
      <div class="hero-meta">
        <div class="top-chip">Score ${candidate.score}/100</div>
        <div class="top-chip">Pulse ${escapeHtml(pulseWindowLabel)}</div>
        <div class="top-chip">CTO floor ${candidate.minimumCtoBnb} BNB</div>
      </div>
    </section>
    <div class="card">
      <div class="grid">
        <div class="metric"><span>Score</span><strong>${candidate.score}/100</strong></div>
        <div class="metric"><span>CTO floor</span><strong>${candidate.minimumCtoBnb} BNB</strong></div>
        <div class="metric"><span>Treasury</span><strong>${candidate.treasuryBnb} BNB</strong></div>
        <div class="metric"><span>Pulse deadline</span><strong>${escapeHtml(pulseWindowLabel)}</strong></div>
        <div class="metric"><span>Treasury gap</span><strong>${candidate.status === "ACTIVE" ? "0 BNB" : `${treasuryStressGapBnb.toFixed(4)} BNB`}</strong></div>
        <div class="metric"><span>Acquisition fit</span><strong>${escapeHtml(acquisitionFit)}</strong></div>
      </div>
    </div>
    <div class="split-grid">
    <div class="card">
      <div class="eyebrow">Readiness</div>
      <div class="progress-track"><div class="progress-fill"></div></div>
      <p>${readiness.score}/${readiness.total}</p>
      <ul>${readiness.checklist.map((item) => `<li>${item.done ? "READY" : "TODO"} · ${escapeHtml(item.label)} · ${escapeHtml(item.detail)}</li>`).join("")}</ul>
    </div>
    <div class="card">
      <div class="eyebrow">Action</div>
      <div class="grid">
        <div class="metric"><span>Urgency</span><strong>${escapeHtml(urgency)}</strong></div>
        <div class="metric"><span>Action</span><strong>${escapeHtml(operatorAction)}</strong></div>
        <div class="metric"><span>Next</span><strong>${escapeHtml(readiness.nextAction)}</strong></div>
        <div class="metric"><span>Status</span><strong>${escapeHtml(candidate.status)}</strong></div>
      </div>
    </div>
    </div>
    <div class="split-grid">
    <div class="card">
      <div class="eyebrow">Links</div>
      <div class="grid">
        <div class="metric"><span>Genome</span><strong><a href="${escapeHtml(candidate.genomeUri)}" target="_blank" rel="noreferrer">open</a></strong></div>
        <div class="metric"><span>Token</span><strong>${escapeHtml(shortAddress(candidate.tokenAddress))}</strong></div>
        <div class="metric"><span>Wallet</span><strong>${escapeHtml(shortAddress(candidate.agentWallet))}</strong></div>
        <div class="metric"><span>Owner</span><strong>${escapeHtml(shortAddress(candidate.ownerAddress))}</strong></div>
      </div>
    </div>
    <div class="card">
      <div class="eyebrow">State</div>
      <div class="grid">
        <div class="metric"><span>Recommendation</span><strong>${escapeHtml(candidate.recommendation)}</strong></div>
        <div class="metric"><span>Registered block</span><strong>${candidate.registeredAtBlock}</strong></div>
        <div class="metric"><span>Threshold</span><strong>${candidate.starvingThresholdBnb} BNB</strong></div>
        <div class="metric"><span>Risks</span><strong>${candidate.risks.length}</strong></div>
      </div>
    </div>
    </div>
  </main>
</body>
</html>`;
}

function pnlTone(value: number): string {
  if (value > 0) return "tone-hot";
  if (value < 0) return "tone-warm";
  return "tone-cool";
}

function renderDashboardCloudSidebar(
  cloudSession: ElizaCloudSession | null,
  cloudSummary: ElizaCloudSummaryFields | null,
): string {
  if (!cloudSession) {
    return `
      <div class="sidebar-panel__title">ElizaCloud</div>
      <div class="status-panel compact-status">
        <button type="button" class="auth-link" data-cloud-hosted-auth>
          Connect ElizaCloud
        </button>
      </div>`;
  }
  const cloudSyncing =
    cloudSession.displayName === "ElizaCloud User" ||
    cloudSession.organizationName === "ElizaCloud" ||
    cloudSession.credits === "linked";
  const cloudModelLabel =
    cloudSession.model && cloudSession.model !== "n/a"
      ? cloudSession.model
      : "—";
  const agentCount =
    cloudSummary?.agentsSummary?.total ?? cloudSummary?.agents?.length ?? 0;
  return `
      <div class="sidebar-panel__title">ElizaCloud</div>
      <div class="status-panel compact-status" data-cloud-syncing="${cloudSyncing ? "true" : "false"}">
        <div class="status-row"><span>Status</span><strong>${cloudSyncing ? "Linked; profile and credits syncing" : "Connected"}</strong></div>
        <div class="status-row"><span>Account</span><strong>${escapeHtml(cloudSession.displayName)}</strong></div>
        <div class="status-row"><span>Org</span><strong>${escapeHtml(cloudSession.organizationName)}</strong></div>
        <div class="status-row"><span>Credits</span><strong>${escapeHtml(cloudSession.credits)}</strong></div>
        <div class="status-row"><span>Cloud agents</span><strong>${agentCount}</strong></div>
        <div class="status-row"><span>Agent</span><strong>${escapeHtml(cloudSession.agentName || "Eliza")}</strong></div>
        <div class="status-row"><span></span><strong><a class="watchlist-link" href="/auth/eliza-cloud/logout">Disconnect</a></strong></div>
      </div>`;
}

function renderCloudToolbarLinks(cloudSession: ElizaCloudSession | null): string {
  if (!cloudSession) return "";
  return `
    <a class="auth-link" href="/cloud/agents">Agents</a>
    <a class="auth-link" href="/cloud/credits">Credits</a>`;
}

function renderCloudPageShell(
  title: string,
  subtitle: string,
  body: string,
  cloudSession: ElizaCloudSession | null = null,
): string {
  const isConnected = !!cloudSession;
  const cloudUser = cloudSession?.displayName ?? null;
  const cloudCredits = cloudSession?.credits ?? null;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(title)} | elizaOK</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;700&display=swap" rel="stylesheet" />
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
:root{
  --bg:#080808;--panel:#0f0f0f;--border:#1c1c1c;--border2:#252525;
  --yellow:#F6E70F;--yr:246,231,15;--green:#39FF14;--red:#FF4040;
  --white:rgba(255,255,255,0.88);--muted:rgba(255,255,255,0.38);
  --clr-muted:rgba(255,255,255,0.38);--clr-primary:#F6E70F;--clr-bg:#080808;
  --dot-color:255,255,255;
  --r:10px;--r-sm:6px;
  font-family:'JetBrains Mono',monospace;
}
[data-theme="light"]{
  --bg:#f4f4f0;--panel:#ffffff;--border:#e0dfd8;--border2:#d0cfca;
  --yellow:#b8a800;--yr:184,168,0;--green:#1a8f00;--red:#d43030;
  --white:rgba(20,20,18,0.88);--muted:rgba(20,20,18,0.42);
  --clr-muted:rgba(20,20,18,0.42);--clr-primary:#b8a800;--clr-bg:#f4f4f0;
  --dot-color:20,20,18;
}
html,body{min-height:100%;background:var(--bg);color:var(--white);transition:background .3s,color .3s;}
canvas#cp-canvas{position:fixed;inset:0;z-index:0;pointer-events:none;opacity:.09;}
[data-theme="light"] canvas#cp-canvas{opacity:.05;}
[data-theme="light"] .cp-card{background:#ffffff;border-color:var(--border);}
[data-theme="light"] .cp-row{border-bottom-color:rgba(20,20,18,.06);}
[data-theme="light"] .cp-agent{background:rgba(20,20,18,.03);border-color:var(--border);}
[data-theme="light"] .cp-connect-hero{background:#ffffff;border-color:var(--border);}
[data-theme="light"] .a-nav a{border-color:var(--border);}
[data-theme="light"] .a-logo{color:var(--yellow);}
[data-theme="light"] .cp-stats{border-color:var(--border);}
[data-theme="light"] .cp-stat{border-right-color:var(--border);}
[data-theme="light"] .cp-profile__avatar{background:rgba(var(--yr),.08);}
[data-theme="light"] #cp-theme-toggle{border-color:var(--border);}
.a-wrap{position:relative;z-index:1;max-width:1100px;margin:0 auto;padding:32px 24px 64px;}
.a-topbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:32px;flex-wrap:wrap;gap:12px;}
.a-logo{font-size:18px;font-weight:700;color:var(--yellow);letter-spacing:.08em;text-decoration:none;}
.a-nav{display:flex;gap:10px;align-items:center;flex-wrap:wrap;}
.a-nav a{color:var(--muted);font-size:11px;text-decoration:none;padding:5px 12px;border:1px solid var(--border);border-radius:var(--r-sm);transition:all .2s;}
.a-nav a:hover{color:var(--yellow);border-color:var(--yellow);box-shadow:0 0 8px rgba(246,231,15,.25);}
.a-nav a.active{color:var(--yellow);border-color:var(--yellow);}
/* ── Card grid (reuse cp- prefix so existing body HTML still works) ── */
.cp-grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:14px;}
.cp-col-12{grid-column:span 12;}
.cp-col-8{grid-column:span 8;}
.cp-col-6{grid-column:span 6;}
.cp-col-4{grid-column:span 4;}
.cp-card{background:var(--panel);border:1px solid var(--border);border-radius:var(--r);overflow:hidden;transition:border-color .2s;}
.cp-card:hover{border-color:rgba(246,231,15,.25);}
.cp-card__head{padding:12px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:8px;}
.cp-card__head h2{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);}
.cp-card__head-badge{font-size:10px;font-weight:600;background:rgba(246,231,15,.08);border:1px solid rgba(246,231,15,.3);color:var(--yellow);padding:2px 8px;border-radius:20px;}
.cp-card__body{padding:16px;}
.cp-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:0;border:1px solid var(--border);border-radius:var(--r);overflow:hidden;}
.cp-stat{padding:16px 14px;text-align:center;border-right:1px solid var(--border);}
.cp-stat:last-child{border-right:none;}
.cp-stat__label{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:8px;}
.cp-stat__value{font-size:24px;font-weight:700;color:var(--white);line-height:1;}
.cp-stat__value--green{color:var(--yellow);}
.cp-stat__value--pink{color:var(--red);}
.cp-profile{display:flex;align-items:center;gap:20px;padding:20px;}
.cp-profile__avatar{width:52px;height:52px;border:1px solid var(--yellow);background:rgba(246,231,15,.08);border-radius:var(--r-sm);display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:700;color:var(--yellow);flex-shrink:0;}
.cp-profile__name{font-size:18px;font-weight:700;}
.cp-profile__org{font-size:11px;color:var(--muted);margin-top:2px;}
.cp-profile__meta{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;}
.cp-profile__chip{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;padding:3px 10px;border:1px solid var(--border);color:var(--muted);border-radius:20px;}
.cp-profile__chip--active{border-color:var(--yellow);color:var(--yellow);}
.cp-rows{display:grid;gap:0;}
.cp-row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid rgba(255,255,255,.04);}
.cp-row:last-child{border-bottom:none;}
.cp-row span{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;}
.cp-row strong{font-size:12px;font-weight:600;text-align:right;max-width:260px;word-break:break-all;}
.cp-agents{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px;padding:16px;}
.cp-agent{background:rgba(255,255,255,.03);border:1px solid var(--border);border-radius:var(--r-sm);overflow:hidden;transition:border-color .2s;}
.cp-agent:hover{border-color:var(--yellow);}
.cp-agent__head{padding:10px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;}
.cp-agent__name{font-size:13px;font-weight:600;}
.cp-agent__status{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;padding:2px 8px;border:1px solid var(--border);color:var(--muted);border-radius:20px;}
.cp-agent__status--active{border-color:var(--yellow);color:var(--yellow);}
.cp-agent__body{padding:10px 14px;}
.cp-agent__row{display:flex;justify-content:space-between;font-size:11px;margin-bottom:5px;}
.cp-agent__row span{color:var(--muted);}
.cp-agent__row strong{font-weight:600;}
.cp-actions{padding:14px 16px;display:flex;gap:8px;flex-wrap:wrap;}
.cp-btn{display:inline-flex;align-items:center;height:32px;padding:0 14px;border:1px solid var(--border);border-radius:var(--r-sm);background:transparent;color:var(--muted);font-family:inherit;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;cursor:pointer;transition:all .2s;text-decoration:none;}
.cp-btn:hover{border-color:var(--yellow);color:var(--yellow);box-shadow:0 0 10px rgba(246,231,15,.2);}
.cp-btn--accent{border-color:var(--yellow);color:var(--yellow);}
.cp-btn--accent:hover{background:var(--yellow);color:#000;}
@media(max-width:960px){.cp-stats{grid-template-columns:repeat(2,minmax(0,1fr));}.cp-col-8,.cp-col-6,.cp-col-4{grid-column:span 12;}}
@media(max-width:600px){.cp-col-12{grid-column:span 12;}}
.a-footer{text-align:center;font-size:10px;color:var(--muted);margin-top:40px;letter-spacing:.06em;}
.cp-connect-hero{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:64px 24px;background:var(--panel);border:1px solid var(--border);border-radius:var(--r);margin-bottom:24px;}
.cp-connect-icon{font-size:40px;color:var(--yellow);margin-bottom:16px;opacity:.6;}
.cp-connect-title{font-size:20px;font-weight:700;color:var(--white);margin-bottom:10px;}
.cp-connect-desc{font-size:13px;color:var(--muted);max-width:400px;line-height:1.7;margin-bottom:20px;}
</style>
</head>
<body>
<canvas id="cp-canvas"></canvas>
<div class="a-wrap">
  <div class="a-topbar">
    <a class="a-logo" href="/">elizaOK</a>
    <nav class="a-nav">
      <a href="/cloud/agents"${title === "Cloud Agents" ? ' class="active"' : ""}>Agents</a>
      <a href="/cloud/credits"${title === "Cloud Credits" ? ' class="active"' : ""}>Credits</a>
      ${isConnected
        ? `<a href="/auth/eliza-cloud/logout" style="color:var(--yellow);border-color:var(--yellow);">${escapeHtml(cloudUser ?? "")} &middot; Logout</a>`
        : `<a href="#" id="cp-cloud-btn" style="cursor:pointer;color:var(--yellow);border-color:rgba(246,231,15,.4);">+ Connect Cloud</a>`}
      <button id="cp-theme-toggle" onclick="cpToggleTheme()" style="background:transparent;border:1px solid var(--border2);border-radius:6px;color:var(--muted);font-family:inherit;font-size:11px;padding:4px 10px;cursor:pointer;transition:all .2s;">☀</button>
    </nav>
  </div>
  ${body}
  <div class="a-footer">elizaOK · Powered by elizaOS · BNB Chain</div>
</div>
<script>
(function(){
  /* ── Theme ── */
  window.cpToggleTheme = function() {
    var root = document.documentElement;
    var isLight = root.getAttribute('data-theme') === 'light';
    var next = isLight ? 'dark' : 'light';
    root.setAttribute('data-theme', next);
    var btn = document.getElementById('cp-theme-toggle');
    if (btn) btn.textContent = next === 'light' ? '🌙' : '☀';
    try { localStorage.setItem('elizaok-theme', next); } catch(e) {}
  };
  (function(){
    var saved;
    try { saved = localStorage.getItem('elizaok-theme'); } catch(e) {}
    if (saved === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
      var btn = document.getElementById('cp-theme-toggle');
      if (btn) btn.textContent = '🌙';
    }
  })();

  /* ── Canvas ── */
  const canvas=document.getElementById('cp-canvas');
  const ctx=canvas.getContext('2d');
  let W,H,dots=[];
  function resize(){W=canvas.width=window.innerWidth;H=canvas.height=window.innerHeight;dots=[];const spacing=22;for(let x=0;x<W;x+=spacing)for(let y=0;y<H;y+=spacing)dots.push({x,y});}
  window.addEventListener('resize',resize);resize();
  let t=0;
  function getDotColor(){return document.documentElement.getAttribute('data-theme')==='light'?'20,20,18':'255,255,255';}
  function draw(){ctx.clearRect(0,0,W,H);t+=0.012;const dc=getDotColor();for(const d of dots){const wave=Math.sin(d.x/90+t)*Math.sin(d.y/90+t*0.7);const r=1+wave*1.1;const a=0.35+wave*0.35;ctx.beginPath();ctx.arc(d.x,d.y,Math.max(0.3,r),0,Math.PI*2);ctx.fillStyle='rgba('+dc+','+a+')';ctx.fill();}requestAnimationFrame(draw);}
  draw();

  function doFinalPollThenReload(sessionId, attempt) {
    attempt = attempt || 0;
    fetch('/api/eliza-cloud/hosted/poll?session=' + encodeURIComponent(sessionId), { credentials: 'same-origin' })
      .then(function(r){ return r.json(); })
      .catch(function(){ return {}; })
      .then(function(d){ if ((d && d.status === 'authenticated') || attempt >= 5) { window.location.reload(); return; } setTimeout(function(){ doFinalPollThenReload(sessionId, attempt + 1); }, 1200); });
  }
  function openCloudAuth(btn) {
    if (btn) btn.style.opacity = '0.5';
    fetch('/api/eliza-cloud/hosted/start', { method: 'POST', headers: {'content-type':'application/json'}, credentials: 'same-origin' })
      .then(function(r){ return r.json(); })
      .then(function(data) {
        if (!data.loginUrl) { window.location.href = '/auth/eliza-cloud?popup=1'; return; }
        var p = window.open(data.loginUrl, 'elizacloud-auth', 'width=500,height=640,scrollbars=yes');
        if (!p) { window.location.href = data.loginUrl; return; }
        if (data.mode === 'cli-session') {
          var count = 0;
          var popupWasClosed = false;
          var ti = setInterval(function() {
            count++;
            var closed = (function(){ try{return p.closed;}catch(e){return true;} }());
            if (closed && !popupWasClosed) {
              popupWasClosed = true;
              clearInterval(ti);
              if (btn) btn.style.opacity = '';
              doFinalPollThenReload(data.sessionId);
              return;
            }
            if (count > 90) {
              clearInterval(ti);
              if (btn) btn.style.opacity = '';
              doFinalPollThenReload(data.sessionId);
              return;
            }
            fetch('/api/eliza-cloud/hosted/poll?session=' + encodeURIComponent(data.sessionId), { credentials: 'same-origin' })
              .then(function(r){ return r.json(); })
              .then(function(pd) {
                if (pd.status === 'authenticated') {
                  clearInterval(ti);
                  try { p.close(); } catch(e) {}
                  window.location.reload();
                }
              }).catch(function(){});
          }, 1500);
        } else {
          var closeTi = setInterval(function() {
            try { if (p.closed) { clearInterval(closeTi); window.location.reload(); } } catch(e) {}
          }, 800);
        }
      })
      .catch(function() { window.location.href = '/auth/eliza-cloud?popup=1'; });
  }

  var cpCloudBtn = document.getElementById('cp-cloud-btn');
  if (cpCloudBtn) {
    cpCloudBtn.addEventListener('click', function(e) {
      e.preventDefault();
      openCloudAuth(this);
    });
  }
})();
</script>
</body>
</html>`;
}

function renderAirdropPage(
  snapshot: DashboardSnapshot | null,
  cloudSession: ElizaCloudSession | null,
  distributionPlan: any,
  distributionExecution: any,
  distributionLedger: any,
): string {
  const pool = (distributionPlan as any)?.distributionPoolUsd ?? 0;
  const eligible = (distributionPlan as any)?.eligibleHolderCount ?? 0;
  const recipients: any[] = (distributionPlan as any)?.recipients ?? [];
  const totalExecuted = (distributionLedger as any)?.totalRecipientsExecuted ?? 0;
  const totalDryRun = (distributionLedger as any)?.totalRecipientsDryRun ?? 0;
  const ledgerRecords: any[] = (distributionLedger as any)?.records ?? [];
  const selectedAsset = (distributionPlan as any)?.selectedAsset ?? {};
  const distNote = (distributionPlan as any)?.note ?? "";
  const snapshotTime = snapshot?.generatedAt ? new Date(snapshot.generatedAt).toLocaleString() : "—";
  const portfolioValue = snapshot?.portfolioLifecycle?.grossPortfolioValueUsd ?? 0;
  const execEnabled = (distributionExecution as any)?.enabled ?? false;
  const execDryRun = (distributionExecution as any)?.dryRun ?? true;
  const nextAction = (distributionExecution as any)?.nextAction ?? "—";
  const publication = (distributionPlan as any)?.publication ?? null;

  const recipientRows = recipients.slice(0, 20).map((r: any) => `
    <tr class="a-tr">
      <td class="a-td mono">${escapeHtml(r.address ?? "")}</td>
      <td class="a-td">${escapeHtml(String(r.qualifiedBalance ?? "—"))}</td>
      <td class="a-td yellow">${escapeHtml(String(r.estimatedShare ?? "—"))}</td>
      <td class="a-td">${escapeHtml(r.label ?? "holder")}</td>
    </tr>`).join("");

  const ledgerRows = ledgerRecords.slice(0, 15).map((rec: any) => `
    <tr class="a-tr">
      <td class="a-td mono">${escapeHtml((rec.recipientAddress ?? "").slice(0, 12))}…</td>
      <td class="a-td">${escapeHtml(String(rec.amount ?? "—"))}</td>
      <td class="a-td ${rec.disposition === "executed" ? "green" : "yellow"}">${escapeHtml(rec.disposition ?? "—")}</td>
      <td class="a-td">${rec.timestamp ? new Date(rec.timestamp).toLocaleTimeString() : "—"}</td>
    </tr>`).join("");

  const cloudUser = cloudSession?.displayName ?? null;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>elizaOK · Airdrop</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;700&display=swap" rel="stylesheet" />
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
:root{
  --bg:#080808;--panel:#0f0f0f;--border:#1c1c1c;--border2:#252525;
  --yellow:#F6E70F;--yr:246,231,15;--green:#39FF14;--red:#FF4040;
  --white:rgba(255,255,255,0.88);--muted:rgba(255,255,255,0.38);
  --dot-color:255,255,255;
  --r:10px;--r-sm:6px;
  font-family:'JetBrains Mono',monospace;
}
[data-theme="light"]{
  --bg:#f4f4f0;--panel:#ffffff;--border:#e0dfd8;--border2:#d0cfca;
  --yellow:#b8a800;--yr:184,168,0;--green:#1a8f00;--red:#d43030;
  --white:rgba(20,20,18,0.88);--muted:rgba(20,20,18,0.42);
  --dot-color:20,20,18;
}
html,body{min-height:100%;background:var(--bg);color:var(--white);transition:background .3s,color .3s;}
canvas#airdrop-canvas{position:fixed;inset:0;z-index:0;pointer-events:none;opacity:.09;}
[data-theme="light"] canvas#airdrop-canvas{opacity:.05;}
[data-theme="light"] .a-hero{background:#fff;border-color:var(--border);}
[data-theme="light"] .a-stat{background:#fff;border-color:var(--border);}
[data-theme="light"] .a-checker{background:#fff;border-color:var(--border);}
[data-theme="light"] .a-card{background:#fff;border-color:var(--border);}
[data-theme="light"] .a-kv{border-bottom-color:rgba(20,20,18,.06);}
[data-theme="light"] .a-table-wrap{background:#fff;border-color:var(--border);}
[data-theme="light"] .a-tr:nth-child(odd){background:rgba(20,20,18,.02);}
[data-theme="light"] .a-pub{background:#fff;border-color:var(--border);}
[data-theme="light"] .a-pub pre{background:#f0f0ec;color:#1a6600;}
[data-theme="light"] .a-input{background:#f8f8f5;border-color:var(--border);color:var(--white);}
[data-theme="light"] .a-nav a{border-color:var(--border);}
[data-theme="light"] #airdrop-theme-toggle{border-color:var(--border);}
.a-wrap{position:relative;z-index:1;max-width:1100px;margin:0 auto;padding:32px 24px 64px;}
.a-topbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:32px;flex-wrap:wrap;gap:12px;}
.a-logo{font-size:18px;font-weight:700;color:var(--yellow);letter-spacing:.08em;text-decoration:none;}
.a-nav{display:flex;gap:10px;align-items:center;}
.a-nav a{color:var(--muted);font-size:11px;text-decoration:none;padding:5px 12px;border:1px solid var(--border);border-radius:var(--r-sm);transition:all .2s;}
.a-nav a:hover{color:var(--yellow);border-color:var(--yellow);box-shadow:0 0 8px rgba(246,231,15,.25);}
.a-nav a.active{color:var(--yellow);border-color:var(--yellow);}
.a-hero{background:var(--panel);border:1px solid var(--border);border-radius:var(--r);padding:32px;margin-bottom:24px;display:flex;justify-content:space-between;align-items:flex-start;gap:24px;flex-wrap:wrap;}
.a-hero h1{font-size:24px;font-weight:700;letter-spacing:.04em;margin-bottom:8px;}
.a-hero h1 span{color:var(--yellow);}
.a-hero p{color:var(--muted);font-size:13px;line-height:1.6;max-width:480px;}
.a-badge{display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:20px;border:1px solid;font-size:11px;font-weight:500;letter-spacing:.04em;}
.a-badge--live{border-color:var(--green);color:var(--green);background:rgba(57,255,20,.07);}
.a-badge--live::before{content:'';width:6px;height:6px;border-radius:50%;background:var(--green);animation:live-pulse 1.2s infinite;}
.a-badge--standby{border-color:var(--yellow);color:var(--yellow);background:rgba(246,231,15,.07);}
.a-badge--standby::before{content:'';width:6px;height:6px;border-radius:50%;background:var(--yellow);}
@keyframes live-pulse{0%,100%{opacity:1;}50%{opacity:.3;}}
.a-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:24px;}
.a-stat{background:var(--panel);border:1px solid var(--border);border-radius:var(--r);padding:18px 20px;transition:border-color .2s,box-shadow .2s;}
.a-stat:hover{border-color:var(--yellow);box-shadow:0 0 16px rgba(246,231,15,.12);}
.a-stat__label{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px;}
.a-stat__val{font-size:22px;font-weight:700;color:var(--yellow);}
.a-stat__sub{font-size:10px;color:var(--muted);margin-top:3px;}
.a-checker{background:var(--panel);border:1px solid var(--border);border-radius:var(--r);padding:24px;margin-bottom:24px;}
.a-checker h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--yellow);margin-bottom:16px;}
.a-input-row{display:flex;gap:10px;flex-wrap:wrap;}
.a-input{flex:1;min-width:260px;background:#151515;border:1px solid var(--border);border-radius:var(--r-sm);color:var(--white);font-family:inherit;font-size:13px;padding:10px 14px;outline:none;transition:border-color .2s;}
.a-input:focus{border-color:var(--yellow);}
.a-btn{padding:10px 20px;border:1px solid var(--yellow);border-radius:var(--r-sm);background:transparent;color:var(--yellow);font-family:inherit;font-size:13px;font-weight:500;cursor:pointer;transition:all .2s;letter-spacing:.04em;}
.a-btn:hover{background:var(--yellow);color:#000;box-shadow:0 0 16px rgba(246,231,15,.35);}
.a-result{margin-top:14px;padding:14px 16px;border-radius:var(--r-sm);font-size:13px;display:none;}
.a-result--eligible{background:rgba(57,255,20,.08);border:1px solid var(--green);color:var(--green);}
.a-result--not{background:rgba(255,64,64,.08);border:1px solid var(--red);color:var(--red);}
.a-result--nodata{background:rgba(246,231,15,.06);border:1px solid var(--yellow);color:var(--yellow);}
.a-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px;}
@media(max-width:700px){.a-grid{grid-template-columns:1fr;}}
.a-card{background:var(--panel);border:1px solid var(--border);border-radius:var(--r);padding:20px;overflow:hidden;}
.a-card h2{font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid var(--border);}
.a-kv{display:flex;justify-content:space-between;align-items:baseline;gap:10px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.04);font-size:12px;min-width:0;}
.a-kv:last-child{border-bottom:none;}
.a-kv span{color:var(--muted);flex-shrink:0;}
.a-kv strong{color:var(--white);text-align:right;min-width:0;overflow-wrap:break-word;word-break:break-word;}
.a-kv strong.yellow{color:var(--yellow);}
.a-kv strong.green{color:var(--green);}
.a-table-wrap{overflow-x:auto;border-radius:var(--r);background:var(--panel);border:1px solid var(--border);margin-bottom:24px;}
.a-table-wrap h2{font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);padding:14px 18px;border-bottom:1px solid var(--border);}
table.a-table{width:100%;border-collapse:collapse;}
.a-tr:nth-child(odd){background:rgba(255,255,255,.02);}
.a-tr:hover{background:rgba(246,231,15,.04);}
.a-td{padding:8px 18px;font-size:11px;color:var(--white);white-space:nowrap;}
.a-td.mono{font-family:'JetBrains Mono',monospace;color:var(--muted);font-size:10px;}
.a-td.yellow{color:var(--yellow);}
.a-td.green{color:var(--green);}
th.a-th{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);padding:8px 18px;text-align:left;border-bottom:1px solid var(--border);}
.a-note{background:rgba(246,231,15,.05);border:1px solid rgba(246,231,15,.15);border-radius:var(--r-sm);padding:12px 16px;font-size:12px;color:var(--muted);margin-bottom:24px;line-height:1.6;}
.a-pub{background:var(--panel);border:1px solid var(--border);border-radius:var(--r);padding:20px;margin-bottom:24px;}
.a-pub h2{font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:12px;}
.a-pub pre{font-size:11px;color:var(--green);background:#030303;border-radius:var(--r-sm);padding:14px;overflow-x:auto;line-height:1.6;}
.a-empty{color:var(--muted);font-size:12px;padding:24px 18px;text-align:center;}
.a-footer{text-align:center;font-size:10px;color:var(--muted);margin-top:40px;letter-spacing:.06em;}
</style>
</head>
<body>
<canvas id="airdrop-canvas"></canvas>
<div class="a-wrap">

  <div class="a-topbar">
    <a class="a-logo" href="/">elizaOK</a>
    <nav class="a-nav">
      <a href="/airdrop" class="active">Airdrop</a>
      ${cloudUser
        ? `<a href="/auth/eliza-cloud/logout" style="color:var(--yellow);border-color:var(--yellow);">${escapeHtml(cloudUser)} &middot; Logout</a>`
        : `<a href="#" id="airdrop-cloud-btn" style="cursor:pointer;color:var(--yellow);border-color:rgba(246,231,15,.4);">Connect Cloud</a>`}
      <button id="airdrop-theme-toggle" onclick="airToggleTheme()" style="background:transparent;border:1px solid var(--border2);border-radius:6px;color:var(--muted);font-family:inherit;font-size:11px;padding:4px 10px;cursor:pointer;transition:all .2s;">☀</button>
    </nav>
  </div>

  <div class="a-hero">
    <div>
      <h1><span>elizaOK</span> · Airdrop Eligibility</h1>
      <p>The treasury flywheel distributes gains back to qualified $GOO holders. Check if your wallet qualifies for the current airdrop cycle and view the distribution plan.</p>
    </div>
    <div>
      <div class="a-badge ${execEnabled ? "a-badge--live" : "a-badge--standby"}">${execEnabled ? (execDryRun ? "DRY RUN" : "LIVE") : "STANDBY"}</div>
      <div style="font-size:10px;color:var(--muted);margin-top:8px;">Last scan: ${snapshotTime}</div>
    </div>
  </div>

  <div class="a-stats">
    <div class="a-stat">
      <div class="a-stat__label">Distribution Pool</div>
      <div class="a-stat__val">$${escapeHtml(pool.toFixed ? pool.toFixed(2) : String(pool))}</div>
      <div class="a-stat__sub">treasury allocation</div>
    </div>
    <div class="a-stat">
      <div class="a-stat__label">Eligible Holders</div>
      <div class="a-stat__val">${eligible}</div>
      <div class="a-stat__sub">qualified $GOO wallets</div>
    </div>
    <div class="a-stat">
      <div class="a-stat__label">Executed Sends</div>
      <div class="a-stat__val">${totalExecuted}</div>
      <div class="a-stat__sub">this cycle</div>
    </div>
    <div class="a-stat">
      <div class="a-stat__label">Dry Run Count</div>
      <div class="a-stat__val">${totalDryRun}</div>
      <div class="a-stat__sub">simulated sends</div>
    </div>
    <div class="a-stat">
      <div class="a-stat__label">Portfolio Value</div>
      <div class="a-stat__val">$${escapeHtml(portfolioValue.toFixed ? portfolioValue.toFixed(2) : String(portfolioValue))}</div>
      <div class="a-stat__sub">gross treasury</div>
    </div>
    <div class="a-stat">
      <div class="a-stat__label">Recipients in Plan</div>
      <div class="a-stat__val">${recipients.length}</div>
      <div class="a-stat__sub">snapshot recipients</div>
    </div>
  </div>

  ${distNote ? `<div class="a-note">${escapeHtml(distNote)}</div>` : ""}

  <div class="a-checker">
    <h2>Check Wallet Eligibility</h2>
    <div class="a-input-row">
      <input id="wallet-input" class="a-input" type="text" placeholder="Enter wallet address (0x…)" autocomplete="off" spellcheck="false" />
      <button class="a-btn" onclick="checkWallet()">Check</button>
    </div>
    <div id="wallet-result" class="a-result"></div>
  </div>

  <div class="a-grid">
    <div class="a-card">
      <h2>Airdrop Asset</h2>
      <div class="a-kv"><span>Mode</span><strong class="yellow">${escapeHtml(selectedAsset.mode ?? "—")}</strong></div>
      <div class="a-kv"><span>Token</span><strong>${escapeHtml(selectedAsset.tokenSymbol ?? "—")}</strong></div>
      <div class="a-kv"><span>Total Amount</span><strong>${escapeHtml(String(selectedAsset.totalAmount ?? "—"))}</strong></div>
      <div class="a-kv"><span>Wallet Balance</span><strong>${escapeHtml(String(selectedAsset.walletBalance ?? "—"))}</strong></div>
      <div class="a-kv"><span>Quote USD</span><strong>$${escapeHtml(String(selectedAsset.walletQuoteUsd ?? "—"))}</strong></div>
      ${selectedAsset.reason ? `<div class="a-kv"><span>Reason</span><strong style="font-size:10px;color:var(--muted);max-width:160px;white-space:normal;">${escapeHtml(selectedAsset.reason)}</strong></div>` : ""}
    </div>
    <div class="a-card">
      <h2>Execution State</h2>
      <div class="a-kv"><span>Enabled</span><strong class="${execEnabled ? "green" : ""}">${execEnabled ? "YES" : "NO"}</strong></div>
      <div class="a-kv"><span>Mode</span><strong class="yellow">${execDryRun ? "Dry Run" : "LIVE"}</strong></div>
      <div class="a-kv"><span>Max/Run</span><strong>${escapeHtml(String((distributionExecution as any)?.maxRecipientsPerRun ?? "—"))}</strong></div>
      <div class="a-kv"><span>Wallet</span><strong style="font-size:10px;color:var(--muted);">${escapeHtml(((distributionExecution as any)?.walletAddress ?? "—").slice(0,16))}…</strong></div>
      <div class="a-kv"><span>Next Action</span><strong style="font-size:10px;">${escapeHtml(nextAction)}</strong></div>
    </div>
  </div>

  ${publication ? `<div class="a-pub">
    <h2>Latest Publication</h2>
    <pre>${escapeHtml(typeof publication === "string" ? publication : JSON.stringify(publication, null, 2))}</pre>
  </div>` : ""}

  <div class="a-table-wrap">
    <h2>Recipient List (top ${Math.min(20, recipients.length)} of ${recipients.length})</h2>
    ${recipients.length === 0
      ? `<div class="a-empty">No recipients in current distribution plan.</div>`
      : `<table class="a-table">
          <thead><tr>
            <th class="a-th">Address</th>
            <th class="a-th">Qualified Balance</th>
            <th class="a-th">Est. Share</th>
            <th class="a-th">Label</th>
          </tr></thead>
          <tbody>${recipientRows}</tbody>
        </table>`}
  </div>

  <div class="a-table-wrap">
    <h2>Distribution Ledger (last ${Math.min(15, ledgerRecords.length)} records)</h2>
    ${ledgerRecords.length === 0
      ? `<div class="a-empty">No ledger records yet.</div>`
      : `<table class="a-table">
          <thead><tr>
            <th class="a-th">Recipient</th>
            <th class="a-th">Amount</th>
            <th class="a-th">Status</th>
            <th class="a-th">Time</th>
          </tr></thead>
          <tbody>${ledgerRows}</tbody>
        </table>`}
  </div>

  <div class="a-footer">elizaOK · Powered by elizaOS · Airdrop flywheel on BNB Chain</div>
</div>

<script>
/* ── Airdrop theme toggle ── */
window.airToggleTheme = function() {
  var root = document.documentElement;
  var isLight = root.getAttribute('data-theme') === 'light';
  var next = isLight ? 'dark' : 'light';
  root.setAttribute('data-theme', next);
  var btn = document.getElementById('airdrop-theme-toggle');
  if (btn) btn.textContent = next === 'light' ? '🌙' : '☀';
  try { localStorage.setItem('elizaok-theme', next); } catch(e) {}
};
(function(){
  var saved; try { saved = localStorage.getItem('elizaok-theme'); } catch(e) {}
  if (saved === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
    var btn = document.getElementById('airdrop-theme-toggle');
    if (btn) btn.textContent = '🌙';
  }
})();

(function(){
  const canvas=document.getElementById('airdrop-canvas');
  const ctx=canvas.getContext('2d');
  let W,H,dots=[];
  function resize(){W=canvas.width=window.innerWidth;H=canvas.height=window.innerHeight;dots=[];const spacing=22;for(let x=0;x<W;x+=spacing)for(let y=0;y<H;y+=spacing)dots.push({x,y,r:0,phase:Math.random()*Math.PI*2});}
  window.addEventListener('resize',resize);resize();
  let t=0;
  function getDotColor(){return document.documentElement.getAttribute('data-theme')==='light'?'20,20,18':'255,255,255';}
  function draw(){
    ctx.clearRect(0,0,W,H);
    t+=0.012;
    const dc=getDotColor();
    for(const d of dots){
      const wave=Math.sin(d.x/90+t)*Math.sin(d.y/90+t*0.7);
      const r=1+wave*1.1;
      const a=0.35+wave*0.35;
      ctx.beginPath();ctx.arc(d.x,d.y,Math.max(0.3,r),0,Math.PI*2);
      ctx.fillStyle='rgba('+dc+','+a+')';ctx.fill();
    }
    requestAnimationFrame(draw);
  }
  draw();
})();

const RECIPIENTS=${JSON.stringify(recipients.map((r: any)=>r.address?.toLowerCase()))};
function checkWallet(){
  const val=document.getElementById('wallet-input').value.trim().toLowerCase();
  const el=document.getElementById('wallet-result');
  if(!val){el.style.display='none';return;}
  if(RECIPIENTS.length===0){
    el.className='a-result a-result--nodata';
    el.innerHTML='No distribution plan loaded yet. The agent has not run a distribution scan.';
    el.style.display='block';return;
  }
  if(RECIPIENTS.includes(val)){
    el.className='a-result a-result--eligible';
    el.innerHTML='✓ This wallet is in the current airdrop recipient list.';
  }else{
    el.className='a-result a-result--not';
    el.innerHTML='✗ This wallet is not in the current airdrop plan. Eligibility is based on $GOO holding thresholds at snapshot time.';
  }
  el.style.display='block';
}
document.getElementById('wallet-input').addEventListener('keydown',function(e){if(e.key==='Enter')checkWallet();});

(function(){
  function doFinalPollThenReload(sessionId, attempt) {
    attempt = attempt || 0;
    fetch('/api/eliza-cloud/hosted/poll?session=' + encodeURIComponent(sessionId), { credentials: 'same-origin' })
      .then(function(r){ return r.json(); })
      .catch(function(){ return {}; })
      .then(function(d){ if ((d && d.status === 'authenticated') || attempt >= 5) { window.location.reload(); return; } setTimeout(function(){ doFinalPollThenReload(sessionId, attempt + 1); }, 1200); });
  }
  function openCloudAuth(btn) {
    if (btn) btn.style.opacity = '0.5';
    fetch('/api/eliza-cloud/hosted/start', { method: 'POST', headers: {'content-type':'application/json'}, credentials: 'same-origin' })
      .then(function(r){ return r.json(); })
      .then(function(data) {
        if (!data.loginUrl) { window.location.href = '/auth/eliza-cloud?popup=1'; return; }
        var p = window.open(data.loginUrl, 'elizacloud-auth', 'width=500,height=640,scrollbars=yes');
        if (!p) { window.location.href = data.loginUrl; return; }
        if (data.mode === 'cli-session') {
          var count = 0;
          var popupWasClosed = false;
          var ti = setInterval(function() {
            count++;
            var closed = (function(){ try{return p.closed;}catch(e){return true;} }());
            if (closed && !popupWasClosed) {
              popupWasClosed = true;
              clearInterval(ti);
              if (btn) btn.style.opacity = '';
              doFinalPollThenReload(data.sessionId);
              return;
            }
            if (count > 90) {
              clearInterval(ti);
              if (btn) btn.style.opacity = '';
              doFinalPollThenReload(data.sessionId);
              return;
            }
            fetch('/api/eliza-cloud/hosted/poll?session=' + encodeURIComponent(data.sessionId), { credentials: 'same-origin' })
              .then(function(r){ return r.json(); })
              .then(function(pd) {
                if (pd.status === 'authenticated') {
                  clearInterval(ti);
                  try { p.close(); } catch(e) {}
                  window.location.reload();
                }
              }).catch(function(){});
          }, 1500);
        } else {
          var closeTi = setInterval(function() {
            try { if (p.closed) { clearInterval(closeTi); window.location.reload(); } } catch(e) {}
          }, 800);
        }
      })
      .catch(function() { window.location.href = '/auth/eliza-cloud?popup=1'; });
  }

  var btn = document.getElementById('airdrop-cloud-btn');
  if (btn) {
    btn.addEventListener('click', function(e) {
      e.preventDefault();
      openCloudAuth(this);
    });
  }
})();
</script>
</body>
</html>`;
}

function renderCloudCreditsPage(
  cloudSession: ElizaCloudSession | null,
  cloudSummary: ElizaCloudSummaryFields | null,
): string {
  if (!cloudSession) {
    return renderCloudPageShell(
      "Cloud Credits",
      "Connect ElizaCloud first",
      `<div class="cp-connect-hero">
        <div class="cp-connect-icon">◈</div>
        <div class="cp-connect-title">Credits &amp; Billing</div>
        <p class="cp-connect-desc">Connect your ElizaCloud account to view credit balance, billing details, and auto top-up settings.</p>
        <a class="cp-btn cp-btn--accent" href="#" id="cp-cloud-btn" style="cursor:pointer;margin-top:4px;">+ Connect ElizaCloud</a>
      </div>`,
      null,
    );
  }
  const agentsSummary = cloudSummary?.agentsSummary;
  const pricing = cloudSummary?.pricing;
  const autoTopUp = cloudSummary?.autoTopUp;
  const body = `
    <div class="cp-grid">
      <!-- Profile hero -->
      <div class="cp-col-12 cp-card">
        <div class="cp-profile">
          <div class="cp-profile__avatar">${escapeHtml((cloudSession.displayName || "E").slice(0,1).toUpperCase())}</div>
          <div>
            <div class="cp-profile__name">${escapeHtml(cloudSession.displayName)}</div>
            <div class="cp-profile__org">${escapeHtml(cloudSession.organizationName)}</div>
            <div class="cp-profile__meta">
              <span class="cp-profile__chip cp-profile__chip--active">CONNECTED</span>
              <span class="cp-profile__chip">${escapeHtml(cloudSession.credits)} CREDITS</span>
              <span class="cp-profile__chip">${escapeHtml(cloudSession.email && cloudSession.email !== "connected-via-elizacloud" ? cloudSession.email : cloudSession.apiKey ? cloudSession.apiKey.slice(0, 10) + "..." : "elizacloud")}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Credit KPI tiles (market card style) -->
      <div class="cp-col-12">
        <div class="cp-stats">
          <div class="cp-stat">
            <div class="cp-stat__label">Account Balance</div>
            <div class="cp-stat__value cp-stat__value--green" style="font-size:16px;word-break:break-all;">${escapeHtml(cloudSession.credits)} credits</div>
          </div>
          <div class="cp-stat">
            <div class="cp-stat__label">Agents</div>
            <div class="cp-stat__value">${agentsSummary?.total ?? cloudSummary?.agents?.length ?? "—"}</div>
          </div>
          <div class="cp-stat">
            <div class="cp-stat__label">Total Spent</div>
            <div class="cp-stat__value cp-stat__value--pink">${agentsSummary ? formatCompactNumber(agentsSummary.totalSpent ?? 0) : "—"}</div>
          </div>
          <div class="cp-stat">
            <div class="cp-stat__label">With Budget</div>
            <div class="cp-stat__value">${agentsSummary?.withBudget ?? "—"}</div>
          </div>
        </div>
      </div>

      <!-- Billing details -->
      <div class="cp-col-6 cp-card">
        <div class="cp-card__head"><h2>Billing</h2><span class="cp-card__head-badge">ELIZACLOUD</span></div>
        <div class="cp-rows">
          <div class="cp-row"><span>Credits / USD</span><strong>${pricing?.creditsPerDollar == null ? "—" : formatCompactNumber(pricing.creditsPerDollar)}</strong></div>
          <div class="cp-row"><span>Minimum deposit</span><strong>${pricing?.minimumTopUp == null ? "—" : `$${formatCompactNumber(pricing.minimumTopUp)}`}</strong></div>
          <div class="cp-row"><span>x402 top-up</span><strong>${pricing ? (pricing.x402Enabled ? "Enabled" : "Disabled") : "—"}</strong></div>
          <div class="cp-row"><span>Agent budget used</span><strong>${agentsSummary ? `${formatCompactNumber(agentsSummary.totalSpent ?? 0)} / ${formatCompactNumber(agentsSummary.totalAllocated ?? 0)}` : "—"}</strong></div>
        </div>
      </div>

      <!-- Auto top-up -->
      <div class="cp-col-6 cp-card">
        <div class="cp-card__head"><h2>Auto Top-up</h2><span class="cp-card__head-badge">${autoTopUp?.enabled ? "ACTIVE" : "OFF"}</span></div>
        <div class="cp-rows">
          <div class="cp-row"><span>Status</span><strong>${autoTopUp ? (autoTopUp.enabled ? "Enabled" : "Disabled") : "—"}</strong></div>
          <div class="cp-row"><span>Payment method</span><strong>${autoTopUp ? (autoTopUp.hasPaymentMethod ? "Saved" : "None") : "—"}</strong></div>
          <div class="cp-row"><span>Threshold</span><strong>${autoTopUp?.threshold == null ? "—" : formatCompactNumber(autoTopUp.threshold)}</strong></div>
          <div class="cp-row"><span>Top-up amount</span><strong>${autoTopUp?.amount == null ? "—" : formatCompactNumber(autoTopUp.amount)}</strong></div>
        </div>
        <div class="cp-actions">
          <a class="cp-btn cp-btn--accent" href="${escapeHtml(getElizaCloudDashboardUrl())}" target="_blank" rel="noreferrer">Top Up in Cloud ↗</a>
          <a class="cp-btn" href="/cloud/agents">View Agents</a>
        </div>
      </div>

      ${!cloudSummary ? `
      <div class="cp-col-12 cp-card">
        <div class="cp-card__head"><h2>Data Status</h2></div>
        <div class="cp-card__body" style="padding:14px;">
          <p style="color:var(--clr-muted);font-size:12px;">Connected — detailed billing data could not be fetched from ElizaCloud. Your session is valid. <a style="color:var(--clr-primary)" href="/cloud/credits">Refresh</a></p>
        </div>
      </div>` : ""}
    </div>`;
  return renderCloudPageShell(
    "Cloud Credits",
    `${cloudSession.organizationName} · billing`,
    body,
    cloudSession,
  );
}

function renderCloudAgentsPage(
  cloudSession: ElizaCloudSession | null,
  cloudSummary: ElizaCloudSummaryFields | null,
): string {
  if (!cloudSession) {
    return renderCloudPageShell(
      "Cloud Agents",
      "Connect ElizaCloud first",
      `<div class="cp-connect-hero">
        <div class="cp-connect-icon">⬡</div>
        <div class="cp-connect-title">Cloud Agents</div>
        <p class="cp-connect-desc">Connect your ElizaCloud account to view and manage AI agents, budgets, and request usage.</p>
        <a class="cp-btn cp-btn--accent" href="#" id="cp-cloud-btn" style="cursor:pointer;margin-top:4px;">+ Connect ElizaCloud</a>
      </div>`,
      null,
    );
  }
  const agents = cloudSummary?.agents || [];
  const agentCards = agents.length
    ? agents.map((agent) => `
        <div class="cp-agent">
          <div class="cp-agent__head">
            <span class="cp-agent__name">${escapeHtml(agent.name)}</span>
            <span class="cp-agent__status${agent.isPaused ? "" : " cp-agent__status--active"}">${agent.isPaused ? "PAUSED" : "ACTIVE"}</span>
          </div>
          <div class="cp-agent__body">
            <div class="cp-agent__row"><span>Budget</span><strong>${agent.hasBudget ? `${formatCompactNumber(agent.available)} avail` : "No budget"}</strong></div>
            <div class="cp-agent__row"><span>Allocated</span><strong>${agent.hasBudget ? formatCompactNumber(agent.allocated) : "—"}</strong></div>
            <div class="cp-agent__row"><span>Requests</span><strong>${agent.totalRequests}</strong></div>
            ${agent.dailyLimit !== null ? `<div class="cp-agent__row"><span>Daily limit</span><strong>${formatCompactNumber(agent.dailyLimit)}</strong></div>` : ""}
          </div>
        </div>`).join("")
    : `<div style="padding:20px;color:var(--clr-muted);font-size:12px;grid-column:span 2">No agents found. Create one below or in ElizaCloud.</div>`;

  const body = `
    <div class="cp-grid">
      <!-- Profile hero -->
      <div class="cp-col-12 cp-card">
        <div class="cp-profile">
          <div class="cp-profile__avatar">${escapeHtml((cloudSession.displayName || "E").slice(0,1).toUpperCase())}</div>
          <div>
            <div class="cp-profile__name">${escapeHtml(cloudSession.displayName)}</div>
            <div class="cp-profile__org">${escapeHtml(cloudSession.organizationName)}</div>
            <div class="cp-profile__meta">
              <span class="cp-profile__chip cp-profile__chip--active">CONNECTED</span>
              <span class="cp-profile__chip">${cloudSummary?.agentsSummary?.total ?? agents.length} AGENTS</span>
              <span class="cp-profile__chip">${escapeHtml(cloudSession.credits)} CREDITS</span>
            </div>
          </div>
        </div>
      </div>

      <!-- KPI stats -->
      <div class="cp-col-12">
        <div class="cp-stats">
          <div class="cp-stat">
            <div class="cp-stat__label">Total Agents</div>
            <div class="cp-stat__value">${cloudSummary?.agentsSummary?.total ?? agents.length}</div>
          </div>
          <div class="cp-stat">
            <div class="cp-stat__label">With Budget</div>
            <div class="cp-stat__value cp-stat__value--green">${cloudSummary?.agentsSummary?.withBudget ?? 0}</div>
          </div>
          <div class="cp-stat">
            <div class="cp-stat__label">Paused</div>
            <div class="cp-stat__value cp-stat__value--pink">${cloudSummary?.agentsSummary?.paused ?? 0}</div>
          </div>
          <div class="cp-stat">
            <div class="cp-stat__label">Credits Left</div>
            <div class="cp-stat__value">${escapeHtml(cloudSession.credits)}</div>
          </div>
        </div>
      </div>

      <!-- Agent cards grid -->
      <div class="cp-col-8 cp-card">
        <div class="cp-card__head">
          <h2>Cloud Agents</h2>
          <span class="cp-card__head-badge">${agents.length} TOTAL</span>
        </div>
        <div class="cp-agents">${agentCards}</div>
        <div class="cp-actions">
          <button type="button" class="cp-btn cp-btn--accent" data-cloud-create-agent>+ New Agent</button>
          <a class="cp-btn" href="${escapeHtml(getElizaCloudDashboardUrl())}" target="_blank" rel="noreferrer">Manage in Cloud ↗</a>
        </div>
      </div>

      <!-- Selected agent details -->
      <div class="cp-col-4 cp-card">
        <div class="cp-card__head"><h2>Selected Agent</h2><span class="cp-card__head-badge">ACTIVE</span></div>
        <div class="cp-rows">
          <div class="cp-row"><span>Agent</span><strong>${escapeHtml(cloudSession.agentName || "Eliza")}</strong></div>
          <div class="cp-row"><span>Org</span><strong>${escapeHtml(cloudSession.organizationName)}</strong></div>
          <div class="cp-row"><span>API Key</span><strong>${escapeHtml(cloudSession.apiKey ? cloudSession.apiKey.slice(0,12) + "..." : "n/a")}</strong></div>
        </div>
        <div class="cp-actions">
          <a class="cp-btn" href="/cloud/credits">View Credits</a>
        </div>
      </div>

      ${!cloudSummary ? `
      <div class="cp-col-12 cp-card">
        <div class="cp-card__head"><h2>Data Status</h2></div>
        <div class="cp-card__body" style="padding:14px;">
          <p style="color:var(--clr-muted);font-size:12px;">Connected — agent list could not be fetched from ElizaCloud API. Your session is valid. <a style="color:var(--clr-primary)" href="/cloud/agents">Refresh</a></p>
        </div>
      </div>` : ""}
    </div>
    <script>
      (function () {
        var buttons = Array.prototype.slice.call(document.querySelectorAll("[data-cloud-create-agent]"));
        buttons.forEach(function (button) {
          button.addEventListener("click", function () {
            var name = window.prompt("New ElizaCloud agent name", "elizaOK Agent");
            if (!name) return;
            var bio = window.prompt("Agent bio (optional)", "ElizaOK cloud agent") || "";
            button.setAttribute("aria-disabled", "true");
            fetch("/api/eliza-cloud/agents/create", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ name: name, bio: bio })
            })
              .then(function (response) {
                return response.json().then(function (payload) {
                  if (!response.ok) {
                    throw new Error(payload && payload.error ? payload.error : "Failed to create ElizaCloud agent.");
                  }
                  return payload;
                });
              })
              .then(function () { window.location.reload(); })
              .catch(function (error) {
                button.removeAttribute("aria-disabled");
                window.alert(error && error.message ? error.message : String(error));
              });
          });
        });
      })();
    </script>`;
  return renderCloudPageShell(
    "Cloud Agents",
    `${cloudSession.organizationName} · agents`,
    body,
    cloudSession,
  );
}

function renderHtml(
  snapshot: DashboardSnapshot | null,
  cloudSession: ElizaCloudSession | null,
  cloudSummary: ElizaCloudSummaryFields | null,
  sidebarWalletBalanceLabel = "n/a",
): string {
  if (!snapshot) {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  ${renderHeadBrandAssets("ElizaOK | elizaOK")}
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Kode+Mono:wght@400;500;700&display=swap" rel="stylesheet">
  <style>
    :root {
      color-scheme: dark;
      --bg: #16130e;
      --panel: rgba(24, 21, 16, 0.88);
      --panel-border: rgba(215, 164, 40, 0.2);
      --text: #f4ecd2;
      --muted: #bca36d;
      --accent: #d7a428;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 32px;
      background:
        radial-gradient(circle at 8% 18%, rgba(244,239,221,0.78), rgba(244,239,221,0.12) 18%, transparent 42%),
        linear-gradient(90deg, rgba(244,239,221,0.06), transparent 28%),
        linear-gradient(180deg, #16130e 0%, #242017 100%);
      font-family: "Kode Mono", monospace;
      color: var(--text);
    }
    .panel {
      width: min(920px, 100%);
      padding: 32px;
      border: 1px solid var(--panel-border);
      border-radius: 24px;
      background: var(--panel);
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.45);
    }
    .eyebrow {
      color: var(--accent);
      text-transform: uppercase;
      letter-spacing: 0.18em;
      font-size: 12px;
      margin-bottom: 12px;
    }
    h1 {
      margin: 0 0 8px;
      font-size: clamp(36px, 5vw, 56px);
      line-height: 1;
    }
    p { color: var(--muted); line-height: 1.65; }
  </style>
</head>
<body>
  <main class="panel">
    <div class="eyebrow">ElizaOK Live System</div>
    <h1>Dashboard warming up</h1>
    <p>No scan snapshot is available yet. The agent is online and waiting for the first discovery cycle to complete.</p>
  </main>
</body>
</html>`;
  }

  const treasurySimulation = snapshot.treasurySimulation ?? {
    paperCapitalUsd: 0,
    deployableCapitalUsd: 0,
    allocatedUsd: 0,
    dryPowderUsd: 0,
    reserveUsd: 0,
    reservePct: 0,
    positionCount: 0,
    averagePositionUsd: 0,
    highestConvictionSymbol: undefined,
    strategyNote:
      "Treasury simulation will appear after the next completed scan.",
    positions: [],
  };
  const portfolioLifecycle = snapshot.portfolioLifecycle ?? {
    activePositions: [],
    watchPositions: [],
    exitedPositions: [],
    timeline: [],
    cashBalanceUsd: 0,
    grossPortfolioValueUsd: 0,
    reservedUsd: 0,
    totalAllocatedUsd: 0,
    totalCurrentValueUsd: 0,
    totalRealizedPnlUsd: 0,
    totalUnrealizedPnlUsd: 0,
    totalUnrealizedPnlPct: 0,
    healthNote:
      "Portfolio lifecycle will appear after the next completed scan.",
  };
  const distributionPlan = snapshot.distributionPlan ?? {
    enabled: false,
    holderTokenAddress: null,
    snapshotPath: ".elizaok/holder-snapshot.json",
    snapshotSource: "none",
    snapshotGeneratedAt: null,
    snapshotBlockNumber: null,
    minEligibleBalance: 0,
    eligibleHolderCount: 0,
    totalQualifiedBalance: 0,
    distributionPoolUsd: 0,
    maxRecipients: 0,
    note: "Distribution state will appear after configuration is enabled.",
    selectedAsset: {
      mode: "none",
      tokenAddress: null,
      tokenSymbol: null,
      totalAmount: null,
      walletBalance: null,
      walletQuoteUsd: null,
      sourcePositionTokenAddress: null,
      reason:
        "Distribution asset selection will appear after configuration is enabled.",
    },
    recipients: [],
    publication: null,
  };
  const distributionExecution = snapshot.distributionExecution ?? {
    enabled: false,
    dryRun: true,
    configured: false,
    liveExecutionArmed: false,
    readinessScore: 0,
    readinessTotal: 0,
    readinessChecks: [],
    nextAction:
      "Distribution execution state will appear after the next completed scan.",
    assetTokenAddress: null,
    assetTotalAmount: null,
    walletAddress: null,
    manifestPath: null,
    manifestFingerprint: null,
    maxRecipientsPerRun: 0,
    cycleSummary: {
      attemptedCount: 0,
      dryRunCount: 0,
      executedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      note: "Distribution execution is idle.",
    },
  };
  const distributionLedger = snapshot.distributionLedger ?? {
    records: [],
    lastUpdatedAt: null,
    totalRecipientsExecuted: 0,
    totalRecipientsDryRun: 0,
  };
  const executionState = snapshot.executionState ?? {
    enabled: false,
    dryRun: true,
    mode: "paper",
    router: "fourmeme",
    configured: false,
    liveTradingArmed: false,
    readinessScore: 0,
    readinessTotal: 0,
    readinessChecks: [],
    nextAction: "Execution state will appear after the next completed scan.",
    risk: {
      maxBuyBnb: 0,
      maxDailyDeployBnb: 0,
      maxSlippageBps: 0,
      maxActivePositions: 0,
      minEntryMcapUsd: 0,
      maxEntryMcapUsd: 0,
      minLiquidityUsd: 0,
      minVolumeUsdM5: 0,
      minVolumeUsdH1: 0,
      minBuyersM5: 0,
      minNetBuysM5: 0,
      minPoolAgeMinutes: 0,
      maxPoolAgeMinutes: 0,
      maxPriceChangeH1Pct: 0,
      allowedQuoteOnly: true,
    },
    gooLane: undefined,
    plans: [],
    cycleSummary: {
      consideredCount: 0,
      eligibleCount: 0,
      attemptedCount: 0,
      dryRunCount: 0,
      executedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      note: "Execution cycle has not run yet for this snapshot.",
    },
  };
  const tradeLedger = snapshot.tradeLedger ?? {
    records: [],
    lastUpdatedAt: null,
    totalExecutedBnb: 0,
    totalDryRunBnb: 0,
  };
  const recentHistory = snapshot.recentHistory ?? [];
  const watchlist = snapshot.watchlist ?? [];
  const eligibleExecutionPlans = executionState.plans.filter(
    (plan) => plan.eligible,
  ).length;
  const gooConfigReadiness = [
    getDiscoveryConfig().goo.enabled ? 1 : 0,
    getDiscoveryConfig().goo.rpcUrl ? 1 : 0,
    getDiscoveryConfig().goo.registryAddress ? 1 : 0,
  ].reduce((sum, value) => sum + value, 0);
  const gooReadiness = buildGooReadiness(getDiscoveryConfig());
  const treasuryRules = getDiscoveryConfig().treasury;
  const takeProfitSummary = treasuryRules.takeProfitRules
    .map((rule) => `${rule.label} +${rule.gainPct}% -> sell ${rule.sellPct}%`)
    .join(" · ");

  const topCandidates = snapshot.topCandidates
    .slice(0, 5)
    .map(
      (candidate, index) => `
        <article class="candidate-card">
          <div class="candidate-card__meta">
            <span class="candidate-rank">0${index + 1}</span>
            <span class="pill ${recommendationTone(candidate.recommendation)}">${escapeHtml(candidate.recommendation)}</span>
          </div>
          <h3><a class="candidate-link" href="${candidateHref(candidate.tokenAddress)}">${escapeHtml(candidate.tokenSymbol)}</a></h3>
          <p class="candidate-subtitle">${escapeHtml(candidate.poolName)} · ${escapeHtml(candidate.dexId)}</p>
          <div class="candidate-stats">
            <div><span>Score</span><strong>${candidate.score}/100</strong></div>
            <div><span>Liquidity</span><strong>$${Math.round(candidate.reserveUsd).toLocaleString()}</strong></div>
            <div><span>Volume 5m</span><strong>$${Math.round(candidate.volumeUsdM5).toLocaleString()}</strong></div>
            <div><span>Age</span><strong>${candidate.poolAgeMinutes}m</strong></div>
          </div>
        </article>`,
    )
    .join("");

  const gooCandidates = snapshot.topGooCandidates
    .slice(0, 5)
    .map(
      (candidate, index) => `
        <article class="goo-card">
          <div class="candidate-card__meta">
            <span class="candidate-rank">0${index + 1}</span>
            <span class="pill ${recommendationTone(candidate.recommendation)}">${escapeHtml(candidate.recommendation)}</span>
          </div>
          <h3><a class="candidate-link" href="${gooCandidateHref(candidate.agentId)}">Agent ${escapeHtml(candidate.agentId)}</a></h3>
          <p class="candidate-subtitle">${escapeHtml(candidate.status)} lifecycle · CTO floor ${candidate.minimumCtoBnb} BNB · <a class="candidate-link" href="${gooCandidateHref(candidate.agentId)}">operator view</a></p>
          <div class="candidate-stats">
            <div><span>Score</span><strong>${candidate.score}/100</strong></div>
            <div><span>Treasury</span><strong>${candidate.treasuryBnb} BNB</strong></div>
            <div><span>Threshold</span><strong>${candidate.starvingThresholdBnb} BNB</strong></div>
            <div><span>Pulse</span><strong>${candidate.secondsUntilPulseTimeout ?? "n/a"}s</strong></div>
          </div>
        </article>`,
    )
    .join("");

  const gooQueueRows = snapshot.topGooCandidates
    .slice(0, 6)
    .map((candidate) => {
      const detail = buildGooCandidateDetail(candidate, getDiscoveryConfig());
      return `
        <div class="status-row">
          <span><a class="watchlist-link" href="${gooCandidateHref(candidate.agentId)}">Agent ${escapeHtml(candidate.agentId)}</a></span>
          <strong>
            ${escapeHtml(detail.urgency)} · ${escapeHtml(candidate.recommendation)}<br />
            ${escapeHtml(detail.operatorAction)}
          </strong>
        </div>`;
    })
    .join("");

  const treasuryAllocationCards = treasurySimulation.positions
    .slice(0, 5)
    .map(
      (position, index) => `
        <article class="candidate-card">
          <div class="candidate-card__meta">
            <span class="candidate-rank">0${index + 1}</span>
            <span class="pill tone-hot">${escapeHtml(position.recommendation)}</span>
          </div>
          <h3>${escapeHtml(position.tokenSymbol)}</h3>
          <p class="candidate-subtitle">${escapeHtml(position.source)} allocation lane</p>
          <div class="candidate-stats">
            <div><span>Allocation</span><strong>${formatUsd(position.allocationUsd)}</strong></div>
            <div><span>Weight</span><strong>${position.allocationPct}%</strong></div>
            <div><span>Score</span><strong>${position.score}/100</strong></div>
            <div><span>Liquidity</span><strong>${formatUsd(position.reserveUsd)}</strong></div>
          </div>
        </article>`,
    )
    .join("");

  const recentRuns = recentHistory
    .slice(0, 6)
    .map(
      (entry) => `
        <div class="status-row">
          <span>${escapeHtml(entry.generatedAt)}</span>
          <strong>
            ${entry.candidateCount} scans / ${entry.topRecommendationCount} buys<br />
            Avg ${entry.averageScore} / Treasury ${formatUsd(entry.treasuryAllocatedUsd)}
          </strong>
        </div>`,
    )
    .join("");

  const watchlistRows = watchlist
    .slice(0, 8)
    .map(
      (entry) => `
        <div class="status-row">
          <span><a class="watchlist-link" href="${candidateHref(entry.tokenAddress)}">${escapeHtml(entry.tokenSymbol)}</a></span>
          <strong>
            ${entry.currentRecommendation} · ${entry.currentScore}/100<br />
            Seen ${entry.appearances}x · Δ ${entry.scoreChange >= 0 ? "+" : ""}${entry.scoreChange}
          </strong>
        </div>`,
    )
    .join("");

  const closedPositions = portfolioLifecycle.exitedPositions;
  const profitableClosedPositions = closedPositions.filter(
    (position) => position.realizedPnlUsd > 0,
  );
  const winRatePct = closedPositions.length
    ? (profitableClosedPositions.length / closedPositions.length) * 100
    : null;
  const tradeRecords = tradeLedger.records.filter(
    (record) => record.plannedBuyBnb > 0,
  );
  const averageBuyBnb = average(
    tradeRecords.map((record) => record.plannedBuyBnb),
  );
  const holdDurationsMs = (
    closedPositions.length > 0
      ? closedPositions
      : portfolioLifecycle.activePositions
  )
    .map(
      (position) =>
        Date.parse(position.lastUpdatedAt) - Date.parse(position.firstSeenAt),
    )
    .filter((value) => Number.isFinite(value) && value > 0);
  const averageHoldMs = average(holdDurationsMs);
  const timezoneLabel =
    Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const currentModel =
    process.env.OPENAI_MODEL?.trim() ||
    process.env.MOLTBOOK_MODEL?.trim() ||
    "n/a";
  const hasOpenAiKey = Boolean(process.env.OPENAI_API_KEY?.trim());
  const cloudAccountRows = renderDashboardCloudSidebar(cloudSession, cloudSummary);
  const riskProfile =
    executionState.risk.maxBuyBnb <= 0.02 &&
    executionState.risk.maxDailyDeployBnb <= 0.05
      ? "Conservative"
      : executionState.risk.maxBuyBnb <= 0.05 &&
          executionState.risk.maxDailyDeployBnb <= 0.2
        ? "Balanced"
        : "Aggressive";
  const sidebarWalletAddress = "0x2D6C3358A3acFe3be42b2Bdf7419e87091270c5F";
  const sidebarMasterCard = `
    <article class="sidebar-panel sidebar-panel--master">
      <div class="sidebar-panel__head">
        <div class="sidebar-avatar">${renderBrandLogoImage("sidebar-avatar__image")}</div>
        <div>
          <strong>elizaOK</strong>
        </div>
      </div>
      <div class="status-panel compact-status">
        <div class="status-row"><span>Wallet</span><strong>${escapeHtml(shortAddress(sidebarWalletAddress))}</strong></div>
        <div class="status-row"><span>Balance</span><strong>${escapeHtml(sidebarWalletBalanceLabel)}</strong></div>
      </div>
      <div class="status-panel compact-status">
        <div class="status-row"><span>TZ</span><strong>${escapeHtml(timezoneLabel)}</strong></div>
        <div class="status-row"><span>Scan</span><strong>${escapeHtml(formatRelativeTime(snapshot.generatedAt))}</strong></div>
        <div class="status-row"><span>Exec</span><strong>${escapeHtml(executionState.mode)} / ${executionState.dryRun ? "dry-run" : "live"}</strong></div>
      </div>
      <div class="sidebar-panel__title">LLM</div>
      <div class="llm-model-row">
        <span>Runtime model</span>
        <strong>${escapeHtml(currentModel)}</strong>
      </div>
      <div class="usage-stack">
        ${renderUsageRow("API key", hasOpenAiKey ? 100 : 0, hasOpenAiKey ? "100%" : "0%")}
        ${renderUsageRow("Model set", currentModel === "n/a" ? 0 : 100, currentModel === "n/a" ? "0%" : "100%")}
      </div>
      ${cloudAccountRows}
      <div class="sidebar-panel__title">System</div>
      <div class="status-panel compact-status">
        <div class="status-row"><span>Discovery</span><strong>${Math.round(getDiscoveryConfig().intervalMs / 60_000)}m</strong></div>
        <div class="status-row"><span>Buy-ready</span><strong>${eligibleExecutionPlans}</strong></div>
        <div class="status-row"><span>Distribution</span><strong>${distributionExecution.enabled ? "armed" : "standby"}</strong></div>
        <div class="status-row"><span>Goo</span><strong>${getDiscoveryConfig().goo.enabled ? "armed" : "standby"}</strong></div>
      </div>
      <div class="sidebar-panel__title">Runtime</div>
      <div class="status-panel compact-status">
        <div class="status-row"><span>Agent</span><strong>elizaOS</strong></div>
        <div class="status-row"><span>Health</span><strong>Discovery ${snapshot.summary.candidateCount > 0 ? "online" : "warming"} · Goo ${getDiscoveryConfig().goo.enabled ? "armed" : "standby"}</strong></div>
      </div>
    </article>`;
  const snapshotStatTiles = [
    { label: "Win Rate", value: formatPct(winRatePct) },
    { label: "Trades", value: String(tradeRecords.length) },
    { label: "Avg Hold", value: formatDuration(averageHoldMs) },
    {
      label: "Avg Size",
      value: averageBuyBnb === null ? "n/a" : formatBnb(averageBuyBnb),
    },
  ]
    .map(
      (item) => `
        <article class="snapshot-tile">
          <span>${escapeHtml(item.label)}</span>
          <strong>${escapeHtml(item.value)}</strong>
        </article>`,
    )
    .join("");
  const discoveryPct = snapshot.summary.averageScore;
  const portfolioPct =
    portfolioLifecycle.grossPortfolioValueUsd > 0
      ? (portfolioLifecycle.totalCurrentValueUsd /
          portfolioLifecycle.grossPortfolioValueUsd) *
        100
      : 0;
  const executionPct =
    executionState.readinessTotal > 0
      ? (executionState.readinessScore / executionState.readinessTotal) * 100
      : 0;
  const distributionPct =
    distributionExecution.readinessTotal > 0
      ? (distributionExecution.readinessScore /
          distributionExecution.readinessTotal) *
        100
      : 0;
  const gooPct = (gooConfigReadiness / 3) * 100;
  const featureDockCards = [
    renderFeatureDockCard(
      "discovery-section",
      "Discovery",
      `${clampPercent(discoveryPct)}%`,
      `${snapshot.summary.candidateCount}`,
      `${snapshot.summary.topRecommendationCount} buy-ready`,
      discoveryPct,
      "hot",
      "BUY-READY",
      "SCANNED",
      `${snapshot.summary.topRecommendationCount}`,
      `${snapshot.summary.candidateCount}`,
    ),
    renderFeatureDockCard(
      "portfolio-section",
      "Portfolio",
      `${clampPercent(portfolioPct)}%`,
      `${portfolioLifecycle.activePositions.length}`,
      `${formatUsd(portfolioLifecycle.grossPortfolioValueUsd)}`,
      portfolioPct,
      "cool",
      "ACTIVE",
      "VALUE",
      `${portfolioLifecycle.activePositions.length}`,
      formatUsd(portfolioLifecycle.grossPortfolioValueUsd),
    ),
    renderFeatureDockCard(
      "treasury-section",
      "Execution",
      `${clampPercent(executionPct)}%`,
      `${eligibleExecutionPlans}`,
      executionState.mode,
      executionPct,
      executionState.dryRun ? "warm" : "hot",
      "ELIGIBLE",
      "MODE",
      `${eligibleExecutionPlans}`,
      executionState.dryRun ? "DRY-RUN" : "LIVE",
    ),
    renderFeatureDockCard(
      "distribution-section",
      "Distribution",
      `${clampPercent(distributionPct)}%`,
      `${distributionPlan.eligibleHolderCount}`,
      `${distributionPlan.recipients.length} recipients`,
      distributionPct,
      distributionExecution.dryRun ? "warm" : "hot",
      "HOLDERS",
      "RECIPIENTS",
      `${distributionPlan.eligibleHolderCount}`,
      `${distributionPlan.recipients.length}`,
    ),
    renderFeatureDockCard(
      "goo-section",
      "Goo",
      `${clampPercent(gooPct)}%`,
      `${snapshot.summary.gooAgentCount}`,
      `${snapshot.summary.gooPriorityCount} priority`,
      gooPct,
      "cool",
      "PRIORITY",
      "REVIEWED",
      `${snapshot.summary.gooPriorityCount}`,
      `${snapshot.summary.gooAgentCount}`,
    ),
  ].join("");
  const discoveryFoldSummary = `${snapshot.summary.candidateCount} scanned · ${snapshot.summary.topRecommendationCount} buy-ready · avg ${snapshot.summary.averageScore}`;
  const portfolioFoldSummary = `${portfolioLifecycle.activePositions.length} active · ${portfolioLifecycle.watchPositions.length} watch · ${formatUsd(portfolioLifecycle.grossPortfolioValueUsd)}`;
  const treasuryFoldSummary = `${formatBnb(executionState.risk.maxBuyBnb)} max buy · ${eligibleExecutionPlans} eligible · ${tradeLedger.records.length} ledger`;
  const distributionFoldSummary = `${distributionPlan.eligibleHolderCount} holders · ${distributionPlan.recipients.length} recipients · ${distributionExecution.dryRun ? "dry-run" : "live"}`;
  const gooFoldSummary = `${snapshot.summary.gooAgentCount} reviewed · ${snapshot.summary.gooPriorityCount} priority · ${gooConfigReadiness}/3 ready`;
  const overviewVisualBars = [
    renderProgress(
      "Discovery",
      snapshot.summary.averageScore,
      100,
      `${snapshot.summary.averageScore}%`,
    ),
    renderProgress("Win rate", winRatePct ?? 0, 100, formatPct(winRatePct)),
    renderProgress(
      "Execution",
      executionPct,
      100,
      `${clampPercent(executionPct)}%`,
    ),
    renderProgress(
      "Distribution",
      distributionPct,
      100,
      `${clampPercent(distributionPct)}%`,
    ),
    renderProgress("Goo", gooPct, 100, `${clampPercent(gooPct)}%`),
    renderProgress(
      "Reserve",
      treasurySimulation.reservePct,
      100,
      `${treasurySimulation.reservePct}%`,
    ),
  ].join("");

  const distributionRecipients = distributionPlan.recipients
    .slice(0, 8)
    .map(
      (recipient, index) => `
        <article class="candidate-card">
          <div class="candidate-card__meta">
            <span class="candidate-rank">0${index + 1}</span>
            <span class="pill tone-cool">${recipient.allocationPct}%</span>
          </div>
          <h3>${escapeHtml(recipient.label || shortAddress(recipient.address))}</h3>
          <p class="candidate-subtitle">${escapeHtml(shortAddress(recipient.address))}</p>
          <div class="candidate-stats">
            <div><span>Balance</span><strong>${Math.round(recipient.balance).toLocaleString()}</strong></div>
            <div><span>Allocation</span><strong>${formatUsd(recipient.allocationUsd)}</strong></div>
            <div><span>Weight</span><strong>${recipient.allocationPct}%</strong></div>
            <div><span>Status</span><strong>Eligible</strong></div>
          </div>
        </article>`,
    )
    .join("");

  const distributionExecutedRecipients = new Set(
    distributionLedger.records
      .filter(
        (record) =>
          record.disposition === "executed" &&
          distributionExecution.manifestFingerprint &&
          record.manifestFingerprint ===
            distributionExecution.manifestFingerprint,
      )
      .map((record) => record.recipientAddress.toLowerCase()),
  );

  const distributionPendingRecipients = distributionPlan.recipients
    .filter(
      (recipient) =>
        !distributionExecutedRecipients.has(recipient.address.toLowerCase()),
    )
    .slice(0, Math.max(1, distributionExecution.maxRecipientsPerRun || 5));

  const distributionPendingRows = distributionPendingRecipients
    .map(
      (recipient) => `
        <div class="status-row">
          <span>${escapeHtml(recipient.label || shortAddress(recipient.address))}</span>
          <strong>
            ${escapeHtml(shortAddress(recipient.address))} · ${recipient.allocationPct}%<br />
            ${formatUsd(recipient.allocationUsd)} current allocation plan
          </strong>
        </div>`,
    )
    .join("");

  // alias for new body template
  const distributionRecipientRows = distributionPendingRows;

  const distributionExecutionRows = distributionExecution.readinessChecks
    .map(
      (check) => `
        <div class="status-row">
          <span>${escapeHtml(check.label)}</span>
          <strong>${check.ready ? "READY" : "TODO"}<br />${escapeHtml(check.detail)}</strong>
        </div>`,
    )
    .join("");

  const distributionLedgerRows = distributionLedger.records
    .slice(0, 6)
    .map(
      (record) => `
        <div class="status-row">
          <span>${escapeHtml(shortAddress(record.recipientAddress))}</span>
          <strong>
            ${escapeHtml(record.disposition)} · ${escapeHtml(record.amount)}${record.txHash ? ` · ${escapeHtml(shortAddress(record.txHash))}` : ""}<br />
            ${escapeHtml(record.reason)}
          </strong>
        </div>`,
    )
    .join("");

  const executionPlanRows = executionState.plans
    .slice(0, 6)
    .map(
      (plan) => `
        <div class="status-row">
          <span>${escapeHtml(plan.tokenSymbol)}</span>
          <strong>
            strategy ${plan.eligible ? "eligible" : "blocked"} · route ${escapeHtml(plan.routeTradable)} · ${plan.score}/100 · ${formatBnb(plan.plannedBuyBnb)}<br />
            ${escapeHtml(plan.routeReason || plan.reasons[0] || "No execution note.")}
          </strong>
        </div>`,
    )
    .join("");

  const recentTradeRows = tradeLedger.records
    .slice(0, 6)
    .map(
      (trade) => `
        <div class="status-row">
          <span>${escapeHtml(trade.tokenSymbol)}</span>
          <strong>
            ${escapeHtml(trade.side || "buy")} · ${escapeHtml(trade.disposition)} · ${formatBnb(trade.plannedBuyBnb)}${trade.txHash ? ` · ${escapeHtml(shortAddress(trade.txHash))}` : ""}<br />
            ${escapeHtml(trade.reason)}
          </strong>
        </div>`,
    )
    .join("");

  const activePortfolioCards = portfolioLifecycle.activePositions
    .slice(0, 6)
    .map(
      (position, index) => `
        <article class="candidate-card">
          <div class="candidate-card__meta">
            <span class="candidate-rank">0${index + 1}</span>
            <span class="pill ${pnlTone(position.unrealizedPnlUsd)}">${position.unrealizedPnlUsd >= 0 ? "+" : ""}${formatUsd(position.unrealizedPnlUsd)}</span>
          </div>
          <h3><a class="candidate-link" href="${candidateHref(position.tokenAddress)}">${escapeHtml(position.tokenSymbol)}</a></h3>
          <p class="candidate-subtitle">${escapeHtml(position.executionSource)} · ${escapeHtml(position.walletVerification)} · ${escapeHtml(position.state)} · ${escapeHtml(position.lastRecommendation)}</p>
          <div class="candidate-stats">
            <div><span>Initial</span><strong>${formatUsd(position.initialAllocationUsd)}</strong></div>
            <div><span>Allocated</span><strong>${formatUsd(position.allocationUsd)}</strong></div>
            <div><span>Current value</span><strong>${formatUsd(position.currentValueUsd)}</strong></div>
            <div><span>Wallet quote</span><strong>${position.walletQuoteUsd !== null && position.walletQuoteUsd !== undefined ? formatUsd(position.walletQuoteUsd) : "n/a"}</strong></div>
            <div><span>TP hit</span><strong>${position.takeProfitCount}</strong></div>
            <div><span>Unrealized</span><strong>${position.unrealizedPnlPct}%</strong></div>
            <div><span>Appearances</span><strong>${position.appearanceCount}</strong></div>
          </div>
        </article>`,
    )
    .join("");

  const timelineRows = portfolioLifecycle.timeline
    .slice(0, 8)
    .map(
      (event) => `
        <div class="status-row">
          <span>${escapeHtml(event.generatedAt)}</span>
          <strong>
            ${escapeHtml(event.tokenSymbol)} · ${escapeHtml(event.type)}<br />
            ${escapeHtml(event.detail)}
          </strong>
        </div>`,
    )
    .join("");

  const overviewStateChips = [
    `execution ${escapeHtml(executionState.dryRun ? "dry-run" : "live")} / ${escapeHtml(executionState.mode)}`,
    `distribution ${escapeHtml(distributionExecution.dryRun ? "dry-run" : "live")} / ${escapeHtml(distributionPlan.selectedAsset.mode)}`,
    `goo ${escapeHtml(getDiscoveryConfig().goo.enabled ? (gooConfigReadiness === 3 ? "ready" : "warming") : "disabled")}`,
  ]
    .map((item) => `<div class="state-chip">${item}</div>`)
    .join("");
  const heroActionRow = `
    <div class="action-row">
      <a class="action-button" href="#discovery-section">Discovery Feed</a>
      <a class="action-button" href="/cloud/agents">Cloud Agents</a>
      <a class="action-button" href="/cloud/credits">Credits</a>
      <a class="action-button" href="${escapeHtml(getElizaCloudDashboardUrl())}" target="_blank" rel="noreferrer">Open Cloud</a>
    </div>`;
  const heroStageRows = [
    {
      label: "Discovery board",
      value: `${snapshot.summary.candidateCount} scanned`,
      meta: `${snapshot.summary.topRecommendationCount} ready · avg ${snapshot.summary.averageScore}`,
    },
    {
      label: "Execution lane",
      value: `${eligibleExecutionPlans} tradable`,
      meta: `${executionState.mode} · ${executionState.dryRun ? "dry-run" : "live"}`,
    },
    {
      label: "Distribution loop",
      value: `${distributionPlan.recipients.length} recipients`,
      meta: `${distributionPlan.eligibleHolderCount} holders · ${distributionExecution.dryRun ? "simulated" : "armed"}`,
    },
    {
      label: "Goo operator",
      value: `${snapshot.summary.gooPriorityCount} priority`,
      meta: `${snapshot.summary.gooAgentCount} reviewed · ${getDiscoveryConfig().goo.enabled ? "enabled" : "standby"}`,
    },
  ]
    .map(
      (item) => `
        <div class="hero-stage__row">
          <span>${escapeHtml(item.label)}</span>
          <strong>${escapeHtml(item.value)}</strong>
          <small>${escapeHtml(item.meta)}</small>
        </div>`,
    )
    .join("");
  const heroStage = `
    <div class="hero-stage">
      <div class="hero-stage__glyphs">♬ ★ ♬ ★ ♪ ✦ ♪</div>
      <div class="hero-stage__count">3</div>
      <div class="hero-stage__screen">
        ${renderBrandLogoImage("hero-stage__image")}
      </div>
      <div class="hero-stage__stack">
        ${heroStageRows}
      </div>
    </div>`;
  const summaryRibbon = [
    `${snapshot.summary.strongestCandidate?.tokenSymbol || "n/a"} strongest signal`,
    `${formatBnb(executionState.risk.maxBuyBnb)} max buy`,
    `${tradeLedger.records.length} executions tracked`,
    `${distributionPlan.selectedAsset.tokenSymbol || "distribution asset pending"}`,
  ]
    .map((item) => `<div class="summary-pill">${escapeHtml(item)}</div>`)
    .join("");
  const cloudTopSyncing = cloudSession
    ? cloudSession.displayName === "ElizaCloud User" ||
      cloudSession.organizationName === "ElizaCloud" ||
      cloudSession.credits === "linked"
    : false;
  const cloudToolbarLinks = renderCloudToolbarLinks(cloudSession);
  const cloudAuthButton = cloudSession
    ? `<a class="auth-link auth-link--connected" href="/auth/eliza-cloud/logout" title="${escapeHtml(cloudSession.displayName)}">${cloudTopSyncing ? "ElizaCloud · syncing" : `ElizaCloud · ${escapeHtml(cloudSession.displayName)} · ${escapeHtml(cloudSession.credits)} credits`}</a>`
    : `<button class="auth-link" type="button" data-cloud-hosted-auth>Sign in with ElizaCloud</button>`;
  const treasuryModelCards = [
    renderMetricCard(
      "Capital model",
      formatUsd(treasurySimulation.paperCapitalUsd),
      "Current treasury capital model baseline.",
    ),
    renderMetricCard(
      "Deployable",
      formatUsd(treasurySimulation.deployableCapitalUsd),
      "Capital currently available for new deployment.",
    ),
    renderMetricCard(
      "Allocated",
      formatUsd(treasurySimulation.allocatedUsd),
      "Capital presently assigned inside the treasury model.",
    ),
    renderMetricCard(
      "Dry powder",
      formatUsd(treasurySimulation.dryPowderUsd),
      "Remaining unallocated treasury capacity.",
    ),
    renderMetricCard(
      "Reserve",
      `${formatUsd(treasurySimulation.reserveUsd)} / ${treasurySimulation.reservePct}%`,
      "Capital held back under reserve discipline.",
    ),
    renderMetricCard(
      "Highest conviction",
      treasurySimulation.highestConvictionSymbol || "n/a",
      "Top name by current treasury conviction.",
    ),
  ].join("");
  const executionControlCards = [
    renderMetricCard(
      "Mode",
      executionState.mode,
      `Router ${executionState.router} in ${executionState.dryRun ? "dry-run" : "live"} mode.`,
    ),
    renderMetricCard(
      "Readiness",
      `${executionState.readinessScore}/${executionState.readinessTotal}`,
      "Current live execution readiness checks.",
    ),
    renderMetricCard(
      "Risk cap",
      formatBnb(executionState.risk.maxBuyBnb),
      `Daily cap ${formatBnb(executionState.risk.maxDailyDeployBnb)}.`,
    ),
    renderMetricCard(
      "Eligible lanes",
      String(eligibleExecutionPlans),
      "Candidates currently passing execution gates.",
    ),
    renderMetricCard(
      "Cycle result",
      `${executionState.cycleSummary.executedCount}/${executionState.cycleSummary.dryRunCount}/${executionState.cycleSummary.failedCount}`,
      "Executed / dry-run / failed counts for the latest cycle.",
    ),
  ].join("");
  const distributionStateCards = [
    renderMetricCard(
      "Holder pool",
      String(distributionPlan.eligibleHolderCount),
      `Minimum balance ${distributionPlan.minEligibleBalance}.`,
    ),
    renderMetricCard(
      "Distribution pool",
      formatUsd(distributionPlan.distributionPoolUsd),
      `Snapshot source ${distributionPlan.snapshotSource}.`,
    ),
    renderMetricCard(
      "Asset mode",
      distributionPlan.selectedAsset.mode,
      distributionPlan.selectedAsset.tokenSymbol ||
        shortAddress(distributionPlan.selectedAsset.tokenAddress || "n/a"),
    ),
    renderMetricCard(
      "Execution mode",
      distributionExecution.dryRun ? "dry_run" : "live",
      `${distributionExecution.readinessScore}/${distributionExecution.readinessTotal} readiness.`,
    ),
    renderMetricCard(
      "Batch size",
      String(distributionExecution.maxRecipientsPerRun),
      `Pending ${Math.max(0, distributionPlan.recipients.length - distributionExecutedRecipients.size)} recipients.`,
    ),
    renderMetricCard(
      "Fingerprint",
      shortAddress(distributionExecution.manifestFingerprint || "n/a"),
      "Current distribution campaign identity.",
    ),
  ].join("");
  const distributionRibbon = [
    `mode ${escapeHtml(distributionExecution.dryRun ? "dry_run" : "live")}`,
    `${distributionExecution.cycleSummary.dryRunCount} dry-run`,
    `${distributionExecution.cycleSummary.executedCount} executed`,
    `${Math.max(0, distributionPlan.recipients.length - distributionExecutedRecipients.size)} pending`,
  ]
    .map((item) => `<div class="summary-pill">${item}</div>`)
    .join("");
  const systemPulse = `
    <article class="glass-card section-card">
      <div class="section-title">
        <div>
          <h2>System</h2>
        </div>
      </div>
      <div class="status-panel">
        <div class="status-row"><span>Strongest candidate</span><strong>${escapeHtml(snapshot.summary.strongestCandidate?.tokenSymbol || "n/a")}</strong></div>
        <div class="status-row"><span>Strongest score</span><strong>${snapshot.summary.strongestCandidate?.score ?? "n/a"}</strong></div>
        <div class="status-row"><span>Recommendation</span><strong>${escapeHtml(snapshot.summary.strongestCandidate?.recommendation || "n/a")}</strong></div>
        <div class="status-row"><span>Goo reviewed</span><strong>${snapshot.summary.gooAgentCount}</strong></div>
        <div class="status-row"><span>Memo title</span><strong>${escapeHtml(snapshot.memoTitle)}</strong></div>
      </div>
    </article>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  ${renderHeadBrandAssets("ElizaOK | elizaOK")}
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    /* ════════════════════════════════════════════════════════
       elizaOK Control Interface
       Inspired by: Hermes Control Interface layout
       Left sidebar · Center grid panels · Right stats
       JetBrains Mono · Black + Yellow + Green
    ════════════════════════════════════════════════════════ */
    @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:ital,wght@0,300;0,400;0,500;0,600;0,700;0,800;1,400&display=swap');

    :root {
      --bg:       #080808;
      --panel:    #0f0f0f;
      --panel2:   #111111;
      --border:   #1c1c1c;
      --border2:  #252525;
      --yellow:   #F6E70F;
      --yr:       246,231,15;
      --green:    #39FF14;
      --gr:       57,255,20;
      --red:      #FF4444;
      --white:    rgba(255,255,255,0.88);
      --dim:      rgba(255,255,255,0.40);
      --mute:     rgba(255,255,255,0.18);
      --r:        7px;
      --r-sm:     5px;
      --dot-color: 255,255,255;
    }
    [data-theme="light"] {
      --bg:       #f4f4f0;
      --panel:    #ffffff;
      --panel2:   #f8f8f5;
      --border:   #e0dfd8;
      --border2:  #d0cfca;
      --yellow:   #b8a800;
      --yr:       184,168,0;
      --green:    #1a8f00;
      --gr:       26,143,0;
      --red:      #d43030;
      --white:    rgba(20,20,18,0.88);
      --dim:      rgba(20,20,18,0.50);
      --mute:     rgba(20,20,18,0.22);
      --dot-color: 20,20,18;
    }

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; overflow: hidden; background: var(--bg); }
    body {
      font-family: 'JetBrains Mono', 'Courier New', monospace;
      font-size: 13px; line-height: 1.5; color: var(--white);
      -webkit-font-smoothing: antialiased;
      transition: background .3s, color .3s;
    }
    ::-webkit-scrollbar { width: 3px; height: 3px; }
    ::-webkit-scrollbar-thumb { background: var(--border2); border-radius: 2px; }
    a { color: inherit; text-decoration: none; }

    /* Canvas */
    #dot-canvas { position: fixed; inset: 0; z-index: 0; pointer-events: none; }

    /* ─── LAYOUT ─────────────────────────────── */
    .layout {
      position: relative; z-index: 1;
      display: flex; flex-direction: column; height: 100vh;
    }

    /* ─── TOP BAR ────────────────────────────── */
    .topbar {
      flex-shrink: 0; height: 44px;
      display: flex; align-items: center;
      background: var(--panel); border-bottom: 1px solid var(--border);
      padding: 0 16px; gap: 12px; z-index: 100;
      transition: background .3s, border-color .3s;
    }
    .topbar__nav { display: flex; gap: 6px; align-items: center; }
    .tb-nav-btn {
      font-family: inherit; font-size: 0.7rem; font-weight: 600;
      letter-spacing: 0.1em; text-transform: uppercase;
      padding: 5px 14px; border-radius: var(--r-sm);
      border: 1px solid var(--border2); background: transparent;
      color: var(--dim); text-decoration: none; cursor: pointer; transition: all .18s;
    }
    .tb-nav-btn:hover { border-color: rgba(var(--yr),.6); color: var(--yellow); }
    .tb-nav-btn--user { border-color: rgba(var(--yr),.5); color: var(--yellow); font-weight: 700; }
    .tb-nav-btn--user:hover { background: rgba(var(--yr),.1); }
    .tb-nav-btn--connect { border-color: rgba(var(--yr),.35); color: var(--yellow); }
    .topbar__right { display: flex; align-items: center; gap: 8px; margin-left: auto; }
    .topbar__time { font-size: 0.75rem; color: var(--dim); }
    .tb-btn {
      font-family: inherit; font-size: 0.7rem; font-weight: 600;
      letter-spacing: 0.12em; text-transform: uppercase;
      padding: 5px 12px; border-radius: var(--r-sm);
      border: 1px solid var(--border2); background: var(--panel2);
      color: var(--dim); cursor: pointer; transition: all .18s; text-decoration: none; display: inline-flex; align-items: center;
    }
    .tb-btn svg { width: 15px; height: 15px; }
    .tb-btn:hover { border-color: var(--border2); color: var(--white); background: var(--border); }
    .tb-btn.live { border-color: rgba(var(--gr),.4); color: var(--green); background: rgba(var(--gr),.06); }
    .tb-btn.primary { border-color: rgba(var(--yr),.4); color: var(--yellow); background: rgba(var(--yr),.06); }
    .tb-btn.primary:hover { background: rgba(var(--yr),.14); box-shadow: 0 0 14px rgba(var(--yr),.18); }
    #theme-toggle { font-size: 0.85rem; padding: 4px 10px; letter-spacing: 0; }

    /* ─── CONTENT AREA ───────────────────────── */
    .content-area { flex: 1; display: flex; overflow: hidden; }

    /* ─── LEFT SIDEBAR ───────────────────────── */
    .sidebar {
      width: 230px; flex-shrink: 0;
      background: rgba(8,8,8,0.97); border-right: 1px solid var(--border);
      display: flex; flex-direction: column;
      overflow-y: auto;
      transition: background .3s, border-color .3s;
    }

    .sb-agent {
      padding: 18px 16px 14px; border-bottom: 1px solid var(--border);
      text-align: center;
    }
    .sb-agent__avatar {
      width: 58px; height: 58px; border-radius: 50%;
      border: 1.5px solid rgba(var(--yr),.35); margin: 0 auto 10px;
      display: block; background: #111;
    }
    .sb-agent__status {
      display: inline-flex; align-items: center; gap: 5px;
      font-size: 0.62rem; letter-spacing: 0.14em; text-transform: uppercase;
      padding: 3px 9px; border-radius: 999px;
      border: 1px solid rgba(var(--gr),.35); color: var(--green);
      margin-bottom: 6px;
    }
    .sb-agent__status-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--green); animation: live-pulse 2s ease-in-out infinite; }
    @keyframes live-pulse { 0%,100%{opacity:1} 50%{opacity:.3} }
    .sb-agent__name { font-size: 0.92rem; font-weight: 700; color: var(--yellow); }
    .sb-agent__role { font-size: 0.62rem; color: var(--dim); letter-spacing: 0.08em; margin-top: 3px; }
    .sb-agent__addr { font-size: 0.58rem; color: var(--mute); margin-top: 5px; }
    .sb-agent__bal  { font-size: 0.72rem; color: var(--white); margin-top: 4px; font-weight: 600; }

    .sb-btns { padding: 12px 12px 10px; border-bottom: 1px solid var(--border); display: flex; gap: 6px; }
    .sb-action-btn {
      flex: 1; font-family: inherit; font-size: 0.62rem; font-weight: 600;
      letter-spacing: 0.1em; text-transform: uppercase;
      padding: 6px 6px; border-radius: var(--r-sm);
      border: 1px solid var(--border2); background: var(--panel2);
      color: var(--dim); cursor: pointer; transition: all .18s;
    }
    .sb-action-btn:hover { border-color: rgba(var(--yr),.35); color: var(--yellow); background: rgba(var(--yr),.05); }

    .sb-section { padding: 12px 12px 10px; border-bottom: 1px solid var(--border); }
    .sb-section__title { font-size: 0.62rem; letter-spacing: 0.18em; text-transform: uppercase; color: var(--mute); margin-bottom: 8px; }

    .qa-btn {
      display: flex; align-items: center; gap: 7px;
      width: 100%; font-family: inherit; font-size: 0.72rem; font-weight: 500;
      padding: 6px 10px; border-radius: var(--r-sm); border: 1px solid transparent;
      background: none; color: var(--dim); cursor: pointer; transition: all .18s;
      text-align: left; margin-bottom: 4px; letter-spacing: 0.04em;
    }
    .qa-btn:hover { background: var(--panel2); border-color: var(--border); color: var(--white); }
    .qa-btn:last-child { margin-bottom: 0; }
    .qa-btn__icon { font-size: 0.82rem; flex-shrink: 0; }

    .sb-stat-row { display: flex; justify-content: space-between; align-items: baseline; padding: 4px 0; font-size: 0.72rem; }
    .sb-stat-row span { color: var(--dim); }
    .sb-stat-row strong { color: var(--white); }
    .sb-stat-row strong.y { color: var(--yellow); }
    .sb-stat-row strong.g { color: var(--green); }

    .recent-item {
      padding: 7px 10px; border-radius: var(--r-sm); margin-bottom: 4px;
      border: 1px solid transparent; cursor: pointer; transition: all .18s;
    }
    .recent-item:hover { background: var(--panel2); border-color: var(--border); }
    .recent-item__sym { font-size: 0.78rem; font-weight: 700; color: var(--yellow); }
    .recent-item__meta { font-size: 0.62rem; color: var(--dim); margin-top: 2px; }

    /* ─── MAIN CONTENT ───────────────────────── */
    .main {
      flex: 1; overflow-y: auto; overflow-x: hidden;
      display: flex; flex-direction: column; gap: 0;
      padding: 12px; background: var(--bg);
    }

    /* Grid rows */
    .panel-row { display: grid; gap: 10px; margin-bottom: 10px; }
    .panel-row--3 { grid-template-columns: 1fr 1fr 1fr; }
    .panel-row--2 { grid-template-columns: 1.4fr 1fr; }
    .panel-row--1 { grid-template-columns: 1fr; }
    .panel-row--2-3 { grid-template-columns: 2fr 1fr; }

    /* Panel */
    .panel {
      background: var(--panel); border: 1px solid var(--border);
      border-radius: var(--r); overflow: hidden;
      display: flex; flex-direction: column;
      transition: background .3s, border-color .3s;
    }
    .panel__head {
      display: flex; align-items: center; gap: 8px;
      padding: 9px 12px; border-bottom: 1px solid var(--border);
      background: var(--panel2); flex-shrink: 0;
    }
    .panel__title { font-size: 0.72rem; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; color: var(--dim); }
    .panel__badge {
      font-size: 0.58rem; letter-spacing: 0.1em; text-transform: uppercase;
      padding: 2px 8px; border-radius: 999px; border: 1px solid; margin-left: auto;
    }
    .pb-green  { color: var(--green); border-color: rgba(var(--gr),.35); }
    .pb-yellow { color: var(--yellow); border-color: rgba(var(--yr),.35); }
    .pb-dim    { color: var(--mute); border-color: var(--border2); }
    .pb-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
    .pb-dot.g { background: var(--green); animation: live-pulse 2.5s infinite; }
    .pb-dot.y { background: var(--yellow); }
    .pb-dot.d { background: #333; }
    .panel__body { padding: 12px; flex: 1; overflow: hidden; }
    .panel__body--p0 { padding: 0; }

    /* Monitor rows (like CPU/storage in Hermes) */
    .mon-row { margin-bottom: 12px; }
    .mon-row:last-child { margin-bottom: 0; }
    .mon-label { display: flex; justify-content: space-between; margin-bottom: 4px; font-size: 0.72rem; }
    .mon-label span { color: var(--dim); }
    .mon-label strong { color: var(--white); }
    .mon-label strong.y { color: var(--yellow); }
    .mon-bar { height: 4px; background: #1a1a1a; border-radius: 2px; }
    .mon-fill { height: 100%; border-radius: 2px; transition: width .8s cubic-bezier(.4,0,.2,1); }
    .mon-fill.y { background: linear-gradient(90deg, rgba(var(--yr),.4), var(--yellow)); }
    .mon-fill.g { background: linear-gradient(90deg, rgba(var(--gr),.4), var(--green)); }
    .mon-big { font-size: 1.5rem; font-weight: 800; color: var(--yellow); line-height: 1; margin-bottom: 3px; }
    .mon-sub { font-size: 0.65rem; color: var(--dim); }

    /* Scheduler-style rows */
    .sched-row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,.04); font-size: 0.78rem; }
    .sched-row:last-child { border-bottom: none; }
    .sched-row span { color: var(--dim); }
    .sched-row strong { font-weight: 600; }
    .sched-row strong.y { color: var(--yellow); }
    .sched-row strong.g { color: var(--green); }
    .sched-row strong.r { color: var(--red); }
    .sched-row strong.w { color: var(--white); }

    /* File explorer / token list */
    .file-tree { font-size: 0.75rem; padding: 6px 0; }
    .file-dir { color: var(--yellow); padding: 4px 0; font-weight: 600; display: flex; align-items: center; gap: 6px; }
    .file-dir::before { content: '▸'; font-size: 0.6rem; color: var(--dim); }
    .file-item { padding: 4px 0 4px 16px; color: var(--dim); display: flex; align-items: center; gap: 7px; cursor: pointer; border-radius: 3px; transition: all .15s; }
    .file-item:hover { background: var(--panel2); color: var(--white); }
    .file-item__sym { color: var(--yellow); font-weight: 700; width: 68px; flex-shrink: 0; }
    .file-item__score { color: var(--white); width: 44px; flex-shrink: 0; }
    .file-item__rec { font-size: 0.62rem; color: var(--dim); }

    /* Terminal / live feed */
    .term-body { font-size: 0.75rem; padding: 10px; overflow-y: auto; max-height: 220px; }
    .term-line { display: flex; gap: 8px; padding: 2px 0; }
    .term-line .ts  { color: var(--mute); flex-shrink: 0; font-size: 0.65rem; }
    .term-line .tag { font-size: 0.58rem; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; padding: 1px 6px; border-radius: 2px; flex-shrink: 0; }
    .tag-info { background: rgba(0,229,255,.15); color: #00E5FF; }
    .tag-ok   { background: rgba(var(--gr),.15); color: var(--green); }
    .tag-warn { background: rgba(255,152,0,.15); color: #FF9800; }
    .tag-err  { background: rgba(255,68,68,.15); color: var(--red); }
    .term-line .msg { color: var(--dim); }
    .term-line .msg .hi { color: var(--yellow); }
    .term-line .msg .ok { color: var(--green); }
    .prompt-line { display: flex; gap: 7px; align-items: center; padding: 3px 0; }
    .prompt-line .pr { color: var(--yellow); }
    .prompt-line .cmd { color: var(--white); }
    .cursor { display: inline-block; width: 8px; height: 14px; background: var(--yellow); animation: blink-cur .8s step-end infinite; }
    @keyframes blink-cur { 0%,100%{opacity:1} 50%{opacity:0} }

    /* Candidates inside panel */
    .cand-row {
      display: flex; align-items: center; gap: 9px;
      padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,.04);
      font-size: 0.75rem; cursor: pointer; transition: background .15s;
      border-radius: 3px;
    }
    .cand-row:last-child { border-bottom: none; }
    .cand-row:hover { background: var(--panel2); padding-left: 5px; }
    .cand-row__rank { color: var(--mute); width: 16px; flex-shrink: 0; font-size: 0.62rem; }
    .cand-row__sym { color: var(--yellow); font-weight: 700; width: 62px; flex-shrink: 0; }
    .cand-row__score { color: var(--white); width: 46px; flex-shrink: 0; }
    .cand-row__pill {
      font-size: 0.55rem; letter-spacing: 0.1em; text-transform: uppercase;
      padding: 2px 6px; border: 1px solid; border-radius: 999px;
    }
    .tone-hot  { color:#F6E70F; border-color:rgba(246,231,15,.4); }
    .tone-warm { color:#FFB700; border-color:rgba(255,183,0,.35); }
    .tone-cool { color:rgba(255,255,255,.55); border-color:rgba(255,255,255,.18); }
    .tone-cold { color:rgba(255,255,255,.28); border-color:rgba(255,255,255,.12); }
    .cand-row__meta { color: var(--mute); font-size: 0.65rem; margin-left: auto; }
    .cand-link { color: var(--yellow); }
    .cand-link:hover { text-decoration: underline; }

    /* Score bar inline */
    .mini-bar { width: 54px; height: 3px; background: #1a1a1a; border-radius: 1px; flex-shrink: 0; }
    .mini-fill { height: 100%; background: var(--yellow); border-radius: 1px; }

    /* ─── RIGHT ASIDE ────────────────────────── */
    .aside {
      width: 220px; flex-shrink: 0;
      background: rgba(8,8,8,0.97); border-left: 1px solid var(--border);
      overflow-y: auto; overflow-x: hidden;
      padding: 12px 10px;
      display: flex; flex-direction: column; gap: 10px;
    }
    .aside-block {
      background: var(--panel); border: 1px solid var(--border);
      border-radius: var(--r); padding: 12px;
    }
    .aside-title {
      font-size: 0.62rem; letter-spacing: 0.16em; text-transform: uppercase;
      color: var(--yellow); opacity: 0.7;
      padding-bottom: 7px; border-bottom: 1px solid var(--border); margin-bottom: 9px;
    }
    .aside-stat {
      display: flex; justify-content: space-between; align-items: baseline;
      padding: 4px 0; font-size: 0.72rem; gap: 5px;
      border-bottom: 1px solid rgba(255,255,255,.03);
    }
    .aside-stat:last-child { border-bottom: none; }
    .aside-stat span { color: var(--dim); flex-shrink: 0; white-space: nowrap; }
    .aside-stat strong { font-weight: 600; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100px; }
    .aside-stat strong.y { color: var(--yellow); }
    .aside-stat strong.g { color: var(--green); }
    .aside-stat strong.w { color: var(--white); }
    .aside-big { font-size: 1.8rem; font-weight: 800; color: var(--yellow); line-height: 1; margin-bottom: 3px; }
    .aside-sub { font-size: 0.62rem; color: var(--dim); margin-bottom: 9px; }

    /* Aside token entry */
    .aside-token { padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,.04); font-size: 0.72rem; }
    .aside-token:last-child { border-bottom: none; }
    .aside-token__sym { color: var(--yellow); font-weight: 700; font-size: 0.82rem; }
    .aside-token__row { display: flex; justify-content: space-between; align-items: baseline; gap: 5px; }
    .aside-token__score { color: var(--white); font-size: 0.7rem; }
    .aside-token__rec { color: var(--dim); font-size: 0.62rem; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* Progress rows (for detail accordions) */
    .progress-row { display: flex; align-items: center; gap: 9px; padding: 4px 0; }
    .progress-row span { width: 90px; flex-shrink: 0; color: var(--dim); font-size: 0.72rem; }
    .progress-bar { flex: 1; height: 3px; background: #1a1a1a; border-radius: 1px; }
    .progress-fill { height: 100%; background: linear-gradient(90deg, rgba(var(--yr),.4), var(--yellow)); border-radius: 1px; transition: width .8s; }
    .progress-val { width: 42px; text-align: right; color: var(--dim); font-size: 0.7rem; flex-shrink: 0; }

    /* Accordion (within panel or standalone) */
    .accord-panel { margin-top: 8px; }
    details.panel-accord { background: var(--panel); border: 1px solid var(--border); border-radius: var(--r); margin-bottom: 6px; overflow: hidden; }
    summary.panel-accord__sum {
      display: flex; align-items: center; gap: 10px;
      padding: 9px 12px; cursor: pointer; list-style: none;
      background: var(--panel2); transition: background .15s;
    }
    summary.panel-accord__sum:hover { background: #161616; }
    .panel-accord__sum::-webkit-details-marker { display: none; }
    .panel-accord__title { font-size: 0.75rem; font-weight: 700; color: var(--white); }
    .panel-accord__meta  { font-size: 0.65rem; color: var(--dim); margin-left: auto; }
    .panel-accord__arr   { font-size: 0.65rem; color: var(--mute); transition: transform .2s; }
    details.panel-accord[open] .panel-accord__arr { transform: rotate(180deg); }
    .panel-accord__body  { padding: 12px; border-top: 1px solid var(--border); }

    /* Metric grid */
    .metric-grid { display: grid; grid-template-columns: repeat(3,1fr); gap: 8px; }
    .metric-card { padding: 10px 12px; background: var(--panel2); border: 1px solid var(--border); border-radius: var(--r-sm); }
    .metric-card__label { font-size: 0.58rem; letter-spacing: 0.14em; text-transform: uppercase; color: var(--mute); margin-bottom: 4px; }
    .metric-card__val { font-size: 1.05rem; font-weight: 700; color: var(--yellow); }
    .metric-card__desc { font-size: 0.58rem; color: var(--dim); line-height: 1.3; margin-top: 2px; }

    .status-row { display: flex; justify-content: space-between; padding: 3px 0; border-bottom: 1px solid rgba(255,255,255,.04); font-size: 0.65rem; }
    .status-row:last-child { border-bottom: none; }
    .status-row span { color: var(--dim); }
    .status-row strong { color: var(--white); }
    .watchlist-link { color: var(--yellow); }

    .candidate-card { padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,.04); }
    .candidate-card:last-child { border-bottom: none; }
    .candidate-card__meta { display: flex; align-items: center; gap: 6px; margin-bottom: 3px; }
    .candidate-rank { font-size: 0.48rem; color: var(--dim); }
    .candidate-link { font-size: 0.82rem; font-weight: 700; color: var(--yellow); }
    .candidate-subtitle { font-size: 0.58rem; color: var(--dim); margin: 1px 0 5px; }
    .candidate-stats { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 8px; font-size: 0.58rem; }
    .candidate-stats div { display: flex; justify-content: space-between; }
    .candidate-stats span { color: var(--dim); }
    .candidate-thesis { font-size: 0.65rem; color: var(--dim); padding: 5px 0; }
    .goo-card { padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,.04); }
    .goo-card:last-child { border-bottom: none; }
    .pill { font-size: 0.44rem; letter-spacing: 0.1em; text-transform: uppercase; padding: 1px 5px; border: 1px solid; border-radius: 999px; }

    .usage-stack { display: flex; flex-direction: column; gap: 3px; margin-top: 6px; }
    .usage-row { display: flex; align-items: center; gap: 6px; }
    .usage-label { width: 48px; color: var(--dim); font-size: 0.58rem; }
    .usage-bar { flex: 1; height: 2px; background: #1a1a1a; border-radius: 1px; }
    .usage-fill { height: 100%; background: var(--yellow); border-radius: 1px; }
    .usage-val { width: 22px; text-align: right; color: var(--dim); font-size: 0.55rem; }

    /* Modal */
    .h-modal-backdrop { position: fixed; inset: 0; z-index: 500; background: rgba(0,0,0,0.94); backdrop-filter: blur(10px); display: flex; align-items: center; justify-content: center; padding: 20px; }
    .h-modal-backdrop.hidden { display: none; }
    .h-modal { background: var(--panel); border: 1px solid var(--border2); border-radius: var(--r); width: 100%; max-width: 960px; max-height: 88vh; overflow-y: auto; scrollbar-width: thin; }
    .h-modal__header { display: flex; align-items: center; justify-content: space-between; padding: 10px 16px; border-bottom: 1px solid var(--border); position: sticky; top: 0; background: var(--panel2); z-index: 1; }
    .h-modal__title { font-size: 0.65rem; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: var(--yellow); }
    .h-modal__close { background: none; border: 1px solid var(--border); border-radius: var(--r-sm); color: var(--dim); font-family: inherit; font-size: 0.58rem; padding: 3px 9px; cursor: pointer; transition: all .18s; }
    .h-modal__close:hover { border-color: #333; color: var(--white); }

    /* Cloud popup */
    .h-cloud-popup { position: fixed; inset: 0; z-index: 600; background: rgba(0,0,0,0.95); display: flex; align-items: center; justify-content: center; }
    .h-cloud-popup.hidden { display: none; }
    .h-cloud-popup__inner { background: var(--panel); border: 1px solid var(--border2); border-radius: var(--r); padding: 28px; width: 380px; max-width: 95vw; }
    .h-cloud-popup__title { font-size: 1rem; font-weight: 700; color: var(--yellow); margin-bottom: 10px; }
    .h-cloud-popup p { font-size: 0.75rem; color: var(--dim); line-height: 1.7; }
    .h-cloud-popup__close { float: right; background: none; border: 1px solid var(--border); border-radius: var(--r-sm); color: var(--dim); font-family: inherit; font-size: 0.58rem; padding: 3px 8px; cursor: pointer; margin-bottom: 10px; }

    .split-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .split-h { font-size: 0.5rem; letter-spacing: 0.16em; text-transform: uppercase; color: var(--mute); padding-bottom: 6px; border-bottom: 1px solid var(--border); margin-bottom: 8px; }

    .np-footer { padding: 10px 14px; font-size: 0.48rem; letter-spacing: 0.12em; text-transform: uppercase; color: var(--mute); border-top: 1px solid var(--border); display: flex; justify-content: space-between; }

    .status-panel { display: flex; flex-direction: column; }

    @media (max-width: 1400px) {
      .aside { width: 200px; }
    }
    @media (max-width: 1100px) {
      .panel-row--3 { grid-template-columns: 1fr 1fr; }
      .aside { width: 185px; padding: 10px 8px; }
    }
    @media (max-width: 960px) {
      .aside { display: none; }
    }
    @media (max-width: 860px) {
      .sidebar { display: none; }
      .panel-row--3 { grid-template-columns: 1fr; }
      .panel-row--2 { grid-template-columns: 1fr; }
      .panel-row--2-3 { grid-template-columns: 1fr; }
    }

    /* ─── LIGHT MODE OVERRIDES ───────────────── */
    [data-theme="light"] .sidebar { background: #fafaf7; border-right-color: var(--border); }
    [data-theme="light"] .aside { background: #fafaf7; border-left-color: var(--border); }
    [data-theme="light"] .panel { background: #ffffff; border-color: var(--border); }
    [data-theme="light"] .panel:hover { border-color: rgba(var(--yr),.35); }
    [data-theme="light"] .terminal { background: #f0f0ec; border-color: var(--border); }
    [data-theme="light"] .terminal__line { color: rgba(20,20,18,0.7); }
    [data-theme="light"] .terminal__cursor { background: rgba(var(--yr),1); }
    [data-theme="light"] .progress-bg { background: #e8e8e4; }
    [data-theme="light"] .ticker { background: #f0f0ec; border-color: var(--border); }
    [data-theme="light"] .ticker__item { color: rgba(20,20,18,0.75); }
    [data-theme="light"] .feat-row { background: #ffffff; border-color: var(--border); }
    [data-theme="light"] .feat-row:hover { border-color: rgba(var(--yr),.4); box-shadow: 0 0 12px rgba(var(--yr),.1); }
    [data-theme="light"] .cand-item { background: #ffffff; border-color: var(--border); }
    [data-theme="light"] .cand-item:hover { border-color: rgba(var(--yr),.4); }
    [data-theme="light"] .aside-block { background: #ffffff; border-color: var(--border); }
    [data-theme="light"] .accord { background: #ffffff; border-color: var(--border); }
    [data-theme="light"] .accord summary { border-color: var(--border); }
    [data-theme="light"] .mon-bg { background: #e8e8e4; }
    [data-theme="light"] .mon-fill { filter: none; }
    [data-theme="light"] .sb-agent { background: linear-gradient(160deg,rgba(var(--yr),.06),transparent 70%); border-color: var(--border); }
    [data-theme="light"] .sb-section__title { color: rgba(20,20,18,0.4); }
    [data-theme="light"] .qa-btn { background: #f0f0ec; border-color: var(--border); color: rgba(20,20,18,0.7); }
    [data-theme="light"] .qa-btn:hover { border-color: rgba(var(--yr),.5); color: var(--yellow); background: rgba(var(--yr),.07); }
    [data-theme="light"] .sb-action-btn { background: #f0f0ec; border-color: var(--border); color: rgba(20,20,18,0.6); }
    [data-theme="light"] #dot-canvas { opacity: 0.06; }
  </style>
</head>
<body>
  <canvas id="dot-canvas"></canvas>

  <div class="h-modal-backdrop hidden" id="feature-modal">
    <div class="h-modal">
      <div class="h-modal__header">
        <div class="h-modal__title" id="feature-modal-title">Detail</div>
        <button class="h-modal__close" id="feature-modal-close">&#x2715; Close</button>
      </div>
      <div id="feature-modal-body"></div>
    </div>
  </div>
  <div class="h-cloud-popup hidden" id="cloud-auth-popup">
    <div class="h-cloud-popup__inner">
      <button class="h-cloud-popup__close" id="cloud-popup-close">&#x2715;</button>
      <div class="h-cloud-popup__title">Connect ElizaCloud</div>
      <p>Sign in to manage agents and credits.</p>
    </div>
  </div>

  <div class="layout">

    <!-- ══ TOP BAR ══════════════════════════════════ -->
    <div class="topbar">
      <nav class="topbar__nav">
        <a class="tb-nav-btn" href="/dashboard" style="border-color:rgba(var(--yr),.5);color:var(--yellow);">Dashboard</a>
      </nav>
      <div class="topbar__right">
        <span class="topbar__time" id="tb-time"></span>
        <button class="tb-btn live"><span style="display:inline-block;width:5px;height:5px;border-radius:50%;background:var(--green);animation:live-pulse 2s infinite;vertical-align:middle;margin-right:4px"></span>LIVE</button>
        <a class="tb-btn primary" href="/airdrop" title="Airdrop">&#x1FA82; AIRDROP</a>
        <a class="tb-btn primary" href="https://x.com/elizaok_bsc" target="_blank" rel="noreferrer">${renderXIconSvg()}</a>
        <a class="tb-btn primary" href="https://github.com/elizaokbsc" target="_blank" rel="noreferrer">${renderGithubIconSvg()}</a>
        <button class="tb-btn primary" id="theme-toggle" title="Toggle light/dark mode" onclick="toggleTheme()">☀</button>
      </div>
    </div>

    <div class="content-area">

      <!-- ══ LEFT SIDEBAR ═══════════════════════════ -->
      <div class="sidebar">

        <!-- Agent identity -->
        <div class="sb-agent">
          <img class="sb-agent__avatar" src="/assets/elizaok-logo.png" alt="elizaOK" />
          <div class="sb-agent__status"><span class="sb-agent__status-dot"></span>LIVE</div>
          <div class="sb-agent__name">elizaOK</div>
          <div class="sb-agent__role">AI Degen Agent &middot; elizaOS</div>
          <div class="sb-agent__addr">${escapeHtml(shortAddress("0x2D6C3358A3acFe3be42b2Bdf7419e87091270c5F"))}</div>
          <div class="sb-agent__bal">${escapeHtml(sidebarWalletBalanceLabel)} BNB</div>
        </div>

        <!-- Agent info -->
        <div class="sb-section">
          <div class="sb-section__title">Agent Status</div>
          <div class="sb-stat-row"><span>Model</span><strong class="y">${escapeHtml(currentModel)}</strong></div>
          <div class="sb-stat-row"><span>Scan every</span><strong>${Math.round(getDiscoveryConfig().intervalMs / 60_000)}m</strong></div>
          <div class="sb-stat-row"><span>Mode</span><strong class="${executionState.dryRun ? '' : 'g'}">${executionState.dryRun ? "DRY-RUN" : "LIVE"}</strong></div>
          <div class="sb-stat-row"><span>Execution</span><strong>${escapeHtml(executionState.mode)}</strong></div>
          <div class="sb-stat-row"><span>Distribution</span><strong class="${distributionExecution.enabled ? 'g' : ''}">${distributionExecution.enabled ? "ARMED" : "STANDBY"}</strong></div>
          <div class="sb-stat-row"><span>Goo scan</span><strong class="${getDiscoveryConfig().goo.enabled ? 'g' : ''}">${getDiscoveryConfig().goo.enabled ? "ACTIVE" : "OFF"}</strong></div>
          <div class="sb-stat-row"><span>Readiness</span><strong class="y">${executionState.readinessScore}/${executionState.readinessTotal}</strong></div>
          <div class="usage-stack" style="margin-top:8px">
            ${renderUsageRow("API key", hasOpenAiKey ? 100 : 0, hasOpenAiKey ? "ok" : "x")}
            ${renderUsageRow("Model", currentModel === "n/a" ? 0 : 100, currentModel === "n/a" ? "--" : "ok")}
          </div>
          ${cloudSession ? `
          <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">
            <div class="sb-stat-row"><span>Cloud</span><strong class="y">${escapeHtml(cloudSession.displayName)}</strong></div>
            <div class="sb-stat-row"><span>Credits</span><strong>${escapeHtml(cloudSession.credits)}</strong></div>
          </div>` : ''}
        </div>

        <!-- Quick actions -->
        <div class="sb-section">
          <div class="sb-section__title">Quick Actions</div>
          <button class="qa-btn" data-nav="overview" onclick="window.scrollTo(0,0)"><span class="qa-btn__icon">&#x1F4CA;</span>AGENT STATUS</button>
          <button class="qa-btn" data-nav="discovery"><span class="qa-btn__icon">&#x1F50D;</span>DISCOVERY</button>
          <button class="qa-btn" data-nav="portfolio"><span class="qa-btn__icon">&#x1F4BC;</span>PORTFOLIO</button>
          <button class="qa-btn" data-nav="execution"><span class="qa-btn__icon">&#x26A1;</span>EXECUTION</button>
          <button class="qa-btn" data-nav="distribution"><span class="qa-btn__icon">&#x1FA82;</span>DISTRIBUTION</button>
          <button class="qa-btn" data-nav="goo"><span class="qa-btn__icon">&#x1F9EC;</span>GOO INTEL</button>
        </div>

        <!-- Recent candidates -->
        <div class="sb-section">
          <div class="sb-section__title">Recent Signals</div>
          ${snapshot.topCandidates.slice(0,4).map(c => `
          <div class="recent-item">
            <div class="recent-item__sym"><a class="cand-link" href="${candidateHref(c.tokenAddress)}">${escapeHtml(c.tokenSymbol)}</a></div>
            <div class="recent-item__meta">${c.score}/100 &middot; ${escapeHtml(c.recommendation).slice(0,18)}</div>
          </div>`).join('') || '<div class="recent-item__meta">No signals yet</div>'}
        </div>

        <!-- Footer -->
        <div class="np-footer">
          <span>elizaOS</span>
          <a href="https://github.com/elizaokbsc" target="_blank" rel="noreferrer">GitHub &#x2197;</a>
        </div>

      </div><!-- /sidebar -->

      <!-- ══ MAIN CONTENT ══════════════════════════ -->
      <div class="main">

        <!-- ROW 1: System Monitor | Scheduler | Token Explorer -->
        <div class="panel-row panel-row--3">

          <!-- System Monitor (like Hermes) -->
          <div class="panel">
            <div class="panel__head">
              <span class="pb-dot g"></span>
              <span class="panel__title">System Monitor</span>
              <span class="panel__badge pb-green">&#x1F4A5; ${snapshot.summary.candidateCount} pools</span>
            </div>
            <div class="panel__body">
              <div class="mon-row">
                <div class="mon-label"><span>SIGNAL SCORE</span><strong class="y">${snapshot.summary.averageScore}/100</strong></div>
                <div class="mon-bar"><div class="mon-fill y" style="width:${snapshot.summary.averageScore}%"></div></div>
              </div>
              <div class="mon-row">
                <div class="mon-label"><span>WIN RATE</span><strong>${formatPct(winRatePct)}</strong></div>
                <div class="mon-bar"><div class="mon-fill g" style="width:${clampPercent(winRatePct ?? 0)}%"></div></div>
              </div>
              <div class="mon-row">
                <div class="mon-label"><span>EXEC READINESS</span><strong>${clampPercent(executionPct)}%</strong></div>
                <div class="mon-bar"><div class="mon-fill y" style="width:${clampPercent(executionPct)}%"></div></div>
              </div>
              <div class="mon-row">
                <div class="mon-label"><span>DISTRIBUTION</span><strong>${clampPercent(distributionPct)}%</strong></div>
                <div class="mon-bar"><div class="mon-fill g" style="width:${clampPercent(distributionPct)}%"></div></div>
              </div>
              <div style="margin-top:10px;display:grid;grid-template-columns:1fr 1fr;gap:8px">
                <div>
                  <div class="mon-big">${snapshot.summary.candidateCount}</div>
                  <div class="mon-sub">Candidates</div>
                </div>
                <div>
                  <div class="mon-big" style="color:var(--green)">${snapshot.summary.topRecommendationCount}</div>
                  <div class="mon-sub">Buy-Ready</div>
                </div>
              </div>
            </div>
          </div>

          <!-- Scheduler / Cron -->
          <div class="panel">
            <div class="panel__head">
              <span class="pb-dot y"></span>
              <span class="panel__title">Scheduler / Execution</span>
              <span class="panel__badge ${executionState.dryRun ? 'pb-dim' : 'pb-green'}">${executionState.dryRun ? "DRY-RUN" : "&#x26A1; LIVE"}</span>
            </div>
            <div class="panel__body">
              <div class="sched-row"><span>Last scan</span><strong class="w">${escapeHtml(formatRelativeTime(snapshot.generatedAt))}</strong></div>
              <div class="sched-row"><span>Next scan</span><strong class="y">~${Math.round(getDiscoveryConfig().intervalMs / 60_000)}m</strong></div>
              <div class="sched-row"><span>Max buy</span><strong class="y">${formatBnb(executionState.risk.maxBuyBnb)} BNB</strong></div>
              <div class="sched-row"><span>Daily cap</span><strong class="w">${formatBnb(executionState.risk.maxDailyDeployBnb)} BNB</strong></div>
              <div class="sched-row"><span>Eligible plans</span><strong class="w">${eligibleExecutionPlans}</strong></div>
              <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">
                <div class="sched-row"><span>Executed</span><strong class="g">${executionState.cycleSummary.executedCount}</strong></div>
                <div class="sched-row"><span>Dry-run</span><strong class="w">${executionState.cycleSummary.dryRunCount}</strong></div>
                <div class="sched-row"><span>Skipped</span><strong class="w">${executionState.cycleSummary.skippedCount}</strong></div>
                <div class="sched-row"><span>Failed</span><strong class="${executionState.cycleSummary.failedCount > 0 ? 'r' : 'w'}">${executionState.cycleSummary.failedCount}</strong></div>
              </div>
              <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">
                <div class="sched-row"><span>Active positions</span><strong class="y">${portfolioLifecycle.activePositions.length}</strong></div>
                <div class="sched-row"><span>Portfolio value</span><strong class="w">${formatUsd(portfolioLifecycle.grossPortfolioValueUsd)}</strong></div>
                <div class="sched-row"><span>Win rate</span><strong class="${(winRatePct ?? 0) > 50 ? 'g' : 'w'}">${formatPct(winRatePct)}</strong></div>
                <div class="sched-row"><span>Total trades</span><strong class="w">${tradeRecords.length}</strong></div>
              </div>
            </div>
          </div>

          <!-- Token Explorer (like File Explorer) -->
          <div class="panel">
            <div class="panel__head">
              <span class="pb-dot g"></span>
              <span class="panel__title">Token Explorer</span>
              <span class="panel__badge pb-yellow">${snapshot.summary.candidateCount} found</span>
            </div>
            <div class="panel__body panel__body--p0">
              <div class="file-tree" style="padding:8px">
                <div class="file-dir">candidates/</div>
                ${snapshot.topCandidates.slice(0,8).map((c, i) => `
                <div class="file-item">
                  <span class="file-item__sym"><a class="cand-link" href="${candidateHref(c.tokenAddress)}">${escapeHtml(c.tokenSymbol)}</a></span>
                  <span class="file-item__score">${c.score}/100</span>
                  <span class="file-item__rec">${escapeHtml(c.recommendation).slice(0,16)}</span>
                </div>`).join('') || '<div class="file-item" style="padding-left:8px">scanning...</div>'}
                <div class="file-dir" style="margin-top:8px">portfolio/</div>
                ${portfolioLifecycle.activePositions.slice(0,4).map(p => `
                <div class="file-item">
                  <span class="file-item__sym"><a class="cand-link" href="${candidateHref(p.tokenAddress)}">${escapeHtml(p.tokenSymbol)}</a></span>
                  <span class="file-item__rec">${escapeHtml(p.stage)}</span>
                </div>`).join('') || '<div class="file-item" style="padding-left:8px">no positions</div>'}
              </div>
            </div>
          </div>

        </div><!-- /panel-row--3 -->

        <!-- ROW 2: Embedded Terminal + Signal Detail -->
        <div class="panel-row panel-row--2-3">

          <!-- Embedded Agent Terminal (like Hermes CLI) -->
          <div class="panel">
            <div class="panel__head">
              <span class="pb-dot g"></span>
              <span class="panel__title">elizaOK Agent Terminal</span>
              <div style="display:flex;gap:4px;margin-left:auto">
                <span class="panel__badge pb-dim">elizaOS</span>
                <span class="panel__badge pb-green">ONLINE</span>
              </div>
            </div>
            <div class="panel__body panel__body--p0">
              <div class="term-body">
                <div class="prompt-line"><span class="pr">root@elizaok:~$</span><span class="cmd">elizaok scan --chain bsc</span></div>
                <div class="term-line"><span class="ts">${escapeHtml(new Date().toTimeString().slice(0,8))}</span><span class="tag tag-info">INFO</span><span class="msg">Initializing BSC mempool scan&hellip;</span></div>
                <div class="term-line"><span class="ts">&nbsp;</span><span class="tag tag-info">INFO</span><span class="msg">Fetching DexScreener pools &mdash; found <span class="hi">${snapshot.summary.candidateCount}</span> candidates</span></div>
                <div class="term-line"><span class="ts">&nbsp;</span><span class="tag tag-ok">SCAN</span><span class="msg">Avg signal score: <span class="hi">${snapshot.summary.averageScore}/100</span></span></div>
                <div class="term-line"><span class="ts">&nbsp;</span><span class="tag tag-${snapshot.summary.topRecommendationCount > 0 ? 'ok' : 'warn'}">TARGET</span><span class="msg">Buy-ready signals: <span class="hi">${snapshot.summary.topRecommendationCount}</span></span></div>
                ${snapshot.summary.strongestCandidate ? `<div class="term-line"><span class="ts">&nbsp;</span><span class="tag tag-ok">BEST</span><span class="msg"><span class="hi">${escapeHtml(snapshot.summary.strongestCandidate.tokenSymbol)}</span> &mdash; score <span class="ok">${snapshot.summary.strongestCandidate.score}/100</span></span></div>` : ''}
                <div class="term-line"><span class="ts">&nbsp;</span><span class="tag tag-${executionState.dryRun ? 'warn' : 'ok'}">${executionState.dryRun ? "DRY" : "LIVE"}</span><span class="msg">Execution mode: <span class="hi">${executionState.dryRun ? "DRY-RUN (simulation)" : "LIVE TRADING"}</span></span></div>
                <div class="term-line"><span class="ts">&nbsp;</span><span class="tag tag-info">WALL</span><span class="msg">Balance: <span class="hi">${escapeHtml(sidebarWalletBalanceLabel)} BNB</span> &middot; ${escapeHtml(shortAddress("0x2D6C3358A3acFe3be42b2Bdf7419e87091270c5F"))}</span></div>
                <div class="term-line"><span class="ts">&nbsp;</span><span class="tag tag-info">DIST</span><span class="msg">Distribution: <span class="hi">${distributionExecution.enabled ? "ARMED" : "STANDBY"}</span> &middot; ${distributionPlan.eligibleHolderCount} holders</span></div>
                <div class="term-line"><span class="ts">&nbsp;</span><span class="tag tag-info">GOO</span><span class="msg">Goo scan: <span class="hi">${getDiscoveryConfig().goo.enabled ? "ACTIVE" : "DISABLED"}</span> &middot; ${snapshot.summary.gooAgentCount} agents reviewed</span></div>
                <div class="prompt-line" style="margin-top:6px"><span class="pr">&gt;_</span><span class="cursor"></span></div>
              </div>
            </div>
          </div>

          <!-- Signal detail (like the right panel in Hermes) -->
          <div class="panel">
            <div class="panel__head">
              <span class="pb-dot y"></span>
              <span class="panel__title">Top Candidates</span>
              <span class="panel__badge pb-yellow">Live Signals</span>
            </div>
            <div class="panel__body panel__body--p0" style="padding:8px">
              ${snapshot.topCandidates.slice(0,6).map((c,i) => `
              <div class="cand-row">
                <span class="cand-row__rank">${i+1}</span>
                <span class="cand-row__sym"><a class="cand-link" href="${candidateHref(c.tokenAddress)}">${escapeHtml(c.tokenSymbol)}</a></span>
                <span class="cand-row__score">${c.score}/100</span>
                <span class="cand-row__pill ${recommendationTone(c.recommendation)}">${escapeHtml(c.recommendation).slice(0,10)}</span>
                <div class="mini-bar"><div class="mini-fill" style="width:${c.score}%"></div></div>
                <span class="cand-row__meta">${c.poolAgeMinutes}m</span>
              </div>`).join('') || '<div style="padding:16px;color:var(--dim);font-style:italic;text-align:center">Scanning BSC pools&hellip;</div>'}
            </div>
          </div>

        </div><!-- /panel-row--2-3 -->

        <!-- ROW 3: Accordion detail sections -->
        <div class="accord-panel">
          <details class="panel-accord" id="discovery-section">
            <summary class="panel-accord__sum">
              <span class="panel-accord__title">&#x1F50D; Full Discovery Report</span>
              <span class="panel-accord__meta">${escapeHtml(discoveryFoldSummary)}</span>
              <span class="panel-accord__arr">&#x25BE;</span>
            </summary>
            <div class="panel-accord__body">
              <div class="split-grid">
                <div><div class="split-h">All Candidates</div>${topCandidates || '<p class="candidate-thesis">No data.</p>'}</div>
                <div>
                  <div class="split-h">Recent Runs</div>${recentRuns || '<p class="candidate-thesis">No data.</p>'}
                  <div class="split-h" style="margin-top:12px">Watchlist</div>${watchlistRows || '<p class="candidate-thesis">Empty.</p>'}
                </div>
              </div>
            </div>
          </details>

          <details class="panel-accord" id="portfolio-section">
            <summary class="panel-accord__sum">
              <span class="panel-accord__title">&#x1F4BC; Portfolio Ledger</span>
              <span class="panel-accord__meta">${escapeHtml(portfolioFoldSummary)}</span>
              <span class="panel-accord__arr">&#x25BE;</span>
            </summary>
            <div class="panel-accord__body">
              <div class="split-grid">
                <div><div class="split-h">Active Positions</div>${activePortfolioCards || '<p class="candidate-thesis">No positions.</p>'}</div>
                <div><div class="split-h">Timeline</div>${timelineRows || '<p class="candidate-thesis">No events.</p>'}</div>
              </div>
            </div>
          </details>

          <details class="panel-accord" id="treasury-section">
            <summary class="panel-accord__sum">
              <span class="panel-accord__title">&#x26A1; Execution Desk</span>
              <span class="panel-accord__meta">${escapeHtml(treasuryFoldSummary)}</span>
              <span class="panel-accord__arr">&#x25BE;</span>
            </summary>
            <div class="panel-accord__body">
              <div class="split-h">Controls</div><div class="metric-grid">${executionControlCards}</div>
              <div class="split-h" style="margin-top:12px">Treasury Model</div><div class="metric-grid">${treasuryModelCards}</div>
              <div class="split-h" style="margin-top:12px">Trade Ledger</div>${recentTradeRows || '<p class="candidate-thesis">No trades.</p>'}
            </div>
          </details>

          <details class="panel-accord" id="distribution-section">
            <summary class="panel-accord__sum">
              <span class="panel-accord__title">&#x1FA82; Airdrop Distribution</span>
              <span class="panel-accord__meta">${escapeHtml(distributionFoldSummary)}</span>
              <span class="panel-accord__arr">&#x25BE;</span>
            </summary>
            <div class="panel-accord__body"><div class="metric-grid">${distributionStateCards}</div></div>
          </details>

          <details class="panel-accord" id="goo-section">
            <summary class="panel-accord__sum">
              <span class="panel-accord__title">&#x1F9EC; Goo Intelligence</span>
              <span class="panel-accord__meta">${escapeHtml(gooFoldSummary)}</span>
              <span class="panel-accord__arr">&#x25BE;</span>
            </summary>
            <div class="panel-accord__body">
              <div class="split-grid">
                <div>${gooCandidates || '<p class="candidate-thesis">No Goo agents. Enable scanning.</p>'}</div>
                <div>${gooQueueRows || '<p class="candidate-thesis">No queue.</p>'}</div>
              </div>
            </div>
          </details>
        </div>

      </div><!-- /main -->

      <!-- ══ RIGHT ASIDE ═══════════════════════════ -->
      <div class="aside">

        <!-- Signal Stats -->
        <div class="aside-block">
          <div class="aside-title">&#x1F4E1; Signal Stats</div>
          <div class="aside-big">${snapshot.summary.candidateCount}</div>
          <div class="aside-sub">candidates scanned</div>
          <div class="aside-stat"><span>Buy-ready</span><strong class="g">${snapshot.summary.topRecommendationCount}</strong></div>
          <div class="aside-stat"><span>Avg score</span><strong class="y">${snapshot.summary.averageScore}/100</strong></div>
          <div class="aside-stat"><span>Best token</span><strong class="y">${escapeHtml(snapshot.summary.strongestCandidate?.tokenSymbol || "—")}</strong></div>
          <div class="aside-stat"><span>Top score</span><strong class="w">${snapshot.summary.strongestCandidate?.score ?? "—"}/100</strong></div>
        </div>

        <!-- Portfolio -->
        <div class="aside-block">
          <div class="aside-title">&#x1F4BC; Portfolio</div>
          <div class="aside-big" style="color:var(--white)">${portfolioLifecycle.activePositions.length}</div>
          <div class="aside-sub">active positions</div>
          <div class="aside-stat"><span>Watching</span><strong class="w">${portfolioLifecycle.watchPositions.length}</strong></div>
          <div class="aside-stat"><span>Exited</span><strong class="w">${portfolioLifecycle.exitedPositions.length}</strong></div>
          <div class="aside-stat"><span>Win rate</span><strong class="${(winRatePct ?? 0) > 50 ? 'g' : 'w'}">${formatPct(winRatePct)}</strong></div>
          <div class="aside-stat"><span>Realized</span><strong class="w">${formatUsd(portfolioLifecycle.totalRealizedPnlUsd)}</strong></div>
          <div class="aside-stat"><span>Gross</span><strong class="y">${formatUsd(portfolioLifecycle.grossPortfolioValueUsd)}</strong></div>
        </div>

        <!-- Execution -->
        <div class="aside-block">
          <div class="aside-title">&#x26A1; Execution</div>
          <div class="aside-big" style="color:${executionState.dryRun ? 'rgba(255,255,255,0.5)' : 'var(--green)'}; font-size:0.9rem; margin-bottom:6px">${executionState.dryRun ? "DRY-RUN" : "&#x26A1; LIVE"}</div>
          <div class="aside-stat"><span>Mode</span><strong class="w">${escapeHtml(executionState.mode)}</strong></div>
          <div class="aside-stat"><span>Executed</span><strong class="g">${executionState.cycleSummary.executedCount}</strong></div>
          <div class="aside-stat"><span>Max buy</span><strong class="y">${formatBnb(executionState.risk.maxBuyBnb)} BNB</strong></div>
          <div class="aside-stat"><span>Daily cap</span><strong class="w">${formatBnb(executionState.risk.maxDailyDeployBnb)} BNB</strong></div>
          <div class="aside-stat"><span>Trades</span><strong class="w">${tradeRecords.length}</strong></div>
        </div>

        <!-- Distribution + Goo -->
        <div class="aside-block">
          <div class="aside-title">&#x1FA82; Distribution</div>
          <div class="aside-stat"><span>Holders</span><strong class="w">${distributionPlan.eligibleHolderCount}</strong></div>
          <div class="aside-stat"><span>Recipients</span><strong class="y">${distributionPlan.recipients.length}</strong></div>
          <div class="aside-stat"><span>Pool</span><strong class="y">${formatUsd(distributionPlan.distributionPoolUsd)}</strong></div>
          <div class="aside-stat"><span>Status</span><strong class="${distributionExecution.enabled ? 'g' : 'w'}">${distributionExecution.enabled ? "ARMED" : "STBY"}</strong></div>
          <div style="margin-top:10px;padding-top:8px;border-top:1px solid var(--border)">
            <div class="aside-title" style="margin-top:0">&#x1F9EC; Goo Intel</div>
            <div class="aside-stat"><span>Reviewed</span><strong class="w">${snapshot.summary.gooAgentCount}</strong></div>
            <div class="aside-stat"><span>Priority</span><strong class="y">${snapshot.summary.gooPriorityCount}</strong></div>
            <div class="aside-stat"><span>Scan</span><strong class="${getDiscoveryConfig().goo.enabled ? 'g' : 'w'}">${getDiscoveryConfig().goo.enabled ? "ON" : "OFF"}</strong></div>
          </div>
        </div>

        <!-- Top Picks -->
        <div class="aside-block">
          <div class="aside-title">&#x1F4A5; Top Picks</div>
          ${snapshot.topCandidates.slice(0,5).map(c => `
          <div class="aside-token">
            <div class="aside-token__row">
              <span class="aside-token__sym"><a class="cand-link" href="${candidateHref(c.tokenAddress)}">${escapeHtml(c.tokenSymbol)}</a></span>
              <span class="aside-token__score">${c.score}/100</span>
            </div>
            <div class="aside-token__rec">${escapeHtml(c.recommendation).slice(0,20)}</div>
          </div>`).join('') || '<div style="color:var(--dim);font-size:0.62rem;padding:4px 0">Scanning&hellip;</div>'}
        </div>

      </div><!-- /aside -->

    </div><!-- /content-area -->
  </div><!-- /layout -->

  <script>
  (function() {
    "use strict";

    /* ── Clock ── */
    function updateTime() {
      var el = document.getElementById('tb-time');
      if (el) el.textContent = new Date().toLocaleTimeString('en-US', {hour12: false});
    }
    updateTime(); setInterval(updateTime, 1000);

    /* ── Theme toggle ── */
    window.toggleTheme = function() {
      var root = document.documentElement;
      var isLight = root.getAttribute('data-theme') === 'light';
      var next = isLight ? 'dark' : 'light';
      root.setAttribute('data-theme', next);
      var btn = document.getElementById('theme-toggle');
      if (btn) btn.textContent = next === 'light' ? '🌙' : '☀';
      try { localStorage.setItem('elizaok-theme', next); } catch(e){}
    };
    (function(){
      var saved = (function(){ try { return localStorage.getItem('elizaok-theme'); } catch(e){ return null; } }());
      if (saved === 'light') {
        document.documentElement.setAttribute('data-theme', 'light');
        var btn = document.getElementById('theme-toggle');
        if (btn) btn.textContent = '🌙';
      }
    })();

    /* ── Dot canvas ── */
    var canvas = document.getElementById('dot-canvas');
    var ctx = canvas.getContext('2d');
    var t = 0;
    function resizeCanvas() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
    function getDotColor() {
      var light = document.documentElement.getAttribute('data-theme') === 'light';
      return light ? '20,20,18' : '255,255,255';
    }
    function drawDots() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      var sp = 20, cols = Math.ceil(canvas.width/sp)+1, rows = Math.ceil(canvas.height/sp)+1;
      var cx = canvas.width/2, cy = canvas.height/2;
      var dc = getDotColor();
      for (var i = 0; i < cols; i++) {
        for (var j = 0; j < rows; j++) {
          var x = i*sp, y = j*sp;
          var dx = x-cx, dy = y-cy, dist = Math.sqrt(dx*dx+dy*dy);
          var w1 = Math.sin(dist*0.012-t*2.0), w2 = Math.sin(x*0.01)*Math.cos(y*0.01), w3 = Math.sin((x+y)*0.008-t*1.5);
          var c = (w1+w2+w3)/3;
          var sz = Math.max(0.2, 0.3+(c+1)*0.95), al = Math.max(0.012, 0.018+(c+1)*0.1);
          ctx.beginPath(); ctx.arc(x,y,sz,0,Math.PI*2);
          ctx.fillStyle='rgba('+dc+','+al+')'; ctx.fill();
        }
      }
      t += 0.016; requestAnimationFrame(drawDots);
    }
    window.addEventListener('resize', resizeCanvas); resizeCanvas(); drawDots();

    /* ── Nav / sidebar quick actions ── */
    document.querySelectorAll('[data-nav]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var tgt = this.getAttribute('data-nav');
        if(tgt === 'overview') return;
        var el = document.getElementById(tgt+'-section');
        if (el) { el.open = true; setTimeout(function(){ el.scrollIntoView({behavior:'smooth',block:'start'}); }, 60); }
      });
    });

    /* ── Cloud auth ── */
    function doFinalPollThenReload(sessionId, attempt) {
      attempt = attempt || 0;
      fetch('/api/eliza-cloud/hosted/poll?session=' + encodeURIComponent(sessionId), { credentials: 'same-origin' })
        .then(function(r){ return r.json(); })
        .catch(function(){ return {}; })
        .then(function(d){ if ((d && d.status === 'authenticated') || attempt >= 5) { window.location.reload(); return; } setTimeout(function(){ doFinalPollThenReload(sessionId, attempt + 1); }, 1200); });
    }
    function openCloudAuth(btn) {
      if (btn) btn.style.opacity = '0.5';
      fetch('/api/eliza-cloud/hosted/start', { method: 'POST', headers: {'content-type':'application/json'}, credentials: 'same-origin' })
        .then(function(r){ return r.json(); })
        .then(function(data) {
          if (!data.loginUrl) { window.location.href = '/auth/eliza-cloud?popup=1'; return; }
          var p = window.open(data.loginUrl, 'elizacloud-auth', 'width=500,height=640,scrollbars=yes');
          if (!p) { window.location.href = data.loginUrl; return; }
          if (data.mode === 'cli-session') {
            var count = 0;
            var popupWasClosed = false;
            var ti = setInterval(function() {
              count++;
              var closed = (function(){ try{return p.closed;}catch(e){return true;} }());
              if (closed && !popupWasClosed) {
                popupWasClosed = true;
                clearInterval(ti);
                if (btn) btn.style.opacity = '';
                doFinalPollThenReload(data.sessionId);
                return;
              }
              if (count > 90) {
                clearInterval(ti);
                if (btn) btn.style.opacity = '';
                doFinalPollThenReload(data.sessionId);
                return;
              }
              fetch('/api/eliza-cloud/hosted/poll?session=' + encodeURIComponent(data.sessionId), { credentials: 'same-origin' })
                .then(function(r){ return r.json(); })
                .then(function(pd) {
                  if (pd.status === 'authenticated') {
                    clearInterval(ti);
                    try { p.close(); } catch(e) {}
                    window.location.reload();
                  }
                }).catch(function(){});
            }, 1500);
          } else {
            var closeTi = setInterval(function() {
              try { if (p.closed) { clearInterval(closeTi); window.location.reload(); } } catch(e) {}
            }, 800);
          }
        })
        .catch(function() { window.location.href = '/auth/eliza-cloud?popup=1'; });
    }
    document.querySelectorAll('[data-cloud-hosted-auth]').forEach(function(btn) {
      btn.addEventListener('click', function() { openCloudAuth(this); });
    });

    /* ── Animate bars ── */
    setTimeout(function() {
      document.querySelectorAll('.mon-fill,.progress-fill,.mini-fill').forEach(function(el) {
        var w = el.style.width; el.style.width = '0%';
        setTimeout(function(){ el.style.width = w; }, 100+Math.random()*400);
      });
    }, 200);

  })();
  </script>
</body>
</html>`;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: AgentRuntime,
): Promise<void> {
  const config = getDiscoveryConfig();
  const snapshot =
    getLatestSnapshot() || (await loadSnapshotFromDisk(config.reportsDir));
  const recentHistory = snapshot?.recentHistory ?? [];
  const treasurySimulation = snapshot?.treasurySimulation ?? {
    paperCapitalUsd: 0,
    deployableCapitalUsd: 0,
    allocatedUsd: 0,
    dryPowderUsd: 0,
    reserveUsd: 0,
    reservePct: 0,
    positionCount: 0,
    averagePositionUsd: 0,
    highestConvictionSymbol: undefined,
    strategyNote:
      "Treasury simulation will appear after the next completed scan.",
    positions: [],
  };
  const portfolioLifecycle = snapshot?.portfolioLifecycle ?? {
    activePositions: [],
    watchPositions: [],
    exitedPositions: [],
    timeline: [],
    cashBalanceUsd: 0,
    grossPortfolioValueUsd: 0,
    reservedUsd: 0,
    totalAllocatedUsd: 0,
    totalCurrentValueUsd: 0,
    totalRealizedPnlUsd: 0,
    totalUnrealizedPnlUsd: 0,
    totalUnrealizedPnlPct: 0,
    healthNote:
      "Portfolio lifecycle will appear after the next completed scan.",
  };
  const executionState = snapshot?.executionState ?? {
    enabled: false,
    dryRun: true,
    mode: "paper",
    router: "fourmeme",
    configured: false,
    liveTradingArmed: false,
    readinessScore: 0,
    readinessTotal: 0,
    readinessChecks: [],
    nextAction: "Execution state will appear after the next completed scan.",
    risk: {
      maxBuyBnb: 0,
      maxDailyDeployBnb: 0,
      maxSlippageBps: 0,
      maxActivePositions: 0,
      minEntryMcapUsd: 0,
      maxEntryMcapUsd: 0,
      minLiquidityUsd: 0,
      minVolumeUsdM5: 0,
      minVolumeUsdH1: 0,
      minBuyersM5: 0,
      minNetBuysM5: 0,
      minPoolAgeMinutes: 0,
      maxPoolAgeMinutes: 0,
      maxPriceChangeH1Pct: 0,
      allowedQuoteOnly: true,
    },
    gooLane: undefined,
    plans: [],
    cycleSummary: {
      consideredCount: 0,
      eligibleCount: 0,
      attemptedCount: 0,
      dryRunCount: 0,
      executedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      note: "Execution cycle has not run yet for this snapshot.",
    },
  };
  const tradeLedger = snapshot?.tradeLedger ?? {
    records: [],
    lastUpdatedAt: null,
    totalExecutedBnb: 0,
    totalDryRunBnb: 0,
  };
  const distributionPlan = snapshot?.distributionPlan ?? {
    enabled: false,
    holderTokenAddress: null,
    snapshotPath: ".elizaok/holder-snapshot.json",
    snapshotSource: "none",
    snapshotGeneratedAt: null,
    snapshotBlockNumber: null,
    minEligibleBalance: 0,
    eligibleHolderCount: 0,
    totalQualifiedBalance: 0,
    distributionPoolUsd: 0,
    maxRecipients: 0,
    note: "Distribution state will appear after configuration is enabled.",
    selectedAsset: {
      mode: "none",
      tokenAddress: null,
      tokenSymbol: null,
      totalAmount: null,
      walletBalance: null,
      walletQuoteUsd: null,
      sourcePositionTokenAddress: null,
      reason:
        "Distribution asset selection will appear after configuration is enabled.",
    },
    recipients: [],
    publication: null,
  };
  const distributionExecution = snapshot?.distributionExecution ?? {
    enabled: false,
    dryRun: true,
    configured: false,
    liveExecutionArmed: false,
    readinessScore: 0,
    readinessTotal: 0,
    readinessChecks: [],
    nextAction:
      "Distribution execution state will appear after the next completed scan.",
    assetTokenAddress: null,
    assetTotalAmount: null,
    walletAddress: null,
    manifestPath: null,
    manifestFingerprint: null,
    maxRecipientsPerRun: 0,
    cycleSummary: {
      attemptedCount: 0,
      dryRunCount: 0,
      executedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      note: "Distribution execution is idle.",
    },
  };
  const distributionLedger = snapshot?.distributionLedger ?? {
    records: [],
    lastUpdatedAt: null,
    totalRecipientsExecuted: 0,
    totalRecipientsDryRun: 0,
  };
  const distributionExecutedRecipients = new Set(
    distributionLedger.records
      .filter(
        (record) =>
          record.disposition === "executed" &&
          distributionExecution.manifestFingerprint &&
          record.manifestFingerprint ===
            distributionExecution.manifestFingerprint,
      )
      .map((record) => record.recipientAddress.toLowerCase()),
  );
  const distributionPendingRecipients = distributionPlan.recipients
    .filter(
      (recipient) =>
        !distributionExecutedRecipients.has(recipient.address.toLowerCase()),
    )
    .slice(0, Math.max(1, distributionExecution.maxRecipientsPerRun || 5));
  const requestUrl = new URL(
    req.url || "/",
    `http://${req.headers.host || "localhost"}`,
  );
  const pathname = requestUrl.pathname;
  const storedCloudSession = readElizaCloudSession(req.headers.cookie);
  let cloudSession = storedCloudSession;

  if (pathname === "/assets/elizaok-logo.png") {
    for (const assetPath of ELIZAOK_LOGO_ASSET_PATHS) {
      try {
        const content = await readFile(assetPath);
        sendBinary(res, 200, "image/png", content);
        return;
      } catch {}
    }

    sendJson(res, 404, { error: "Logo asset not found" });
    return;
  }

  if (pathname === "/assets/videobg.mp4") {
    const videoPath = path.resolve(process.cwd(), "apps/elizaokbsc/assets/videobg.mp4");
    try {
      const stat = await import("fs/promises").then(m => m.stat(videoPath));
      const total = stat.size;
      const rangeHeader = req.headers.range;
      if (rangeHeader) {
        const [startStr, endStr] = rangeHeader.replace("bytes=", "").split("-");
        const start = parseInt(startStr, 10);
        const end = endStr ? parseInt(endStr, 10) : Math.min(start + 1_000_000, total - 1);
        const chunkSize = end - start + 1;
        const { createReadStream } = await import("fs");
        const stream = createReadStream(videoPath, { start, end });
        res.writeHead(206, {
          "content-type": "video/mp4",
          "content-range": `bytes ${start}-${end}/${total}`,
          "accept-ranges": "bytes",
          "content-length": String(chunkSize),
          "cache-control": "public, max-age=86400",
        });
        stream.pipe(res);
      } else {
        const content = await readFile(videoPath);
        res.writeHead(200, {
          "content-type": "video/mp4",
          "accept-ranges": "bytes",
          "content-length": String(total),
          "cache-control": "public, max-age=86400",
        });
        res.end(content);
      }
    } catch {
      sendJson(res, 404, { error: "Video asset not found" });
    }
    return;
  }

  if (pathname === "/assets/elizaok-banner.png") {
    for (const assetPath of ELIZAOK_BANNER_ASSET_PATHS) {
      try {
        const content = await readFile(assetPath);
        sendBinary(res, 200, "image/png", content);
        return;
      } catch {}
    }

    sendJson(res, 404, { error: "Banner asset not found" });
    return;
  }

  if (pathname === "/health") {
    sendJson(res, 200, {
      status: "ok",
      agent: runtime.character.name,
      discoveryEnabled: config.enabled,
      gooEnabled: config.goo.enabled,
      executionEnabled: executionState.enabled,
      executionDryRun: executionState.dryRun,
      executionMode: executionState.mode,
      executionRouter: executionState.router,
      executionLiveTradingArmed: executionState.liveTradingArmed,
      latestRunId: snapshot?.summary.runId ?? null,
    });
    return;
  }

  if (pathname === "/auth/eliza-cloud") {
    const popupParam = requestUrl.searchParams.get("popup") === "1";
    const state =
      globalThis.crypto && typeof globalThis.crypto.randomUUID === "function"
        ? globalThis.crypto.randomUUID()
        : `elizaok-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    if (!hasElizaCloudAppAuthConfig()) {
      const createResponse = await createElizaCloudCliSession(state);
      const createPayload = (await createResponse.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!createResponse.ok) {
        sendRedirect(
          res,
          `/dashboard?cloud_error=${encodeURIComponent(createPayload?.error || "failed_to_create_elizacloud_session")}`,
        );
        return;
      }
      sendRedirect(res, buildElizaCloudCliLoginUrl(state));
      return;
    }

    const loginUrl = buildElizaCloudLoginUrl(req, state, popupParam);
    if (!loginUrl) {
      sendRedirect(res, "/dashboard?cloud_error=missing_elizacloud_app_auth_config");
      return;
    }
    sendRedirect(res, loginUrl, [serializeElizaCloudAuthState(state)]);
    return;
  }

  if (pathname === "/api/eliza-cloud/hosted/start") {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "Method not allowed" });
      return;
    }

    const state =
      globalThis.crypto && typeof globalThis.crypto.randomUUID === "function"
        ? globalThis.crypto.randomUUID()
        : `elizaok-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    if (!hasElizaCloudAppAuthConfig()) {
      const createResponse = await createElizaCloudCliSession(state);
      const createPayload = (await createResponse.json().catch(() => null)) as
        | { error?: string }
        | { status?: string }
        | null;
      if (!createResponse.ok) {
        sendJson(res, createResponse.status || 500, {
          error:
            (createPayload &&
              "error" in createPayload &&
              createPayload.error) ||
            "Failed to create ElizaCloud session",
        });
        return;
      }
      sendJson(res, 200, {
        loginUrl: buildElizaCloudCliLoginUrl(state),
        sessionId: state,
        mode: "cli-session",
      });
      return;
    }

    const loginUrl = buildElizaCloudLoginUrl(req, state, true);
    if (!loginUrl) {
      sendJson(res, 500, { error: "Missing ElizaCloud hosted app auth URL" });
      return;
    }

    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "set-cookie": serializeElizaCloudAuthState(state),
    });
    res.end(JSON.stringify({ loginUrl, state, mode: "app-auth" }, null, 2));
    return;
  }

  if (pathname === "/api/eliza-cloud/hosted/poll") {
    const sessionId = requestUrl.searchParams.get("session")?.trim() || "";
    if (!sessionId) {
      sendJson(res, 400, { error: "session is required" });
      return;
    }

    const statusResponse = await fetchElizaCloudCliSession(sessionId);
    const statusPayload = (await statusResponse.json().catch(() => null)) as {
      error?: string;
      status?: string;
      apiKey?: string;
      keyPrefix?: string;
    } | null;

    if (!statusResponse.ok || !statusPayload) {
      sendJson(
        res,
        statusResponse.status || 500,
        statusPayload || { error: "Failed to poll ElizaCloud" },
      );
      return;
    }

    if (statusPayload.status === "authenticated" && statusPayload.apiKey) {
      const apiBase = elizaCloudApiBase();
      const [primaryAgent, profile, credits, creditSummary] = await Promise.all([
        fetchElizaCloudPrimaryAgentConfig(apiBase, statusPayload.apiKey),
        fetchElizaCloudUser(apiBase, statusPayload.apiKey),
        fetchElizaCloudCreditsBalance(apiBase, statusPayload.apiKey),
        fetchElizaCloudCreditsSummary(apiBase, statusPayload.apiKey),
      ]);
      const session = buildElizaCloudApiSession(
        statusPayload.apiKey,
        {
          ...creditSummary,
          ...profile,
          displayName:
            profile?.displayName ||
            creditSummary?.displayName ||
            profile?.organizationName ||
            "ElizaCloud User",
          organizationName:
            profile?.organizationName ||
            creditSummary?.organizationName ||
            "ElizaCloud",
          credits:
            credits || creditSummary?.credits || profile?.credits || "linked",
          agentId: primaryAgent?.id || "",
          agentName: primaryAgent?.name || "Eliza",
          model: primaryAgent
            ? primaryAgent.modelProvider
              ? `${primaryAgent.modelProvider}/${primaryAgent.model}`
              : primaryAgent.model
            : "n/a",
        },
        "siwe",
      );
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "set-cookie": serializeElizaCloudSession(session),
      });
      res.end(JSON.stringify({ status: "authenticated", session }, null, 2));
      return;
    }

    if (statusPayload.status === "authenticated" && cloudSession) {
      sendJson(res, 200, { status: "authenticated", session: cloudSession });
      return;
    }

    sendJson(res, 200, { status: statusPayload.status || "pending" });
    return;
  }

  if (pathname === "/api/eliza-cloud/siwe/nonce") {
    const response = await fetchElizaCloudNonce(req);
    const body = await response.text();
    res.writeHead(response.status, {
      "content-type":
        response.headers.get("content-type") ||
        "application/json; charset=utf-8",
    });
    res.end(body);
    return;
  }

  if (pathname === "/api/eliza-cloud/siwe/verify") {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "Method not allowed" });
      return;
    }

    const payload = await readRequestJson<{
      message?: string;
      signature?: string;
    }>(req);
    if (!payload?.message || !payload?.signature) {
      sendJson(res, 400, { error: "message and signature are required" });
      return;
    }

    const response = await verifyElizaCloudSiwe({
      message: payload.message,
      signature: payload.signature,
    });
    const data = (await response.json().catch(() => null)) as
      | ElizaCloudVerifyResponse
      | { error?: string }
      | null;

    if (!response.ok || !data || !("apiKey" in data)) {
      sendJson(
        res,
        response.status || 500,
        data || { error: "ElizaCloud verification failed" },
      );
      return;
    }

    const apiBase = elizaCloudApiBase();
    const [primaryAgent, profile, credits, creditSummary] = await Promise.all([
      fetchElizaCloudPrimaryAgentConfig(apiBase, data.apiKey),
      fetchElizaCloudUser(apiBase, data.apiKey),
      fetchElizaCloudCreditsBalance(apiBase, data.apiKey),
      fetchElizaCloudCreditsSummary(apiBase, data.apiKey),
    ]);
    const session = buildElizaCloudApiSession(
      data.apiKey,
      {
        ...creditSummary,
        ...profile,
        displayName:
          profile?.displayName ||
          creditSummary?.displayName ||
          data.organization?.name ||
          profile?.email ||
          shortAddress(data.address),
        email: profile?.email || data.user.id,
        walletAddress: profile?.walletAddress || data.address,
        organizationName:
          profile?.organizationName ||
          creditSummary?.organizationName ||
          data.organization?.name ||
          "ElizaCloud",
        organizationSlug:
          profile?.organizationSlug || data.organization?.slug || "elizacloud",
        credits:
          credits || creditSummary?.credits || profile?.credits || "linked",
        agentId: primaryAgent?.id || "",
        agentName: primaryAgent?.name || "Eliza",
        model: primaryAgent
          ? primaryAgent.modelProvider
            ? `${primaryAgent.modelProvider}/${primaryAgent.model}`
            : primaryAgent.model
          : "n/a",
      },
      "siwe",
    );

    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "set-cookie": serializeElizaCloudSession(session),
    });
    res.end(JSON.stringify({ success: true, session }, null, 2));
    return;
  }

  if (pathname === "/api/eliza-cloud/app-auth/complete") {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "Method not allowed" });
      return;
    }

    const payload = await readRequestJson<{
      state?: string;
      appId?: string;
      app_id?: string;
      access_token?: string;
      token?: string;
      authToken?: string;
      auth_token?: string;
      bearer?: string;
    }>(req);
    const stateFromPayload = payload?.state?.trim() || "";
    const expectedState = readElizaCloudAuthState(req.headers.cookie);
    if (
      stateFromPayload &&
      expectedState &&
      stateFromPayload !== expectedState
    ) {
      res.writeHead(400, {
        "content-type": "application/json; charset=utf-8",
        "set-cookie": clearElizaCloudAuthState(),
      });
      res.end(
        JSON.stringify(
          { error: "ElizaCloud state verification failed." },
          null,
          2,
        ),
      );
      return;
    }

    const authToken =
      payload?.access_token?.trim() ||
      payload?.token?.trim() ||
      payload?.authToken?.trim() ||
      payload?.auth_token?.trim() ||
      payload?.bearer?.trim() ||
      "";
    const appId =
      payload?.appId?.trim() || payload?.app_id?.trim() || getElizaCloudAppId();
    const result = await buildElizaCloudSessionFromAppAuth(authToken, appId);
    if (!result.session) {
      res.writeHead(400, {
        "content-type": "application/json; charset=utf-8",
        "set-cookie": clearElizaCloudAuthState(),
      });
      res.end(
        JSON.stringify(
          { error: result.error || "ElizaCloud app auth failed." },
          null,
          2,
        ),
      );
      return;
    }

    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "set-cookie": [
        serializeElizaCloudSession(result.session),
        clearElizaCloudAuthState(),
      ],
    });
    res.end(
      JSON.stringify({ success: true, session: result.session }, null, 2),
    );
    return;
  }

  if (pathname === "/auth/eliza-cloud/demo") {
    if (!isLocalRequest(req) || !isElizaCloudDemoEnabled()) {
      sendRedirect(res, "/dashboard?cloud_error=eliza_cloud_demo_disabled");
      return;
    }
    sendRedirect(res, buildElizaCloudDemoUrl(req));
    return;
  }

  if (pathname === "/auth/eliza-cloud/callback") {
    const popupMode = requestUrl.searchParams.get("popup") === "1";
    const stateFromQuery = requestUrl.searchParams.get("state")?.trim() || "";
    const expectedState = readElizaCloudAuthState(req.headers.cookie);
    const appAuthToken =
      requestUrl.searchParams.get("access_token")?.trim() ||
      requestUrl.searchParams.get("token")?.trim() ||
      requestUrl.searchParams.get("authToken")?.trim() ||
      requestUrl.searchParams.get("auth_token")?.trim() ||
      requestUrl.searchParams.get("bearer")?.trim() ||
      "";
    const appIdFromQuery =
      requestUrl.searchParams.get("appId")?.trim() ||
      requestUrl.searchParams.get("app_id")?.trim() ||
      getElizaCloudAppId();

    if (requestUrl.searchParams.get("error")) {
      const message =
        requestUrl.searchParams.get("error_description") ||
        requestUrl.searchParams.get("error") ||
        "ElizaCloud authentication failed.";
      const cookieHeaders = [clearElizaCloudAuthState()];
      if (popupMode) {
        sendHtml(
          res,
          200,
          renderCloudPopupResultHtml("error", message),
          cookieHeaders,
        );
        return;
      }
      sendRedirect(
        res,
        `/dashboard?cloud_error=${encodeURIComponent(message)}`,
        cookieHeaders,
      );
      return;
    }

    if (stateFromQuery && expectedState && stateFromQuery !== expectedState) {
      const cookieHeaders = [clearElizaCloudAuthState()];
      if (popupMode) {
        sendHtml(
          res,
          200,
          renderCloudPopupResultHtml(
            "error",
            "ElizaCloud state verification failed.",
          ),
          cookieHeaders,
        );
        return;
      }
      sendRedirect(
        res,
        "/dashboard?cloud_error=invalid_elizacloud_state",
        cookieHeaders,
      );
      return;
    }

    if (appAuthToken && appIdFromQuery) {
      const result = await buildElizaCloudSessionFromAppAuth(
        appAuthToken,
        appIdFromQuery,
      );
      const cookieHeaders = result.session
        ? [
            serializeElizaCloudSession(result.session),
            clearElizaCloudAuthState(),
          ]
        : [clearElizaCloudAuthState()];
      if (!result.session) {
        const message = result.error || "ElizaCloud app auth failed.";
        if (popupMode) {
          sendHtml(
            res,
            200,
            renderCloudPopupResultHtml("error", message),
            cookieHeaders,
          );
          return;
        }
        sendRedirect(
          res,
          `/dashboard?cloud_error=${encodeURIComponent(message)}`,
          cookieHeaders,
        );
        return;
      }
      if (popupMode) {
        sendHtml(
          res,
          200,
          renderCloudPopupResultHtml("success", "ElizaCloud connected."),
          cookieHeaders,
        );
        return;
      }
      sendRedirect(res, "/dashboard?cloud_connected=1", cookieHeaders);
      return;
    }

    if (hasElizaCloudAppAuthConfig()) {
      sendHtml(res, 200, renderCloudCallbackBridgeHtml(popupMode));
      return;
    }

    const session = buildElizaCloudSessionFromQuery(requestUrl);
    if (!session) {
      const cookieHeaders = [clearElizaCloudAuthState()];
      if (popupMode) {
        sendHtml(
          res,
          200,
          renderCloudPopupResultHtml(
            "error",
            "ElizaCloud callback did not include a supported app auth token.",
          ),
          cookieHeaders,
        );
        return;
      }
      sendRedirect(
        res,
        "/dashboard?cloud_error=missing_callback_payload",
        cookieHeaders,
      );
      return;
    }
    const cookieHeaders = [
      serializeElizaCloudSession(session),
      clearElizaCloudAuthState(),
    ];
    if (popupMode) {
      sendHtml(
        res,
        200,
        renderCloudPopupResultHtml("success", "ElizaCloud connected."),
        cookieHeaders,
      );
      return;
    }
    sendRedirect(res, "/dashboard?cloud_connected=1", cookieHeaders);
    return;
  }

  if (pathname === "/auth/eliza-cloud/logout") {
    sendRedirect(res, "/dashboard?cloud_disconnected=1", [clearElizaCloudSession()]);
    return;
  }

  if (pathname === "/api/elizaok/latest") {
    if (!snapshot) {
      sendJson(res, 404, { error: "No snapshot available yet" });
      return;
    }

    sendJson(res, 200, snapshot);
    return;
  }

  if (pathname === "/api/elizaok/execution") {
    sendJson(res, 200, executionState);
    return;
  }

  if (pathname === "/api/elizaok/trades") {
    sendJson(res, 200, tradeLedger);
    return;
  }

  if (pathname === "/api/elizaok/history") {
    if (!snapshot) {
      sendJson(res, 404, { error: "No snapshot available yet" });
      return;
    }

    sendJson(res, 200, {
      generatedAt: snapshot.generatedAt,
      history: recentHistory,
    });
    return;
  }

  if (pathname === "/api/elizaok/simulation") {
    if (!snapshot) {
      sendJson(res, 404, { error: "No snapshot available yet" });
      return;
    }

    sendJson(res, 200, {
      generatedAt: snapshot.generatedAt,
      simulation: treasurySimulation,
    });
    return;
  }

  if (pathname === "/api/elizaok/portfolio") {
    if (!snapshot) {
      sendJson(res, 404, { error: "No snapshot available yet" });
      return;
    }

    sendJson(res, 200, {
      generatedAt: snapshot.generatedAt,
      portfolio: portfolioLifecycle,
    });
    return;
  }

  if (pathname === "/api/elizaok/portfolio/positions") {
    const tokenAddress = requestUrl.searchParams.get("token")?.toLowerCase();
    if (!tokenAddress) {
      sendJson(res, 400, { error: "Missing token query parameter" });
      return;
    }
    if (!snapshot) {
      sendJson(res, 404, { error: "No snapshot available yet" });
      return;
    }

    const detail = buildPortfolioPositionDetail(snapshot, tokenAddress);
    if (!detail.position && detail.timeline.length === 0) {
      sendJson(res, 404, { error: "Portfolio position not found" });
      return;
    }

    sendJson(res, 200, {
      generatedAt: snapshot.generatedAt,
      detail,
    });
    return;
  }

  if (pathname === "/api/elizaok/timeline") {
    if (!snapshot) {
      sendJson(res, 404, { error: "No snapshot available yet" });
      return;
    }

    sendJson(res, 200, {
      generatedAt: snapshot.generatedAt,
      timeline: portfolioLifecycle.timeline,
    });
    return;
  }

  if (pathname === "/api/elizaok/distribution") {
    if (!snapshot) {
      sendJson(res, 404, { error: "No snapshot available yet" });
      return;
    }

    sendJson(res, 200, {
      generatedAt: snapshot.generatedAt,
      distribution: distributionPlan,
      execution: distributionExecution,
      ledger: distributionLedger,
    });
    return;
  }

  if (pathname === "/api/elizaok/distribution/run") {
    if (req.method !== "POST") {
      sendJson(res, 405, {
        error: "Method not allowed",
        detail: "Use POST to trigger a manual distribution run.",
      });
      return;
    }
    if (!snapshot) {
      sendJson(res, 404, { error: "No snapshot available yet" });
      return;
    }

    const refreshedDistributionPlan = await buildDistributionPlan(
      config.distribution,
      snapshot.treasurySimulation,
      config.execution.rpcUrl,
      snapshot.portfolioLifecycle,
    );
    const {
      distributionExecution: refreshedExecution,
      distributionLedger: refreshedLedger,
    } = await executeDistributionLane({
      config: config.distribution,
      distributionPlan: refreshedDistributionPlan,
      reportsDir: config.reportsDir,
      rpcUrl: config.execution.rpcUrl,
    });

    await persistDistributionExecutionState(
      snapshot,
      config.reportsDir,
      refreshedDistributionPlan,
      refreshedExecution,
      refreshedLedger,
    );

    sendJson(res, 200, {
      generatedAt: new Date().toISOString(),
      message: "Manual distribution run completed.",
      distribution: refreshedDistributionPlan,
      execution: refreshedExecution,
      ledger: refreshedLedger,
    });
    return;
  }

  if (pathname === "/api/elizaok/distribution/execution") {
    if (!snapshot) {
      sendJson(res, 404, { error: "No snapshot available yet" });
      return;
    }

    sendJson(res, 200, {
      generatedAt: snapshot.generatedAt,
      execution: distributionExecution,
    });
    return;
  }

  if (pathname === "/api/elizaok/distribution/ledger") {
    if (!snapshot) {
      sendJson(res, 404, { error: "No snapshot available yet" });
      return;
    }

    sendJson(res, 200, {
      generatedAt: snapshot.generatedAt,
      ledger: distributionLedger,
    });
    return;
  }

  if (pathname === "/api/elizaok/distribution/pending") {
    if (!snapshot) {
      sendJson(res, 404, { error: "No snapshot available yet" });
      return;
    }

    sendJson(res, 200, {
      generatedAt: snapshot.generatedAt,
      manifestFingerprint: distributionExecution.manifestFingerprint,
      pendingRecipients: distributionPendingRecipients,
      pendingCount: Math.max(
        0,
        distributionPlan.recipients.length -
          distributionExecutedRecipients.size,
      ),
      maxRecipientsPerRun: distributionExecution.maxRecipientsPerRun,
    });
    return;
  }

  if (pathname === "/api/elizaok/goo") {
    const readiness = buildGooReadiness(config);
    sendJson(res, 200, {
      generatedAt: snapshot?.generatedAt ?? null,
      enabled: config.goo.enabled,
      configured: readiness.configured,
      readinessChecks: {
        enabled: config.goo.enabled,
        rpcUrlConfigured: Boolean(config.goo.rpcUrl),
        registryConfigured: Boolean(config.goo.registryAddress),
      },
      readinessScore: readiness.score,
      readinessTotal: readiness.total,
      readinessChecklist: readiness.checklist,
      nextAction: readiness.nextAction,
      registryAddress: config.goo.registryAddress,
      rpcUrlConfigured: Boolean(config.goo.rpcUrl),
      lookbackBlocks: config.goo.lookbackBlocks,
      maxAgents: config.goo.maxAgents,
      candidates: snapshot?.topGooCandidates ?? [],
    });
    return;
  }

  if (pathname === "/api/elizaok/goo/candidates") {
    const candidates = snapshot?.topGooCandidates ?? [];
    const agentId = requestUrl.searchParams.get("agent");
    if (agentId) {
      const detail = candidates.find(
        (candidate) => candidate.agentId === agentId,
      );
      if (!detail) {
        sendJson(res, 404, { error: "Goo candidate not found" });
        return;
      }

      sendJson(res, 200, buildGooCandidateDetail(detail, config));
      return;
    }

    sendJson(res, 200, {
      generatedAt: snapshot?.generatedAt ?? null,
      candidates: candidates.map((candidate) =>
        buildGooCandidateDetail(candidate, config),
      ),
    });
    return;
  }

  if (pathname === "/api/elizaok/watchlist") {
    if (!snapshot) {
      sendJson(res, 404, { error: "No snapshot available yet" });
      return;
    }

    sendJson(res, 200, {
      generatedAt: snapshot.generatedAt,
      watchlist: snapshot.watchlist,
    });
    return;
  }

  if (pathname === "/api/elizaok/candidates") {
    const candidateHistory = await loadCandidateHistoryFromDisk(
      config.reportsDir,
    );
    const tokenAddress = requestUrl.searchParams.get("token")?.toLowerCase();

    if (tokenAddress) {
      const detail = candidateHistory.find(
        (candidate) => candidate.tokenAddress.toLowerCase() === tokenAddress,
      );
      if (!detail) {
        sendJson(res, 404, { error: "Candidate not found" });
        return;
      }

      sendJson(res, 200, {
        ...detail,
        portfolio: buildPortfolioPositionDetail(snapshot, tokenAddress),
      });
      return;
    }

    sendJson(res, 200, {
      generatedAt: snapshot?.generatedAt ?? null,
      candidates: candidateHistory.slice(0, 50).map((detail) => detail.latest),
    });
    return;
  }

  if (pathname === "/candidate") {
    const candidateHistory = await loadCandidateHistoryFromDisk(
      config.reportsDir,
    );
    const tokenAddress = requestUrl.searchParams.get("token")?.toLowerCase();
    if (!tokenAddress) {
      sendJson(res, 400, { error: "Missing token query parameter" });
      return;
    }

    const detail = candidateHistory.find(
      (candidate) => candidate.tokenAddress.toLowerCase() === tokenAddress,
    );
    if (!detail) {
      sendJson(res, 404, { error: "Candidate not found" });
      return;
    }

    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      renderCandidateDetail(
        detail,
        buildPortfolioPositionDetail(snapshot, tokenAddress),
      ),
    );
    return;
  }

  if (pathname === "/goo-candidate") {
    const agentId = requestUrl.searchParams.get("agent");
    const candidate = snapshot?.topGooCandidates.find(
      (item) => item.agentId === agentId,
    );
    if (!candidate) {
      sendJson(res, 404, { error: "Goo candidate not found" });
      return;
    }

    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      renderGooCandidateDetail(buildGooCandidateDetail(candidate, config)),
    );
    return;
  }

  if (pathname === "/api/eliza-cloud/agents/create") {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "Method not allowed" });
      return;
    }
    if (!cloudSession?.apiKey) {
      sendJson(res, 401, { error: "ElizaCloud API key is required" });
      return;
    }
    const payload = await readRequestJson<{ name?: string; bio?: string }>(req);
    const name = payload?.name?.trim() || "";
    const bio = payload?.bio?.trim() || "";
    if (!name) {
      sendJson(res, 400, { error: "name is required" });
      return;
    }
    const response = await createElizaCloudAgent(cloudSession.apiKey, {
      name,
      bio,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      sendJson(
        res,
        response.status || 500,
        data || { error: "Failed to create ElizaCloud agent" },
      );
      return;
    }
    sendJson(res, 200, data || { success: true });
    return;
  }

  if (pathname === "/cloud/credits") {
    const refreshedCloud = await refreshElizaCloudSession(cloudSession);
    cloudSession = refreshedCloud.session;
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      ...(cloudSession
        ? { "set-cookie": serializeElizaCloudSession(cloudSession) }
        : {}),
    });
    res.end(renderCloudCreditsPage(cloudSession, refreshedCloud.summary));
    return;
  }

  if (pathname === "/cloud/agents") {
    const refreshedCloud = await refreshElizaCloudSession(cloudSession);
    cloudSession = refreshedCloud.session;
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      ...(cloudSession
        ? { "set-cookie": serializeElizaCloudSession(cloudSession) }
        : {}),
    });
    res.end(renderCloudAgentsPage(cloudSession, refreshedCloud.summary));
    return;
  }

  if (pathname === "/airdrop") {
    const refreshedCloud = await refreshElizaCloudSession(cloudSession);
    cloudSession = refreshedCloud.session;
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      ...(cloudSession ? { "set-cookie": serializeElizaCloudSession(cloudSession) } : {}),
    });
    res.end(renderAirdropPage(snapshot, cloudSession, distributionPlan, distributionExecution, distributionLedger));
    return;
  }

  if (pathname === "/dashboard") {
    const refreshedCloud = await refreshElizaCloudSession(cloudSession);
    cloudSession = refreshedCloud.session;
    const sidebarWalletBalanceLabel = await fetchWalletNativeBalanceLabel(
      config.execution.rpcUrl,
      "0x2D6C3358A3acFe3be42b2Bdf7419e87091270c5F",
    );
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      ...(cloudSession
        ? { "set-cookie": serializeElizaCloudSession(cloudSession) }
        : {}),
    });
    res.end(
      renderHtml(
        snapshot,
        cloudSession,
        refreshedCloud.summary,
        sidebarWalletBalanceLabel,
      ),
    );
    return;
  }

  if (pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderLandingPage());
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

export function startDashboardServer(runtime: AgentRuntime) {
  const config = getDiscoveryConfig();
  if (!config.dashboard.enabled) {
    runtime.logger.info("ElizaOK dashboard server disabled");
    return null;
  }

  const server = createServer((req, res) => {
    void handleRequest(req, res, runtime).catch((error) => {
      runtime.logger.error(
        { error },
        "ElizaOK dashboard server request failed",
      );
      if (!res.headersSent) {
        sendJson(res, 500, { error: "Internal server error" });
      } else {
        res.end();
      }
    });
  });

  server.listen(config.dashboard.port, () => {
    runtime.logger.info(
      { port: config.dashboard.port },
      "ElizaOK dashboard server started",
    );
  });

  return server;
}
