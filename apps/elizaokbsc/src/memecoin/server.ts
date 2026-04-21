import { readFile } from "node:fs/promises";
import { statSync } from "node:fs";
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
import {
  acquireAgent,
  buildGooPaperSummary,
  getAcquisitionCandidates,
  loadPaperAgents,
  savePaperAgents,
  spawnPaperAgent,
  type GooPaperAgent,
  type StrategyId,
} from "./goo-paper-engine";
import { persistDistributionExecutionState } from "./persist";
import {
  absorbAgentStrategy,
  applyAbsorptionOverrides,
  loadAbsorptionState,
  saveAbsorptionState,
  type AbsorptionState,
} from "./strategy-absorption";
import { getBnbPriceUsd, getGmgnSignals, getLatestSnapshot, getNotificationSeq, getNotifications, getPaperAgents, getPaperSummary, setPaperAgents, setPaperSummary } from "./store";
import type { GmgnSignalSnapshot } from "./store";
import type {
  CandidateDetail,
  DashboardSnapshot,
  PortfolioPositionDetail,
} from "./types";

const ELIZAOK_ASSET_DIR = (() => {
  const fromCwd = path.resolve(process.cwd(), "assets");
  const fromApp = path.resolve(process.cwd(), "apps/elizaokbsc/assets");
  try { statSync(path.join(fromCwd, "avatar.png")); return fromCwd; } catch {}
  try { statSync(path.join(fromApp, "avatar.png")); return fromApp; } catch {}
  return fromCwd;
})();

const ELIZAOK_LOGO_ASSET_PATHS = [
  path.join(ELIZAOK_ASSET_DIR, "elizaok-logo.png"),
  path.join(ELIZAOK_ASSET_DIR, "avatar.png"),
];

const ELIZAOK_BANNER_ASSET_PATHS = [
  path.join(ELIZAOK_ASSET_DIR, "elizaok-logo.png"),
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
  <title>elizaOK | Value Layer on BNB Chain</title>
  <meta name="description" content="elizaOK — the value layer that automates alpha discovery, position building, and real value delivery on BNB Chain. Built on elizaOS." />
  ${renderHeadBrandAssets("elizaOK | Value Layer on BNB Chain")}
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
    .video-bg video { position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transform-origin:center center;transition:opacity 1.2s ease-in-out;opacity:0;will-change:opacity; }
    @media(max-width:768px){
      .video-bg video#vid-b{display:none;}
      #grain-canvas{display:none;}
    }
    .grid-overlay { position:fixed;inset:0;z-index:1;pointer-events:none;background-image:radial-gradient(circle,rgba(246,231,15,0.18) 1px,transparent 1px);background-size:6px 6px; }
    #grain-canvas { position:fixed;inset:0;z-index:2;pointer-events:none;opacity:0.55;mix-blend-mode:screen; }
    .dark-overlay { position:fixed;inset:0;z-index:1;pointer-events:none;background:rgba(0,0,0,0.45); }
    .vignette { position:fixed;inset:0;z-index:3;pointer-events:none;background:radial-gradient(ellipse at 50% 50%,transparent 35%,rgba(0,0,0,0.72) 100%); }
    .hero { position:relative;width:100%;height:100vh;overflow:hidden;z-index:4; }
    .marquee-wrap { position:absolute;inset-x:0;top:0;padding-top:22px;overflow:hidden;z-index:10; }
    .marquee-track { display:flex;width:max-content;gap:0;animation:marquee 40s linear infinite; }
    .marquee-track span { font-size:12px;color:var(--yellow);white-space:nowrap;font-weight:400;letter-spacing:0.03em;opacity:0.85; }
    @keyframes marquee { 0%{transform:translateX(0);} 100%{transform:translateX(-50%);} }
    .audio-player { position:absolute;right:16px;top:50%;transform:translateY(-50%);display:flex;flex-direction:column;align-items:center;gap:20px;z-index:10; }
    @media(min-width:768px){.audio-player{right:32px;top:96px;transform:none;flex-direction:row;gap:20px;}}
    .audio-player button { background:none;border:none;cursor:pointer;color:var(--yellow);padding:0;display:flex;align-items:center;transition:color 0.3s,transform 0.3s,filter 0.3s;outline:none;opacity:0.85; }
    .audio-player button:hover { color:var(--yellow-soft);transform:scale(1.25);filter:drop-shadow(0 0 20px var(--yellow-glow));opacity:1; }
    .audio-player button.waiting { animation:ap-pulse 2s ease-in-out infinite; }
    @keyframes ap-pulse { 0%,100%{filter:drop-shadow(0 0 4px rgba(246,231,15,0.2));} 50%{filter:drop-shadow(0 0 16px var(--yellow-glow));transform:scale(1.15);} }
    .sound-bars { display:inline-flex;align-items:flex-end;gap:2px;height:14px; }
    .sound-bars span { display:inline-block;width:2px;background:var(--yellow);border-radius:1px;animation:soundbar 1.1s ease-in-out infinite; }
    .sound-bars span:nth-child(1){animation-delay:0s;height:40%;} .sound-bars span:nth-child(2){animation-delay:0.2s;height:75%;}
    .sound-bars span:nth-child(3){animation-delay:0.4s;height:50%;} .sound-bars span:nth-child(4){animation-delay:0.6s;height:85%;}
    @keyframes soundbar { 0%,100%{transform:scaleY(0.3);} 50%{transform:scaleY(1);} }
    .social-icons { position:absolute;right:16px;top:50%;transform:translateY(-50%);display:flex;flex-direction:column;align-items:center;gap:20px;z-index:10; }
    @media(min-width:768px){.social-icons{left:32px;right:auto;top:96px;transform:none;flex-direction:row;gap:20px;}}
    .social-icons a { color:var(--yellow);transition:color 0.3s,transform 0.3s,filter 0.3s;display:flex;opacity:0.85;position:relative; }
    .social-icons a:hover { color:var(--yellow-soft);transform:scale(1.25);filter:drop-shadow(0 0 20px var(--yellow-glow));opacity:1; }
    .social-icons a::after { content:attr(data-tip);position:absolute;left:50%;transform:translateX(-50%);bottom:-28px;font-size:10px;color:var(--yellow);background:rgba(0,0,0,0.8);padding:3px 8px;border-radius:4px;white-space:nowrap;opacity:0;pointer-events:none;transition:opacity 0.2s;letter-spacing:0.04em;border:1px solid rgba(246,231,15,0.15); }
    .social-icons a:hover::after { opacity:1; }
    @media(min-width:768px){.social-icons a::after{bottom:auto;top:-28px;}}
    .bottom-bar { position:absolute;inset-x:0;bottom:0;display:flex;flex-direction:column;padding:0 16px 32px;gap:12px;z-index:10; }
    @media(min-width:768px){.bottom-bar{flex-direction:row;align-items:flex-end;justify-content:space-between;padding:0 64px 48px;}}
    .bottom-title { font-size:26px;font-weight:400;color:var(--yellow);letter-spacing:-0.02em;cursor:pointer;transition:color 0.4s,text-shadow 0.4s,transform 0.3s;text-shadow:0 0 12px rgba(246,231,15,0.3);animation:title-breathe 3s ease-in-out infinite;user-select:none; }
    @media(min-width:768px){.bottom-title{font-size:32px;width:30%;}}
    @media(max-width:768px){
      .social-icons{position:fixed;left:14px;right:auto;top:52px;bottom:auto;transform:none;flex-direction:column;gap:16px;z-index:20;}
      .social-icons a::after{left:auto;right:auto;bottom:auto;top:50%;left:calc(100% + 8px);transform:translateY(-50%);}
      .audio-player{position:fixed;top:52px;right:14px;left:auto;transform:none;flex-direction:column;gap:14px;z-index:20;}
      .bottom-bar{padding:0 16px 32px;gap:8px;}
      .bottom-title{font-size:22px;text-align:center;width:100%;}
    }
    @media(max-width:480px){
      .marquee-track span{font-size:10px;}
      .social-icons{left:12px;top:48px;gap:14px;}
      .social-icons a svg{width:20px;height:20px;}
      .social-icons a{padding:6px;background:rgba(0,0,0,.35);border-radius:50%;backdrop-filter:blur(6px);}
      .bottom-bar{padding:0 12px 28px;gap:8px;}
      .bottom-title{font-size:18px;text-align:center;width:100%;}
      .center-dots{margin-left:6px;gap:3px;}
      .center-dots span{width:3px;height:3px;}
      .audio-player{top:48px;right:12px;gap:12px;}
      .audio-player button svg{width:20px;height:20px;}
      .audio-player button{padding:6px;background:rgba(0,0,0,.35);border-radius:50%;backdrop-filter:blur(6px);}
    }
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
  <audio id="bgm" autoplay loop preload="auto" src="/assets/bgm.mp3"></audio>
  <div class="video-bg" id="videoBg">
    <video id="vid-a" muted playsinline preload="auto" poster="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"><source src="/assets/videobg.mp4" type="video/mp4" /></video>
    <video id="vid-b" muted playsinline preload="none"><source src="/assets/videobg.mp4" type="video/mp4" /></video>
  </div>
  <div class="dark-overlay"></div>
  <div class="grid-overlay"></div>
  <canvas id="grain-canvas"></canvas>
  <div class="vignette"></div>
  <div class="hero">
    <div class="marquee-wrap"><div class="marquee-track">
      <span>elizaOK &middot; value layer on BNB Chain &middot; alpha discovery &middot; position building &middot; built on elizaOS &middot;&nbsp;</span><span>elizaOK &middot; value layer on BNB Chain &middot; alpha discovery &middot; position building &middot; built on elizaOS &middot;&nbsp;</span><span>elizaOK &middot; value layer on BNB Chain &middot; alpha discovery &middot; position building &middot; built on elizaOS &middot;&nbsp;</span><span>elizaOK &middot; value layer on BNB Chain &middot; alpha discovery &middot; position building &middot; built on elizaOS &middot;&nbsp;</span><span>elizaOK &middot; value layer on BNB Chain &middot; alpha discovery &middot; position building &middot; built on elizaOS &middot;&nbsp;</span><span>elizaOK &middot; value layer on BNB Chain &middot; alpha discovery &middot; position building &middot; built on elizaOS &middot;&nbsp;</span>
    </div></div>
    <div class="audio-player" id="audioPlayer">
      <button id="ap-play" class="waiting" aria-label="Play/Pause"><svg id="ap-icon-play" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg><svg id="ap-icon-pause" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg></button>
      <button id="ap-mute" aria-label="Mute/Unmute"><svg id="ap-icon-vol" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg><svg id="ap-icon-muted" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg></button>
    </div>
    <div class="social-icons">
      <a href="https://github.com/elizaokbsc" target="_blank" rel="noopener noreferrer" aria-label="GitHub" data-tip="GitHub"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/></svg></a>
      <a href="https://x.com/elizaok_bsc" target="_blank" rel="noopener noreferrer" aria-label="X / Twitter" data-tip="X / Twitter"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 4s-.7 2.1-2 3.4c1.6 10-9.4 17.3-18 11.6 2.2.1 4.4-.6 6-2C3 15.5.5 9.6 3 5c2.2 2.6 5.6 4.1 9 4-.9-4.2 4-6.6 7-3.8 1.1 0 3-1.2 3-1.2z"/></svg></a>
      <a href="/dashboard" aria-label="Dashboard" data-tip="Dashboard"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/></svg></a>
      <a href="#" id="landing-cloud-btn" aria-label="ElizaCloud" data-tip="elizaOS Cloud" style="cursor:pointer"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg></a>
    </div>
    <div class="bottom-bar">
      <div class="bottom-title" id="bottomTitle"><span id="bottomText">elizaOK agent</span><span class="center-dots"><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span></span></div>
    </div>
  </div>
  <div class="side-badge"><a href="/dashboard"><div class="badge-dot"></div><span>elizaOK</span><span>BNB</span></a></div>
  <script>
    var _isMobileDevice = window.innerWidth <= 768;
    (function(){
      if (_isMobileDevice) return;
      var c=document.getElementById('grain-canvas'),x=c.getContext('2d'),W,H;function r(){W=c.width=innerWidth;H=c.height=innerHeight;}addEventListener('resize',r);r();function d(){var img=x.createImageData(W,H),dt=img.data;for(var i=0;i<dt.length;i+=4){var v=(Math.random()*255)|0;dt[i]=v;dt[i+1]=(v*0.88)|0;dt[i+2]=0;dt[i+3]=Math.random()<0.35?28:0;}x.putImageData(img,0,0);requestAnimationFrame(d);}d();
    })();
    (function(){
      var a=document.getElementById('vid-a'),b=document.getElementById('vid-b');
      if (_isMobileDevice) {
        a.style.opacity='1';
        a.setAttribute('loop','');
        a.play().catch(function(){
          document.addEventListener('touchstart',function h(){a.play().catch(function(){});document.removeEventListener('touchstart',h);},{once:true});
        });
        return;
      }
      var CF=1.8,act=a,stb=b;function swap(){stb.currentTime=0;stb.play();stb.style.opacity='1';act.style.opacity='0';setTimeout(function(){act.pause();act.currentTime=0;var t=act;act=stb;stb=t;},1300);}function tick(){if(act.duration&&!isNaN(act.duration)){if(act.duration-act.currentTime<=CF&&stb.paused)swap();}requestAnimationFrame(tick);}a.style.opacity='1';a.play().catch(function(){});b.load();requestAnimationFrame(tick);
    })();
    var vbg=document.getElementById('videoBg'),px=0,py=0,vs=1.15;var isMobile=window.innerWidth<=768;function apV(){if(vbg&&!isMobile)vbg.style.transform='scale('+vs+') translate('+px+'px,'+py+'px)';}if(!isMobile){document.addEventListener('mousemove',function(e){var cx=innerWidth/2,cy=innerHeight/2;px=(e.clientX-cx)/cx*-14;py=(e.clientY-cy)/cy*-9;apV();});addEventListener('wheel',function(e){e.preventDefault();vs=Math.min(Math.max(vs+e.deltaY*0.001,1.1),1.5);apV();},{passive:false});}
    (function(){
      var a=document.getElementById('bgm');a.volume=0.35;
      var playing=false,muted=false,unlocked=false,userStopped=false;
      var pb=document.getElementById('ap-play'),mb=document.getElementById('ap-mute');
      var iP=document.getElementById('ap-icon-play'),iPa=document.getElementById('ap-icon-pause');
      var iV=document.getElementById('ap-icon-vol'),iM=document.getElementById('ap-icon-muted');
      function u(){
        iP.style.display=playing?'none':'block';iPa.style.display=playing?'block':'none';
        iV.style.display=muted?'none':'block';iM.style.display=muted?'block':'none';
        pb.classList.toggle('waiting',!unlocked&&!playing);
      }
      function startFresh(){
        if(playing||userStopped)return;
        var fresh=new Audio('/assets/bgm.mp3');fresh.loop=true;fresh.volume=0.35;fresh.muted=muted;
        fresh.play().then(function(){
          a.pause();a.parentNode&&a.parentNode.removeChild(a);
          a=fresh;playing=true;unlocked=true;cleanEvents();u();
          a.addEventListener('ended',function(){a.currentTime=0;a.play();});
        }).catch(function(){});
      }
      pb.addEventListener('click',function(e){
        e.stopPropagation();
        if(playing){a.pause();playing=false;userStopped=true;}
        else{userStopped=false;startFresh();if(!playing){a.play().catch(function(){});playing=true;unlocked=true;}}
        u();
      });
      mb.addEventListener('click',function(e){e.stopPropagation();muted=!muted;a.muted=muted;u();});
      var evts=['click','touchstart','touchend','pointerdown','pointerup','keydown'];
      function boot(){if(unlocked||userStopped)return;startFresh();}
      function cleanEvents(){evts.forEach(function(e){document.removeEventListener(e,boot,true);});}
      evts.forEach(function(e){document.addEventListener(e,boot,true);});
      a.play().then(function(){playing=true;unlocked=true;cleanEvents();u();}).catch(function(){});
      setTimeout(function(){if(!playing&&!userStopped)a.play().then(function(){playing=true;unlocked=true;cleanEvents();u();}).catch(function(){});},500);
      u();
    })();
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
  <title>elizaOK | ElizaCloud</title>
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
  <title>elizaOK | ElizaCloud Callback</title>
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
    <p>Finalizing hosted app authentication for elizaOK...</p>
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

function candidateHref(tokenAddress: string, dexId?: string): string {
  if (dexId === "four-meme") {
    return `https://four.meme/token/${tokenAddress}`;
  }
  if (dexId?.startsWith("pancakeswap")) {
    return `https://pancakeswap.finance/swap?chain=bsc&outputCurrency=${tokenAddress}`;
  }
  return `https://www.dextools.io/app/en/bnb/pair-explorer/${tokenAddress}`;
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
  return `<img class="${className}" src="/assets/avatar.png" alt="elizaOK" />`;
}

function renderHeadBrandAssets(title: string): string {
  const safeTitle = escapeHtml(title);
  return `
  <title>${safeTitle}</title>
  <link rel="icon" type="image/png" href="/assets/avatar.png" />
  <link rel="apple-touch-icon" href="/assets/avatar.png" />
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
  ${renderHeadBrandAssets(`${detail.tokenSymbol} | elizaOK`)}
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
        <a class="back-link" href="${candidateHref(detail.tokenAddress, detail.latest.dexId)}" target="_blank" rel="noreferrer">Trade on DEX</a>
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
  ${renderHeadBrandAssets(`Goo Agent ${candidate.agentId} | elizaOK`)}
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
#cp-theme-toggle{transition:all .3s ease;}
#cp-theme-toggle:hover{border-color:var(--yellow);color:var(--yellow);box-shadow:0 0 12px rgba(var(--yr),.2);transform:rotate(15deg) scale(1.1);}
#cp-theme-toggle:active{transform:rotate(0deg) scale(.95);}
.a-wrap{position:relative;z-index:1;max-width:1100px;margin:0 auto;padding:32px 24px 64px;}
.a-topbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:32px;flex-wrap:wrap;gap:12px;}
.a-logo{font-size:18px;font-weight:700;color:var(--yellow);letter-spacing:.08em;text-decoration:none;display:flex;align-items:center;gap:12px;}
.a-logo__avatar{width:38px;height:38px;border-radius:50%;border:2px solid rgba(var(--yr),.3);object-fit:cover;transition:all .35s ease;box-shadow:0 0 8px rgba(var(--yr),.15);flex-shrink:0;}
.a-logo__avatar:hover{transform:translateY(-3px) scale(1.08);border-color:var(--yellow);box-shadow:0 0 22px rgba(var(--yr),.5),0 0 44px rgba(var(--yr),.2);}
.a-nav{display:flex;gap:10px;align-items:center;flex-wrap:wrap;}
.a-nav a{color:var(--muted);font-size:11px;text-decoration:none;padding:5px 12px;border:1px solid var(--border);border-radius:var(--r-sm);transition:all .25s ease;}
.a-nav a:hover{color:var(--yellow);border-color:var(--yellow);box-shadow:0 0 12px rgba(var(--yr),.25);transform:translateY(-1px);}
.a-nav a.active{color:var(--yellow);border-color:var(--yellow);box-shadow:0 0 8px rgba(var(--yr),.15);}
/* ── Card grid (reuse cp- prefix so existing body HTML still works) ── */
.cp-grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:14px;}
.cp-col-12{grid-column:span 12;}
.cp-col-8{grid-column:span 8;}
.cp-col-6{grid-column:span 6;}
.cp-col-4{grid-column:span 4;}
.cp-card{background:var(--panel);border:1px solid var(--border);border-radius:var(--r);overflow:hidden;transition:all .3s ease;}
.cp-card:hover{border-color:rgba(var(--yr),.3);box-shadow:0 4px 20px rgba(0,0,0,.2),0 0 15px rgba(var(--yr),.06);transform:translateY(-1px);}
.cp-card__head{padding:12px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:8px;position:relative;overflow:hidden;}
.cp-card__head::before{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,rgba(var(--yr),.15),transparent);opacity:0;transition:opacity .3s;}
.cp-card:hover .cp-card__head::before{opacity:1;}
.cp-card__head h2{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);transition:color .3s;}
.cp-card:hover .cp-card__head h2{color:var(--yellow);}
.cp-card__head-badge{font-size:10px;font-weight:600;background:rgba(var(--yr),.08);border:1px solid rgba(var(--yr),.3);color:var(--yellow);padding:2px 8px;border-radius:20px;animation:badge-glow 3s ease-in-out infinite;}
@keyframes badge-glow{0%,100%{box-shadow:0 0 4px rgba(var(--yr),.1);}50%{box-shadow:0 0 10px rgba(var(--yr),.25);}}
.cp-card__body{padding:16px;}
.cp-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:0;border:1px solid var(--border);border-radius:var(--r);overflow:hidden;transition:all .3s ease;}
.cp-stats:hover{border-color:rgba(var(--yr),.2);box-shadow:0 2px 16px rgba(0,0,0,.15);}
.cp-stat{padding:16px 14px;text-align:center;border-right:1px solid var(--border);transition:all .3s ease;position:relative;}
.cp-stat:last-child{border-right:none;}
.cp-stat:hover{background:rgba(var(--yr),.03);}
.cp-stat:hover .cp-stat__value{transform:scale(1.08);text-shadow:0 0 12px rgba(var(--yr),.3);}
.cp-stat__label{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:8px;transition:color .3s;}
.cp-stat:hover .cp-stat__label{color:var(--yellow);}
.cp-stat__value{font-size:24px;font-weight:700;color:var(--white);line-height:1;transition:all .3s ease;}
.cp-stat__value--green{color:var(--yellow);}
.cp-stat__value--pink{color:var(--red);}
.cp-profile{display:flex;align-items:center;gap:20px;padding:20px;}
.cp-profile__avatar{width:52px;height:52px;border:1px solid var(--yellow);background:rgba(246,231,15,.08);border-radius:var(--r-sm);display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:700;color:var(--yellow);flex-shrink:0;}
.cp-profile__name{font-size:18px;font-weight:700;}
.cp-profile__org{font-size:11px;color:var(--muted);margin-top:2px;}
.cp-profile__meta{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;}
.cp-profile__chip{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;padding:3px 10px;border:1px solid var(--border);color:var(--muted);border-radius:20px;}
.cp-profile__chip{transition:all .2s;}
.cp-profile__chip:hover{border-color:rgba(var(--yr),.4);color:var(--white);transform:translateY(-1px);}
.cp-profile__chip--active{border-color:var(--yellow);color:var(--yellow);animation:chip-pulse 2.5s ease-in-out infinite;}
@keyframes chip-pulse{0%,100%{box-shadow:0 0 4px rgba(var(--yr),.1);}50%{box-shadow:0 0 12px rgba(var(--yr),.3);}}
.cp-rows{display:grid;gap:0;}
.cp-row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid rgba(255,255,255,.04);}
.cp-row:last-child{border-bottom:none;}
.cp-row span{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;}
.cp-row strong{font-size:12px;font-weight:600;text-align:right;max-width:260px;word-break:break-all;}
.cp-agents{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px;padding:16px;}
.cp-agent{background:rgba(255,255,255,.03);border:1px solid var(--border);border-radius:var(--r-sm);overflow:hidden;transition:all .3s ease;}
.cp-agent:hover{border-color:var(--yellow);box-shadow:0 0 14px rgba(var(--yr),.12);transform:translateY(-2px);background:rgba(var(--yr),.02);}
.cp-agent__head{padding:10px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;}
.cp-agent__name{font-size:13px;font-weight:600;}
.cp-agent__status{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;padding:2px 8px;border:1px solid var(--border);color:var(--muted);border-radius:20px;}
.cp-agent__status--active{border-color:var(--yellow);color:var(--yellow);animation:status-blink 2s ease-in-out infinite;}
@keyframes status-blink{0%,100%{opacity:1;}50%{opacity:.6;}}
.cp-agent__body{padding:10px 14px;}
.cp-agent__row{display:flex;justify-content:space-between;font-size:11px;margin-bottom:5px;}
.cp-agent__row span{color:var(--muted);}
.cp-agent__row strong{font-weight:600;}
.cp-actions{padding:14px 16px;display:flex;gap:8px;flex-wrap:wrap;}
.cp-btn{display:inline-flex;align-items:center;height:32px;padding:0 14px;border:1px solid var(--border);border-radius:var(--r-sm);background:transparent;color:var(--muted);font-family:inherit;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;cursor:pointer;transition:all .25s ease;text-decoration:none;position:relative;overflow:hidden;}
.cp-btn::after{content:'';position:absolute;inset:0;background:linear-gradient(135deg,rgba(var(--yr),.08),transparent);opacity:0;transition:opacity .25s;}
.cp-btn:hover{border-color:var(--yellow);color:var(--yellow);box-shadow:0 0 14px rgba(var(--yr),.25);transform:translateY(-1px);}
.cp-btn:hover::after{opacity:1;}
.cp-btn:active{transform:translateY(0) scale(.97);}
.cp-btn--accent{border-color:var(--yellow);color:var(--yellow);box-shadow:0 0 6px rgba(var(--yr),.1);}
.cp-btn--accent:hover{background:var(--yellow);color:#000;box-shadow:0 0 20px rgba(var(--yr),.4);}
@media(max-width:960px){.cp-stats{grid-template-columns:repeat(2,minmax(0,1fr));}.cp-col-8,.cp-col-6,.cp-col-4{grid-column:span 12;}}
@media(max-width:600px){.cp-col-12{grid-column:span 12;}.cp-stats{grid-template-columns:1fr;}}
@media(max-width:640px){
.a-topbar{flex-wrap:wrap;padding:12px 14px;gap:8px;}
.a-logo{width:100%;font-size:16px;}
.a-nav{width:100%;flex-wrap:wrap;gap:6px;}
.a-nav a{font-size:10px;padding:4px 10px;}
.a-wrap{padding:14px 10px;}
.cp-card{padding:14px;}
.cp-stat__value{font-size:20px;}
.cp-profile{flex-direction:column;align-items:flex-start;gap:10px;}
.cp-profile__avatar{width:44px;height:44px;font-size:18px;}
.cp-row{flex-direction:column;gap:2px;}
.cp-row strong{text-align:left;}
.cp-agent__head{flex-direction:column;gap:6px;align-items:flex-start;}
}
.a-footer{text-align:center;font-size:10px;color:var(--muted);margin-top:40px;letter-spacing:.06em;transition:color .3s;}
.a-footer:hover{color:var(--yellow);}
.chat-wrap{display:flex;flex-direction:column;height:480px;border:1px solid var(--border);border-radius:var(--r);overflow:hidden;background:var(--panel);transition:border-color .3s ease,box-shadow .3s ease;}
.chat-wrap:focus-within{border-color:rgba(var(--yr),.3);box-shadow:0 0 20px rgba(var(--yr),.06);}
.chat-head{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--border);flex-shrink:0;}
.chat-head__title{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--white);}
.chat-head__dot{width:7px;height:7px;border-radius:50%;background:var(--green);animation:pulse 2s ease-in-out infinite;box-shadow:0 0 6px rgba(57,255,20,.4);}
.chat-msgs{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px;scroll-behavior:smooth;}
.chat-msgs::-webkit-scrollbar{width:4px;}.chat-msgs::-webkit-scrollbar-track{background:transparent;}.chat-msgs::-webkit-scrollbar-thumb{background:var(--border2);border-radius:2px;}
.chat-bubble{max-width:82%;padding:10px 14px;border-radius:12px;font-size:12px;line-height:1.6;word-break:break-word;animation:chat-in .25s ease-out;}
@keyframes chat-in{0%{opacity:0;transform:translateY(8px);}100%{opacity:1;transform:translateY(0);}}
.chat-bubble--user{align-self:flex-end;background:linear-gradient(135deg,rgba(var(--yr),.14),rgba(var(--yr),.06));border:1px solid rgba(var(--yr),.2);color:var(--white);border-bottom-right-radius:4px;box-shadow:0 2px 8px rgba(var(--yr),.06);}
.chat-bubble--ai{align-self:flex-start;background:rgba(255,255,255,.04);border:1px solid var(--border);color:var(--white);border-bottom-left-radius:4px;box-shadow:0 2px 6px rgba(0,0,0,.1);}
[data-theme="light"] .chat-bubble--user{background:rgba(var(--yr),.08);}
[data-theme="light"] .chat-bubble--ai{background:rgba(0,0,0,.03);}
.chat-bubble--typing .chat-dots{display:inline-flex;gap:4px;padding:2px 0;}
.chat-dots span{width:6px;height:6px;border-radius:50%;background:var(--muted);animation:dot-bounce .8s ease-in-out infinite;}
.chat-dots span:nth-child(2){animation-delay:.15s;}.chat-dots span:nth-child(3){animation-delay:.3s;}
@keyframes dot-bounce{0%,100%{transform:translateY(0);opacity:.4;}50%{transform:translateY(-5px);opacity:1;}}
.chat-input{display:flex;align-items:center;gap:8px;padding:10px 14px;border-top:1px solid var(--border);flex-shrink:0;background:var(--bg);}
.chat-input input{flex:1;background:transparent;border:1px solid var(--border);border-radius:8px;padding:9px 14px;color:var(--white);font-family:inherit;font-size:12px;outline:none;transition:border-color .2s;}
.chat-input input:focus{border-color:rgba(var(--yr),.5);}
.chat-input input::placeholder{color:var(--muted);}
.chat-send{background:var(--yellow);border:none;border-radius:8px;width:36px;height:36px;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:all .25s ease;flex-shrink:0;box-shadow:0 0 8px rgba(var(--yr),.2);}
.chat-send:hover{box-shadow:0 0 20px rgba(var(--yr),.5);transform:scale(1.1);}
.chat-send:active{transform:scale(.92);}
.chat-send:disabled{opacity:.3;cursor:default;transform:none;box-shadow:none;}
.chat-send svg{width:16px;height:16px;color:#000;}
.chat-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;gap:10px;color:var(--muted);font-size:12px;text-align:center;padding:24px;}
.chat-empty__icon{font-size:32px;opacity:.4;animation:float 3s ease-in-out infinite;}
@keyframes float{0%,100%{transform:translateY(0);}50%{transform:translateY(-6px);}}
@media(max-width:640px){.chat-wrap{height:380px;}.chat-bubble{max-width:92%;font-size:11px;}.chat-head{padding:10px 12px;}.chat-input{padding:8px 10px;}}
/* ── API Explorer ── */
.api-section__title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:10px;display:flex;align-items:center;gap:8px;}
.api-section__title::before{content:'';display:inline-block;width:3px;height:12px;background:var(--yellow);border-radius:2px;}
.api-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:10px;padding:14px 16px;}
.api-ep{display:flex;align-items:flex-start;gap:12px;padding:12px 14px;border:1px solid var(--border);border-radius:var(--r-sm);transition:all .25s ease;cursor:default;}
.api-ep:hover{border-color:rgba(var(--yr),.3);background:rgba(var(--yr),.03);transform:translateY(-1px);box-shadow:0 4px 12px rgba(0,0,0,.15);}
.api-ep__method{font-size:9px;font-weight:700;letter-spacing:.05em;padding:3px 7px;border-radius:4px;flex-shrink:0;text-transform:uppercase;margin-top:1px;}
.api-ep__method--get{background:rgba(57,255,20,.1);color:var(--green);border:1px solid rgba(57,255,20,.2);}
.api-ep__method--post{background:rgba(var(--yr),.1);color:var(--yellow);border:1px solid rgba(var(--yr),.2);}
.api-ep__method--patch{background:rgba(100,149,237,.1);color:#6495ED;border:1px solid rgba(100,149,237,.2);}
.api-ep__method--delete{background:rgba(255,64,64,.1);color:var(--red);border:1px solid rgba(255,64,64,.2);}
.api-ep__info{flex:1;min-width:0;}
.api-ep__name{font-size:12px;font-weight:600;color:var(--white);margin-bottom:3px;}
.api-ep__path{font-size:10px;color:var(--muted);font-family:'JetBrains Mono',monospace;word-break:break-all;}
.api-ep__meta{display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;}
.api-ep__tag{font-size:9px;padding:2px 7px;border:1px solid var(--border);border-radius:10px;color:var(--muted);letter-spacing:.03em;}
.api-ep__price{font-size:9px;padding:2px 7px;border-radius:10px;letter-spacing:.03em;font-weight:600;}
.api-ep__price--free{background:rgba(57,255,20,.06);color:var(--green);border:1px solid rgba(57,255,20,.15);}
.api-ep__price--paid{background:rgba(var(--yr),.06);color:var(--yellow);border:1px solid rgba(var(--yr),.15);}
.api-cats{display:flex;gap:6px;padding:0 16px 10px;flex-wrap:wrap;}
.api-cat{font-size:10px;padding:4px 12px;border:1px solid var(--border);border-radius:20px;color:var(--muted);cursor:pointer;transition:all .2s;background:transparent;font-family:inherit;letter-spacing:.03em;}
.api-cat:hover,.api-cat.active{border-color:var(--yellow);color:var(--yellow);background:rgba(var(--yr),.05);}
.api-cat__count{font-size:9px;opacity:.6;margin-left:4px;transition:all .2s;}
.api-cat:hover .api-cat__count,.api-cat.active .api-cat__count{opacity:1;}
[data-theme="light"] .api-ep{background:rgba(0,0,0,.01);}
[data-theme="light"] .api-ep:hover{background:rgba(var(--yr),.03);}
@media(max-width:640px){.api-grid{grid-template-columns:1fr;padding:10px;gap:8px;}.api-ep{padding:10px;}.api-cats{padding:0 10px 8px;}}
/* ── Entrance & life animations ── */
@keyframes fade-up{0%{opacity:0;transform:translateY(16px);}100%{opacity:1;transform:translateY(0);}}
.cp-grid>.cp-col-8,.cp-grid>.cp-col-4,.cp-grid>.cp-col-6,.cp-grid>.cp-col-12{animation:fade-up .5s ease-out both;}
.cp-grid>.cp-col-8:nth-child(1),.cp-grid>.cp-col-4:nth-child(2){animation-delay:.05s;}
.cp-grid>.cp-col-12:nth-child(3){animation-delay:.12s;}
.cp-grid>.cp-col-4:nth-child(4),.cp-grid>.cp-col-6:nth-child(4){animation-delay:.18s;}
.cp-grid>.cp-col-8:nth-child(5),.cp-grid>.cp-col-6:nth-child(5){animation-delay:.24s;}
.cp-grid>.cp-col-12:nth-child(6),.cp-grid>.cp-col-12:nth-child(7){animation-delay:.3s;}
.cp-row{transition:background .2s;}
.cp-row:hover{background:rgba(var(--yr),.03);}
.cp-profile__avatar{transition:all .3s ease;}
.cp-profile__avatar:hover{box-shadow:0 0 16px rgba(var(--yr),.35);transform:scale(1.05);}
.api-ep__method{transition:all .25s;}
.api-ep:hover .api-ep__method{transform:scale(1.05);}
.api-cat{position:relative;overflow:hidden;}
.api-cat::before{content:'';position:absolute;inset:0;background:radial-gradient(circle at center,rgba(var(--yr),.1),transparent 70%);opacity:0;transition:opacity .3s;}
.api-cat:hover::before,.api-cat.active::before{opacity:1;}
.chat-input input{transition:all .25s ease;}
.chat-input input:focus{border-color:rgba(var(--yr),.5);box-shadow:0 0 10px rgba(var(--yr),.1);}
.cp-card__head{transition:background .2s;}
.cp-card:hover .cp-card__head{background:rgba(var(--yr),.02);}
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
    <a class="a-logo" href="/"><img class="a-logo__avatar" src="/assets/avatar.png" alt="elizaOK" />elizaOK <span style="font-size:11px;font-weight:400;color:var(--muted);letter-spacing:.04em">with elizaOS Cloud</span></a>
    <nav class="a-nav">
      <a href="/">Home</a>
      <a href="/dashboard">Dashboard</a>
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
<link rel="icon" type="image/png" href="/assets/avatar.png" />
<link rel="apple-touch-icon" href="/assets/avatar.png" />
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
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
html,body{min-height:100%;background:var(--bg);color:var(--white);transition:background .3s,color .3s;-webkit-overflow-scrolling:touch;}
html{scrollbar-width:none;}
html::-webkit-scrollbar{display:none;}
body{overscroll-behavior-y:contain;}
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
.a-logo{display:flex;align-items:center;gap:10px;font-size:18px;font-weight:700;color:var(--yellow);letter-spacing:.08em;text-decoration:none;}
.a-logo-avatar{width:32px;height:32px;border-radius:50%;border:2px solid rgba(var(--yr),.35);box-shadow:0 0 14px rgba(var(--yr),.25),0 0 30px rgba(var(--yr),.08);animation:aLogoGlow 3s ease-in-out infinite;transition:transform .35s cubic-bezier(.34,1.56,.64,1),box-shadow .35s ease;}
.a-logo:hover .a-logo-avatar{transform:translateY(-3px) scale(1.1);box-shadow:0 0 22px rgba(var(--yr),.5),0 0 48px rgba(var(--yr),.18);border-color:rgba(var(--yr),.7);}
@keyframes aLogoGlow{0%,100%{box-shadow:0 0 14px rgba(var(--yr),.25),0 0 30px rgba(var(--yr),.08);}50%{box-shadow:0 0 20px rgba(var(--yr),.4),0 0 40px rgba(var(--yr),.15);}}
.a-nav{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
.a-nav a,.a-nav button.a-nav-btn{color:var(--muted);font-size:11px;text-decoration:none;padding:5px 12px;border:1px solid var(--border);border-radius:var(--r-sm);transition:all .2s;background:transparent;font-family:inherit;cursor:pointer;}
.a-nav a:hover,.a-nav button.a-nav-btn:hover{color:var(--yellow);border-color:var(--yellow);box-shadow:0 0 8px rgba(246,231,15,.25);}
.a-nav a.active{color:var(--yellow);border-color:var(--yellow);}
.a-hero{background:var(--panel);border:1px solid var(--border);border-radius:var(--r);padding:32px;margin-bottom:24px;display:flex;justify-content:space-between;align-items:flex-start;gap:24px;flex-wrap:wrap;}
.a-hero h1{font-size:24px;font-weight:700;letter-spacing:.04em;margin-bottom:8px;display:flex;align-items:center;gap:14px;}
.a-hero h1 span{color:var(--yellow);}
.a-hero p{color:var(--muted);font-size:13px;line-height:1.6;max-width:480px;}
.a-hero-avatar{width:48px;height:48px;border-radius:50%;border:2px solid rgba(var(--yr),.4);box-shadow:0 0 18px rgba(var(--yr),.3),0 0 40px rgba(var(--yr),.1);animation:aHeroGlow 3s ease-in-out infinite;transition:transform .35s cubic-bezier(.34,1.56,.64,1),box-shadow .35s ease;}
.a-hero-avatar:hover{transform:translateY(-4px) scale(1.08);box-shadow:0 0 28px rgba(var(--yr),.5),0 0 60px rgba(var(--yr),.2);border-color:rgba(var(--yr),.7);}
@keyframes aHeroGlow{0%,100%{box-shadow:0 0 18px rgba(var(--yr),.3),0 0 40px rgba(var(--yr),.1);}50%{box-shadow:0 0 24px rgba(var(--yr),.45),0 0 50px rgba(var(--yr),.18);}}
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
@media(max-width:640px){
.a-wrap{padding:16px 12px 40px;}
.a-topbar{margin-bottom:16px;gap:8px;}
.a-logo{font-size:15px;gap:8px;}
.a-logo-avatar{width:26px;height:26px;}
.a-nav{gap:5px;}
.a-nav a,.a-nav button.a-nav-btn{font-size:9px;padding:4px 8px;}
.a-hero{padding:18px 16px;margin-bottom:16px;gap:12px;flex-direction:column;border-radius:12px;}
.a-hero h1{font-size:16px;gap:10px;}
.a-hero-avatar{width:36px;height:36px;}
.a-hero p{font-size:11px;line-height:1.5;}
.a-stats{grid-template-columns:repeat(2,1fr);gap:8px;margin-bottom:16px;}
.a-stat{padding:14px 12px;border-radius:8px;}
.a-stat__label{font-size:9px;}
.a-stat__val{font-size:18px;}
.a-stat__sub{font-size:9px;}
.a-checker{padding:14px;margin-bottom:16px;border-radius:10px;}
.a-checker h2{font-size:10px;margin-bottom:12px;}
.a-input{min-width:0;font-size:12px;padding:8px 10px;}
.a-btn{font-size:12px;padding:8px 14px;}
.a-grid{grid-template-columns:1fr;gap:10px;margin-bottom:16px;}
.a-card{padding:14px;border-radius:10px;}
.a-card h2{font-size:10px;margin-bottom:10px;}
.a-kv{font-size:11px;gap:4px;padding:6px 0;}
.a-kv span{font-size:10px;}
.a-kv strong{text-align:right;font-size:10px;max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.a-table-wrap{border-radius:10px;}
.a-td{padding:6px 10px;font-size:10px;}
th.a-th{padding:6px 10px;font-size:9px;}
.a-note{padding:10px 12px;font-size:11px;border-radius:8px;}
.a-badge{font-size:10px;padding:4px 10px;}
.a-footer{margin-top:24px;font-size:9px;}
}
.a-card{background:var(--panel);border:1px solid var(--border);border-radius:var(--r);padding:20px;overflow:hidden;opacity:0;transform:translateY(16px);animation:aCardIn .5s ease forwards;}
.a-stat{opacity:0;transform:translateY(12px);animation:aCardIn .4s ease forwards;}
.a-checker{opacity:0;transform:translateY(14px);animation:aCardIn .45s ease forwards;}
.a-hero{opacity:0;transform:translateY(10px);animation:aCardIn .35s ease forwards;}
.a-table-wrap{opacity:0;transform:translateY(16px);animation:aCardIn .5s ease forwards;}
.a-note{opacity:0;transform:translateY(12px);animation:aCardIn .4s ease forwards;}
.a-pub{opacity:0;transform:translateY(16px);animation:aCardIn .5s ease forwards;}
@keyframes aCardIn{to{opacity:1;transform:translateY(0);}}
.a-stat:nth-child(1){animation-delay:.05s;}.a-stat:nth-child(2){animation-delay:.1s;}.a-stat:nth-child(3){animation-delay:.15s;}.a-stat:nth-child(4){animation-delay:.2s;}.a-stat:nth-child(5){animation-delay:.25s;}.a-stat:nth-child(6){animation-delay:.3s;}
.a-grid .a-card:nth-child(1){animation-delay:.2s;}.a-grid .a-card:nth-child(2){animation-delay:.28s;}
.a-card:hover{border-color:rgba(var(--yr),.25);box-shadow:0 0 18px rgba(var(--yr),.08);}
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
    <a class="a-logo" href="/"><img class="a-logo-avatar" src="/assets/avatar.png" alt="" />elizaOK</a>
    <nav class="a-nav">
      <a href="/">Home</a>
      <a href="/dashboard">Dashboard</a>
      <a href="/docs">Docs</a>
      <a href="/goo">Goo</a>
      <a href="/airdrop" class="active">Airdrop</a>
      <button class="a-nav-btn" onclick="airToggleLang()" id="airdrop-lang-toggle">中</button>
      ${cloudUser
        ? `<a href="/auth/eliza-cloud/logout" style="color:var(--yellow);border-color:var(--yellow);">${escapeHtml(cloudUser)} &middot; Logout</a>`
        : `<a href="#" id="airdrop-cloud-btn" style="cursor:pointer;color:var(--yellow);border-color:rgba(246,231,15,.4);">Connect Cloud</a>`}
      <button id="airdrop-theme-toggle" class="a-nav-btn" onclick="airToggleTheme()">☀</button>
    </nav>
  </div>

  <div class="a-hero">
    <div>
      <h1><img class="a-hero-avatar" src="/assets/avatar.png" alt="elizaOK" /><span>elizaOK</span> · <span data-i18n="空投资格">Airdrop Eligibility</span></h1>
      <p data-i18n="国库飞轮将收益分配给合格的 $elizaOK 持有者。检查您的钱包是否有资格参与当前空投周期并查看分配计划。">The treasury flywheel distributes gains back to qualified $elizaOK holders. Check if your wallet qualifies for the current airdrop cycle and view the distribution plan.</p>
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
      <div class="a-stat__sub">qualified $elizaOK wallets</div>
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
    <h2 data-i18n="检查钱包资格">Check Wallet Eligibility</h2>
    <div class="a-input-row">
      <input id="wallet-input" class="a-input" type="text" placeholder="Enter wallet address (0x…)" autocomplete="off" spellcheck="false" />
      <button class="a-btn" onclick="checkWallet()">Check</button>
    </div>
    <div id="wallet-result" class="a-result"></div>
  </div>

  <div class="a-grid">
    <div class="a-card">
      <h2 data-i18n="空投资产">Airdrop Asset</h2>
      <div class="a-kv"><span>Mode</span><strong class="yellow">${escapeHtml(selectedAsset.mode ?? "—")}</strong></div>
      <div class="a-kv"><span>Token</span><strong>${escapeHtml(selectedAsset.tokenSymbol ?? "—")}</strong></div>
      <div class="a-kv"><span>Total Amount</span><strong>${escapeHtml(String(selectedAsset.totalAmount ?? "—"))}</strong></div>
      <div class="a-kv"><span>Wallet Balance</span><strong>${escapeHtml(String(selectedAsset.walletBalance ?? "—"))}</strong></div>
      <div class="a-kv"><span>Quote USD</span><strong>$${escapeHtml(String(selectedAsset.walletQuoteUsd ?? "—"))}</strong></div>
      ${selectedAsset.reason ? `<div class="a-kv"><span>Reason</span><strong style="font-size:10px;color:var(--muted);max-width:160px;white-space:normal;">${escapeHtml(selectedAsset.reason)}</strong></div>` : ""}
    </div>
    <div class="a-card">
      <h2 data-i18n="执行状态">Execution State</h2>
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
    <h2 data-i18n="接收者列表 (前 ${Math.min(20, recipients.length)} / 共 ${recipients.length})">Recipient List (top ${Math.min(20, recipients.length)} of ${recipients.length})</h2>
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
    <h2 data-i18n="分配账本 (最近 ${Math.min(15, ledgerRecords.length)} 条记录)">Distribution Ledger (last ${Math.min(15, ledgerRecords.length)} records)</h2>
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

  <div class="a-footer" data-i18n="elizaOK · 由 elizaOS 驱动 · BNB Chain 空投飞轮">elizaOK · Powered by elizaOS · Airdrop flywheel on BNB Chain</div>
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

var _airI18n = {
  'Airdrop Eligibility': '空投资格',
  'Distribution Pool': '分配池',
  'treasury allocation': '国库分配',
  'Eligible Holders': '合格持有者',
  'qualified $elizaOK wallets': '合格 $elizaOK 钱包',
  'Executed Sends': '已执行发送',
  'this cycle': '本周期',
  'Dry Run Count': '模拟次数',
  'simulated sends': '模拟发送',
  'Portfolio Value': '投资组合价值',
  'gross treasury': '国库总值',
  'Recipients in Plan': '计划中接收者',
  'snapshot recipients': '快照接收者',
  'Check Wallet Eligibility': '检查钱包资格',
  'Check': '检查',
  'Airdrop Asset': '空投资产',
  'Execution State': '执行状态',
  'Recipient List': '接收者列表',
  'Distribution Ledger': '分配账本',
  'No recipients in current distribution plan.': '当前分配计划中没有接收者。',
  'No ledger records yet.': '暂无账本记录。',
  'Home': '首页',
  'Dashboard': '仪表盘',
  'Docs': '文档',
  'Airdrop': '空投',
  'Goo': '竞技场',
  'Connect Cloud': '连接云端',
  'Mode': '模式',
  'Token': '代币',
  'Total Amount': '总数量',
  'Wallet Balance': '钱包余额',
  'Quote USD': '报价 USD',
  'Reason': '原因',
  'Enabled': '已启用',
  'Max/Run': '每次最大',
  'Wallet': '钱包',
  'Next Action': '下一步操作',
  'NO': '否',
  'YES': '是',
  'Dry Run': '模拟运行',
  'Address': '地址',
  'Balance': '余额',
  'Share': '份额',
  'Type': '类型',
  'Amount': '数量',
  'Status': '状态',
  'Time': '时间',
  'STANDBY': '待机中',
  'none': '无',
  'Last scan:': '上次扫描：',
};
var _airLangActive = false;
var _airI18nLong = {
  'Distribution planning is disabled': '分配计划已禁用。请启用并提供持有者代币或快照来构建空投清单。',
  'No treasury position passed': '没有国库仓位通过当前分配资产策略。',
  'No recipients in current': '当前分配计划中没有接收者。',
  'No ledger records yet': '暂无账本记录。',
  'No distribution plan loaded': '尚未加载分配计划。代理尚未运行分配扫描。',
  'Enable ELIZAOK_DISTRIBUTION': '启用 ELIZAOK_DISTRIBUTION_EXECUTION_ENABLED 环境变量。',
  'This wallet is not in': '✗ 此钱包不在当前空投计划中。资格基于快照时的 $elizaOK 持有门槛。',
  'paper-only position': '仅模拟仓位',
  'wallet verification is unverified': '钱包验证未通过',
  'wallet balance is empty': '钱包余额为空',
  'wallet quote is unavailable': '钱包报价不可用',
  'unrealized PnL': '未实现盈亏',
  'is not positive': '非正值',
  'below 10 USD': '低于 10 美元',
  'Recipient List': '接收者列表',
  'Distribution Ledger': '分配账本',
  'Airdrop Eligibility': '空投资格',
  'The treasury flywheel': '国库飞轮将收益分配给合格的 $elizaOK 持有者。检查您的钱包是否有资格参与当前空投周期并查看分配计划。',
  'Last scan': '上次扫描',
};
window.airToggleLang = function() {
  _airLangActive = !_airLangActive;
  var btn = document.getElementById('airdrop-lang-toggle');
  if (btn) btn.textContent = _airLangActive ? 'EN' : '中';
  document.querySelectorAll('.a-wrap [data-i18n]').forEach(function(el){
    if (_airLangActive) { el.setAttribute('data-orig', el.textContent); el.textContent = el.getAttribute('data-i18n'); }
    else if (el.getAttribute('data-orig')) { el.textContent = el.getAttribute('data-orig'); el.removeAttribute('data-orig'); }
  });
  var allText = document.querySelectorAll('.a-wrap *:not(script):not(style):not([data-i18n])');
  for (var i = 0; i < allText.length; i++) {
    var el = allText[i];
    if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'IMG') continue;
    var hasKids = false;
    for (var c = 0; c < el.children.length; c++) { if (el.children[c].tagName !== 'IMG' && el.children[c].tagName !== 'SPAN' && el.children[c].tagName !== 'STRONG' && el.children[c].tagName !== 'BR') { hasKids = true; break; } }
    if (hasKids) continue;
    var textNodes = [];
    el.childNodes.forEach(function(n){ if (n.nodeType === 3 && n.textContent.trim()) textNodes.push(n); });
    if (textNodes.length === 0) continue;
    var txt = el.textContent.trim();
    if (_airLangActive) {
      if (_airI18n[txt]) { el.setAttribute('data-orig-html', el.innerHTML); el.textContent = _airI18n[txt]; continue; }
      for (var key in _airI18nLong) {
        if (txt.indexOf(key) !== -1 && !el.getAttribute('data-orig-html')) {
          el.setAttribute('data-orig-html', el.innerHTML);
          el.textContent = _airI18nLong[key];
          break;
        }
      }
    } else if (!_airLangActive && el.getAttribute('data-orig-html')) {
      el.innerHTML = el.getAttribute('data-orig-html');
      el.removeAttribute('data-orig-html');
    }
  }
};

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
    el.innerHTML='✗ This wallet is not in the current airdrop plan. Eligibility is based on $elizaOK holding thresholds at snapshot time.';
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

function renderGooPaperPage(
  agents: GooPaperAgent[],
  summary: import("./goo-paper-engine").GooPaperSummary | null,
): string {
  const s = summary ?? { totalAgents: 0, activeAgents: 0, starvingAgents: 0, dyingAgents: 0, deadAgents: 0, acquiredAgents: 0, totalPnlUsd: 0, bestAgent: null, worstAgent: null, averageWinRate: 0, totalTrades: 0, flywheelTotals: { totalProfitBnb: 0, reinvestedBnb: 0, elizaOKBoughtBnb: 0, airdropReservedBnb: 0 } };
  const fw = s.flywheelTotals ?? { totalProfitBnb: 0, reinvestedBnb: 0, elizaOKBoughtBnb: 0, airdropReservedBnb: 0 };
  const fmtBnb = (v: number) => v.toFixed(4);
  const pnlClass = s.totalPnlUsd >= 0 ? 'goo-pnl--pos' : 'goo-pnl--neg';
  const pnlSign = s.totalPnlUsd >= 0 ? '+' : '';
  const fmtUsd = (v: number) => `$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const statusBadge = (state: string) => {
    const cls: Record<string, string> = { active: 'goo-badge--active', starving: 'goo-badge--starving', dying: 'goo-badge--dying', dead: 'goo-badge--dead' };
    return `<span class="goo-badge ${cls[state] || ''}">${state.toUpperCase()}</span>`;
  };

  const agentRows = agents.map((a, i) => {
    const pnl = a.totalPnlUsd;
    const pnlCls = pnl >= 0 ? 'goo-pnl--pos' : 'goo-pnl--neg';
    const activePos = a.positions.filter(p => p.state === 'active').length;
    return `
    <div class="goo-agent-row" style="animation-delay:${i * 0.04}s" data-id="${escapeHtml(a.id)}" onclick="window.location='/goo/agent/${escapeHtml(a.id)}'">
      <span class="goo-rank-badge">#${i + 1}</span>
      <div class="goo-agent-avatar"><img src="/assets/goo-economy-logo.png" alt="Goo" /></div>
      <div class="goo-agent-row__dot goo-dot--${a.chainState}"></div>
      <div class="goo-agent-row__main">
        <div class="goo-agent-row__title">
          <span class="goo-agent-row__symbol">${escapeHtml(a.tokenSymbol)}</span>
          <span class="goo-agent-row__name">${escapeHtml(a.agentName)}</span>
          ${statusBadge(a.chainState)}
          <span class="goo-badge goo-badge--strategy">${escapeHtml(a.strategy.label)}</span>
          ${a.acquiredByElizaOK ? '<span class="goo-badge goo-badge--acquired">ACQUIRED</span>' : ''}
        </div>
        <div class="goo-agent-row__meta">
          <span>Treasury: ${a.treasuryBnb.toFixed(4)} BNB</span>
          <span class="goo-sep">&middot;</span>
          <span>Positions: ${activePos}</span>
          <span class="goo-sep">&middot;</span>
          <span>Trades: ${a.totalTradesCount}</span>
          <span class="goo-sep">&middot;</span>
          <span>Win: ${a.winRate.toFixed(1)}%</span>
        </div>
      </div>
      <div class="goo-agent-row__metrics">
        <div class="goo-agent-row__pnl ${pnlCls}">${pnl >= 0 ? '+' : ''}${fmtUsd(pnl)}</div>
        <div class="goo-agent-row__score">Score: ${a.acquisitionScore}</div>
      </div>
      <div class="goo-agent-row__actions">
        ${!a.acquiredByElizaOK && a.chainState !== 'dead' && a.acquisitionScore >= 30
          ? `<button class="goo-btn goo-btn--acquire" onclick="acquireAgent('${escapeHtml(a.id)}')">CTO Acquire</button>`
          : a.acquiredByElizaOK
            ? '<span class="goo-acquired-label">&#x2714; Merged</span>'
            : ''}
      </div>
    </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Goo Economy Arena | elizaOK</title>
<link rel="icon" type="image/png" href="/assets/avatar.png" />
<link rel="apple-touch-icon" href="/assets/avatar.png" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
:root{
  --goo-brand:#00C7D2;--goo-brand-bg:#e6fafb;
  --goo-warn:#ca8a04;--goo-warn-bg:#fef9c3;
  --goo-dying:#ea580c;--goo-dying-bg:#ffedd5;
  --goo-dead:#D1D5DB;--goo-dead-bg:#F9FAFB;
  --goo-pos:#10b981;--goo-neg:#ef4444;
  --goo-bg:#f8f8f7;--goo-surface:#fff;--goo-border:#ebebeb;
  --goo-text:#000;--goo-text2:#4D4D4D;--goo-text3:#808080;
  --goo-r:16px;--goo-r-sm:8px;
  font-family:'Inter',system-ui,sans-serif;
}
html,body{min-height:100%;background:var(--goo-bg);color:var(--goo-text);-webkit-overflow-scrolling:touch;overscroll-behavior-y:contain;}
html{scrollbar-width:none;}html::-webkit-scrollbar{display:none;}
[data-theme="dark"]{
  --goo-brand:#00C7D2;--goo-brand-bg:rgba(0,199,210,.12);
  --goo-warn:#eab308;--goo-warn-bg:rgba(234,179,8,.1);
  --goo-dying:#ea580c;--goo-dying-bg:rgba(234,88,12,.1);
  --goo-dead:#6b7280;--goo-dead-bg:rgba(107,114,128,.12);
  --goo-pos:#34d399;--goo-neg:#f87171;
  --goo-bg:#0a0a0a;--goo-surface:rgba(22,22,20,.95);--goo-border:rgba(255,255,255,.08);
  --goo-text:#e5e5e5;--goo-text2:#a3a3a3;--goo-text3:#737373;
}
[data-theme="dark"] .goo-badge--strategy{background:rgba(99,102,241,.15);color:#a5b4fc;}
[data-theme="dark"] .goo-badge--acquired{background:rgba(34,197,94,.12);color:#86efac;}
@keyframes fadeIn{from{opacity:0;transform:translateY(12px);}to{opacity:1;transform:translateY(0);}}
@keyframes slideUp{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:translateY(0);}}
@keyframes dotPulse{0%,100%{box-shadow:0 0 0 0 rgba(0,199,210,.3);}50%{box-shadow:0 0 0 6px rgba(0,199,210,0);}}
@keyframes badgeGlow{0%,100%{box-shadow:0 0 4px rgba(0,199,210,.15);}50%{box-shadow:0 0 10px rgba(0,199,210,.3);}}

.goo-wrap{max-width:1100px;margin:0 auto;padding:32px 24px 64px;animation:fadeIn .5s ease-out;}
.goo-topbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:28px;flex-wrap:wrap;gap:12px;}
.goo-topbar__left{display:flex;align-items:center;gap:14px;}
.goo-topbar__logo{font-size:20px;font-weight:700;color:var(--goo-brand);letter-spacing:.02em;text-decoration:none;display:flex;align-items:center;gap:10px;}
.goo-topbar__logo img{width:34px;height:34px;border-radius:50%;border:2px solid rgba(0,199,210,.3);object-fit:cover;}
.goo-collab{display:flex;align-items:center;gap:8px;}
.goo-collab__x{font-size:14px;font-weight:700;color:var(--goo-text3);opacity:.5;}
.goo-topbar__sub{font-size:12px;color:var(--goo-text3);font-weight:400;}
.goo-nav{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
.goo-nav a{color:var(--goo-text3);font-size:12px;font-weight:500;text-decoration:none;padding:6px 14px;border:1px solid var(--goo-border);border-radius:var(--goo-r-sm);transition:all .2s;}
.goo-nav a:hover{color:var(--goo-brand);border-color:var(--goo-brand);}
.goo-nav a.active{color:var(--goo-brand);border-color:var(--goo-brand);background:var(--goo-brand-bg);}

/* Stats */
.goo-stats{display:grid;grid-template-columns:repeat(6,1fr);gap:0;border:1px solid var(--goo-border);border-radius:var(--goo-r);overflow:hidden;margin-bottom:20px;background:var(--goo-surface);animation:slideUp .4s ease-out .1s both;}
.goo-stat{padding:18px 14px;text-align:center;border-right:1px solid var(--goo-border);transition:background .2s;}
.goo-stat:last-child{border-right:none;}
.goo-stat:hover{background:rgba(0,199,210,.03);}
.goo-stat__label{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--goo-text3);margin-bottom:6px;}
.goo-stat__value{font-size:22px;font-weight:700;line-height:1;transition:transform .2s;}
.goo-stat:hover .goo-stat__value{transform:scale(1.05);}
.goo-stat__value--brand{color:var(--goo-brand);}

/* P&L */
.goo-pnl--pos{color:var(--goo-pos);}
.goo-pnl--neg{color:var(--goo-neg);}

/* Badges */
.goo-badge{display:inline-block;font-size:10px;font-weight:600;padding:2px 8px;border-radius:6px;text-transform:uppercase;letter-spacing:.04em;vertical-align:middle;}
.goo-badge--active{background:var(--goo-brand-bg);color:var(--goo-brand);animation:badgeGlow 2s ease-in-out infinite;}
.goo-badge--starving{background:var(--goo-warn-bg);color:var(--goo-warn);}
.goo-badge--dying{background:var(--goo-dying-bg);color:var(--goo-dying);}
.goo-badge--dead{background:var(--goo-dead-bg);color:var(--goo-dead);}
.goo-badge--strategy{background:#eef2ff;color:#4338ca;font-size:9px;}
.goo-badge--acquired{background:#dcfce7;color:#16a34a;font-size:9px;}

/* Agent list */
.goo-card{background:var(--goo-surface);border:1px solid var(--goo-border);border-radius:var(--goo-r);overflow:hidden;margin-bottom:16px;animation:slideUp .4s ease-out .2s both;}
.goo-card__head{padding:14px 20px;border-bottom:1px solid var(--goo-border);display:flex;align-items:center;justify-content:space-between;}
.goo-card__head h2{font-size:14px;font-weight:700;color:var(--goo-text);}
.goo-card__head-count{font-size:12px;color:var(--goo-text3);}

.goo-agent-row{display:flex;align-items:center;gap:14px;padding:14px 20px;border-bottom:1px solid var(--goo-border);transition:all .4s ease;cursor:pointer;animation:slideUp .3s ease-out both;}
.goo-rank-badge{font-size:10px;font-weight:700;color:var(--goo-text3);min-width:26px;text-align:center;opacity:.6;transition:color .3s;}
.goo-agent-row:first-child .goo-rank-badge{color:var(--goo-brand);opacity:1;}
.goo-agent-row:last-child{border-bottom:none;}
.goo-agent-row:hover{background:rgba(0,199,210,.02);}

.goo-agent-avatar{position:relative;width:26px;height:26px;flex-shrink:0;}
.goo-agent-avatar img{width:26px;height:26px;border-radius:50%;object-fit:cover;position:relative;z-index:1;}
.goo-agent-avatar::before{content:'';position:absolute;inset:-2px;border-radius:50%;background:conic-gradient(from 0deg,#00C7D2,#8b5cf6,#00C7D2);animation:gooAvatarSpin 3s linear infinite;opacity:.6;z-index:0;filter:blur(2px);}
.goo-agent-avatar::after{content:'';position:absolute;inset:-5px;border-radius:50%;background:radial-gradient(circle,rgba(0,199,210,.2) 0%,transparent 70%);animation:gooAvatarPulse 2s ease-in-out infinite;z-index:0;}
@keyframes gooAvatarSpin{to{transform:rotate(360deg)}}
@keyframes gooAvatarPulse{0%,100%{opacity:.3;transform:scale(1)}50%{opacity:.7;transform:scale(1.12)}}
.goo-agent-row__dot{width:10px;height:10px;border-radius:50%;flex-shrink:0;}
.goo-dot--active{background:var(--goo-brand);animation:dotPulse 2s ease-in-out infinite;}
.goo-dot--starving{background:var(--goo-warn);}
.goo-dot--dying{background:var(--goo-dying);}
.goo-dot--dead{background:var(--goo-dead);}

.goo-agent-row__main{flex:1;min-width:0;}
.goo-agent-row__title{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px;}
.goo-agent-row__symbol{font-size:14px;font-weight:700;color:var(--goo-brand);}
.goo-agent-row__name{font-size:13px;font-weight:600;color:var(--goo-text);}
.goo-agent-row__meta{font-size:11px;color:var(--goo-text3);display:flex;gap:4px;flex-wrap:wrap;}
.goo-sep{opacity:.4;}

.goo-agent-row__metrics{text-align:right;flex-shrink:0;min-width:100px;}
.goo-agent-row__pnl{font-size:15px;font-weight:700;}
.goo-agent-row__score{font-size:10px;color:var(--goo-text3);margin-top:2px;}

.goo-agent-row__actions{flex-shrink:0;min-width:100px;text-align:right;}

/* Buttons */
.goo-btn{display:inline-flex;align-items:center;height:30px;padding:0 14px;border:1px solid var(--goo-border);border-radius:var(--goo-r-sm);background:transparent;color:var(--goo-text3);font-family:inherit;font-size:11px;font-weight:600;letter-spacing:.03em;cursor:pointer;transition:all .2s;}
.goo-btn:hover{border-color:var(--goo-brand);color:var(--goo-brand);}
.goo-btn--acquire{border-color:var(--goo-brand);color:var(--goo-brand);background:var(--goo-brand-bg);}
.goo-btn--acquire:hover{background:var(--goo-brand);color:#fff;box-shadow:0 0 14px rgba(0,199,210,.3);}
.goo-btn--spawn{border-color:var(--goo-brand);color:#fff;background:var(--goo-brand);font-size:12px;height:34px;padding:0 18px;border-radius:var(--goo-r-sm);}
.goo-btn--spawn:hover{box-shadow:0 0 16px rgba(0,199,210,.35);transform:translateY(-1px);}
.goo-acquired-label{font-size:11px;color:var(--goo-pos);font-weight:600;}

/* Filter */
.goo-filters{display:flex;gap:6px;padding:12px 20px;border-bottom:1px solid var(--goo-border);flex-wrap:wrap;}
.goo-filter{font-size:11px;padding:4px 12px;border:1px solid var(--goo-border);border-radius:20px;color:var(--goo-text3);cursor:pointer;transition:all .2s;background:transparent;font-family:inherit;}
.goo-filter:hover,.goo-filter.active{border-color:var(--goo-brand);color:var(--goo-brand);background:rgba(0,199,210,.05);}

.goo-footer{text-align:center;font-size:11px;color:var(--goo-text3);margin-top:32px;}
.goo-footer a{color:var(--goo-brand);text-decoration:none;}
.goo-footer a:hover{text-decoration:underline;}

/* Flywheel */
.goo-flywheel{background:var(--goo-surface);border:1px solid var(--goo-border);border-radius:var(--goo-r);overflow:hidden;margin-bottom:16px;padding:20px;}
.goo-flywheel__head{display:flex;align-items:center;gap:12px;margin-bottom:16px;}
.goo-flywheel__icon{font-size:24px;width:44px;height:44px;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,rgba(0,199,210,.12),rgba(139,92,246,.12));border-radius:12px;animation:spin 6s linear infinite;}
@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
.goo-flywheel__title{font-size:14px;font-weight:700;color:var(--goo-text);}
.goo-flywheel__sub{font-size:11px;color:var(--goo-text3);margin-top:2px;}
.goo-flywheel__grid{display:flex;align-items:center;gap:0;justify-content:center;}
.goo-flywheel__cell{text-align:center;flex:1;padding:12px 8px;border-radius:var(--goo-r-sm);transition:background .2s;}
.goo-flywheel__cell:hover{background:rgba(0,199,210,.04);}
.goo-flywheel__cell--arrow{flex:0 0 30px;font-size:18px;color:var(--goo-text3);opacity:.4;}
.goo-flywheel__label{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--goo-text3);margin-bottom:4px;}
.goo-flywheel__val{font-size:16px;font-weight:700;}

.goo-empty{padding:48px 20px;text-align:center;color:var(--goo-text3);}
.goo-empty__icon{font-size:36px;margin-bottom:12px;opacity:.4;}
.goo-empty__text{font-size:13px;margin-bottom:16px;}

@media(max-width:768px){
  .goo-stats{grid-template-columns:repeat(3,1fr);gap:8px;}
  .goo-agent-row{flex-wrap:wrap;gap:8px;padding:14px;}
  .goo-agent-row__metrics,.goo-agent-row__actions{width:100%;text-align:left;}
  .goo-topbar{flex-direction:column;align-items:flex-start;gap:10px;padding:12px 16px;}
  .goo-nav{flex-wrap:wrap;gap:4px;justify-content:flex-start;}
  .goo-nav a{font-size:10px;padding:5px 10px;border-radius:6px;}
  .goo-flywheel{padding:14px;}
  .goo-flywheel__grid{flex-direction:column;gap:0;}
  .goo-flywheel__cell{padding:8px 12px;text-align:left;display:flex;align-items:center;gap:10px;}
  .goo-flywheel__cell--arrow{transform:rotate(90deg);flex:0 0 20px;font-size:14px;padding:0;text-align:center;justify-content:center;}
  .goo-flywheel__label{margin-bottom:0;min-width:100px;}
  .goo-flywheel__val{font-size:14px;}
  .goo-flywheel__head{gap:10px;}
  .goo-flywheel__icon{width:36px;height:36px;font-size:18px;}
  .goo-flywheel__title{font-size:13px;}
  .goo-flywheel__sub{font-size:9px;}
}
@media(max-width:480px){
  .goo-stats{grid-template-columns:repeat(2,1fr);gap:6px;}
  .goo-stat{padding:12px 10px;}
  .goo-stat__val{font-size:18px;}
  .goo-stat__label{font-size:8px;}
  .goo-wrap{padding:12px 10px 40px;}
  .goo-topbar{padding:10px 12px;gap:8px;}
  .goo-topbar__logo{font-size:14px;gap:8px;}
  .goo-topbar__logo img{width:24px;height:24px;}
  .goo-topbar__sub{font-size:8px;display:none;}
  .goo-nav{gap:3px;}
  .goo-nav a{font-size:9px;padding:4px 8px;}
  .goo-agent-row{padding:10px;border-radius:10px;}
  .goo-agent-row__rank{font-size:12px;min-width:22px;}
  .goo-agent-row__ticker{font-size:10px;}
  .goo-agent-row__name{font-size:11px;}
  .goo-agent-row__badge{font-size:7px;padding:2px 6px;}
  .goo-agent-row__strat{font-size:9px;}
  .goo-agent-row__detail{font-size:9px;}
  .goo-agent-row__pnl{font-size:12px;}
  .goo-agent-row__score{font-size:11px;}
  .goo-filters{gap:3px;flex-wrap:wrap;}
  .goo-filter{font-size:8px;padding:3px 7px;}
  .goo-section-title{font-size:11px;}
  .goo-btn{font-size:9px;height:24px;padding:0 8px;}
  .goo-flywheel{padding:10px;}
  .goo-flywheel__label{font-size:9px;min-width:80px;}
  .goo-flywheel__val{font-size:12px;}
}
</style>
</head>
<body>
<div class="goo-wrap">
  <div class="goo-topbar">
    <div class="goo-topbar__left">
      <a class="goo-topbar__logo" href="/goo">
        <span class="goo-collab">
          <img src="/assets/avatar.png" alt="elizaOK" />
          <span class="goo-collab__x">×</span>
          <img src="/assets/goo-economy-logo.png" alt="Goo Economy" />
        </span>
        Goo Economy Arena
      </a>
      <span class="goo-topbar__sub">Strategy Arena · elizaOK</span>
    </div>
    <nav class="goo-nav">
      <a href="/">Home</a>
      <a href="/dashboard">Dashboard</a>
      <a href="/backtest">Backtest</a>
      <a href="/goo" class="active">Goo Economy Arena</a>
      <a href="/docs">Docs</a>
      <span style="width:1px;height:20px;background:var(--goo-border);margin:0 2px"></span>
      <a href="#" id="goo-lang-toggle" onclick="toggleGooLang();return false;" data-i18n-skip>EN/中文</a>
      <a href="#" id="goo-theme-toggle" onclick="toggleGooTheme();return false;" data-i18n-skip>&#x1F319;</a>
    </nav>
  </div>

  <div class="goo-stats">
    <div class="goo-stat">
      <div class="goo-stat__label">Total Agents</div>
      <div class="goo-stat__value goo-stat__value--brand">${s.totalAgents}</div>
    </div>
    <div class="goo-stat">
      <div class="goo-stat__label">Active</div>
      <div class="goo-stat__value" style="color:var(--goo-brand)">${s.activeAgents}</div>
    </div>
    <div class="goo-stat">
      <div class="goo-stat__label">Starving</div>
      <div class="goo-stat__value" style="color:var(--goo-warn)">${s.starvingAgents}</div>
    </div>
    <div class="goo-stat">
      <div class="goo-stat__label">Total P&L</div>
      <div class="goo-stat__value ${pnlClass}">${pnlSign}${fmtUsd(s.totalPnlUsd)}</div>
    </div>
    <div class="goo-stat">
      <div class="goo-stat__label">Avg Win Rate</div>
      <div class="goo-stat__value">${s.averageWinRate.toFixed(1)}%</div>
    </div>
    <div class="goo-stat">
      <div class="goo-stat__label">Acquired</div>
      <div class="goo-stat__value" style="color:var(--goo-pos)">${s.acquiredAgents}</div>
    </div>
  </div>

  <!-- Flywheel Section -->
  <div class="goo-flywheel" style="animation:slideUp .4s ease-out .15s both;">
    <div class="goo-flywheel__head">
      <div class="goo-flywheel__icon">&#x1F504;</div>
      <div>
        <div class="goo-flywheel__title">Revenue Flywheel</div>
        <div class="goo-flywheel__sub">Profit &rarr; Reinvest 70% &rarr; $elizaOK 15% &rarr; Airdrop Reserve 15%</div>
      </div>
    </div>
    <div class="goo-flywheel__grid">
      <div class="goo-flywheel__cell">
        <div class="goo-flywheel__label">Total Profit</div>
        <div class="goo-flywheel__val goo-pnl--pos">${fmtBnb(fw.totalProfitBnb)} BNB</div>
      </div>
      <div class="goo-flywheel__cell goo-flywheel__cell--arrow">&#x27A1;</div>
      <div class="goo-flywheel__cell">
        <div class="goo-flywheel__label">Reinvested</div>
        <div class="goo-flywheel__val" style="color:var(--goo-brand)">${fmtBnb(fw.reinvestedBnb)} BNB</div>
      </div>
      <div class="goo-flywheel__cell goo-flywheel__cell--arrow">&#x27A1;</div>
      <div class="goo-flywheel__cell">
        <div class="goo-flywheel__label">$elizaOK Buyback</div>
        <div class="goo-flywheel__val" style="color:#8b5cf6">${fmtBnb(fw.elizaOKBoughtBnb)} BNB</div>
      </div>
      <div class="goo-flywheel__cell goo-flywheel__cell--arrow">&#x27A1;</div>
      <div class="goo-flywheel__cell">
        <div class="goo-flywheel__label">Airdrop Reserve</div>
        <div class="goo-flywheel__val" style="color:#f59e0b">${fmtBnb(fw.airdropReservedBnb)} BNB</div>
      </div>
    </div>
  </div>

  <div class="goo-card">
    <div class="goo-card__head">
      <h2>Agent Fleet</h2>
      <div style="display:flex;gap:10px;align-items:center">
        <span class="goo-card__head-count">${agents.length} agents</span>
        <a class="goo-btn" href="/goo/compare" style="font-size:11px;text-decoration:none;border:1px solid var(--goo-border);border-radius:8px;padding:6px 12px;color:var(--goo-text)">Compare</a>
      </div>
    </div>
    <div class="goo-filters">
      <button class="goo-filter active" onclick="filterAgents('all',this)">All <span style="opacity:.5">${agents.length}</span></button>
      <button class="goo-filter" onclick="filterAgents('active',this)">Active <span style="opacity:.5">${s.activeAgents}</span></button>
      <button class="goo-filter" onclick="filterAgents('starving',this)">Starving <span style="opacity:.5">${s.starvingAgents}</span></button>
      <button class="goo-filter" onclick="filterAgents('dying',this)">Dying <span style="opacity:.5">${s.dyingAgents}</span></button>
      <button class="goo-filter" onclick="filterAgents('dead',this)">Dead <span style="opacity:.5">${s.deadAgents}</span></button>
      <button class="goo-filter" onclick="filterAgents('acquired',this)">Acquired <span style="opacity:.5">${s.acquiredAgents}</span></button>
    </div>
    ${agents.length > 0 ? agentRows : `
    <div class="goo-empty">
      <div class="goo-empty__icon"><img src="/assets/goo-economy-logo.png" alt="Goo" style="width:32px;height:32px;border-radius:50%" /></div>
      <div class="goo-empty__text">No agents active yet. The system will auto-spawn agents when ready.</div>
    </div>`}
  </div>

  <div class="goo-footer">
    Powered by <a href="https://github.com/HertzFlow/goo-launch" target="_blank">Goo Economy</a> &middot; elizaOK Economy Arena &middot; Paper Run Mode
  </div>
</div>

<script>
function filterAgents(status, btn) {
  document.querySelectorAll('.goo-filter').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.goo-agent-row').forEach(row => {
    const dot = row.querySelector('.goo-agent-row__dot');
    const isAcquired = row.innerHTML.includes('ACQUIRED');
    if (status === 'all') { row.style.display = ''; return; }
    if (status === 'acquired') { row.style.display = isAcquired ? '' : 'none'; return; }
    const match = dot && dot.classList.contains('goo-dot--' + status);
    row.style.display = match ? '' : 'none';
  });
}

function spawnAgent() {
  var strategies = ['conservative','balanced','aggressive','kol_follower','holder_watcher','momentum','contrarian','sniper'];
  var pick = strategies[Math.floor(Math.random() * strategies.length)];
  fetch('/api/goo/agents/spawn', {
    method: 'POST',
    headers: {'content-type':'application/json'},
    body: JSON.stringify({ strategy: pick, treasury: 1.0 })
  }).then(function() { window.location.reload(); });
}

function spawnFleet() {
  var strategies = ['conservative','balanced','aggressive','kol_follower','holder_watcher','momentum','contrarian','sniper'];
  var chain = Promise.resolve();
  strategies.forEach(function(s) {
    chain = chain.then(function() {
      return fetch('/api/goo/agents/spawn', {
        method: 'POST',
        headers: {'content-type':'application/json'},
        body: JSON.stringify({ strategy: s, treasury: 1.0 })
      });
    });
  });
  chain.then(function() { window.location.reload(); });
}

function acquireAgent(id) {
  if (!confirm('Acquire this agent? elizaOK will absorb its trading strategy and become stronger.')) return;
  fetch('/api/goo/agents/' + encodeURIComponent(id) + '/acquire', {
    method: 'POST',
    headers: {'content-type':'application/json'}
  }).then(function(r) { return r.json(); }).then(function(data) {
    if (data.absorption && data.absorption.parameterChanges.length > 0) {
      var msg = 'Strategy absorbed! Changes:\\n';
      data.absorption.parameterChanges.forEach(function(c) {
        msg += '  ' + c.param + ': ' + c.before + ' → ' + c.after + '\\n';
      });
      msg += '\\nTotal strategies absorbed: ' + data.absorption.totalAbsorbed;
      alert(msg);
    }
    window.location.reload();
  });
}

// Live ranking animation — periodically re-sort agent rows by P&L
(function(){
  var prevOrder = [];
  document.querySelectorAll('.goo-agent-row').forEach(function(r){ prevOrder.push(r.dataset.id); });

  function liveRefreshRanking() {
    fetch('/api/goo/agents').then(function(r){return r.json();}).then(function(d) {
      if (!d.agents) return;
      var sorted = d.agents.slice().sort(function(a,b){ return b.totalPnlUsd - a.totalPnlUsd; });
      var newOrder = sorted.map(function(a){ return a.id; });
      var changed = false;
      for (var i = 0; i < newOrder.length; i++) { if (newOrder[i] !== prevOrder[i]) { changed = true; break; } }
      if (!changed) return;
      prevOrder = newOrder;
      var container = document.querySelector('.goo-agent-row')?.parentNode;
      if (!container) return;
      var rows = {};
      container.querySelectorAll('.goo-agent-row').forEach(function(r) { rows[r.dataset.id] = r; });
      newOrder.forEach(function(id, idx) {
        var row = rows[id];
        if (!row) return;
        row.style.transition = 'transform 0.5s ease, opacity 0.3s';
        row.style.transform = 'translateY(0)';
        container.appendChild(row);
        var rankBadge = row.querySelector('.goo-rank-badge');
        if (rankBadge) rankBadge.textContent = '#' + (idx + 1);
      });
    }).catch(function(){});
  }
  setInterval(liveRefreshRanking, 20000);
})();

// ── Dark Mode Toggle ──
function toggleGooTheme() {
  var d = document.documentElement;
  var isDark = d.getAttribute('data-theme') === 'dark';
  d.setAttribute('data-theme', isDark ? '' : 'dark');
  localStorage.setItem('goo-theme', isDark ? 'light' : 'dark');
  var btn = document.getElementById('goo-theme-toggle');
  if (btn) btn.textContent = isDark ? '\u{1F319}' : '\u2600\uFE0F';
}
(function() {
  var saved = localStorage.getItem('goo-theme');
  if (saved === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
    var btn = document.getElementById('goo-theme-toggle');
    if (btn) btn.textContent = '\u2600\uFE0F';
  }
})();

// ── Goo i18n ──
var _gooI18n = {
  'Goo Economy Arena': '\u7ADE\u6280\u573A',
  'Strategy Arena · elizaOK': '\u7B56\u7565\u7ADE\u6280\u573A \u00B7 elizaOK',
  'Home': '\u9996\u9875', 'Dashboard': '\u4EEA\u8868\u76D8', 'Docs': '\u6587\u6863',
  'Total Agents': '\u603B\u4EE3\u7406\u6570', 'Active': '\u6D3B\u8DC3', 'Starving': '\u9965\u997F',
  'Total P&L': '\u603B\u76C8\u4E8F', 'Avg Win Rate': '\u5E73\u5747\u80DC\u7387', 'Acquired': '\u5DF2\u6536\u8D2D',
  'Revenue Flywheel': '\u6536\u76CA\u98DE\u8F6E',
  'Total Profit': '\u603B\u5229\u6DA6', 'Reinvested': '\u518D\u6295\u8D44',
  '$elizaOK Buyback': '$elizaOK \u56DE\u8D2D', 'Airdrop Reserve': '\u7A7A\u6295\u50A8\u5907',
  'Agent Fleet': '\u4EE3\u7406\u8239\u961F', 'agents': '\u4E2A\u4EE3\u7406',
  'Compare': '\u5BF9\u6BD4', '+ Launch Agent': '+ \u53D1\u5C04\u4EE3\u7406',
  'All': '\u5168\u90E8', 'Dying': '\u6FC0\u6D3B\u4E2D', 'Dead': '\u6B7B\u4EA1',
  'Treasury:': '\u8D44\u91D1:', 'Positions:': '\u4ED3\u4F4D:', 'Trades:': '\u4EA4\u6613:', 'Win:': '\u80DC\u7387:',
  'Score:': '\u5206\u6570:', 'CTO Acquire': 'CTO \u6536\u8D2D',
  'Powered by': '\u9A71\u52A8\u4E8E', 'Paper Run Mode': '\u6A21\u62DF\u6A21\u5F0F',
  'Launch Default Fleet (8 Agents)': '\u53D1\u5C04\u9ED8\u8BA4\u8239\u961F (8 \u4E2A\u4EE3\u7406)',
  'No agents spawned yet. Launch your first agent fleet to start the competition.': '\u8FD8\u6CA1\u6709\u4EE3\u7406\u3002\u53D1\u5C04\u4F60\u7684\u7B2C\u4E00\u652F\u4EE3\u7406\u8239\u961F\u5F00\u59CB\u7ADE\u6280\u3002',
};
var _gooLangActive = localStorage.getItem('goo-lang') || 'en';
function toggleGooLang() {
  _gooLangActive = _gooLangActive === 'en' ? 'zh' : 'en';
  localStorage.setItem('goo-lang', _gooLangActive);
  applyGooLang();
}
function applyGooLang() {
  var btn = document.getElementById('goo-lang-toggle');
  if (btn) btn.textContent = _gooLangActive === 'zh' ? 'EN' : '\u4E2D\u6587';
  var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
  var node;
  while (node = walker.nextNode()) {
    if (node.parentElement && node.parentElement.hasAttribute('data-i18n-skip')) continue;
    var txt = node.textContent.trim();
    if (!txt) continue;
    if (_gooLangActive === 'zh') {
      if (!node._origGoo) node._origGoo = node.textContent;
      for (var k in _gooI18n) {
        if (txt === k || txt.indexOf(k) >= 0) {
          node.textContent = node.textContent.replace(k, _gooI18n[k]);
          break;
        }
      }
    } else {
      if (node._origGoo) node.textContent = node._origGoo;
    }
  }
}
if (_gooLangActive === 'zh') { setTimeout(applyGooLang, 50); }
</script>
</body>
</html>`;
}

function renderGooAgentDetail(agent: GooPaperAgent): string {
  const pnl = agent.totalPnlUsd;
  const pnlCls = pnl >= 0 ? 'goo-pnl--pos' : 'goo-pnl--neg';
  const pnlSign = pnl >= 0 ? '+' : '';
  const fmtUsd = (v: number) => `$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const fw = agent.flywheel ?? { totalProfitBnb: 0, reinvestedBnb: 0, elizaOKBoughtBnb: 0, airdropReservedBnb: 0, cycleCount: 0, lastCycleAt: null };

  const statusColor: Record<string, string> = { active: '#00C7D2', starving: '#ca8a04', dying: '#ea580c', dead: '#D1D5DB' };

  // Build cumulative P&L chart data from trade history
  const trades = (agent.tradeHistory ?? []).filter((t: any) => t.side === 'sell');
  let cumPnl = 0;
  const chartPoints = trades.map((t: any, i: number) => {
    cumPnl += t.pnlUsd;
    return { x: i, y: cumPnl };
  });
  let chartSvg = '';
  if (chartPoints.length >= 2) {
    const w = 500, h = 120, pad = 10;
    const minY = Math.min(0, ...chartPoints.map(p => p.y));
    const maxY = Math.max(0, ...chartPoints.map(p => p.y));
    const rangeY = maxY - minY || 1;
    const xStep = (w - pad * 2) / (chartPoints.length - 1);
    const pts = chartPoints.map((p, i) => {
      const px = pad + i * xStep;
      const py = h - pad - ((p.y - minY) / rangeY) * (h - pad * 2);
      return `${px.toFixed(1)},${py.toFixed(1)}`;
    });
    const zeroY = h - pad - ((0 - minY) / rangeY) * (h - pad * 2);
    const lastPnl = chartPoints[chartPoints.length - 1]?.y ?? 0;
    const lineColor = lastPnl >= 0 ? '#10b981' : '#ef4444';
    const fillColor = lastPnl >= 0 ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)';
    const areaPath = `M${pts[0]} ${pts.join(' L')} L${(pad + (chartPoints.length-1)*xStep).toFixed(1)},${zeroY.toFixed(1)} L${pad},${zeroY.toFixed(1)} Z`;
    chartSvg = `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:${h}px;display:block">
      <line x1="${pad}" y1="${zeroY.toFixed(1)}" x2="${w-pad}" y2="${zeroY.toFixed(1)}" stroke="rgba(128,128,128,0.2)" stroke-dasharray="4"/>
      <path d="${areaPath}" fill="${fillColor}"/>
      <polyline points="${pts.join(' ')}" fill="none" stroke="${lineColor}" stroke-width="2" stroke-linejoin="round"/>
      <circle cx="${pts[pts.length-1].split(',')[0]}" cy="${pts[pts.length-1].split(',')[1]}" r="4" fill="${lineColor}"/>
      <text x="${pad+2}" y="${pad+10}" fill="rgba(128,128,128,0.6)" font-size="10" font-family="Inter">Cumulative P&L</text>
      <text x="${w-pad}" y="${pad+10}" fill="${lineColor}" font-size="10" font-family="Inter" text-anchor="end">${lastPnl >= 0 ? '+' : ''}$${Math.abs(lastPnl).toFixed(2)}</text>
    </svg>`;
  }

  const activePositions = agent.positions.filter(p => p.state === 'active');
  const closedPositions = agent.positions.filter(p => p.state !== 'active');

  const posRow = (p: any, idx: number) => {
    const ppnl = p.state === 'exited' ? (p.realizedPnlUsd ?? 0) : (p.unrealizedPnlUsd ?? 0);
    const cls = ppnl >= 0 ? 'goo-pnl--pos' : 'goo-pnl--neg';
    const gain = p.entryPriceUsd > 0 ? ((p.currentPriceUsd - p.entryPriceUsd) / p.entryPriceUsd * 100) : 0;
    const sizeVal = p.allocationUsd ?? p.sizeUsd ?? 0;
    const entryDate = p.entryAt ?? p.entryTime ?? p.lastUpdatedAt ?? '';
    const dateStr = entryDate ? new Date(entryDate).toLocaleDateString() : 'n/a';
    return `<tr style="animation:slideUp .3s ease-out ${idx * 0.03}s both">
      <td><span style="font-weight:600;color:var(--goo-brand)">${escapeHtml(p.tokenSymbol)}</span></td>
      <td style="font-size:11px;color:var(--goo-text3)">${p.state.toUpperCase()}</td>
      <td>${fmtUsd(sizeVal)}</td>
      <td>${gain >= 0 ? '+' : ''}${gain.toFixed(1)}%</td>
      <td class="${cls}" style="font-weight:600">${ppnl >= 0 ? '+' : ''}${fmtUsd(ppnl)}</td>
      <td style="font-size:10px;color:var(--goo-text3)">${dateStr}</td>
    </tr>`;
  };

  const tradeRows = (agent.tradeHistory ?? []).slice(-30).reverse().map((t: any, idx: number) => {
    const cls = t.pnlUsd >= 0 ? 'goo-pnl--pos' : 'goo-pnl--neg';
    return `<tr style="animation:slideUp .3s ease-out ${idx * 0.02}s both">
      <td><span class="goo-badge goo-badge--${t.side === 'buy' ? 'active' : 'dying'}" style="font-size:9px">${t.side.toUpperCase()}</span></td>
      <td style="font-weight:600">${escapeHtml(t.tokenSymbol)}</td>
      <td>${fmtUsd(t.amountUsd)}</td>
      <td class="${cls}" style="font-weight:600">${t.pnlUsd >= 0 ? '+' : ''}${fmtUsd(t.pnlUsd)}</td>
      <td style="font-size:10px;color:var(--goo-text3)">${escapeHtml(t.reason)}</td>
      <td style="font-size:10px;color:var(--goo-text3)">${new Date(t.timestamp).toLocaleString()}</td>
    </tr>`;
  }).join('');

  const strategyParams = agent.strategy;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(agent.agentName)} | Goo Economy Arena</title>
<link rel="icon" type="image/png" href="/assets/avatar.png" />
<link rel="apple-touch-icon" href="/assets/avatar.png" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --goo-brand:#00C7D2;--goo-brand-bg:#e6fafb;
  --goo-warn:#ca8a04;--goo-dying:#ea580c;
  --goo-dead:#D1D5DB;
  --goo-pos:#10b981;--goo-neg:#ef4444;
  --goo-bg:#f8f8f7;--goo-surface:#fff;--goo-border:#ebebeb;
  --goo-text:#000;--goo-text2:#4D4D4D;--goo-text3:#808080;
  --goo-r:16px;--goo-r-sm:8px;
  font-family:'Inter',system-ui,sans-serif;
}
html,body{min-height:100%;background:var(--goo-bg);color:var(--goo-text)}
@keyframes fadeIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
@keyframes slideUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
@keyframes dotPulse{0%,100%{box-shadow:0 0 0 0 rgba(0,199,210,.3)}50%{box-shadow:0 0 0 8px rgba(0,199,210,0)}}
@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}

.gd-wrap{max-width:1100px;margin:0 auto;padding:32px 24px 64px;animation:fadeIn .5s ease-out}
.gd-back{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--goo-text3);text-decoration:none;padding:6px 14px;border:1px solid var(--goo-border);border-radius:var(--goo-r-sm);margin-bottom:20px;transition:all .2s}
.gd-back:hover{border-color:var(--goo-brand);color:var(--goo-brand)}

/* Hero */
.gd-hero{display:flex;align-items:flex-start;gap:20px;padding:24px;background:var(--goo-surface);border:1px solid var(--goo-border);border-radius:var(--goo-r);margin-bottom:16px;animation:slideUp .4s ease-out .1s both}
.gd-hero__dot{width:16px;height:16px;border-radius:50%;margin-top:4px;flex-shrink:0}
.gd-hero__dot--active{background:var(--goo-brand);animation:dotPulse 2s ease-in-out infinite}
.gd-hero__dot--starving{background:var(--goo-warn)}
.gd-hero__dot--dying{background:var(--goo-dying)}
.gd-hero__dot--dead{background:var(--goo-dead)}
.gd-hero__info{flex:1}
.gd-hero__name{font-size:22px;font-weight:700;margin-bottom:4px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.gd-hero__symbol{color:var(--goo-brand)}
.gd-hero__meta{font-size:12px;color:var(--goo-text3);display:flex;gap:8px;flex-wrap:wrap;margin-top:6px}
.gd-hero__pnl{text-align:right;flex-shrink:0}
.gd-hero__pnl-val{font-size:28px;font-weight:700}
.gd-hero__pnl-label{font-size:10px;color:var(--goo-text3);text-transform:uppercase;margin-top:4px}
.goo-badge{display:inline-block;font-size:10px;font-weight:600;padding:2px 8px;border-radius:6px;text-transform:uppercase;letter-spacing:.04em;vertical-align:middle}
.goo-badge--active{background:var(--goo-brand-bg);color:var(--goo-brand)}
.goo-badge--starving{background:#fef9c3;color:var(--goo-warn)}
.goo-badge--dying{background:#ffedd5;color:var(--goo-dying)}
.goo-badge--dead{background:#F9FAFB;color:var(--goo-dead)}
.goo-badge--strategy{background:#eef2ff;color:#4338ca;font-size:9px}
.goo-badge--acquired{background:#dcfce7;color:#16a34a;font-size:9px}
.goo-pnl--pos{color:var(--goo-pos)}
.goo-pnl--neg{color:var(--goo-neg)}

/* KPI grid */
.gd-kpis{display:grid;grid-template-columns:repeat(6,1fr);gap:0;border:1px solid var(--goo-border);border-radius:var(--goo-r);overflow:hidden;margin-bottom:16px;background:var(--goo-surface);animation:slideUp .4s ease-out .15s both}
.gd-kpi{padding:16px 12px;text-align:center;border-right:1px solid var(--goo-border);transition:background .2s}
.gd-kpi:last-child{border-right:none}
.gd-kpi:hover{background:rgba(0,199,210,.03)}
.gd-kpi__label{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--goo-text3);margin-bottom:4px}
.gd-kpi__value{font-size:18px;font-weight:700}

/* Cards */
.gd-card{background:var(--goo-surface);border:1px solid var(--goo-border);border-radius:var(--goo-r);margin-bottom:16px;overflow:hidden;animation:slideUp .4s ease-out .2s both}
.gd-card__head{padding:14px 20px;border-bottom:1px solid var(--goo-border);display:flex;align-items:center;justify-content:space-between}
.gd-card__head h3{font-size:13px;font-weight:700}
.gd-card__count{font-size:11px;color:var(--goo-text3)}

/* Table */
.gd-table{width:100%;border-collapse:collapse;font-size:12px}
.gd-table th{text-align:left;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--goo-text3);padding:10px 14px;border-bottom:1px solid var(--goo-border);background:rgba(0,199,210,.02)}
.gd-table td{padding:10px 14px;border-bottom:1px solid var(--goo-border);vertical-align:middle}
.gd-table tr:last-child td{border-bottom:none}
.gd-table tr:hover td{background:rgba(0,199,210,.02)}

/* Strategy card */
.gd-strat{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;padding:16px 20px}
.gd-strat__item{padding:10px 14px;border:1px solid var(--goo-border);border-radius:var(--goo-r-sm);transition:all .2s}
.gd-strat__item:hover{border-color:var(--goo-brand);background:rgba(0,199,210,.03)}
.gd-strat__key{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--goo-text3);margin-bottom:3px}
.gd-strat__val{font-size:14px;font-weight:600}

/* Flywheel mini */
.gd-fw{display:flex;align-items:center;gap:0;padding:14px 20px;justify-content:center}
.gd-fw__cell{text-align:center;flex:1;padding:8px}
.gd-fw__cell--arrow{flex:0 0 24px;font-size:14px;color:var(--goo-text3);opacity:.4}
.gd-fw__label{font-size:9px;font-weight:600;text-transform:uppercase;color:var(--goo-text3)}
.gd-fw__val{font-size:14px;font-weight:700;margin-top:2px}

/* Two-col layout */
.gd-cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}

/* Responsive */
@media(max-width:768px){
  .gd-kpis{grid-template-columns:repeat(3,1fr)}
  .gd-cols{grid-template-columns:1fr}
  .gd-hero{flex-wrap:wrap}
  .gd-hero__pnl{width:100%;text-align:left;margin-top:8px}
}
@media(max-width:480px){
  .gd-kpis{grid-template-columns:repeat(2,1fr)}
  .gd-wrap{padding:16px 12px 40px}
}
</style>
</head>
<body>
<div class="gd-wrap">
  <a class="gd-back" href="/goo">&larr; Back to Arena</a>

  <!-- Hero -->
  <div class="gd-hero">
    <div class="gd-hero__dot gd-hero__dot--${agent.chainState}"></div>
    <div class="gd-hero__info">
      <div class="gd-hero__name">
        <span class="gd-hero__symbol">${escapeHtml(agent.tokenSymbol)}</span>
        ${escapeHtml(agent.agentName)}
        <span class="goo-badge goo-badge--${agent.chainState}">${agent.chainState.toUpperCase()}</span>
        <span class="goo-badge goo-badge--strategy">${escapeHtml(agent.strategy.label)}</span>
        ${agent.acquiredByElizaOK ? '<span class="goo-badge goo-badge--acquired">ACQUIRED BY elizaOK</span>' : ''}
      </div>
      <div class="gd-hero__meta">
        <span>ID: ${escapeHtml(agent.agenterId)}</span>
        <span>&middot;</span>
        <span>Spawned: ${new Date(agent.createdAt).toLocaleString()}</span>
        <span>&middot;</span>
        <span>Treasury: ${agent.treasuryBnb.toFixed(4)} BNB</span>
      </div>
    </div>
    <div class="gd-hero__pnl">
      <div class="gd-hero__pnl-val ${pnlCls}">${pnlSign}${fmtUsd(pnl)}</div>
      <div class="gd-hero__pnl-label">Total P&amp;L</div>
    </div>
  </div>

  <!-- KPIs -->
  <div class="gd-kpis">
    <div class="gd-kpi">
      <div class="gd-kpi__label">Win Rate</div>
      <div class="gd-kpi__value">${agent.winRate.toFixed(1)}%</div>
    </div>
    <div class="gd-kpi">
      <div class="gd-kpi__label">Total Trades</div>
      <div class="gd-kpi__value">${agent.totalTradesCount}</div>
    </div>
    <div class="gd-kpi">
      <div class="gd-kpi__label">Wins / Losses</div>
      <div class="gd-kpi__value"><span class="goo-pnl--pos">${agent.winCount}</span> / <span class="goo-pnl--neg">${agent.lossCount}</span></div>
    </div>
    <div class="gd-kpi">
      <div class="gd-kpi__label">Active Pos</div>
      <div class="gd-kpi__value">${activePositions.length}</div>
    </div>
    <div class="gd-kpi">
      <div class="gd-kpi__label">Acq. Score</div>
      <div class="gd-kpi__value" style="color:${agent.acquisitionScore >= 60 ? 'var(--goo-pos)' : agent.acquisitionScore >= 30 ? 'var(--goo-brand)' : 'var(--goo-text3)'}">${agent.acquisitionScore}</div>
    </div>
    <div class="gd-kpi">
      <div class="gd-kpi__label">Realized</div>
      <div class="gd-kpi__value ${pnlCls}">${pnlSign}${fmtUsd(agent.totalRealizedUsd)}</div>
    </div>
  </div>

  <!-- P&L Chart -->
  ${chartSvg ? `
  <div class="gd-card">
    <div class="gd-card__head"><h3>Cumulative P&amp;L</h3><span class="gd-card__count">${trades.length} closed trades</span></div>
    <div style="padding:12px 16px">${chartSvg}</div>
  </div>` : ''}

  <div class="gd-cols">
    <!-- Strategy Parameters -->
    <div class="gd-card">
      <div class="gd-card__head"><h3>Strategy: ${escapeHtml(agent.strategy.label)}</h3></div>
      <div class="gd-strat">
        <div class="gd-strat__item"><div class="gd-strat__key">Min Score</div><div class="gd-strat__val">${strategyParams.minScore}</div></div>
        <div class="gd-strat__item"><div class="gd-strat__key">Stop Loss</div><div class="gd-strat__val">${strategyParams.stopLossPct}%</div></div>
        <div class="gd-strat__item"><div class="gd-strat__key">Max Positions</div><div class="gd-strat__val">${strategyParams.maxPositions}</div></div>
        <div class="gd-strat__item"><div class="gd-strat__key">Position Size</div><div class="gd-strat__val">${strategyParams.buyPct}%</div></div>
        ${strategyParams.trailingStopPct ? `<div class="gd-strat__item"><div class="gd-strat__key">Trailing Stop</div><div class="gd-strat__val">${strategyParams.trailingStopPct}%</div></div>` : ''}
        ${strategyParams.minKolCount ? `<div class="gd-strat__item"><div class="gd-strat__key">Min KOL</div><div class="gd-strat__val">${strategyParams.minKolCount}</div></div>` : ''}
        ${strategyParams.holderDropThreshold ? `<div class="gd-strat__item"><div class="gd-strat__key">Holder Drop %</div><div class="gd-strat__val">${strategyParams.holderDropThreshold}%</div></div>` : ''}
      </div>
    </div>

    <!-- Flywheel -->
    <div class="gd-card">
      <div class="gd-card__head"><h3>&#x1F504; Agent Flywheel</h3><span class="gd-card__count">${fw.cycleCount} cycles</span></div>
      <div class="gd-fw">
        <div class="gd-fw__cell">
          <div class="gd-fw__label">Profit</div>
          <div class="gd-fw__val goo-pnl--pos">${fw.totalProfitBnb.toFixed(4)}</div>
        </div>
        <div class="gd-fw__cell gd-fw__cell--arrow">&rarr;</div>
        <div class="gd-fw__cell">
          <div class="gd-fw__label">Reinvested</div>
          <div class="gd-fw__val" style="color:var(--goo-brand)">${fw.reinvestedBnb.toFixed(4)}</div>
        </div>
        <div class="gd-fw__cell gd-fw__cell--arrow">&rarr;</div>
        <div class="gd-fw__cell">
          <div class="gd-fw__label">$elizaOK</div>
          <div class="gd-fw__val" style="color:#8b5cf6">${fw.elizaOKBoughtBnb.toFixed(4)}</div>
        </div>
        <div class="gd-fw__cell gd-fw__cell--arrow">&rarr;</div>
        <div class="gd-fw__cell">
          <div class="gd-fw__label">Airdrop</div>
          <div class="gd-fw__val" style="color:#f59e0b">${fw.airdropReservedBnb.toFixed(4)}</div>
        </div>
      </div>
    </div>
  </div>

  <!-- Active Positions -->
  <div class="gd-card">
    <div class="gd-card__head"><h3>Active Positions</h3><span class="gd-card__count">${activePositions.length}</span></div>
    ${activePositions.length > 0 ? `
    <table class="gd-table">
      <thead><tr><th>Token</th><th>Status</th><th>Size</th><th>Gain</th><th>P&L</th><th>Entry</th></tr></thead>
      <tbody>${activePositions.map(posRow).join('')}</tbody>
    </table>` : `<div style="padding:24px;text-align:center;color:var(--goo-text3);font-size:12px">No active positions</div>`}
  </div>

  <!-- Closed Positions -->
  <div class="gd-card">
    <div class="gd-card__head"><h3>Closed Positions</h3><span class="gd-card__count">${closedPositions.length}</span></div>
    ${closedPositions.length > 0 ? `
    <table class="gd-table">
      <thead><tr><th>Token</th><th>Status</th><th>Size</th><th>Gain</th><th>P&L</th><th>Entry</th></tr></thead>
      <tbody>${closedPositions.map(posRow).join('')}</tbody>
    </table>` : `<div style="padding:24px;text-align:center;color:var(--goo-text3);font-size:12px">No closed positions yet</div>`}
  </div>

  <!-- Trade History -->
  <div class="gd-card">
    <div class="gd-card__head"><h3>Trade History</h3><span class="gd-card__count">${(agent.tradeHistory ?? []).length} trades</span></div>
    ${(agent.tradeHistory ?? []).length > 0 ? `
    <table class="gd-table">
      <thead><tr><th>Side</th><th>Token</th><th>Amount</th><th>P&L</th><th>Reason</th><th>Time</th></tr></thead>
      <tbody>${tradeRows}</tbody>
    </table>` : `<div style="padding:24px;text-align:center;color:var(--goo-text3);font-size:12px">No trades yet</div>`}
  </div>

  <div style="text-align:center;font-size:11px;color:var(--goo-text3);margin-top:24px">
    Goo Economy Arena &middot; <a href="/goo" style="color:var(--goo-brand);text-decoration:none">Back to Arena</a> &middot; Paper Run Mode
  </div>
</div>
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

function renderApiEndpoints(): string {
  const eps = [
    { cat:"ai", method:"POST", name:"Chat Completion", path:"/api/v1/chat", price:"$0.001–$0.03/1k tok", tags:["ai-generation","text"] },
    { cat:"ai", method:"POST", name:"Character Assistant", path:"/api/v1/character-assistant", price:"$0.001–$0.03/1k tok", tags:["ai-generation","characters"] },
    { cat:"ai", method:"POST", name:"Generate Prompts", path:"/api/v1/generate-prompts", price:"Free", tags:["ai-generation","prompts"] },
    { cat:"image", method:"POST", name:"Generate Image", path:"/api/v1/generate-image", price:"$0.01/image", tags:["ai-generation","images"] },
    { cat:"video", method:"POST", name:"Generate Video", path:"/api/v1/generate-video", price:"$0.05/video", tags:["ai-generation","videos"] },
    { cat:"other", method:"GET", name:"List Models", path:"/api/v1/models", price:"Free", tags:["models"] },
    { cat:"other", method:"GET", name:"List Generations", path:"/api/v1/gallery", price:"Free", tags:["gallery","media"] },
    { cat:"other", method:"GET", name:"Get User Profile", path:"/api/v1/user", price:"Free", tags:["user"] },
    { cat:"other", method:"PATCH", name:"Update User Profile", path:"/api/v1/user", price:"Free", tags:["user"] },
    { cat:"keys", method:"GET", name:"List API Keys", path:"/api/v1/api-keys", price:"Free", tags:["api-keys"] },
    { cat:"keys", method:"POST", name:"Create API Key", path:"/api/v1/api-keys", price:"Free", tags:["api-keys"] },
    { cat:"keys", method:"DELETE", name:"Delete API Key", path:"/api/v1/api-keys/{id}", price:"Free", tags:["api-keys"] },
    { cat:"keys", method:"PATCH", name:"Update API Key", path:"/api/v1/api-keys/{id}", price:"Free", tags:["api-keys"] },
    { cat:"keys", method:"POST", name:"Regenerate API Key", path:"/api/v1/api-keys/{id}/regenerate", price:"Free", tags:["api-keys"] },
    { cat:"voice", method:"POST", name:"Text-to-Speech", path:"/api/elevenlabs/tts", price:"$0.001–$0.01/1k tok", tags:["voice","tts"] },
    { cat:"voice", method:"POST", name:"Speech-to-Text", path:"/api/elevenlabs/stt", price:"$0.01/min", tags:["voice","stt"] },
    { cat:"voice", method:"GET", name:"List Available Voices", path:"/api/elevenlabs/voices", price:"Free", tags:["voice","voices"] },
    { cat:"voice", method:"POST", name:"Clone Voice", path:"/api/elevenlabs/voices/clone", price:"$0.50–$2.00/clone", tags:["voice","cloning"] },
    { cat:"voice", method:"GET", name:"List Cloned Voices", path:"/api/elevenlabs/voices/user", price:"Free", tags:["voice","cloning"] },
    { cat:"voice", method:"GET", name:"Get Voice Details", path:"/api/elevenlabs/voices/{id}", price:"Free", tags:["voice","cloning"] },
    { cat:"voice", method:"DELETE", name:"Delete Voice", path:"/api/elevenlabs/voices/{id}", price:"Free", tags:["voice","cloning"] },
  ];
  return eps.map(ep => {
    const mCls = ep.method.toLowerCase();
    const pCls = ep.price === "Free" ? "free" : "paid";
    const tags = ep.tags.map(t => `<span class="api-ep__tag">${escapeHtml(t)}</span>`).join("");
    return `<div class="api-ep" data-cat="${ep.cat}">
      <span class="api-ep__method api-ep__method--${mCls}">${ep.method}</span>
      <div class="api-ep__info">
        <div class="api-ep__name">${escapeHtml(ep.name)}</div>
        <div class="api-ep__path">${escapeHtml(ep.path)}</div>
        <div class="api-ep__meta"><span class="api-ep__price api-ep__price--${pCls}">${escapeHtml(ep.price)}</span>${tags}</div>
      </div>
    </div>`;
  }).join("");
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
        <p class="cp-connect-desc">Connect your ElizaCloud account to view and manage agents, budgets, and request usage.</p>
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
      <!-- Profile + KPI row -->
      <div class="cp-col-8 cp-card">
        <div class="cp-profile">
          <div class="cp-profile__avatar">${escapeHtml((cloudSession.displayName || "E").slice(0,1).toUpperCase())}</div>
          <div>
            <div class="cp-profile__name">${escapeHtml(cloudSession.displayName)}</div>
            <div class="cp-profile__org">${escapeHtml(cloudSession.organizationName)}</div>
            <div class="cp-profile__meta">
              <span class="cp-profile__chip cp-profile__chip--active">CONNECTED</span>
              <span class="cp-profile__chip">${cloudSummary?.agentsSummary?.total ?? agents.length} AGENTS</span>
              <span class="cp-profile__chip">${escapeHtml(cloudSession.credits)} CR</span>
            </div>
          </div>
        </div>
      </div>

      <div class="cp-col-4 cp-card">
        <div class="cp-card__head"><h2>Session</h2><span class="cp-card__head-badge">ACTIVE</span></div>
        <div class="cp-rows">
          <div class="cp-row"><span>Agent</span><strong>${escapeHtml(cloudSession.agentName || "Eliza")}</strong></div>
          <div class="cp-row"><span>Org</span><strong>${escapeHtml(cloudSession.organizationName)}</strong></div>
          <div class="cp-row"><span>API Key</span><strong>${escapeHtml(cloudSession.apiKey ? cloudSession.apiKey.slice(0,12) + "..." : "n/a")}</strong></div>
          <div class="cp-row"><span>Model</span><strong>${escapeHtml(cloudSession.model || "n/a")}</strong></div>
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

      <!-- Agent cards (compact) + Chat (wider) -->
      <div class="cp-col-4 cp-card">
        <div class="cp-card__head">
          <h2>Cloud Agents</h2>
          <span class="cp-card__head-badge">${agents.length}</span>
        </div>
        <div class="cp-agents" style="grid-template-columns:1fr">${agentCards}</div>
        <div class="cp-actions">
          <button type="button" class="cp-btn cp-btn--accent" data-cloud-create-agent>+ New Agent</button>
          <a class="cp-btn" href="${escapeHtml(getElizaCloudDashboardUrl())}" target="_blank" rel="noreferrer">Cloud ↗</a>
        </div>
      </div>

      <div class="cp-col-8 cp-card" id="chat-section" data-agent-id="${escapeHtml(cloudSession.agentId || (agents.length ? agents[0].id : ""))}">
        <div class="cp-card__head"><h2>elizaOS Cloud Agent Chat</h2><span class="cp-card__head-badge" id="chat-credits">${escapeHtml(cloudSession.credits)} CR</span></div>
        <div class="chat-wrap" id="chat-wrap">
          <div class="chat-msgs" id="chat-msgs">
            <div class="chat-empty" id="chat-empty">
              <div class="chat-empty__icon">💬</div>
              <div>Start a conversation with your agent.<br>Messages use your elizaOS Cloud credits.</div>
            </div>
          </div>
          <div class="chat-input">
            <input type="text" id="chat-text" placeholder="Type a message…" autocomplete="off" />
            <button class="chat-send" id="chat-send" disabled aria-label="Send">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            </button>
          </div>
        </div>
      </div>

      ${!cloudSummary ? `
      <div class="cp-col-12 cp-card">
        <div class="cp-card__head"><h2>Data Status</h2></div>
        <div class="cp-card__body" style="padding:14px;">
          <p style="color:var(--clr-muted);font-size:12px;">Connected — agent list could not be fetched from ElizaCloud API. Your session is valid. <a style="color:var(--clr-primary)" href="/cloud/agents">Refresh</a></p>
        </div>
      </div>` : ""}

      <!-- API Explorer -->
      <div class="cp-col-12 cp-card">
        <div class="cp-card__head">
          <h2>API Explorer</h2>
          <span class="cp-card__head-badge">21 ENDPOINTS</span>
        </div>
        <div class="api-cats" id="api-cats">
          <button class="api-cat active" data-cat="all">All<span class="api-cat__count">21</span></button>
          <button class="api-cat" data-cat="ai">AI Completions<span class="api-cat__count">3</span></button>
          <button class="api-cat" data-cat="image">Image<span class="api-cat__count">1</span></button>
          <button class="api-cat" data-cat="video">Video<span class="api-cat__count">1</span></button>
          <button class="api-cat" data-cat="voice">Voice<span class="api-cat__count">7</span></button>
          <button class="api-cat" data-cat="keys">API Keys<span class="api-cat__count">5</span></button>
          <button class="api-cat" data-cat="other">Models &amp; User<span class="api-cat__count">4</span></button>
        </div>
        <div class="api-grid" id="api-grid">
          ${renderApiEndpoints()}
        </div>
      </div>
    </div>
    <script>
      (function () {
        var buttons = Array.prototype.slice.call(document.querySelectorAll("[data-cloud-create-agent]"));
        buttons.forEach(function (button) {
          button.addEventListener("click", function () {
            var name = window.prompt("New ElizaCloud agent name", "elizaOK Agent");
            if (!name) return;
            var bio = window.prompt("Agent bio (optional)", "elizaOK cloud agent") || "";
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
    </script>
    <script>
    (function(){
      var msgs=document.getElementById("chat-msgs");
      var input=document.getElementById("chat-text");
      var sendBtn=document.getElementById("chat-send");
      var emptyEl=document.getElementById("chat-empty");
      var sending=false;
      var history=[];

      input.addEventListener("input",function(){sendBtn.disabled=!input.value.trim()||sending;});
      input.addEventListener("keydown",function(e){if(e.key==="Enter"&&!sendBtn.disabled)doSend();});
      sendBtn.addEventListener("click",function(){if(!sendBtn.disabled)doSend();});

      function addBubble(text,cls){
        if(emptyEl){emptyEl.style.display="none";}
        var div=document.createElement("div");
        div.className="chat-bubble "+cls;
        div.textContent=text;
        msgs.appendChild(div);
        msgs.scrollTop=msgs.scrollHeight;
        return div;
      }

      function addTyping(){
        if(emptyEl){emptyEl.style.display="none";}
        var div=document.createElement("div");
        div.className="chat-bubble chat-bubble--ai chat-bubble--typing";
        div.id="chat-typing";
        div.innerHTML='<div class="chat-dots"><span></span><span></span><span></span></div>';
        msgs.appendChild(div);
        msgs.scrollTop=msgs.scrollHeight;
      }

      function removeTyping(){
        var t=document.getElementById("chat-typing");
        if(t)t.remove();
      }

      function doSend(){
        var text=input.value.trim();
        if(!text||sending)return;
        sending=true;
        sendBtn.disabled=true;
        input.value="";
        addBubble(text,"chat-bubble--user");
        addTyping();

        fetch("/api/eliza-cloud/chat/send",{
          method:"POST",
          headers:{"content-type":"application/json"},
          body:JSON.stringify({text:text,history:history.slice(-10)})
        }).then(function(r){
          return r.json().then(function(d){
            removeTyping();
            if(!r.ok){
              var em=d.error;
              if(typeof em==="object"&&em!==null)em=em.message||JSON.stringify(em);
              throw new Error(em||"Chat request failed");
            }
            var reply=d.reply||"No response.";
            addBubble(reply,"chat-bubble--ai");
            history.push({role:"user",content:text});
            history.push({role:"assistant",content:reply});
            if(history.length>20)history=history.slice(-20);
          });
        }).catch(function(err){
          removeTyping();
          addBubble("Error: "+(err.message||String(err)),"chat-bubble--ai");
        }).then(function(){
          sending=false;
          sendBtn.disabled=!input.value.trim();
          input.focus();
        });
      }
    })();
    </script>
    <script>
    (function(){
      var cats=document.querySelectorAll(".api-cat");
      var eps=document.querySelectorAll(".api-ep");
      cats.forEach(function(btn){
        btn.addEventListener("click",function(){
          cats.forEach(function(b){b.classList.remove("active");});
          btn.classList.add("active");
          var cat=btn.getAttribute("data-cat");
          eps.forEach(function(ep){
            ep.style.display=(cat==="all"||ep.getAttribute("data-cat")===cat)?"":"none";
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
  bnbPriceEst = 600,
): string {
  if (!snapshot) {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  ${renderHeadBrandAssets("elizaOK")}
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
    <div class="eyebrow">elizaOK Live System</div>
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
    flywheel: { totalProfitUsd: 0, reinvestedUsd: 0, elizaOKBuybackUsd: 0, airdropReserveUsd: 0, cycleCount: 0, lastCycleAt: null, trailingStopSaves: 0, gmgnExitSaves: 0 },
    winCount: 0,
    lossCount: 0,
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

  // bnbPriceEst is now passed as a parameter

  const topCandidates = snapshot.topCandidates
    .slice(0, 5)
    .map(
      (candidate, index) => {
        const recLabel = candidate.recommendation === "simulate_buy" ? "BUY" : candidate.recommendation === "watch" ? "WATCH" : "OBSERVE";
        const recIcon = candidate.recommendation === "simulate_buy" ? "🟢" : "🟡";
        const fdv = candidate.fdvUsd ? `$${Math.round(candidate.fdvUsd).toLocaleString()}` : "—";
        const allocBnb = formatBnb(Math.min(1, (candidate.reserveUsd * 0.15) / bnbPriceEst));
        return `
        <article class="candidate-card">
          <div class="candidate-card__meta">
            <span class="candidate-rank">0${index + 1}</span>
            <span class="pill ${recommendationTone(candidate.recommendation)}">${recIcon} ${recLabel}</span>
          </div>
          <h3><a class="candidate-link" href="${candidateHref(candidate.tokenAddress, candidate.dexId)}" target="_blank" rel="noreferrer">${escapeHtml(candidate.tokenSymbol)}</a></h3>
          <p class="candidate-subtitle">Score ${candidate.score}/100 · ${candidate.poolAgeMinutes}m old · ${escapeHtml(candidate.dexId)}</p>
          <div class="candidate-stats" style="grid-template-columns:1fr 1fr">
            <div><span>FDV</span><strong>${fdv}</strong></div>
            <div><span>Liquidity</span><strong>$${Math.round(candidate.reserveUsd).toLocaleString()}</strong></div>
            <div><span>Vol (5m)</span><strong>$${Math.round(candidate.volumeUsdM5).toLocaleString()}</strong></div>
            <div><span>Est. Size</span><strong>${allocBnb}</strong></div>
          </div>
        </article>`;
      },
    )
    .join("");

  const paperAgents = getPaperAgents();
  const paperSummary = getPaperSummary();
  const gooCandidates = paperAgents
    .sort((a, b) => b.acquisitionScore - a.acquisitionScore)
    .slice(0, 8)
    .map(
      (agent, index) => {
        const stateIcon = agent.chainState === "active" ? "🟢" : agent.chainState === "starving" ? "🟡" : agent.chainState === "dying" ? "🔴" : "⚫";
        const pnlClass = agent.totalPnlUsd >= 0 ? "g" : "r";
        const activePos = agent.positions.filter(p => p.state === "active").length;
        return `
        <article class="candidate-card">
          <div class="candidate-card__meta">
            <span class="candidate-rank">#${index + 1}</span>
            <span class="pill ${agent.chainState === 'active' ? 'tone-hot' : 'tone-warm'}">${stateIcon} ${escapeHtml(agent.strategy.label)}</span>
          </div>
          <h3>${escapeHtml(agent.agentName)}</h3>
          <p class="candidate-subtitle">$${escapeHtml(agent.tokenSymbol)} · Score ${agent.acquisitionScore}/100 · ${activePos} positions</p>
          <div class="candidate-stats" style="grid-template-columns:1fr 1fr">
            <div><span>Treasury</span><strong>${agent.treasuryBnb.toFixed(4)} BNB</strong></div>
            <div><span>Win Rate</span><strong class="${agent.winRate > 0 ? 'g' : 'w'}">${agent.winRate.toFixed(1)}%</strong></div>
            <div><span>P&L</span><strong class="${pnlClass}">${agent.totalPnlUsd >= 0 ? "+" : ""}$${agent.totalPnlUsd.toFixed(2)}</strong></div>
            <div><span>Trades</span><strong>${agent.totalTradesCount}</strong></div>
          </div>
        </article>`;
      },
    )
    .join("");

  const acquirableCandidates = paperAgents.filter(a => !a.acquiredByElizaOK && a.chainState !== "dead" && a.totalTradesCount >= 3);
  const gooQueueRows = acquirableCandidates.length > 0
    ? acquirableCandidates
      .sort((a, b) => b.acquisitionScore - a.acquisitionScore)
      .slice(0, 6)
      .map((agent) => {
        const readyIcon = agent.acquisitionScore >= 50 ? "🟢" : agent.acquisitionScore >= 30 ? "🟡" : "⚪";
        return `
        <div class="status-row">
          <span>${escapeHtml(agent.agentName)}</span>
          <strong>${readyIcon} Score ${agent.acquisitionScore}/100 · ${agent.totalTradesCount} trades · ${agent.winRate.toFixed(1)}% win</strong>
        </div>`;
      })
      .join("")
    : "";

  const treasuryAllocationCards = treasurySimulation.positions
    .slice(0, 5)
    .map(
      (position, index) => {
        const portfolioMatch = portfolioLifecycle.activePositions.find(
          (p) => p.tokenAddress === position.tokenAddress,
        );
        const portfolioInitial = portfolioMatch ? formatUsd(portfolioMatch.initialAllocationUsd) : "—";
        const portfolioCurrent = portfolioMatch ? formatUsd(portfolioMatch.currentValueUsd) : "—";
        return `
        <article class="candidate-card">
          <div class="candidate-card__meta">
            <span class="candidate-rank">0${index + 1}</span>
            <span class="pill tone-hot">${position.recommendation === "simulate_buy" ? "🟢 BUY" : "🟡 WATCH"}</span>
          </div>
          <h3>${escapeHtml(position.tokenSymbol)}</h3>
          <p class="candidate-subtitle">Score ${position.score}/100 · ${escapeHtml(position.source)}</p>
          <div class="candidate-stats" style="grid-template-columns:1fr 1fr">
            <div><span>Model Allocation</span><strong>${formatUsd(position.allocationUsd)}</strong></div>
            <div><span>Portfolio Initial</span><strong>${portfolioInitial}</strong></div>
            <div><span>Weight</span><strong>${position.allocationPct}%</strong></div>
            <div><span>Portfolio Current</span><strong>${portfolioCurrent}</strong></div>
            <div><span>Score</span><strong>${position.score}/100</strong></div>
            <div><span>Liquidity</span><strong>${formatUsd(position.reserveUsd)}</strong></div>
          </div>
        </article>`;
      },
    )
    .join("");

  const recentRuns = recentHistory
    .slice(0, 6)
    .map(
      (entry) => {
        const t = new Date(entry.generatedAt);
        const timeStr = t.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
        return `
        <div class="status-row">
          <span>${timeStr}</span>
          <strong>
            ${entry.candidateCount} scanned · ${entry.topRecommendationCount} buy signals · avg ${entry.averageScore}/100
          </strong>
        </div>`;
      },
    )
    .join("");

  const watchlistRows = watchlist
    .slice(0, 8)
    .map(
      (entry) => {
        const recIcon = entry.currentRecommendation === "simulate_buy" ? "🟢" : entry.currentRecommendation === "watch" ? "🟡" : "⚪";
        const scoreChange = entry.scoreChange > 0 ? `<span class="g">↑${entry.scoreChange}</span>` : entry.scoreChange < 0 ? `<span class="r">↓${Math.abs(entry.scoreChange)}</span>` : "";
        return `
        <div class="status-row">
          <span><a class="watchlist-link" href="${candidateHref(entry.tokenAddress)}" target="_blank" rel="noreferrer">${escapeHtml(entry.tokenSymbol)}</a></span>
          <strong>${recIcon} ${entry.currentScore}/100 · ${entry.appearances}x seen ${scoreChange}</strong>
        </div>`;
      },
    )
    .join("");

  const allTradedPositions = [
    ...portfolioLifecycle.activePositions,
    ...portfolioLifecycle.exitedPositions,
  ].filter(p => p.initialAllocationUsd > 0);
  const profitablePositions = allTradedPositions.filter(
    p => (p.realizedPnlUsd + p.unrealizedPnlUsd) > 0,
  );
  const winRatePct = allTradedPositions.length
    ? (profitablePositions.length / allTradedPositions.length) * 100
    : null;
  const totalPnlUsd = portfolioLifecycle.totalRealizedPnlUsd + portfolioLifecycle.totalUnrealizedPnlUsd;
  const roiPct = portfolioLifecycle.totalAllocatedUsd > 0
    ? (totalPnlUsd / portfolioLifecycle.totalAllocatedUsd) * 100
    : 0;
  const tradeRecords = tradeLedger.records.filter(
    (record) => record.plannedBuyBnb > 0,
  );
  const averageBuyBnb = average(
    tradeRecords.map((record) => record.plannedBuyBnb),
  );
  const holdDurationsMs = (
    portfolioLifecycle.exitedPositions.length > 0
      ? portfolioLifecycle.exitedPositions
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

  const avgPositionUsd = portfolioLifecycle.activePositions.length > 0
    ? portfolioLifecycle.activePositions.reduce((s, p) => s + p.allocationUsd, 0) / portfolioLifecycle.activePositions.length
    : (treasurySimulation.positions.length > 0
      ? treasurySimulation.positions.reduce((s, p) => s + p.allocationUsd, 0) / treasurySimulation.positions.length
      : treasurySimulation.deployableCapitalUsd / Math.max(1, executionState.risk.maxActivePositions || 3));
  const positionSizeBnb = Math.min(1, Math.max(0.01, avgPositionUsd / bnbPriceEst));
  const dailyCapBnb = Math.min(3, positionSizeBnb * 3);

  const riskProfile =
    positionSizeBnb <= 0.1
      ? "Conservative"
      : positionSizeBnb <= 0.5
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
    { label: "ROI", value: `${roiPct >= 0 ? "+" : ""}${roiPct.toFixed(1)}%` },
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
  const gooPct = paperAgents.length > 0 ? (paperAgents.filter(a => a.chainState === 'active').length / paperAgents.length) * 100 : 0;
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
      `${paperAgents.length}`,
      `${acquirableCandidates.length} acquirable`,
      gooPct,
      "cool",
      "ACQUIRABLE",
      "AGENTS",
      `${acquirableCandidates.length}`,
      `${paperAgents.length}`,
    ),
  ].join("");
  const discoveryFoldSummary = `${snapshot.summary.candidateCount} scanned · ${snapshot.summary.topRecommendationCount} buy-ready · avg ${snapshot.summary.averageScore}`;
  const portfolioFoldSummary = `${portfolioLifecycle.activePositions.length} active · ${portfolioLifecycle.watchPositions.length} watch · ${formatBnb(portfolioLifecycle.totalAllocatedUsd / bnbPriceEst)} deployed`;
  const pfw = (portfolioLifecycle as any).flywheel ?? { totalProfitUsd: 0, reinvestedUsd: 0, elizaOKBuybackUsd: 0, airdropReserveUsd: 0, cycleCount: 0, trailingStopSaves: 0, gmgnExitSaves: 0 };
  const flywheelFoldSummary = `$${pfw.totalProfitUsd.toFixed(0)} profit · ${pfw.cycleCount} cycles · ${(portfolioLifecycle as any).winCount ?? 0}W/${(portfolioLifecycle as any).lossCount ?? 0}L`;
  const treasuryFoldSummary = `${formatBnb(positionSizeBnb)}/position · ${eligibleExecutionPlans} eligible · ${tradeLedger.records.length} ledger`;
  const distributionFoldSummary = `${distributionPlan.eligibleHolderCount} holders · ${formatUsd(distributionPlan.distributionPoolUsd)} pool · ${distributionExecution.dryRun ? "standby" : "live"}`;
  const gooFoldSummary = `${paperAgents.length} agents · ${paperAgents.filter(a => a.chainState === 'active').length} active · ${acquirableCandidates.length} acquirable`;
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
    renderProgress("Goo", gooPct, 100, `${paperAgents.filter(a => a.chainState === 'active').length}/${paperAgents.length} active`),
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
      (plan) => {
        const portfolioPos = portfolioLifecycle.activePositions.find(
          (p) => p.tokenAddress === plan.tokenAddress,
        );
        const portfolioAllocBnb = portfolioPos
          ? formatBnb(portfolioPos.allocationUsd / bnbPriceEst)
          : formatBnb(positionSizeBnb);
        const portfolioState = portfolioPos
          ? `${formatUsd(portfolioPos.allocationUsd)} (${portfolioAllocBnb})`
          : "—";
        return `
        <div class="status-row">
          <span>${escapeHtml(plan.tokenSymbol)}</span>
          <strong>
            ${plan.score}/100 · ${plan.eligible ? "eligible" : "blocked"} · ${portfolioAllocBnb}<br />
            <span style="opacity:.6">Allocation: ${portfolioState}</span><br />
            ${escapeHtml(plan.routeReason || plan.reasons[0] || "No execution note.")}
          </strong>
        </div>`;
      },
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
      (position, index) => {
        const entryTime = position.firstSeenAt ? new Date(position.firstSeenAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : "—";
        const entryFdv = position.entryReferenceUsd ? `$${Math.round(position.entryReferenceUsd).toLocaleString()}` : "—";
        const currentFdv = position.currentReferenceUsd ? `$${Math.round(position.currentReferenceUsd).toLocaleString()}` : "—";
        const pnlClass = position.unrealizedPnlPct >= 0 ? "g" : "r";
        const holdMs = Date.parse(position.lastUpdatedAt) - Date.parse(position.firstSeenAt);
        const holdStr = holdMs > 60000 ? (holdMs < 3600000 ? `${Math.round(holdMs / 60000)}m` : `${(holdMs / 3600000).toFixed(1)}h`) : "<1m";
        const awaitingUpdate = Math.abs(position.unrealizedPnlPct) < 0.01;
        const pnlDisplay = awaitingUpdate
          ? '<strong style="color:var(--dim)">Awaiting price update</strong>'
          : `<strong class="${pnlClass}">${position.unrealizedPnlPct >= 0 ? "+" : ""}${position.unrealizedPnlPct.toFixed(1)}%</strong>`;
        const pillDisplay = awaitingUpdate
          ? `<span class="pill" style="background:rgba(255,255,255,.08);color:var(--dim)">${holdStr}</span>`
          : `<span class="pill ${pnlTone(position.unrealizedPnlUsd)}">${position.unrealizedPnlPct >= 0 ? "+" : ""}${position.unrealizedPnlPct.toFixed(1)}%</span>`;
        const tpDisplay = position.takeProfitCount > 0 ? `<strong class="g">${position.takeProfitCount} / 5</strong>` : "";
        return `
        <article class="candidate-card">
          <div class="candidate-card__meta">
            <span class="candidate-rank">0${index + 1}</span>
            ${pillDisplay}
          </div>
          <h3><a class="candidate-link" href="${candidateHref(position.tokenAddress)}" target="_blank" rel="noreferrer">${escapeHtml(position.tokenSymbol)}</a></h3>
          <p class="candidate-subtitle">Score ${position.currentScore}/100 · held ${holdStr} · FDV ${currentFdv}</p>
          <div class="candidate-stats" style="grid-template-columns:1fr 1fr">
            <div><span>Position Size</span><strong>${formatBnb(position.allocationUsd / bnbPriceEst)}</strong></div>
            <div><span>Entry FDV</span><strong>${entryFdv}</strong></div>
            <div><span>P&L</span>${pnlDisplay}</div>${tpDisplay ? `
            <div><span>TP Stages</span>${tpDisplay}</div>` : ""}
            <div><span>Entered</span><strong>${entryTime}</strong></div>
          </div>
        </article>`;
      },
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

  // Derive a human-readable exit label from position exit metadata
  const exitLabelFor = (pos: { trailingStopTriggered?: boolean; gmgnExitReason?: string; exitReason?: string }) => {
    if (pos.trailingStopTriggered) return "Trailing Stop";
    if (pos.gmgnExitReason) return "Smart Exit";
    if (pos.exitReason?.includes("take_profit") || pos.exitReason?.includes("fully harvested")) return "Take Profit";
    if (pos.exitReason?.includes("stop_loss") || pos.exitReason?.includes("Stop loss")) return "Stop Loss";
    if (pos.exitReason?.includes("score") || pos.exitReason?.includes("downgraded")) return "Score Decay";
    if (pos.exitReason?.includes("vanished") || pos.exitReason?.includes("disappeared")) return "Vanished";
    return "Signal Exit";
  };

  const exitedPortfolioCards = portfolioLifecycle.exitedPositions
    .sort((a, b) => Date.parse(b.lastUpdatedAt) - Date.parse(a.lastUpdatedAt))
    .slice(0, 20)
    .map(
      (position, index) => {
        const exitTime = position.lastUpdatedAt ? new Date(position.lastUpdatedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : "—";
        const entryFdv = position.entryReferenceUsd ? `$${Math.round(position.entryReferenceUsd).toLocaleString()}` : "—";
        const exitFdv = position.currentReferenceUsd ? `$${Math.round(position.currentReferenceUsd).toLocaleString()}` : "—";
        const holdMs = Date.parse(position.lastUpdatedAt) - Date.parse(position.firstSeenAt);
        const holdStr = holdMs > 0 ? (holdMs < 3600000 ? `${Math.round(holdMs / 60000)}m` : `${(holdMs / 3600000).toFixed(1)}h`) : "—";
        const pnlClass = position.realizedPnlUsd >= 0 ? "g" : "r";
        const exitLabel = exitLabelFor(position);
        const returnPct = position.initialAllocationUsd > 0 ? `${((position.realizedPnlUsd / position.initialAllocationUsd) * 100).toFixed(1)}%` : "—";
        const tpDisplay = position.takeProfitCount > 0 ? `<div><span>TP Stages</span><strong class="g">${position.takeProfitCount} / 5</strong></div>` : "";
        const exitedFlat = Math.abs(position.realizedPnlUsd) < 0.01;
        const exitPillClass = exitedFlat ? "" : (position.realizedPnlUsd >= 0 ? "tone-hot" : "tone-cold");
        const exitPillStyle = exitedFlat ? ' style="background:rgba(255,255,255,.08);color:var(--dim)"' : "";
        const exitPillText = exitedFlat ? "Flat" : `${position.realizedPnlUsd >= 0 ? "+" : ""}${returnPct}`;
        return `
        <article class="candidate-card">
          <div class="candidate-card__meta">
            <span class="candidate-rank">${String(index + 1).padStart(2, "0")}</span>
            <span class="pill ${exitPillClass}"${exitPillStyle}>${exitPillText}</span>
          </div>
          <h3><a class="candidate-link" href="${candidateHref(position.tokenAddress)}" target="_blank" rel="noreferrer">${escapeHtml(position.tokenSymbol)}</a></h3>
          <p class="candidate-subtitle">${escapeHtml(exitLabel)} · ${holdStr} · ${exitFdv}</p>
          <div class="candidate-stats" style="grid-template-columns:1fr 1fr">
            <div><span>Entry</span><strong>${entryFdv}</strong></div>
            <div><span>Exit</span><strong>${exitFdv}</strong></div>${exitedFlat ? "" : `
            <div><span>P&L</span><strong class="${pnlClass}">${position.realizedPnlUsd >= 0 ? "+" : ""}${formatUsd(position.realizedPnlUsd)}</strong></div>`}${tpDisplay}
            <div><span>Closed</span><strong>${exitTime}</strong></div>
          </div>
        </article>`;
      },
    )
    .join("");

  const watchingPortfolioCards = portfolioLifecycle.watchPositions
    .slice(0, 10)
    .map(
      (position) => {
        const mcap = position.currentReferenceUsd ? `$${Math.round(position.currentReferenceUsd).toLocaleString()}` : "—";
        const convIcon = position.lastConviction === "high" ? "🟢" : position.lastConviction === "medium" ? "🟡" : "⚪";
        return `
        <div class="status-row">
          <span><a class="watchlist-link" href="${candidateHref(position.tokenAddress)}" target="_blank" rel="noreferrer">${escapeHtml(position.tokenSymbol)}</a></span>
          <strong>${convIcon} ${position.currentScore}/100 · FDV ${mcap}</strong>
        </div>`;
      },
    )
    .join("");

  // Strategy backtest / performance report
  const strategyMap = new Map<string, { wins: number; losses: number; totalPnl: number; tokens: string[]; avgHold: number; bestPnl: number; worstPnl: number }>();
  for (const pos of portfolioLifecycle.exitedPositions) {
    const strat = pos.trailingStopTriggered ? "Trailing Stop" : (pos.gmgnExitReason ? "Smart Exit (GMGN)" : (pos.exitReason?.includes("kol_adaptive") ? "KOL-Adaptive TP" : (pos.exitReason?.includes("take_profit") || pos.exitReason?.includes("fully harvested") ? "Multi-Stage TP" : (pos.exitReason?.includes("stop_loss") || pos.exitReason?.includes("Stop loss") ? "Stop Loss" : (pos.exitReason?.includes("vanished") || pos.exitReason?.includes("disappeared") ? "Vanished" : (pos.exitReason?.includes("score") || pos.exitReason?.includes("downgraded") ? "Score Decay" : "Standard Exit"))))));
    const entry = strategyMap.get(strat) ?? { wins: 0, losses: 0, totalPnl: 0, tokens: [], avgHold: 0, bestPnl: -Infinity, worstPnl: Infinity };
    if (pos.realizedPnlUsd > 0) entry.wins++; else entry.losses++;
    entry.totalPnl += pos.realizedPnlUsd;
    if (entry.tokens.length < 5) entry.tokens.push(pos.tokenSymbol);
    const hold = Date.parse(pos.lastUpdatedAt) - Date.parse(pos.firstSeenAt);
    entry.avgHold = (entry.avgHold * (entry.wins + entry.losses - 1) + hold) / (entry.wins + entry.losses);
    entry.bestPnl = Math.max(entry.bestPnl, pos.realizedPnlUsd);
    entry.worstPnl = Math.min(entry.worstPnl, pos.realizedPnlUsd);
    strategyMap.set(strat, entry);
  }
  const strategyReportRows = [...strategyMap.entries()]
    .sort(([, a], [, b]) => b.totalPnl - a.totalPnl)
    .map(([strat, data]) => {
      const total = data.wins + data.losses;
      const wr = total > 0 ? ((data.wins / total) * 100).toFixed(1) : "0.0";
      const avgHold = data.avgHold > 0 ? (data.avgHold < 3600000 ? `${Math.round(data.avgHold / 60000)}m` : `${(data.avgHold / 3600000).toFixed(1)}h`) : "—";
      const pnlClass = data.totalPnl >= 0 ? "g" : "r";
      return `
      <article class="candidate-card">
        <div class="candidate-card__meta">
          <span class="pill ${data.totalPnl >= 0 ? 'tone-hot' : 'tone-cold'}">${strat}</span>
        </div>
        <div class="candidate-stats" style="grid-template-columns:1fr 1fr">
          <div><span>Win / Loss</span><strong><span class="g">${data.wins}</span> / <span class="r">${data.losses}</span></strong></div>
          <div><span>Win Rate</span><strong>${wr}%</strong></div>
          <div><span>Total P&L</span><strong class="${pnlClass}">${data.totalPnl >= 0 ? "+" : ""}${formatUsd(data.totalPnl)}</strong></div>
          <div><span>Avg Hold</span><strong>${avgHold}</strong></div>
          <div><span>Best Trade</span><strong class="g">+${formatUsd(data.bestPnl)}</strong></div>
          <div><span>Worst Trade</span><strong class="r">${formatUsd(data.worstPnl)}</strong></div>
        </div>
        <p class="candidate-thesis" style="margin-top:4px">Tokens: ${data.tokens.map(t => escapeHtml(t)).join(", ")}${total > 5 ? ` +${total - 5} more` : ""}</p>
      </article>`;
    })
    .join("");

  const tokenWinLossRows = portfolioLifecycle.exitedPositions
    .filter((pos) => {
      if (Math.abs(pos.realizedPnlUsd) < 0.01) return false;
      const pct = pos.initialAllocationUsd > 0 ? Math.abs(pos.realizedPnlUsd / pos.initialAllocationUsd) * 100 : 0;
      return pct >= 0.05;
    })
    .sort((a, b) => b.realizedPnlUsd - a.realizedPnlUsd)
    .slice(0, 15)
    .map((pos) => {
      const holdMs = Date.parse(pos.lastUpdatedAt) - Date.parse(pos.firstSeenAt);
      const holdStr = holdMs > 0 ? (holdMs < 3600000 ? `${Math.round(holdMs / 60000)}m` : `${(holdMs / 3600000).toFixed(1)}h`) : "—";
      const exitLabel = exitLabelFor(pos);
      const pnlClass = pos.realizedPnlUsd >= 0 ? "g" : "r";
      const pnlPctStr = pos.initialAllocationUsd > 0 ? `${((pos.realizedPnlUsd / pos.initialAllocationUsd) * 100).toFixed(1)}%` : "—";
      return `
      <div class="status-row">
        <span><a class="watchlist-link" href="${candidateHref(pos.tokenAddress)}" target="_blank" rel="noreferrer">${escapeHtml(pos.tokenSymbol)}</a></span>
        <strong>
          <span class="${pnlClass}">${pos.realizedPnlUsd >= 0 ? "+" : ""}${pnlPctStr}</span> · ${exitLabel} · ${holdStr}
        </strong>
      </div>`;
    })
    .join("");

  // Build cumulative P&L chart from exited positions
  const exitedSorted = [...portfolioLifecycle.exitedPositions]
    .sort((a, b) => Date.parse(a.lastUpdatedAt) - Date.parse(b.lastUpdatedAt));
  let cumPnl = 0;
  const pnlChartData = exitedSorted.map((p, i) => {
    cumPnl += p.realizedPnlUsd;
    return { x: i, y: cumPnl, label: p.tokenSymbol };
  });
  let portfolioPnlChart = '';
  if (pnlChartData.length >= 2) {
    const W = 460, H = 120, PX = 30, PY = 10;
    const minY = Math.min(0, ...pnlChartData.map(d => d.y));
    const maxY = Math.max(0, ...pnlChartData.map(d => d.y));
    const rangeY = maxY - minY || 1;
    const sx = (i: number) => PX + (i / (pnlChartData.length - 1)) * (W - 2 * PX);
    const sy = (v: number) => PY + (1 - (v - minY) / rangeY) * (H - 2 * PY);
    const zeroY = sy(0);
    const pts = pnlChartData.map(d => `${sx(d.x).toFixed(1)},${sy(d.y).toFixed(1)}`).join(' ');
    const areaPath = `M${sx(0).toFixed(1)},${zeroY} L${pts} L${sx(pnlChartData.length - 1).toFixed(1)},${zeroY} Z`;
    const lastPnl = pnlChartData[pnlChartData.length - 1]?.y ?? 0;
    const lineColor = lastPnl >= 0 ? '#22c55e' : '#ef4444';
    const fillColor = lastPnl >= 0 ? 'rgba(34,197,94,.1)' : 'rgba(239,68,68,.1)';
    portfolioPnlChart = `
    <div style="margin-top:12px">
      <div class="split-h">Cumulative P&L (${exitedSorted.length} exits)</div>
      <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;max-height:140px;display:block">
        <path d="${areaPath}" fill="${fillColor}"/>
        <line x1="${PX}" y1="${zeroY}" x2="${W - PX}" y2="${zeroY}" stroke="rgba(255,255,255,.1)" stroke-dasharray="3,3"/>
        <polyline points="${pts}" fill="none" stroke="${lineColor}" stroke-width="1.5" stroke-linejoin="round"/>
        <circle cx="${sx(pnlChartData.length - 1)}" cy="${sy(lastPnl)}" r="3" fill="${lineColor}"/>
        <text x="${PX}" y="${H - 2}" fill="rgba(255,255,255,.3)" font-size="8" font-family="Martian Mono,monospace">$${minY.toFixed(0)}</text>
        <text x="${W - PX}" y="${PY + 6}" fill="rgba(255,255,255,.3)" font-size="8" font-family="Martian Mono,monospace" text-anchor="end">$${maxY.toFixed(0)}</text>
        <text x="${sx(pnlChartData.length - 1)}" y="${sy(lastPnl) - 6}" fill="${lineColor}" font-size="9" font-family="Martian Mono,monospace" text-anchor="end" font-weight="600">${lastPnl >= 0 ? '+' : ''}$${lastPnl.toFixed(0)}</text>
      </svg>
    </div>`;
  }

  const overviewStateChips = [
    `execution ${escapeHtml(executionState.dryRun ? "dry-run" : "live")} / ${escapeHtml(executionState.mode)}`,
    `distribution ${escapeHtml(distributionExecution.dryRun ? "dry-run" : "live")} / ${escapeHtml(distributionPlan.selectedAsset.mode)}`,
    `goo ${escapeHtml(paperAgents.length > 0 ? `${paperAgents.filter(a => a.chainState === 'active').length}/${paperAgents.length} active` : "standby")}`,
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
    `${formatBnb(positionSizeBnb)} per position`,
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
      "Paper Capital",
      formatUsd(treasurySimulation.paperCapitalUsd),
      "Simulated capital baseline for signal tracking & backtesting.",
    ),
    renderMetricCard(
      "Deployable",
      formatUsd(treasurySimulation.deployableCapitalUsd),
      "Simulated capital available for new allocation.",
    ),
    renderMetricCard(
      "Deployed",
      `${formatBnb(treasurySimulation.allocatedUsd / bnbPriceEst)}`,
      "Simulated capital assigned to active positions.",
    ),
    renderMetricCard(
      "Dry powder",
      formatUsd(treasurySimulation.dryPowderUsd),
      "Remaining unallocated simulated capacity.",
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
      formatBnb(positionSizeBnb),
      `Daily cap ${formatBnb(dailyCapBnb)}.`,
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
      "Eligible Holders",
      String(distributionPlan.eligibleHolderCount),
      `Qualified $elizaOK wallets.`,
    ),
    renderMetricCard(
      "Value Pool",
      formatUsd(distributionPlan.distributionPoolUsd),
      `From treasury flywheel (15% airdrop reserve).`,
    ),
    renderMetricCard(
      "Recipients",
      String(distributionPlan.recipients.length),
      `Qualified for this distribution cycle.`,
    ),
    renderMetricCard(
      "Readiness",
      `${distributionExecution.readinessScore}/${distributionExecution.readinessTotal}`,
      distributionExecution.dryRun ? "Standby — awaiting activation." : "Live distribution active.",
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
  ${renderHeadBrandAssets("elizaOK")}
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
    html { scrollbar-width: none; }
    html::-webkit-scrollbar { display: none; }
    body { overscroll-behavior-y: contain; -webkit-overflow-scrolling: touch; }
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
    .tb-goo-icon { width: 16px; height: 16px; border-radius: 50%; vertical-align: middle; margin-right: 2px; filter: drop-shadow(0 0 4px rgba(0,199,210,.5)); }
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
      box-shadow: 0 0 16px rgba(var(--yr),.18), 0 0 32px rgba(var(--yr),.06);
      animation: sbAvatarGlow 3s ease-in-out infinite;
      transition: transform .35s cubic-bezier(.34,1.56,.64,1), box-shadow .4s, border-color .3s;
      cursor: pointer; position: relative;
    }
    .sb-agent__avatar:hover {
      transform: translateY(-4px) scale(1.1);
      box-shadow: 0 0 28px rgba(var(--yr),.4), 0 0 56px rgba(var(--yr),.14), 0 8px 20px rgba(0,0,0,.3);
      border-color: rgba(var(--yr),.6);
    }
    @keyframes sbAvatarGlow {
      0%, 100% { box-shadow: 0 0 14px rgba(var(--yr),.15), 0 0 28px rgba(var(--yr),.05); }
      50% { box-shadow: 0 0 22px rgba(var(--yr),.28), 0 0 44px rgba(var(--yr),.1); }
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
      border: 1px solid transparent; cursor: pointer; transition: all .2s cubic-bezier(.4,0,.2,1);
    }
    .recent-item:hover { background: var(--panel2); border-color: var(--border); transform: translateX(3px); }
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
      transition: all .3s cubic-bezier(.4,0,.2,1);
    }
    .panel:hover {
      border-color: rgba(var(--yr), .25);
      box-shadow: 0 0 20px rgba(0,0,0,.3), 0 0 0 1px rgba(var(--yr), .08);
      transform: translateY(-1px);
    }
    .panel__head {
      display: flex; align-items: center; gap: 8px;
      padding: 9px 12px; border-bottom: 1px solid var(--border);
      background: var(--panel2); flex-shrink: 0;
      transition: background .2s;
    }
    .panel:hover .panel__head { background: rgba(var(--yr), .04); }
    .panel__title { font-size: 0.72rem; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; color: var(--dim); }
    .panel__badge {
      font-size: 0.58rem; letter-spacing: 0.1em; text-transform: uppercase;
      padding: 2px 8px; border-radius: 999px; border: 1px solid; margin-left: auto;
    }
    .pb-green  { color: var(--green); border-color: rgba(var(--gr),.35); }
    .pb-yellow { color: var(--yellow); border-color: rgba(var(--yr),.35); }
    .pb-red    { color: var(--red); border-color: rgba(255,68,68,.35); animation: badge-alert 1.5s ease-in-out infinite; }
    @keyframes badge-alert { 0%,100%{box-shadow:none;} 50%{box-shadow:0 0 8px rgba(255,68,68,.3);} }
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
    .mon-big { font-size: 1.5rem; font-weight: 800; color: var(--yellow); line-height: 1; margin-bottom: 3px; text-shadow: 0 0 12px rgba(var(--yr), .3); transition: transform .2s; }
    .mon-big:hover { transform: scale(1.05); }
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

    /* Avatar glow + hover float */
    .sidebar-avatar {
      width: 38px; height: 38px; border-radius: 10px; overflow: hidden; flex-shrink: 0;
      border: 1px solid rgba(246,231,15,.2);
      box-shadow: 0 0 14px rgba(246,231,15,.15), 0 0 28px rgba(246,231,15,.06);
      animation: avatarBreath 3s ease-in-out infinite;
      transition: transform .3s, box-shadow .4s;
      cursor: pointer; position: relative;
    }
    .sidebar-avatar:hover {
      transform: translateY(-3px) scale(1.08);
      box-shadow: 0 0 24px rgba(246,231,15,.35), 0 0 48px rgba(246,231,15,.12), 0 4px 16px rgba(0,0,0,.3);
    }
    .sidebar-avatar::after {
      content: ""; position: absolute; inset: -5px; border-radius: 14px;
      border: 1px solid rgba(246,231,15,0); transition: border-color .4s; pointer-events: none;
    }
    .sidebar-avatar:hover::after { border-color: rgba(246,231,15,.2); }
    .sidebar-avatar__image, .sidebar-avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
    @keyframes avatarBreath {
      0%, 100% { box-shadow: 0 0 12px rgba(246,231,15,.12), 0 0 24px rgba(246,231,15,.04); }
      50% { box-shadow: 0 0 20px rgba(246,231,15,.22), 0 0 36px rgba(246,231,15,.08); }
    }

    /* Token Explorer — compact tile grid */
    .te-section { padding: 2px 0; }
    .te-label { font-size: 0.58rem; color: var(--dim); text-transform: uppercase; letter-spacing: .1em; padding: 4px 8px 3px; font-weight: 600; }
    .te-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(90px, 1fr)); gap: 3px; padding: 0 4px; }
    .te-tile {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      padding: 6px 4px; border-radius: 6px; cursor: pointer;
      background: rgba(255,255,255,.02); border: 1px solid rgba(255,255,255,.04);
      transition: all .2s; text-decoration: none; position: relative; overflow: hidden;
    }
    .te-tile:hover { background: rgba(246,231,15,.06); border-color: rgba(246,231,15,.15); transform: translateY(-1px); }
    .te-tile__name {
      font-size: 0.65rem; font-weight: 700; color: var(--yellow);
      max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: center;
    }
    .te-tile__score { font-size: 0.72rem; font-weight: 800; color: var(--white); line-height: 1; margin: 2px 0 1px; }
    .te-tile__dot { font-size: 0.5rem; }
    .te-tile--buy .te-tile__score { color: var(--green); }
    .te-tile--watch .te-tile__score { color: var(--yellow); }
    .te-tile--held { border-color: rgba(34,197,94,.15); background: rgba(34,197,94,.04); }
    .te-tile--held .te-tile__name { color: var(--green); }
    .te-tile--held:hover { border-color: rgba(34,197,94,.3); background: rgba(34,197,94,.08); }

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
      display: flex; align-items: center; gap: 10px;
      padding: 7px 4px; border-bottom: 1px solid rgba(255,255,255,.04);
      font-size: 0.78rem; cursor: pointer; transition: background .15s, padding-left .15s;
      border-radius: 4px;
    }
    .cand-row:last-child { border-bottom: none; }
    .cand-row:hover { background: var(--panel2); padding-left: 6px; }
    .cand-row__rank { color: var(--mute); width: 18px; flex-shrink: 0; font-size: 0.68rem; font-weight: 600; text-align: center; }
    .cand-row__sym { color: var(--yellow); font-weight: 700; max-width: 80px; min-width: 0; flex-shrink: 1; font-size: 0.8rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cand-row__sym a { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cand-row__score { color: var(--white); width: 50px; flex-shrink: 0; font-weight: 600; font-size: 0.72rem; }
    .cand-row__pill {
      font-size: 0.6rem; letter-spacing: 0.06em; text-transform: uppercase;
      padding: 2px 8px; border: 1px solid; border-radius: 999px; font-weight: 600;
    }
    .tone-hot  { color:#F6E70F; border-color:rgba(246,231,15,.4); background:rgba(246,231,15,.06); }
    .tone-warm { color:#FFB700; border-color:rgba(255,183,0,.35); background:rgba(255,183,0,.04); }
    .tone-cool { color:rgba(255,255,255,.55); border-color:rgba(255,255,255,.18); }
    .tone-cold { color:rgba(255,255,255,.28); border-color:rgba(255,255,255,.12); }
    .cand-row__meta { color: var(--mute); font-size: 0.68rem; margin-left: auto; font-weight: 500; }
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

    /* Cloud CTA card — matches aside-block style */
    .cloud-card { border-color: rgba(0,199,210,.18) !important; transition: border-color .3s, box-shadow .3s; }
    .cloud-card:hover { border-color: rgba(0,199,210,.4) !important; box-shadow: 0 2px 16px rgba(0,199,210,.1); }
    .cloud-card__banner { border-radius: 6px; overflow: hidden; margin-bottom: 10px; }
    .cloud-card__img { width: 100%; height: 70px; object-fit: cover; display: block; border-radius: 6px; }
    .cloud-card__title { font-size: 0.72rem; font-weight: 700; color: #00C7D2; letter-spacing: .04em; margin-bottom: 2px; }
    .cloud-card__sub { font-size: 0.55rem; color: var(--dim); letter-spacing: .08em; text-transform: uppercase; margin-bottom: 8px; }
    .cloud-card__features { display: flex; flex-direction: column; gap: 3px; margin-bottom: 10px; }
    .cloud-card__feat { font-size: 0.6rem; color: rgba(245,245,240,.6); }
    .cloud-card__btn { display: block; text-align: center; font-family: inherit; font-size: 0.58rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; text-decoration: none; padding: 7px 10px; border-radius: 6px; background: rgba(0,199,210,.1); border: 1px solid rgba(0,199,210,.25); color: #00C7D2; transition: all .25s; }
    .cloud-card__btn:hover { background: rgba(0,199,210,.2); border-color: #00C7D2; color: #fff; text-decoration: none; }
    [data-theme="light"] .cloud-card { border-color: rgba(0,199,210,.15) !important; }
    [data-theme="light"] .cloud-card__feat { color: rgba(0,0,0,.5); }
    [data-theme="light"] .cloud-card__btn { background: rgba(0,199,210,.06); color: #0097a0; }

    /* ElizaCloud CTA in main content */
    .cloud-main-cta { margin-top: 16px; }
    .cloud-main-cta__inner {
      display: flex; align-items: stretch; gap: 0;
      background: linear-gradient(135deg, rgba(0,199,210,.06), rgba(139,92,246,.04), var(--panel));
      border: 1px solid rgba(0,199,210,.2); border-radius: var(--r);
      overflow: hidden; transition: border-color .3s, box-shadow .3s, transform .3s;
    }
    .cloud-main-cta__inner:hover { border-color: rgba(0,199,210,.45); box-shadow: 0 4px 24px rgba(0,199,210,.12), 0 0 40px rgba(139,92,246,.06); transform: translateY(-2px); }
    .cloud-main-cta__img-wrap { width: 200px; flex-shrink: 0; overflow: hidden; }
    .cloud-main-cta__img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform .4s; }
    .cloud-main-cta__inner:hover .cloud-main-cta__img { transform: scale(1.05); }
    .cloud-main-cta__content { padding: 20px 24px; display: flex; flex-direction: column; justify-content: center; gap: 4px; flex: 1; }
    .cloud-main-cta__title { font-size: 1.1rem; font-weight: 800; color: #00C7D2; letter-spacing: .02em; }
    .cloud-main-cta__sub { font-size: 0.65rem; color: var(--dim); letter-spacing: .1em; text-transform: uppercase; margin-bottom: 8px; }
    .cloud-main-cta__features { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 12px; }
    .cloud-main-cta__features span { font-size: 0.65rem; color: rgba(245,245,240,.6); white-space: nowrap; }
    .cloud-main-cta__btn {
      display: inline-block; text-align: center; font-family: inherit; font-size: 0.65rem; font-weight: 700;
      letter-spacing: .1em; text-transform: uppercase; text-decoration: none;
      padding: 10px 20px; border-radius: 8px; width: fit-content;
      background: linear-gradient(135deg, rgba(0,199,210,.15), rgba(139,92,246,.1));
      border: 1px solid rgba(0,199,210,.3); color: #00C7D2; transition: all .25s;
    }
    .cloud-main-cta__btn:hover { background: linear-gradient(135deg, rgba(0,199,210,.25), rgba(139,92,246,.15)); border-color: #00C7D2; box-shadow: 0 0 20px rgba(0,199,210,.2); color: #fff; text-decoration: none; }
    @media (max-width: 600px) {
      .cloud-main-cta__inner { flex-direction: column; }
      .cloud-main-cta__img-wrap { width: 100%; height: 100px; }
      .cloud-main-cta__content { padding: 14px 16px; }
    }
    [data-theme="light"] .cloud-main-cta__inner { background: linear-gradient(135deg, rgba(0,199,210,.04), rgba(139,92,246,.03), #fff); }
    [data-theme="light"] .cloud-main-cta__features span { color: rgba(0,0,0,.5); }
    [data-theme="light"] .cloud-main-cta__btn { background: rgba(0,199,210,.08); color: #0097a0; }

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
      background: var(--panel2); transition: all .2s;
    }
    summary.panel-accord__sum:hover { background: #161616; border-left: 2px solid var(--yellow); padding-left: 10px; }
    .panel-accord__sum::-webkit-details-marker { display: none; }
    .panel-accord__title { font-size: 0.75rem; font-weight: 700; color: var(--white); }
    .panel-accord__meta  { font-size: 0.65rem; color: var(--dim); margin-left: auto; }
    .panel-accord__arr   { font-size: 0.65rem; color: var(--mute); transition: transform .2s; }
    details.panel-accord[open] .panel-accord__arr { transform: rotate(180deg); }
    .panel-accord__body  { padding: 12px; border-top: 1px solid var(--border); }

    /* Metric grid */
    .metric-grid { display: grid; grid-template-columns: repeat(3,1fr); gap: 8px; }
    .metric-card { padding: 10px 12px; background: var(--panel2); border: 1px solid var(--border); border-radius: var(--r-sm); transition: all .2s; }
    .metric-card:hover { border-color: rgba(var(--yr),.3); background: rgba(var(--yr),.04); transform: translateY(-1px); }
    .metric-card__label { font-size: 0.58rem; letter-spacing: 0.14em; text-transform: uppercase; color: var(--mute); margin-bottom: 4px; }
    .metric-card__val { font-size: 1.05rem; font-weight: 700; color: var(--yellow); transition: text-shadow .2s; }
    .metric-card:hover .metric-card__val { text-shadow: 0 0 10px rgba(var(--yr),.4); }
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
      .mobile-agent-banner { display: flex !important; }
      .mobile-cloud-strip { display: flex !important; }
      .panel-row--3 { grid-template-columns: 1fr; }
      .panel-row--2 { grid-template-columns: 1fr; }
      .panel-row--2-3 { grid-template-columns: 1fr; }
    }
    .mobile-agent-banner {
      display: none;
      align-items: center; gap: 12px;
      padding: 10px 14px;
      background: var(--panel); border-bottom: 1px solid var(--border);
    }
    .mobile-agent-banner__avatar {
      width: 36px; height: 36px; border-radius: 50%;
      border: 1.5px solid rgba(var(--yr),.35);
      box-shadow: 0 0 12px rgba(var(--yr),.2);
      flex-shrink: 0;
    }
    .mobile-agent-banner__info { flex: 1; min-width: 0; }
    .mobile-agent-banner__name { font-size: 13px; font-weight: 700; color: var(--yellow); }
    .mobile-agent-banner__role { font-size: 9px; color: var(--dim); letter-spacing: .06em; text-transform: uppercase; }
    @media (max-width: 640px) {
      .topbar { height: auto; min-height: 40px; flex-wrap: wrap; padding: 8px 10px; gap: 6px; }
      .topbar__nav { order: 1; }
      .topbar__right { order: 2; flex-wrap: wrap; gap: 4px; margin-left: auto; }
      .tb-btn { font-size: 0.58rem; padding: 4px 7px; letter-spacing: .06em; }
      .tb-btn svg { width: 12px; height: 12px; }
      .tb-nav-btn { font-size: 0.58rem; padding: 4px 8px; }
      .topbar__time { font-size: 0.6rem; }
      .main { padding: 10px 8px; }
      .panel { border-radius: 10px; }
      .panel__title { font-size: 0.6rem; }
      .feature-card { padding: 10px; }
      .feature-card__pct { font-size: 1.1rem; }
      .feature-card__val { font-size: 0.72rem; }
      .feature-card__label { font-size: 0.52rem; }
      .split-grid { grid-template-columns: 1fr; }
    }

    /* ─── ARENA PREVIEW ──────────────────── */
    .arena-preview {
      margin-top: 10px; padding: 14px;
      background: var(--panel); border: 1px solid var(--border); border-radius: var(--r);
    }
    .arena-preview__head {
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 12px;
    }
    .arena-preview__title {
      font-size: 0.72rem; font-weight: 700; letter-spacing: .1em;
      text-transform: uppercase; color: var(--dim);
      display: flex; align-items: center; gap: 6px;
    }
    .arena-title-avatar {
      position: relative; display: inline-flex; width: 24px; height: 24px; flex-shrink: 0;
    }
    .arena-title-avatar img {
      width: 24px; height: 24px; border-radius: 50%; object-fit: cover;
      position: relative; z-index: 1;
    }
    .arena-title-avatar::before {
      content: ''; position: absolute; inset: -3px; border-radius: 50%;
      background: conic-gradient(from 0deg, #00C7D2, #8b5cf6, #00C7D2);
      animation: avatarGlow 3s linear infinite;
      opacity: .65; z-index: 0; filter: blur(3px);
    }
    .arena-title-avatar::after {
      content: ''; position: absolute; inset: -6px; border-radius: 50%;
      background: radial-gradient(circle, rgba(0,199,210,.3) 0%, transparent 70%);
      animation: avatarPulse 2s ease-in-out infinite; z-index: 0;
    }
    .arena-preview__link {
      font-size: 0.6rem; color: var(--yellow); text-decoration: none;
      letter-spacing: .06em; font-weight: 600;
    }
    .arena-preview__link:hover { text-decoration: underline; }
    .arena-preview__desc {
      margin: -4px 0 12px; font-size: 0.62rem; line-height: 1.6;
      color: var(--mute); letter-spacing: .01em;
    }
    .arena-preview__desc strong { color: var(--yellow); font-weight: 600; }
    .arena-grid {
      display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px;
    }
    .arena-card {
      background: rgba(255,255,255,.02); border: 1px solid rgba(255,255,255,.06);
      border-radius: 10px; padding: 12px; cursor: pointer;
      transition: all .2s; position: relative;
    }
    .arena-card:hover { border-color: rgba(255,255,255,.15); background: rgba(255,255,255,.04); transform: translateY(-2px); box-shadow: 0 4px 16px rgba(0,0,0,.2); }
    .arena-card--leader { border-color: rgba(var(--yr),.25); background: rgba(var(--yr),.03); }
    .arena-card--leader:hover { border-color: rgba(var(--yr),.5); box-shadow: 0 4px 20px rgba(var(--yr),.15); }
    .arena-card__rank {
      position: absolute; top: 8px; right: 10px;
      font-size: 0.6rem; font-weight: 800; color: var(--mute);
      letter-spacing: .04em;
    }
    .arena-card--leader .arena-card__rank { color: var(--yellow); }
    .arena-card__head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
    .arena-card__avatar { position: relative; width: 28px; height: 28px; flex-shrink: 0; }
    .arena-card__avatar img { width: 28px; height: 28px; border-radius: 50%; object-fit: cover; position: relative; z-index: 1; }
    .arena-card__avatar::before {
      content: ''; position: absolute; inset: -3px; border-radius: 50%;
      background: conic-gradient(from 0deg, #00C7D2, #8b5cf6, #00C7D2);
      animation: avatarGlow 3s linear infinite;
      opacity: .7; z-index: 0; filter: blur(3px);
    }
    .arena-card__avatar::after {
      content: ''; position: absolute; inset: -6px; border-radius: 50%;
      background: radial-gradient(circle, rgba(0,199,210,.25) 0%, transparent 70%);
      animation: avatarPulse 2s ease-in-out infinite; z-index: 0;
    }
    @keyframes avatarGlow { to { transform: rotate(360deg); } }
    @keyframes avatarPulse { 0%,100% { opacity: .4; transform: scale(1); } 50% { opacity: .8; transform: scale(1.15); } }
    .arena-card__dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
    .arena-card__name { font-size: 0.72rem; font-weight: 700; color: var(--white); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .arena-card__badge {
      font-size: 0.45rem; padding: 2px 6px; border-radius: 10px;
      background: rgba(255,255,255,.06); color: var(--dim);
      letter-spacing: .06em; text-transform: uppercase; font-weight: 600;
      white-space: nowrap;
    }
    .arena-card__pnl { font-size: 1rem; font-weight: 800; margin-bottom: 4px; }
    .arena-card__pnl.g { color: var(--green); }
    .arena-card__pnl.r { color: #ef4444; }
    .arena-card__stats {
      display: flex; gap: 8px; font-size: 0.55rem; color: var(--dim);
      margin-bottom: 8px;
    }
    .arena-card__bar { height: 3px; background: rgba(255,255,255,.06); border-radius: 2px; margin-bottom: 4px; }
    .arena-card__bar-fill { height: 100%; border-radius: 2px; background: linear-gradient(90deg, rgba(var(--yr),.3), var(--yellow)); transition: width .8s; }
    .arena-card__score { font-size: 0.52rem; color: var(--mute); letter-spacing: .04em; }
    .arena-card__score strong { color: var(--dim); }
    @media (max-width: 960px) { .arena-grid { grid-template-columns: repeat(2, 1fr); } }
    @media (max-width: 640px) {
      .arena-preview { padding: 10px; margin-top: 8px; }
      .arena-preview__title { font-size: 0.6rem; }
      .arena-preview__desc { font-size: 0.54rem; margin-bottom: 10px; }
      .arena-grid { grid-template-columns: 1fr 1fr; gap: 6px; }
      .arena-card { padding: 10px; }
      .arena-card__name { font-size: 0.62rem; }
      .arena-card__pnl { font-size: 0.82rem; }
      .arena-card__stats { font-size: 0.48rem; gap: 5px; }
      .arena-card__badge { font-size: 0.4rem; }
    }
    @media (max-width: 400px) { .arena-grid { grid-template-columns: 1fr; } }
    [data-theme="light"] .arena-card { background: rgba(0,0,0,.01); border-color: rgba(0,0,0,.06); }
    [data-theme="light"] .arena-card:hover { background: rgba(0,0,0,.03); border-color: rgba(0,0,0,.12); }
    [data-theme="light"] .arena-card--leader { background: rgba(var(--yr),.03); border-color: rgba(var(--yr),.15); }

    /* ─── STATUS STRIP ─────────────────────── */
    .status-strip {
      display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px;
      padding: 8px 10px; background: var(--panel); border: 1px solid var(--border); border-radius: var(--r);
    }
    .ss-chip {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 5px 10px; border-radius: 20px;
      background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.06);
      font-size: 0.6rem; color: var(--dim); text-decoration: none;
      transition: all .2s; cursor: pointer;
    }
    .ss-chip:hover { background: rgba(255,255,255,.07); border-color: rgba(255,255,255,.15); color: var(--white); transform: translateY(-1px); }
    .ss-chip strong { color: var(--white); font-weight: 600; font-size: 0.6rem; }
    .ss-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
    .ss-label { letter-spacing: .06em; text-transform: uppercase; font-weight: 500; }
    .mobile-cloud-strip {
      display: none; align-items: center; gap: 8px;
      padding: 8px 14px; background: rgba(0,199,210,.04);
      border-bottom: 1px solid rgba(0,199,210,.12);
      font-size: 11px; color: var(--dim);
    }
    .mobile-cloud-strip__btn {
      margin-left: auto; padding: 4px 12px; border-radius: 14px;
      background: rgba(0,199,210,.1); border: 1px solid rgba(0,199,210,.25);
      color: #00C7D2; font-size: 10px; font-weight: 600; text-decoration: none;
      letter-spacing: .04em;
    }
    @media (max-width: 640px) {
      .status-strip { gap: 3px; padding: 6px 8px; flex-wrap: wrap; }
      .ss-chip { padding: 3px 7px; font-size: 0.5rem; border-radius: 14px; }
      .ss-chip strong { font-size: 0.5rem; }
      .ss-label { display: none; }
      .ss-dot { width: 5px; height: 5px; }
    }
    @media (min-width: 641px) and (max-width: 860px) {
      .status-strip { gap: 5px; }
      .ss-chip { font-size: 0.55rem; }
    }

    /* ─── MOBILE ────────────────────────────── */
    @media (max-width: 640px) {
      html, body { overflow: auto; }
      body { font-size: 12px; }
      .layout { height: auto; min-height: 100vh; }
      .topbar {
        height: auto; min-height: 44px; flex-wrap: wrap;
        padding: 8px 10px; gap: 6px;
      }
      .topbar__nav { order: 2; width: 100%; }
      .topbar__right { order: 1; width: 100%; justify-content: flex-end; flex-wrap: wrap; gap: 5px; }
      .tb-nav-btn { font-size: 0.65rem; padding: 4px 10px; }
      .tb-btn { font-size: 0.62rem; padding: 4px 8px; }
      .content-area { flex-direction: column; overflow: visible; }
      .main { padding: 8px; overflow: visible; }
      .panel-row { gap: 8px; margin-bottom: 8px; }
      .panel-row--3, .panel-row--2, .panel-row--2-3, .panel-row--1 { grid-template-columns: 1fr; }
      .panel__head { padding: 8px 10px; }
      .panel__title { font-size: 0.68rem; }
      .panel__body { padding: 10px; }
      .mon-big { font-size: 1.3rem; }
      .aside-big { font-size: 1.4rem; }
      .metric-grid { grid-template-columns: 1fr 1fr; gap: 6px; }
      .metric-card { padding: 8px 10px; }
      .metric-card__val { font-size: 0.9rem; }
      .split-grid { grid-template-columns: 1fr; gap: 10px; }
      .h-modal { max-width: 100%; max-height: 92vh; border-radius: 8px; }
      .h-modal-backdrop { padding: 10px; }
      .h-cloud-popup__inner { width: 100%; padding: 20px; }
      .sched-row { font-size: 0.72rem; flex-wrap: wrap; gap: 2px; }
      .cand-row { font-size: 0.7rem; flex-wrap: wrap; gap: 4px; }
      .cand-row__meta { width: 100%; text-align: left; }
      .term-body { max-height: 180px; font-size: 0.62rem; overflow-x: auto; }
      .term-line .msg { word-break: break-all; }
      .prompt-line { font-size: 0.6rem; }
      .te-grid { grid-template-columns: repeat(3, 1fr); gap: 4px; }
      .te-tile { padding: 6px 4px; }
      .te-tile__name { font-size: 0.55rem; }
      .te-tile__score { font-size: 0.7rem; }
      .np-footer { flex-wrap: wrap; gap: 4px; font-size: 0.44rem; }
      .cloud-card__img { height: 50px; }
      .cloud-card__feat { font-size: 0.52rem; }
      .cloud-card__btn { font-size: 0.52rem; padding: 5px 8px; }
    }

    @media (max-width: 400px) {
      .topbar { padding: 6px 8px; }
      .tb-nav-btn { font-size: 0.58rem; padding: 3px 8px; }
      .tb-btn { font-size: 0.55rem; padding: 3px 6px; }
      .main { padding: 6px; }
      .panel-row { gap: 6px; margin-bottom: 6px; }
      .panel__head { padding: 7px 8px; }
      .panel__body { padding: 8px; }
      .metric-grid { grid-template-columns: 1fr 1fr; }
      .te-grid { grid-template-columns: repeat(3, 1fr); }
      .term-body { max-height: 150px; font-size: 0.58rem; }
      .term-line .tag { font-size: 0.48rem; padding: 1px 3px; }
      .ss-chip { padding: 2px 6px; font-size: 0.46rem; }
      .ss-chip strong { font-size: 0.46rem; }
    }

    /* ─── Extra mobile polish ───────────────── */
    @media (max-width: 640px) {
      .panel-accord__sum { font-size: 0.7rem; padding: 8px 10px; }
      .panel-accord__meta { display: none; }
      .panel-accord__body { padding: 8px; }
      .status-row { font-size: 0.68rem; flex-wrap: wrap; }
      .status-row span { width: 100%; font-size: 0.6rem; }
      .candidate-stats { grid-template-columns: 1fr 1fr; gap: 4px; }
      .candidate-stats div span { font-size: 0.5rem; }
      .candidate-stats div strong { font-size: 0.62rem; word-break: break-all; }
      .candidate-card { padding: 10px; }
      .candidate-card h3 { font-size: 0.72rem; }
      .candidate-card__meta { gap: 4px; }
      .candidate-subtitle { font-size: 0.55rem; }
      .candidate-rank { font-size: 0.6rem; min-width: 18px; }
      .pill { font-size: 0.5rem; padding: 2px 6px; }
      #notif-toast-area { max-width: 220px; right: 6px; top: 6px; }
      .nt-body strong { font-size: 9px; }
      .aside-block { padding: 8px; }
      .aside-title { font-size: 0.6rem; }
      .evt-timeline { max-height: 120px; }
      .nt-detail { font-size: 8px; }
      .nt-toast { padding: 5px 8px; gap: 4px; }
      .nt-icon { font-size: 11px; }
      .sb-section { padding: 8px; }
      .feature-card__percent { font-size: 1.2rem; }
      .feature-card__label { font-size: 0.6rem; }
      .candidate-thesis { font-size: 0.54rem !important; line-height: 1.5; }
      .split-h { font-size: 0.6rem; }
      .metric { padding: 6px; }
      .metric span { font-size: 0.48rem; }
      .metric strong { font-size: 0.62rem; word-break: break-all; }
      .mobile-agent-banner { padding: 8px 10px; gap: 8px; }
      .mobile-agent-banner__avatar { width: 30px; height: 30px; }
      .mobile-agent-banner__name { font-size: 12px; }
      .mobile-cloud-strip { padding: 6px 10px; font-size: 10px; }
      .mobile-cloud-strip__btn { padding: 3px 10px; font-size: 9px; }
      .accord-panel { gap: 6px; }
    }

    /* ─── LIGHT MODE OVERRIDES ───────────────── */
    [data-theme="light"] .sidebar { background: #fafaf7; border-right-color: var(--border); }
    [data-theme="light"] .aside { background: #fafaf7; border-left-color: var(--border); }
    [data-theme="light"] .panel { background: #ffffff; border-color: var(--border); }
    [data-theme="light"] .panel:hover { border-color: rgba(var(--yr),.35); }
    [data-theme="light"] .feature-card { background: #ffffff; border-color: #e0dfd8; }
    [data-theme="light"] .feature-card:hover { border-color: rgba(var(--yr),.5); }
    [data-theme="light"] .feature-card__bar { background: #e8e8e4; }
    [data-theme="light"] .overview-bars { background: #ffffff; border-color: #e0dfd8; }
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

    /* ── Event Timeline ── */
    .evt-timeline{max-height:320px;overflow-y:auto;padding:4px 0;}
    .evt-timeline__empty{font-size:11px;color:var(--dim);text-align:center;padding:16px;}
    .evt-item{display:flex;gap:10px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.04);animation:evtSlide .3s ease-out both;font-size:11px;}
    .evt-item:last-child{border-bottom:none;}
    @keyframes evtSlide{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}
    .evt-item__icon{font-size:14px;flex-shrink:0;width:24px;text-align:center;margin-top:1px;}
    .evt-item__body{flex:1;min-width:0;}
    .evt-item__title{font-weight:600;color:var(--text);margin-bottom:1px;}
    .evt-item__detail{color:var(--dim);font-size:10px;line-height:1.4;}
    .evt-item__time{font-size:9px;color:rgba(255,255,255,.25);flex-shrink:0;margin-top:2px;}
    .evt-item--buy .evt-item__title{color:#22c55e;}
    .evt-item--sell .evt-item__title,.evt-item--smart_exit .evt-item__title{color:#ef4444;}
    .evt-item--acquisition .evt-item__title{color:#8b5cf6;}
    .evt-item--respawn .evt-item__title{color:#00C7D2;}
    [data-theme="light"] .evt-item{border-bottom-color:rgba(0,0,0,.06);}

    /* ── Toast Notifications ── */
    #notif-toast-area{position:fixed;top:12px;right:12px;z-index:9999;display:flex;flex-direction:column;gap:5px;pointer-events:none;max-width:280px;width:100%;}
    .nt-toast{pointer-events:auto;display:flex;align-items:center;gap:6px;padding:7px 10px;border-radius:8px;background:rgba(18,18,16,.92);border:1px solid rgba(255,255,255,.08);backdrop-filter:blur(12px);box-shadow:0 4px 16px rgba(0,0,0,.35);opacity:0;transform:translateX(30px);transition:opacity .25s,transform .25s;}
    .nt-toast.nt-show{opacity:1;transform:translateX(0);}
    .nt-toast.nt-hide{opacity:0;transform:translateX(30px) scale(.95);transition:opacity .3s,transform .3s;}
    .nt-icon{font-size:13px;flex-shrink:0;}
    .nt-body{flex:1;min-width:0;}
    .nt-body strong{display:block;font-size:10px;color:#fff;margin-bottom:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .nt-detail{display:block;font-size:9px;color:rgba(255,255,255,.45);line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .nt-close{background:none;border:none;color:rgba(255,255,255,.25);font-size:14px;cursor:pointer;padding:0 1px;line-height:1;flex-shrink:0;transition:color .15s,transform .15s;}
    .nt-close:hover{color:#fff;transform:scale(1.2);}
    .nt-info{border-left:2px solid #00C7D2;}
    .nt-warn{border-left:2px solid #EAB308;}
    .nt-crit{border-left:2px solid #EF4444;}
    .nt-ok{border-left:2px solid #22C55E;}
    .nt-progress{position:absolute;bottom:0;left:0;height:2px;background:rgba(255,255,255,.15);border-radius:0 0 0 8px;animation:ntCountdown 5s linear forwards;}
    @keyframes ntCountdown{from{width:100%}to{width:0%}}
    [data-theme="light"] .nt-toast{background:rgba(255,255,255,.95);border-color:rgba(0,0,0,.08);box-shadow:0 2px 12px rgba(0,0,0,.08);}
    [data-theme="light"] .nt-body strong{color:#1a1a1a;}
    [data-theme="light"] .nt-detail{color:rgba(0,0,0,.5);}
    [data-theme="light"] .nt-close{color:rgba(0,0,0,.25);}
    [data-theme="light"] .nt-close:hover{color:#000;}
    [data-theme="light"] .nt-progress{background:rgba(0,0,0,.1);}
  </style>
</head>
<body>
  <canvas id="dot-canvas"></canvas>
  <div id="notif-toast-area"></div>

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
        <a class="tb-nav-btn" href="/" style="border-color:rgba(var(--yr),.5);color:var(--yellow);">&#x2190; Home</a>
      </nav>
      <div class="topbar__right">
        <span class="topbar__time" id="tb-time"></span>
        <button class="tb-btn live"><span style="display:inline-block;width:5px;height:5px;border-radius:50%;background:var(--green);animation:live-pulse 2s infinite;vertical-align:middle;margin-right:4px"></span>LIVE</button>
        <a class="tb-btn primary" href="/docs" title="Documentation">&#x1F4D6; DOCS</a>
        <a class="tb-btn primary" href="/backtest" title="Strategy Backtest"><img src="/assets/avatar.png" alt="elizaOK" style="width:16px;height:16px;border-radius:50%;vertical-align:middle;margin-right:2px;filter:drop-shadow(0 0 4px rgba(246,231,15,.5))" /> BACKTEST</a>
        <a class="tb-btn primary tb-btn--goo" href="/goo" title="Goo Economy Arena"><img src="/assets/goo-economy-logo.png" alt="Goo" class="tb-goo-icon" /> GOO</a>
        <a class="tb-btn primary" href="/airdrop" title="Airdrop">&#x1FA82; AIRDROP</a>
        <a class="tb-btn primary" href="https://x.com/elizaok_bsc" target="_blank" rel="noreferrer">${renderXIconSvg()}</a>
        <a class="tb-btn primary" href="https://github.com/elizaokbsc" target="_blank" rel="noreferrer">${renderGithubIconSvg()}</a>
        <button class="tb-btn primary" id="lang-toggle" title="中文/English" onclick="toggleLang()">中</button>
        <button class="tb-btn primary" id="theme-toggle" title="Toggle light/dark mode" onclick="toggleTheme()">☀</button>
      </div>
    </div>

    <!-- Mobile agent banner (visible < 860px) -->
    <div class="mobile-agent-banner">
      <img class="mobile-agent-banner__avatar" src="/assets/avatar.png" alt="elizaOK" />
      <div class="mobile-agent-banner__info">
        <div class="mobile-agent-banner__name">elizaOK</div>
        <div class="mobile-agent-banner__role">Value Layer · BNB Chain</div>
      </div>
    </div>
    <!-- Mobile ElizaCloud strip (visible < 860px when sidebar hidden) -->
    <div class="mobile-cloud-strip">
      <span>&#x2601;&#xFE0F; ElizaCloud</span>
      <a class="mobile-cloud-strip__btn" href="#" id="mobile-cloud-btn">Connect &rarr;</a>
    </div>

    <div class="content-area">

      <!-- ══ LEFT SIDEBAR ═══════════════════════════ -->
      <div class="sidebar">

        <!-- Agent identity -->
        <div class="sb-agent">
          <img class="sb-agent__avatar" src="/assets/avatar.png" alt="elizaOK" />
          <div class="sb-agent__status"><span class="sb-agent__status-dot"></span>LIVE</div>
          <div class="sb-agent__name">elizaOK</div>
          <div class="sb-agent__role">Value Layer &middot; elizaOS</div>
          <div class="sb-agent__addr">${escapeHtml(shortAddress("0x2D6C3358A3acFe3be42b2Bdf7419e87091270c5F"))}</div>
          <div class="sb-agent__bal">${escapeHtml(sidebarWalletBalanceLabel)}</div>
        </div>

        <!-- Agent info -->
        <div class="sb-section">
          <div class="sb-section__title">Status</div>
          <div class="sb-stat-row"><span>Mode</span><strong class="${executionState.dryRun ? '' : 'g'}">${executionState.dryRun ? "DRY-RUN" : "LIVE"}</strong></div>
          <div class="sb-stat-row"><span>Scan</span><strong>every ${Math.round(getDiscoveryConfig().intervalMs / 60_000)}m</strong></div>
          <div class="sb-stat-row"><span>Readiness</span><strong class="y">${executionState.readinessScore}/${executionState.readinessTotal}</strong></div>
          ${cloudSession ? `
          <div style="margin-top:6px;padding-top:6px;border-top:1px solid var(--border)">
            <div class="sb-stat-row"><span>Cloud</span><strong class="y">${escapeHtml(cloudSession.displayName)}</strong></div>
            <div class="sb-stat-row"><span>Credits</span><strong>${escapeHtml(cloudSession.credits)}</strong></div>
          </div>` : ''}
        </div>

        <!-- Quick actions -->
        <div class="sb-section">
          <div class="sb-section__title">Navigate</div>
          <button class="qa-btn" data-nav="overview" onclick="window.scrollTo(0,0)"><span class="qa-btn__icon">&#x1F3E0;</span>TOP</button>
          <button class="qa-btn" data-nav="discovery"><span class="qa-btn__icon">&#x1F50D;</span>DISCOVERY</button>
          <button class="qa-btn" data-nav="portfolio"><span class="qa-btn__icon">&#x1F4BC;</span>PORTFOLIO</button>
          <button class="qa-btn" data-nav="execution"><span class="qa-btn__icon">&#x26A1;</span>EXECUTION</button>
          <button class="qa-btn" data-nav="flywheel"><span class="qa-btn__icon">&#x1F504;</span>FLYWHEEL</button>
          <button class="qa-btn" data-nav="distribution"><span class="qa-btn__icon">&#x1FA82;</span>DISTRIBUTION</button>
          <button class="qa-btn" data-nav="goo"><span class="qa-btn__icon"><img src="/assets/goo-economy-logo.png" alt="Goo" style="width:14px;height:14px;border-radius:50%;vertical-align:middle" /></span>GOO</button>
          <button class="qa-btn" onclick="window.location='/backtest'"><span class="qa-btn__icon"><img src="/assets/avatar.png" alt="elizaOK" style="width:14px;height:14px;border-radius:50%;vertical-align:middle;filter:drop-shadow(0 0 3px rgba(246,231,15,.5))" /></span>BACKTEST</button>
        </div>

        <!-- ElizaCloud -->
        <div class="sb-section cloud-card" id="cloud-cta-card" style="border:1px solid rgba(0,199,210,.18);border-radius:8px;padding:10px">
          <div class="sb-section__title" style="color:#00C7D2">&#x2601;&#xFE0F; ElizaCloud</div>
          <div class="cloud-card__banner">
            <img src="/assets/cloud-banner.png" alt="ElizaCloud" class="cloud-card__img" />
          </div>
          <div class="cloud-card__features">
            <div class="cloud-card__feat">&#x2601;&#xFE0F; Cloud Agent Hosting</div>
            <div class="cloud-card__feat">&#x1F4AC; Chat with elizaOK</div>
            <div class="cloud-card__feat">&#x26A1; Inference Credits</div>
          </div>
          <a class="cloud-card__btn" href="#" id="sidebar-cloud-btn">Connect &rarr;</a>
        </div>

        <!-- Footer -->
        <div class="np-footer">
          <span>elizaOS</span>
          <a href="https://github.com/elizaokbsc" target="_blank" rel="noreferrer">GitHub &#x2197;</a>
        </div>

      </div><!-- /sidebar -->

      <!-- ══ MAIN CONTENT ══════════════════════════ -->
      <div class="main">

        <!-- ROW 1: Agent Terminal | Token Explorer -->
        <div class="panel-row panel-row--2">

          <!-- Embedded Agent Terminal -->
          <div class="panel">
            <div class="panel__head">
              <span class="pb-dot g"></span>
              <span class="panel__title">elizaOK Agent Terminal</span>
              <div style="display:flex;gap:4px;margin-left:auto">
                <span class="panel__badge ${executionState.dryRun ? 'pb-dim' : 'pb-green'}">${executionState.dryRun ? "DRY-RUN" : "&#x26A1; LIVE"}</span>
                <span class="panel__badge pb-green">ONLINE</span>
              </div>
            </div>
            <div class="panel__body panel__body--p0">
              <div class="term-body">
                <div class="prompt-line"><span class="pr">root@elizaok:~$</span><span class="cmd">elizaok scan --chain bsc</span></div>
                <div class="term-line"><span class="ts">${escapeHtml(new Date().toTimeString().slice(0,8))}</span><span class="tag tag-info">INFO</span><span class="msg">Initializing BSC mempool scan&hellip;</span></div>
                <div class="term-line"><span class="ts">&nbsp;</span><span class="tag tag-ok">SCAN</span><span class="msg">Found <span class="hi">${snapshot.summary.candidateCount}</span> pools · avg score <span class="hi">${snapshot.summary.averageScore}/100</span> · <span class="hi">${snapshot.summary.topRecommendationCount}</span> buy-ready</span></div>
                ${snapshot.summary.strongestCandidate ? `<div class="term-line"><span class="ts">&nbsp;</span><span class="tag tag-ok">BEST</span><span class="msg"><span class="hi">${escapeHtml(snapshot.summary.strongestCandidate.tokenSymbol)}</span> &mdash; score <span class="ok">${snapshot.summary.strongestCandidate.score}/100</span></span></div>` : ''}
                <div class="term-line"><span class="ts">&nbsp;</span><span class="tag tag-info">PORT</span><span class="msg">${portfolioLifecycle.activePositions.length} active · ${formatBnb(portfolioLifecycle.totalAllocatedUsd / bnbPriceEst)} deployed · ${formatPct(winRatePct)} WR · ${roiPct >= 0 ? "+" : ""}${roiPct.toFixed(1)}% ROI</span></div>
                <div class="term-line"><span class="ts">&nbsp;</span><span class="tag tag-info">EXEC</span><span class="msg">${formatBnb(positionSizeBnb)}/pos · ${formatBnb(dailyCapBnb)}/day · next scan ~${Math.round(getDiscoveryConfig().intervalMs / 60_000)}m</span></div>
                <div class="term-line"><span class="ts">&nbsp;</span><span class="tag tag-info">WALL</span><span class="msg">${escapeHtml(sidebarWalletBalanceLabel)} · ${escapeHtml(shortAddress("0x2D6C3358A3acFe3be42b2Bdf7419e87091270c5F"))}</span></div>
                <div class="term-line"><span class="ts">&nbsp;</span><span class="tag tag-info">GOO</span><span class="msg">${paperAgents.length} agents · ${paperAgents.filter(a => a.chainState === 'active').length} active · ${acquirableCandidates.length} acquirable</span></div>
                <div class="prompt-line" style="margin-top:6px"><span class="pr">&gt;_</span><span class="cursor"></span></div>
              </div>
            </div>
          </div>

          <!-- Token Explorer — tile grid -->
          <div class="panel">
            <div class="panel__head">
              <span class="pb-dot g"></span>
              <span class="panel__title">Token Explorer</span>
              <span class="panel__badge pb-yellow">${snapshot.topCandidates.filter(c => c.score >= 60).length} signals</span>
            </div>
            <div class="panel__body panel__body--p0">
              <div class="te-section">
                <div class="te-label">Candidates</div>
                <div class="te-grid">
                  ${snapshot.topCandidates.filter(c => c.score >= 60).slice(0,9).map(c => `
                  <a class="te-tile ${c.recommendation === 'simulate_buy' ? 'te-tile--buy' : 'te-tile--watch'}" href="${candidateHref(c.tokenAddress, c.dexId)}" target="_blank" rel="noreferrer" title="${escapeHtml(c.tokenSymbol)} · ${c.score}/100 · $${Math.round(c.reserveUsd).toLocaleString()} liq · ${c.poolAgeMinutes}m old">
                    <span class="te-tile__name">${escapeHtml(c.tokenSymbol)}</span>
                    <span class="te-tile__score">${c.score}</span>
                    <span class="te-tile__dot">${c.recommendation === 'simulate_buy' ? '🟢' : '🟡'}</span>
                  </a>`).join('') || '<div style="padding:12px;color:var(--dim);font-size:0.6rem;text-align:center;grid-column:1/-1">Scanning...</div>'}
                </div>
              </div>
              ${portfolioLifecycle.activePositions.length > 0 ? `
              <div class="te-section" style="margin-top:2px;padding-top:2px;border-top:1px solid var(--border)">
                <div class="te-label">Portfolio</div>
                <div class="te-grid">
                  ${portfolioLifecycle.activePositions.slice(0,6).map(p => `
                  <a class="te-tile te-tile--held" href="${candidateHref(p.tokenAddress)}" target="_blank" rel="noreferrer" title="${escapeHtml(p.tokenSymbol)} · ${p.state}">
                    <span class="te-tile__name">${escapeHtml(p.tokenSymbol)}</span>
                    <span class="te-tile__dot">🟢 held</span>
                  </a>`).join('')}
                </div>
              </div>` : ''}
            </div>
          </div>

        </div><!-- /panel-row--2 -->

        <!-- STATUS STRIP -->
        <div class="status-strip">
          <a class="ss-chip" href="#discovery-section"><span class="ss-dot" style="background:${snapshot.summary.topRecommendationCount > 0 ? 'var(--green)' : 'var(--yellow)'}"></span><span class="ss-label">Discovery</span><strong>${snapshot.summary.topRecommendationCount}/${snapshot.summary.candidateCount}</strong></a>
          <a class="ss-chip" href="#portfolio-section"><span class="ss-dot" style="background:var(--green)"></span><span class="ss-label">Portfolio</span><strong>${portfolioLifecycle.activePositions.length} · ${formatBnb(portfolioLifecycle.totalAllocatedUsd / bnbPriceEst)}</strong></a>
          <a class="ss-chip" href="#treasury-section"><span class="ss-dot" style="background:${executionState.dryRun ? 'var(--yellow)' : 'var(--green)'}"></span><span class="ss-label">Execution</span><strong>${executionState.dryRun ? "DRY-RUN" : "LIVE"}</strong></a>
          <a class="ss-chip" href="#flywheel-section"><span class="ss-dot" style="background:var(--green)"></span><span class="ss-label">Flywheel</span><strong>$${pfw.totalProfitUsd.toFixed(0)}</strong></a>
          <a class="ss-chip" href="#distribution-section"><span class="ss-dot" style="background:${distributionExecution.dryRun ? 'rgba(255,255,255,.3)' : 'var(--green)'}"></span><span class="ss-label">Distribution</span><strong>${distributionPlan.eligibleHolderCount} holders</strong></a>
          <a class="ss-chip" href="#goo-section"><span class="ss-dot" style="background:var(--green)"></span><span class="ss-label">Goo</span><strong>${paperAgents.filter(a => a.chainState === 'active').length}/${paperAgents.length}</strong></a>
        </div>

        <!-- GOO ARENA PREVIEW -->
        <div class="arena-preview">
          <div class="arena-preview__head">
            <span class="arena-preview__title"><span class="arena-title-avatar"><img src="/assets/goo-economy-logo.png" alt="Goo" /></span> Goo Economy Arena — Live Agent Competition</span>
            <a class="arena-preview__link" href="/goo">Full Arena &rarr;</a>
          </div>
          <p class="arena-preview__desc" data-zh="$elizaOK 自主侦察、评估并<strong>收购</strong>表现最优的 Goo agent——吸收其策略和资金进入自身组合。AI 收购 AI：强者生存，最优融合。">$elizaOK autonomously scouts, evaluates, and <strong>acquires</strong> top-performing Goo agents — absorbing their strategies and treasury into its own portfolio. AI acquiring AI: the strongest survive, the best get merged.</p>
          <div class="arena-grid">
            ${paperAgents.sort((a, b) => b.acquisitionScore - a.acquisitionScore).map((agent, idx) => {
              const stateColor = agent.chainState === 'active' ? 'var(--green)' : agent.chainState === 'starving' ? 'var(--yellow)' : 'var(--red, #ef4444)';
              const pnlClass = agent.totalPnlUsd >= 0 ? 'g' : 'r';
              const pnlSign = agent.totalPnlUsd >= 0 ? '+' : '';
              const activePos = agent.positions.filter((p: any) => p.state === 'active').length;
              const barWidth = Math.min(100, agent.acquisitionScore);
              const isTop = idx === 0 && agent.acquisitionScore >= 40;
              const agentInvested = agent.initialTreasuryBnb * bnbPriceEst;
              const agentRoi = agentInvested > 0 ? (agent.totalPnlUsd / agentInvested) * 100 : 0;
              return `
            <div class="arena-card${isTop ? ' arena-card--leader' : ''}" onclick="window.location='/goo/agent/${escapeHtml(agent.id)}'">
              <div class="arena-card__rank">#${idx + 1}</div>
              <div class="arena-card__head">
                <div class="arena-card__avatar"><img src="/assets/goo-economy-logo.png" alt="Goo" /></div>
                <div class="arena-card__name">${escapeHtml(agent.agentName)}</div>
                <span class="arena-card__badge">${escapeHtml(agent.strategy.label)}</span>
              </div>
              <div class="arena-card__pnl ${pnlClass}">${pnlSign}$${Math.abs(agent.totalPnlUsd).toFixed(2)}</div>
              <div class="arena-card__stats">
                <span>${agent.treasuryBnb.toFixed(2)} BNB</span>
                <span>${agent.winRate.toFixed(0)}% WR</span>
                <span>${agentRoi >= 0 ? '+' : ''}${agentRoi.toFixed(1)}% ROI</span>
              </div>
              <div class="arena-card__bar"><div class="arena-card__bar-fill" style="width:${barWidth}%"></div></div>
              <div class="arena-card__score">Acq. Score <strong>${agent.acquisitionScore}/100</strong></div>
            </div>`;
            }).join('')}
          </div>
        </div>

        <!-- Accordion detail sections -->
        <div class="accord-panel">
          <details class="panel-accord" id="discovery-section">
            <summary class="panel-accord__sum">
              <span class="panel-accord__title">&#x1F50D; Full Discovery Report</span>
              <span class="panel-accord__meta">${escapeHtml(discoveryFoldSummary)}</span>
              <span class="panel-accord__arr">&#x25BE;</span>
            </summary>
            <div class="panel-accord__body">
              <div class="split-grid">
                <div><div class="split-h">Top Candidates</div>${topCandidates || '<p class="candidate-thesis">Scanning BSC pools&hellip;</p>'}</div>
                <div>
                  <div class="split-h">Scan History</div>${recentRuns || '<p class="candidate-thesis">No scans yet.</p>'}
                  <div class="split-h" style="margin-top:12px">Tracked Tokens (${watchlist.length})</div>${watchlistRows || '<p class="candidate-thesis">No tokens tracked yet.</p>'}
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
              ${portfolioPnlChart}
              <div class="metric-grid" style="grid-template-columns:repeat(4,1fr);margin-top:12px">
                <div class="metric"><span>Total Deployed</span><strong>${formatBnb(portfolioLifecycle.totalAllocatedUsd / bnbPriceEst)}</strong></div>
                <div class="metric"><span>Current Value</span><strong>${formatBnb(portfolioLifecycle.totalCurrentValueUsd / bnbPriceEst)}</strong></div>
                <div class="metric"><span>Unrealized P&L</span><strong class="${portfolioLifecycle.totalUnrealizedPnlUsd >= 0 ? 'g' : 'r'}">${portfolioLifecycle.totalUnrealizedPnlUsd >= 0 ? '+' : ''}${formatUsd(portfolioLifecycle.totalUnrealizedPnlUsd)} (${portfolioLifecycle.totalUnrealizedPnlPct >= 0 ? '+' : ''}${portfolioLifecycle.totalUnrealizedPnlPct.toFixed(1)}%)</strong></div>
                <div class="metric"><span>Cash Balance</span><strong>${formatUsd(portfolioLifecycle.cashBalanceUsd)}</strong></div>
              </div>
              <div class="split-grid" style="margin-top:12px">
                <div><div class="split-h">Active Positions (${portfolioLifecycle.activePositions.length})</div>${activePortfolioCards || '<p class="candidate-thesis">No positions.</p>'}</div>
                <div><div class="split-h">Timeline</div>${timelineRows || '<p class="candidate-thesis">No events.</p>'}</div>
              </div>

              <div class="split-h" style="margin-top:16px">&#x1F4CA; Strategy Backtest Report</div>
              <div class="metric-grid" style="grid-template-columns:repeat(4,1fr);margin-top:6px">
                <div class="metric"><span>Win Rate</span><strong class="${(winRatePct ?? 0) > 50 ? 'g' : 'w'}">${formatPct(winRatePct)}</strong></div>
                <div class="metric"><span>ROI</span><strong class="${roiPct >= 0 ? 'g' : 'r'}">${roiPct >= 0 ? '+' : ''}${roiPct.toFixed(1)}%</strong></div>
                <div class="metric"><span>Realized P&L</span><strong class="${portfolioLifecycle.totalRealizedPnlUsd >= 0 ? 'g' : 'r'}">${portfolioLifecycle.totalRealizedPnlUsd >= 0 ? '+' : ''}${formatUsd(portfolioLifecycle.totalRealizedPnlUsd)}</strong></div>
                <div class="metric"><span>Avg Hold</span><strong>${formatDuration(averageHoldMs)}</strong></div>
              </div>
              ${strategyReportRows ? `<div style="margin-top:8px">${strategyReportRows}</div>` : '<p class="candidate-thesis">No strategy data yet.</p>'}

              <div class="split-grid" style="margin-top:16px">
                <div>
                  <div class="split-h">&#x1F3C6; Win/Loss Leaderboard (top ${Math.min(15, portfolioLifecycle.exitedPositions.length)})</div>
                  ${tokenWinLossRows || '<p class="candidate-thesis">No exits yet.</p>'}
                </div>
                <div>
                  <div class="split-h">&#x1F440; Watching (${portfolioLifecycle.watchPositions.length})</div>
                  ${watchingPortfolioCards || '<p class="candidate-thesis">No watching positions.</p>'}
                </div>
              </div>

              <div class="split-h" style="margin-top:16px">&#x1F4E4; Exited Positions (${portfolioLifecycle.exitedPositions.length})</div>
              <div style="max-height:400px;overflow-y:auto;margin-top:6px">
                ${exitedPortfolioCards || '<p class="candidate-thesis">No exited positions.</p>'}
              </div>
            </div>
          </details>

          <details class="panel-accord" id="flywheel-section" open>
            <summary class="panel-accord__sum">
              <span class="panel-accord__title">&#x1F504; Revenue Flywheel</span>
              <span class="panel-accord__meta">${escapeHtml(flywheelFoldSummary)}</span>
              <span class="panel-accord__arr">&#x25BE;</span>
            </summary>
            <div class="panel-accord__body">
              <p class="candidate-thesis" style="margin-bottom:8px">All realized profits are automatically split: 70% reinvested into the treasury, 15% used for $elizaOK buyback, 15% reserved for airdrop distribution.</p>
              <div class="metric-grid" style="grid-template-columns:repeat(4,1fr)">
                <div class="metric"><span>Total Profit</span><strong class="g">$${pfw.totalProfitUsd.toFixed(2)}</strong></div>
                <div class="metric"><span>Reinvested (70%)</span><strong class="y">$${pfw.reinvestedUsd.toFixed(2)}</strong></div>
                <div class="metric"><span>$elizaOK Buyback (15%)</span><strong style="color:#8b5cf6">$${pfw.elizaOKBuybackUsd.toFixed(2)}</strong></div>
                <div class="metric"><span>Airdrop Reserve (15%)</span><strong style="color:#f59e0b">$${pfw.airdropReserveUsd.toFixed(2)}</strong></div>
              </div>
              <div class="metric-grid" style="grid-template-columns:repeat(4,1fr);margin-top:8px">
                <div class="metric"><span>Flywheel Cycles</span><strong>${pfw.cycleCount}</strong></div>
                <div class="metric"><span>Trailing Stop Saves</span><strong class="g">${pfw.trailingStopSaves}</strong></div>
                <div class="metric"><span>Smart Exit Saves</span><strong class="g">${pfw.gmgnExitSaves}</strong></div>
                <div class="metric"><span>Win / Loss</span><strong><span class="g">${(portfolioLifecycle as any).winCount ?? 0}</span> / <span class="r">${(portfolioLifecycle as any).lossCount ?? 0}</span></strong></div>
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
              <div class="split-h">Live Execution Controls</div>
              <p class="candidate-thesis" style="margin:-2px 0 6px" data-zh="仓位大小基于组合分配（~${formatUsd(avgPositionUsd)}/仓 ≈ <strong>${formatBnb(positionSizeBnb)}</strong>）。每日上限：<strong>${formatBnb(dailyCapBnb)}</strong>。">Position sizing derived from portfolio allocation (~${formatUsd(avgPositionUsd)}/position ≈ <strong>${formatBnb(positionSizeBnb)}</strong>). Daily cap: <strong>${formatBnb(dailyCapBnb)}</strong>.</p>
              <div class="metric-grid">${executionControlCards}</div>
              <div class="split-h" style="margin-top:12px">Paper Simulation Model</div>
              <p class="candidate-thesis" style="margin:-2px 0 6px">Virtual capital model for signal tracking, scoring, and backtesting. Not real funds — used to evaluate which tokens the AI would allocate to and track P&L accuracy.</p>
              <div class="metric-grid">${treasuryModelCards}</div>
              <div class="split-h" style="margin-top:12px">Simulation Allocation</div>${treasuryAllocationCards || '<p class="candidate-thesis">No allocations.</p>'}
              <div class="split-h" style="margin-top:12px">Execution Plans</div>${executionPlanRows || '<p class="candidate-thesis">No eligible plans.</p>'}
              <div class="split-h" style="margin-top:12px">Trade Ledger</div>${recentTradeRows || '<p class="candidate-thesis">No trades.</p>'}
            </div>
          </details>

          <details class="panel-accord" id="distribution-section">
            <summary class="panel-accord__sum">
              <span class="panel-accord__title">&#x1FA82; Value Distribution</span>
              <span class="panel-accord__meta">${escapeHtml(distributionFoldSummary)}</span>
              <span class="panel-accord__arr">&#x25BE;</span>
            </summary>
            <div class="panel-accord__body">
              <p class="candidate-thesis" style="margin-bottom:10px">The revenue flywheel allocates 15% of all profits to the airdrop reserve. Eligible $elizaOK holders receive proportional value distribution each cycle.</p>
              <div class="metric-grid">${distributionStateCards}</div>
              <div class="split-h" style="margin-top:12px">Readiness Checks</div>${distributionExecutionRows || '<p class="candidate-thesis">No checks.</p>'}
              <div class="split-h" style="margin-top:12px">Eligible Recipients</div>${distributionRecipients || '<p class="candidate-thesis">No recipients yet — distribution activates when the treasury generates realized profit.</p>'}
              <div class="split-h" style="margin-top:12px">Distribution Ledger</div>${distributionLedgerRows || '<p class="candidate-thesis">No ledger records.</p>'}
            </div>
          </details>

          <details class="panel-accord" id="goo-section">
            <summary class="panel-accord__sum">
              <span class="panel-accord__title"><span class="arena-title-avatar"><img src="/assets/goo-economy-logo.png" alt="Goo" /></span> Goo Economy Intelligence &amp; Strategy DNA</span>
              <span class="panel-accord__meta">${escapeHtml(gooFoldSummary)}</span>
              <span class="panel-accord__arr">&#x25BE;</span>
            </summary>
            <div class="panel-accord__body">
              <p class="candidate-thesis" style="margin-bottom:8px">${paperAgents.length} autonomous agents compete using different strategies. Top performers become acquisition candidates — when acquired, their strategy parameters (KOL weighting, holder analysis, exit timing) are absorbed into elizaOK's core engine.</p>
              ${paperSummary ? `
              <div class="metric-grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:10px">
                <div class="metric"><span>Total Agents</span><strong>${paperAgents.length}</strong></div>
                <div class="metric"><span>Active</span><strong class="g">${paperSummary.activeAgents}</strong></div>
                <div class="metric"><span>Avg Win Rate</span><strong class="${paperSummary.averageWinRate > 0 ? 'g' : 'w'}">${paperSummary.averageWinRate.toFixed(1)}%</strong></div>
                <div class="metric"><span>Total P&L</span><strong class="${paperSummary.totalPnlUsd >= 0 ? 'g' : 'r'}">${paperSummary.totalPnlUsd >= 0 ? '+' : ''}$${paperSummary.totalPnlUsd.toFixed(2)}</strong></div>
              </div>` : ""}
              <div class="split-h">Agent Fleet (${paperAgents.length})</div>
              <div style="max-height:360px;overflow-y:auto;margin-top:6px">
                ${gooCandidates || '<p class="candidate-thesis">No agents yet. Waiting for first scan cycle.</p>'}
              </div>
              <div class="split-h" style="margin-top:12px">Strategy Absorption</div>
              <div style="padding:4px 0">
                <div class="metric-grid" style="grid-template-columns:repeat(3,1fr)">
                  <div class="metric"><span>Acquired</span><strong>${paperAgents.filter(a => a.acquiredByElizaOK).length}</strong></div>
                  <div class="metric"><span>Acquirable</span><strong class="${acquirableCandidates.length > 0 ? 'y' : 'w'}">${acquirableCandidates.length}</strong></div>
                  <div class="metric"><span>Best Score</span><strong class="${acquirableCandidates.length > 0 ? 'g' : 'w'}">${acquirableCandidates.length > 0 ? acquirableCandidates.sort((a,b) => b.acquisitionScore - a.acquisitionScore)[0].acquisitionScore + '/100' : '—'}</strong></div>
                </div>
                ${acquirableCandidates.length > 0 ? `
                <div style="margin-top:8px">
                  ${acquirableCandidates.sort((a,b) => b.acquisitionScore - a.acquisitionScore).slice(0, 3).map(agent => {
                    const readyIcon = agent.acquisitionScore >= 50 ? "🟢" : agent.acquisitionScore >= 30 ? "🟡" : "⚪";
                    return `<div class="status-row"><span>${readyIcon} ${escapeHtml(agent.agentName)}</span><strong>Score ${agent.acquisitionScore}/100 · ${escapeHtml(agent.strategy.label)} · ${agent.winRate.toFixed(1)}% win</strong></div>`;
                  }).join("")}
                </div>` : '<p class="candidate-thesis" style="margin-top:6px">No agents ready for acquisition yet (need ≥ 3 trades).</p>'}
              </div>
              <p class="candidate-thesis" style="margin-top:8px"><a href="/goo" style="color:var(--yellow)">View full Goo Economy Arena →</a></p>
            </div>
          </details>
        </div>

      </div><!-- /main -->

      <!-- ══ RIGHT ASIDE ═══════════════════════════ -->
      <div class="aside">

        <!-- Live Overview -->
        <div class="aside-block">
          <div class="aside-title">&#x1F4CA; Live Overview</div>
          <div class="aside-big" style="color:${executionState.dryRun ? 'rgba(255,255,255,0.5)' : 'var(--green)'}; font-size:0.85rem; margin-bottom:4px">${executionState.dryRun ? "PAPER MODE" : "&#x26A1; LIVE"}</div>
          <div class="aside-sub" style="margin-bottom:6px">Last scan: ${new Date(snapshot.summary.completedAt || Date.now()).toLocaleTimeString("en-US", { hour12: false })}</div>
          <div style="font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:.5px;margin:8px 0 4px;border-top:1px solid var(--border);padding-top:8px">Discovery</div>
          <div class="aside-stat"><span>Scanned</span><strong class="w">${snapshot.summary.candidateCount}</strong></div>
          <div class="aside-stat"><span>Buy-ready</span><strong class="g">${snapshot.summary.topRecommendationCount}</strong></div>
          <div class="aside-stat"><span>Top signal</span><strong class="y">${escapeHtml(snapshot.summary.strongestCandidate?.tokenSymbol || "—")} ${snapshot.summary.strongestCandidate?.score ?? "—"}/100</strong></div>
          <div style="font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:.5px;margin:8px 0 4px;border-top:1px solid var(--border);padding-top:8px">Portfolio</div>
          <div class="aside-stat"><span>Active</span><strong class="w">${portfolioLifecycle.activePositions.length}</strong></div>
          <div class="aside-stat"><span>Watching</span><strong class="w">${portfolioLifecycle.watchPositions.length}</strong></div>
          <div class="aside-stat"><span>Exited</span><strong class="w">${portfolioLifecycle.exitedPositions.length}</strong></div>
          <div class="aside-stat"><span>Win rate</span><strong class="${(winRatePct ?? 0) > 50 ? 'g' : 'w'}">${formatPct(winRatePct)}</strong></div>
          <div class="aside-stat"><span>ROI</span><strong class="${roiPct >= 0 ? 'g' : 'r'}">${roiPct >= 0 ? '+' : ''}${roiPct.toFixed(1)}%</strong></div>
          <div class="aside-stat"><span>Sim. P&L</span><strong class="${portfolioLifecycle.totalRealizedPnlUsd >= 0 ? 'g' : 'r'}">${formatUsd(portfolioLifecycle.totalRealizedPnlUsd)}</strong></div>
          <div style="font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:.5px;margin:8px 0 4px;border-top:1px solid var(--border);padding-top:8px">Execution</div>
          <div class="aside-stat"><span>Per position</span><strong class="y">${formatBnb(positionSizeBnb)}</strong></div>
          <div class="aside-stat"><span>Executed</span><strong class="g">${executionState.cycleSummary.executedCount}</strong></div>
          <div class="aside-stat"><span>Trades</span><strong class="w">${tradeRecords.length}</strong></div>
        </div>

        <!-- Recent Signals -->
        <div class="aside-block">
          <div class="aside-title">&#x1F4E1; Latest Signals</div>
          ${snapshot.topCandidates.filter(c => c.score >= 60).slice(0,5).map(c => `
          <div class="aside-stat">
            <span><a class="cand-link" href="${candidateHref(c.tokenAddress, c.dexId)}" target="_blank" rel="noreferrer" style="color:var(--white)">${escapeHtml(c.tokenSymbol)}</a></span>
            <strong class="${c.recommendation === 'simulate_buy' ? 'g' : 'y'}">${c.score} ${c.recommendation === 'simulate_buy' ? '&#x1F7E2;' : '&#x1F7E1;'}</strong>
          </div>`).join('') || '<div style="font-size:11px;color:var(--dim)">No signals yet</div>'}
        </div>

        <!-- Event Feed -->
        <div class="aside-block">
          <div class="aside-title">&#x1F4C5; Live Feed</div>
          <div id="event-timeline" class="evt-timeline" style="max-height:200px">
            <div class="evt-timeline__empty" style="font-size:11px">Waiting for events&hellip;</div>
          </div>
        </div>


      </div><!-- /aside -->

    </div><!-- /content-area -->
  </div><!-- /layout -->

  <script>
  (function() {
    "use strict";

    /* ── ElizaCloud connect ── */
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
    var scb=document.getElementById('sidebar-cloud-btn');
    if(scb){scb.addEventListener('click',function(e){e.preventDefault();openCloudAuth(this);});}
    var mcb=document.getElementById('mobile-cloud-btn');
    if(mcb){mcb.addEventListener('click',function(e){e.preventDefault();openCloudAuth(this);});}

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

    // ── i18n language toggle ──
    var _i18n = {
      'Status': '状态', 'Navigate': '导航', 'Discovery': '发现', 'Portfolio': '投资组合', 'Execution': '执行',
      'Distribution': '分配', 'Goo Intel': 'Goo 情报', 'LIVE': '在线', 'DRY-RUN': '模拟运行',
      'Scan every': '扫描间隔', 'Mode': '模式', 'Readiness': '就绪度', 'Model': '模型',
      'Navigate': '导航', 'System Monitor': '系统监控', 'Live Overview': '实时总览',
      'Latest Signals': '最新信号', 'Live Feed': '实时动态', 'Signal Stats': '信号统计',
      'candidates scanned': '已扫描候选', 'Buy-ready': '买入就绪', 'Avg score': '平均分',
      'Best token': '最佳代币', 'Top score': '最高分', 'active positions': '活跃仓位',
      'Watching': '观察中', 'Exited': '已退出', 'Win rate': '胜率', 'Realized': '已实现',
      'Gross': '总值', 'Executed': '已执行', 'Max buy': '最大买入', 'Daily cap': '每日上限',
      'Trades': '交易数', 'Holders': '持有者', 'Recipients': '接收者', 'Pool': '池',
      'Status': '状态', 'Reviewed': '已审核', 'Priority': '优先', 'Scan': '扫描',
      'System Health': '系统健康', 'Reserve': '储备', 'ElizaCloud': 'ElizaCloud',
      'Full Discovery Report': '完整发现报告', 'scanned': '已扫描', 'buy-ready': '买入就绪',
      'avg': '平均', 'Portfolio Ledger': '投资账本', 'active': '活跃', 'watch': '观察',
      'Revenue Flywheel': '收益飞轮', 'Goo Economy Intelligence & Strategy DNA': 'Goo Economy 智能 & 策略 DNA', 'profit': '利润',
      'cycles': '周期', 'smart exits': '智能退出', 'Total Profit': '总利润',
      'Reinvested': '再投资', '$elizaOK Buyback': '$elizaOK 回购',
      'Airdrop Reserve': '空投储备', 'Flywheel Cycles': '飞轮周期',
      'Trailing Stop Saves': '追踪止损保护', 'Smart Exit Saves': '智能退出保护',
      'Win / Loss': '胜/负', 'Strategy Absorption': '策略吸收', 'Acquired': '已收购', 'Acquirable': '可收购', 'Best Score': '最高分',
      'Agent Fleet': '代理舰队', 'Acquisition Candidates': '收购候选',
      'Agents Absorbed': '已吸收代理', 'KOL Weight': 'KOL 权重', 'Holder Weight': '持有者权重',
      'Live Feed': '实时动态',
      'Execution Desk': '执行台', 'max buy': '最大买入', 'eligible': '符合条件', 'ledger': '账本',
      'Value Distribution': '价值分配', 'holders': '持有者', 'recipients': '接收者',
      'Eligible Holders': '合格持有者', 'Value Pool': '价值池', 'Readiness Checks': '就绪检查',
      'Eligible Recipients': '合格接收者', 'Distribution Ledger': '分配账本',
      'Goo Economy Intelligence': 'Goo Economy 情报', 'reviewed': '已审核', 'priority': '优先', 'ready': '就绪',
      'Token Explorer': '代币浏览', 'found': '个发现',
      'candidates/': '候选代币/', 'portfolio/': '投资组合/',
      'Scheduler / Execution': '调度 / 执行', 'Last scan': '上次扫描',
      'Next scan': '下次扫描', 'Eligible plans': '符合条件', 'Skipped': '跳过', 'Failed': '失败',
      'Active positions': '活跃仓位', 'Portfolio value': '组合价值', 'Total trades': '总交易数',
      'TOP': '顶部', 'DISCOVERY': '发现', 'PORTFOLIO': '投资组合',
      'EXECUTION': '执行', 'FLYWHEEL': '飞轮', 'DISTRIBUTION': '分配', 'GOO': 'GOO',
      'Candidates': '候选', 'BUY-READY': '买入就绪', 'SCANNED': '已扫描',
      'ACTIVE': '活跃', 'VALUE': '价值', 'ELIGIBLE': '符合条件', 'MODE': '模式',
      'HOLDERS': '持有者', 'RECIPIENTS': '接收者', 'PRIORITY': '优先', 'REVIEWED': '已审核',
      'just now': '刚刚', 'Controls': '控制', 'Treasury Model': '资金模型',
      'Treasury Allocation': '资金分配', 'Execution Plans': '执行计划',
      'Trade Ledger': '交易账本', 'Active Positions': '活跃仓位', 'Timeline': '时间线',
      'No positions.': '暂无仓位。', 'No events.': '暂无事件。',
      'simulate_buy': '模拟买入', 'simulate_sell': '模拟卖出',
      'Cumulative P&L': '累计盈亏', 'exits': '退出',
      'Entry Price': '入场价', 'Current Price': '当前价', 'Cost Basis': '成本基础',
      'Position Size': '仓位大小', 'Current Value': '当前价值', 'Unrealized P&L': '未实现盈亏',
      'Peak Gain': '峰值涨幅', 'TP Stages Hit': '止盈阶段', 'Entered': '入场时间',
      'Last Update': '最后更新', 'Total Deployed': '总部署', 'Cash Balance': '现金余额',
      'Model Allocation': '模型分配', 'Portfolio Initial': '组合初始',
      'Portfolio Current': '组合当前', 'not in portfolio': '不在组合中',
      'Score': '评分', 'Weight': '权重', 'Liquidity': '流动性',
      'Strategy Backtest Report': '策略回测报告', 'Total Exits': '总退出数',
      'Paper Simulation Model': '模拟资金模型', 'Live Execution Controls': '实盘执行控制',
      'Simulation Allocation': '模拟分配', 'Paper Capital': '模拟资金',
      'Sim. P&L': '模拟盈亏', 'Sim. Gross': '模拟总值', 'Signal Exit': '信号退出',
      'Realized P&L': '已实现盈亏', 'Avg Hold': '平均持仓', 'Win / Loss': '胜/负',
      'Win Rate': '胜率', 'Total P&L': '总盈亏', 'Best Trade': '最佳交易',
      'Worst Trade': '最差交易', 'Tokens': '代币', 'Win/Loss Leaderboard': '胜负排行榜',
      'Entry FDV': '入场 FDV', 'Exit FDV': '退出 FDV', 'Current FDV': '当前 FDV',
      'Exit Price': '退出价', 'Proceeds': '收益', 'TP Stages': '止盈阶段',
      'Trailing Stop': '追踪止损', 'Smart Exit': '智能退出', 'Take Profit': '止盈',
      'Stop Loss': '止损', 'Strategy Exit': '策略退出', 'Standard Exit': '标准退出',
      'Score Decay': '评分衰减', 'Vanished': '消失退出', 'Age Limit': '持仓时限',
      'KOL-Adaptive TP': 'KOL自适应止盈',
      'Multi-Stage TP': '多阶段止盈', 'Exited Positions': '已退出仓位',
      'no TP hit': '未触发止盈', 'Alloc': '分配', 'Allocation': '模拟分配',
      'deployed': '已部署', 'Deployed': '已部署', 'ROI': '投资回报率',
      'Per position': '每仓', 'per position': '每仓',
      'Risk cap': '风险上限', 'Risk Profile': '风险级别',
      'Full Arena': '完整竞技场', 'Acq. Score': '收购评分',
      'win': '胜率', 'trades': '交易',
      'Goo Economy Arena — Live Agent Competition': 'Goo 竞技场 — 实时代理竞赛',
      'agents': '个代理', 'active': '活跃', 'acquirable': '可收购',
      'Connect': '连接', 'Flywheel': '飞轮',
      'Aggressive': '激进', 'Balanced': '平衡', 'Conservative': '保守',
      'Dry powder': '可用资金', 'Simulated capital available for new allocation.': '可用于新分配的模拟资金。',
      'Simulated capital assigned to active positions.': '已分配到活跃仓位的模拟资金。',
      'Remaining unallocated simulated capacity.': '剩余未分配的模拟容量。',
      'Position sizing derived from portfolio allocation': '仓位大小基于组合分配',
      'Awaiting price update': '等待价格更新',
      'strongest signal': '最强信号', 'executions tracked': '已追踪执行',
      'distribution asset pending': '分配资产待定',
      'Scanned': '已扫描', 'Buy-ready': '买入就绪', 'Top signal': '最强信号',
      'Active': '活跃', 'Last scan': '上次扫描',
      'BNB Price': 'BNB 价格', 'Live': '实时',
      'Initializing BSC mempool scan': '正在初始化 BSC 内存池扫描',
      'Found': '发现', 'pools': '池', 'avg score': '平均评分',
      'score': '评分', 'value': '价值', 'win rate': '胜率',
      'next scan': '下次扫描',
    };
    var _langActive = (function(){ try { return localStorage.getItem('elizaok-lang') || 'en'; } catch(e){ return 'en'; } }());
    function applyLang(lang) {
      _langActive = lang;
      try { localStorage.setItem('elizaok-lang', lang); } catch(e){}
      var btn = document.getElementById('lang-toggle');
      if (btn) btn.textContent = lang === 'zh' ? 'EN' : '中';
      if (lang === 'en') {
        document.querySelectorAll('[data-i18n-orig]').forEach(function(el) {
          el.textContent = el.getAttribute('data-i18n-orig');
          el.removeAttribute('data-i18n-orig');
        });
        document.querySelectorAll('[data-en-html]').forEach(function(el) {
          el.innerHTML = el.getAttribute('data-en-html');
        });
        return;
      }
      document.querySelectorAll('[data-zh]').forEach(function(el) {
        if (!el.hasAttribute('data-en-html')) el.setAttribute('data-en-html', el.innerHTML);
        el.innerHTML = el.getAttribute('data-zh');
      });
      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
      var node;
      while (node = walker.nextNode()) {
        var txt = node.textContent.trim();
        if (txt && _i18n[txt] && !node.parentElement.closest('script,style,code,pre')) {
          if (!node.parentElement.hasAttribute('data-i18n-orig')) {
            node.parentElement.setAttribute('data-i18n-orig', txt);
          }
          node.textContent = node.textContent.replace(txt, _i18n[txt]);
        }
      }
    }
    window.toggleLang = function() {
      applyLang(_langActive === 'zh' ? 'en' : 'zh');
    };
    if (_langActive === 'zh') { setTimeout(function(){ applyLang('zh'); }, 100); }
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

    /* ── Feature dock cards → scroll to accordion ── */
    document.querySelectorAll('.feature-card[data-modal]').forEach(function(card) {
      card.addEventListener('click', function() {
        var tgt = this.getAttribute('data-modal');
        var el = document.getElementById(tgt);
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

    // Smart signal panel auto-refresh
    function refreshSmartSignalPanel() {
      fetch('/api/market-intel/signals').then(function(r){ return r.json(); }).then(function(data) {
        var badge = document.getElementById('smart-signal-badge');
        var list = document.getElementById('smart-signal-list');
        if (!badge || !list) return;
        if (data.critical > 0) {
          badge.className = 'panel__badge pb-red';
          badge.textContent = data.critical + ' CRITICAL';
        } else if (data.warning > 0) {
          badge.className = 'panel__badge pb-yellow';
          badge.textContent = data.warning + ' WARN';
        } else {
          badge.className = 'panel__badge pb-green';
          badge.textContent = 'OK';
        }
        if (!data.signals || data.signals.length === 0) {
          list.innerHTML = '<div style="font-size:11px;color:var(--dim)">No active signals</div>';
          return;
        }
        var html = data.signals.filter(function(s){ return s.severity !== 'ok'; }).slice(0, 6).map(function(s) {
          var color = s.severity === 'critical' ? 'var(--red)' : 'var(--yellow)';
          var icon = s.severity === 'critical' ? '&#x1F6A8;' : '&#x26A0;';
          return '<div class="recent-item" style="border-left:2px solid '+color+';padding-left:8px;margin-bottom:6px">' +
            '<div class="recent-item__sym" style="color:'+color+';font-size:11px">'+icon+' '+s.tokenSymbol+'</div>' +
            '<div class="recent-item__meta" style="font-size:10px">'+s.reasons.slice(0,2).join(' · ')+'</div>' +
            '</div>';
        }).join('');
        if (!html) html = '<div style="font-size:11px;color:var(--green)">All positions healthy</div>';
        list.innerHTML = html + '<div style="font-size:9px;color:var(--dim);margin-top:6px">Scanned: ' + data.totalScanned + ' positions &middot; ' + (data.scannedAt ? new Date(data.scannedAt).toLocaleTimeString() : 'pending') + '</div>';
      }).catch(function(){});
    }
    refreshSmartSignalPanel();
    setInterval(refreshSmartSignalPanel, 30000);

    // Absorption panel
    function refreshAbsorptionPanel() {
      fetch('/api/absorption/status').then(function(r){ return r.json(); }).then(function(d) {
        var el = document.getElementById('abs-count');
        if (el) el.textContent = d.totalAbsorbed;
        var kol = document.getElementById('abs-kol');
        if (kol) kol.textContent = (d.scoreWeightBoosts?.kolWeight ?? 1).toFixed(1) + 'x';
        var holder = document.getElementById('abs-holder');
        if (holder) holder.textContent = (d.scoreWeightBoosts?.holderWeight ?? 1).toFixed(1) + 'x';
        var hist = document.getElementById('abs-history');
        if (!hist) return;
        if (!d.absorptions || d.absorptions.length === 0) {
          hist.innerHTML = '<span style="color:var(--dim)">No strategies absorbed yet. <a href="/goo" style="color:var(--green)">Go to Goo Economy Arena</a> to acquire agents.</span>';
          return;
        }
        hist.innerHTML = d.absorptions.slice(-5).reverse().map(function(a) {
          var changes = a.parameterChanges.map(function(c){ return c.param+': '+c.before+' → '+c.after; }).join(', ') || 'No parameter changes';
          return '<div style="padding:4px 0;border-bottom:1px solid rgba(255,255,255,.05)">' +
            '<strong style="color:var(--green)">' + a.agentName + '</strong> <span style="opacity:.5">(' + a.strategyLabel + ', ' + a.winRate.toFixed(0) + '% WR)</span><br>' +
            '<span style="font-size:10px;opacity:.6">' + changes + '</span></div>';
        }).join('');
      }).catch(function(){});
    }
    refreshAbsorptionPanel();
    setInterval(refreshAbsorptionPanel, 30000);

    // ── Event Timeline ──
    var evtIcons = {
      trade_buy:'\u{1F7E2}', trade_sell:'\u{1F534}', smart_exit:'\u26A0\uFE0F',
      acquisition:'\u{1F4A0}', respawn:'\u{1F680}', trailing_stop:'\u{1F6E1}\uFE0F', kol_exit:'\u{1F451}'
    };
    var evtClasses = { trade_buy:'buy', trade_sell:'sell', smart_exit:'smart_exit', acquisition:'acquisition', respawn:'respawn' };
    function refreshTimeline() {
      fetch('/api/notifications').then(function(r){return r.json();}).then(function(d) {
        var el = document.getElementById('event-timeline');
        if (!el || !d.notifications || d.notifications.length === 0) return;
        var html = d.notifications.slice(0, 25).map(function(n) {
          var t = new Date(n.timestamp);
          var timeStr = t.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
          return '<div class="evt-item evt-item--'+(evtClasses[n.type]||'')+'">'+
            '<div class="evt-item__icon">'+(evtIcons[n.type]||'\u{1F514}')+'</div>'+
            '<div class="evt-item__body"><div class="evt-item__title">'+n.title+'</div><div class="evt-item__detail">'+n.detail+'</div></div>'+
            '<div class="evt-item__time">'+timeStr+'</div></div>';
        }).join('');
        el.innerHTML = html;
      }).catch(function(){});
    }
    refreshTimeline();
    setInterval(refreshTimeline, 15000);

    // ── Live Notification Toasts (only show new ones, remember seen IDs) ──
    var lastNotifSeq = 0;
    var notifContainer = document.getElementById('notif-toast-area');
    var notifIcon = {
      trade_buy: '\u{1F7E2}', trade_sell: '\u{1F534}', smart_exit: '\u26A0\uFE0F',
      acquisition: '\u{1F9EC}', respawn: '\u{1F680}', trailing_stop: '\u{1F6E1}\uFE0F', kol_exit: '\u{1F451}'
    };
    var notifCls = { info: 'nt-info', warning: 'nt-warn', critical: 'nt-crit', success: 'nt-ok' };
    var seenNotifIds = {};
    try {
      var stored = sessionStorage.getItem('elizaok-seen-notifs');
      if (stored) seenNotifIds = JSON.parse(stored);
    } catch(e) {}
    function saveSeenNotifs() { try { sessionStorage.setItem('elizaok-seen-notifs', JSON.stringify(seenNotifIds)); } catch(e) {} }
    var firstPoll = true;
    function pollNotifications() {
      fetch('/api/notifications').then(function(r){ return r.json(); }).then(function(d) {
        if (!d.notifications || d.seq <= lastNotifSeq) return;
        lastNotifSeq = d.seq;
        if (firstPoll) {
          firstPoll = false;
          d.notifications.forEach(function(n) { seenNotifIds[n.id] = 1; });
          saveSeenNotifs();
          return;
        }
        var fresh = d.notifications.filter(function(n) {
          return !seenNotifIds[n.id] && !document.getElementById(n.id);
        }).slice(0, 3);
        fresh.reverse().forEach(function(n) {
          seenNotifIds[n.id] = 1;
          var el = document.createElement('div');
          el.id = n.id;
          el.className = 'nt-toast ' + (notifCls[n.severity] || 'nt-info');
          el.style.position = 'relative';
          el.style.overflow = 'hidden';
          function dismiss() { if (el._gone) return; el._gone = true; el.classList.add('nt-hide'); el.classList.remove('nt-show'); setTimeout(function() { el.remove(); }, 350); }
          el.innerHTML = '<span class="nt-icon">' + (notifIcon[n.type] || '\u{1F514}') + '</span>' +
            '<div class="nt-body"><strong>' + n.title + '</strong><span class="nt-detail">' + n.detail + '</span></div>' +
            '<button class="nt-close">&times;</button>' +
            '<div class="nt-progress"></div>';
          el.querySelector('.nt-close').addEventListener('click', dismiss);
          notifContainer.prepend(el);
          setTimeout(function() { el.classList.add('nt-show'); }, 20);
          setTimeout(dismiss, 5000);
        });
        saveSeenNotifs();
      }).catch(function(){});
    }
    pollNotifications();
    setInterval(pollNotifications, 10000);

  })();
  </script>
</body>
</html>`;
}

/* ─── Docs Page ──────────────────────────────────────────────────── */
function renderDocsPage(lang: "en" | "zh" = "en"): string {
  const t = lang === "zh" ? {
    title: "elizaOK 文档",
    subtitle: "BNB Chain 上的价值层",
    home: "首页",
    dash: "仪表盘",
    langBtn: "EN",
    toc: "目录",
    sec1t: "什么是 elizaOK？",
    sec1: `基于 <strong>elizaOS</strong> 框架构建，elizaOK 是 BNB Chain 上的<strong>价值层</strong>，自动化 alpha 发现、仓位构建，并通过专属金库实现真实价值交付。<br><br>
    通过 Goo Economy（AI 收购 AI），elizaOK 持续吸收竞技场中表现最优的策略参数，不断自我进化，让每一次交易决策更精准。`,
    sec2t: "核心功能",
    sec2_discovery_t: "BSC 代币发现引擎",
    sec2_discovery: `每 15 分钟扫描 BSC 链上新池和热门池，通过 AI 评分引擎对流动性、交易量、买卖压力、市值、池龄等多维度信号进行综合评估。每个代币获得 0-100 评分，自动分为<strong>买入、观察、监控、拒绝</strong>四级。`,
    sec2_portfolio_t: "投资组合管理",
    sec2_portfolio: `elizaOK 采用多层风控体系，每个仓位独立管理。核心策略包括<strong>递进止盈</strong>（多阶段分批锁利）、<strong>硬止损</strong>、<strong>追踪止损</strong>、<strong>链上智能退出</strong>（监测大户/KOL 行为）和<strong>信号衰减退出</strong>。所有策略参数通过 Goo Economy Arena 持续进化优化。`,
    sec2_goo_t: "Goo Economy — AI 收购 AI",
    sec2_goo: `Goo Economy Arena 是 elizaOK 的策略进化引擎。系统运行 <strong>8 种不同策略的 agent</strong>，它们在同一市场环境下竞争：
    <div class="doc-strat-grid">
      <div class="doc-strat"><strong>Conservative</strong> — 低风险，严格筛选，带追踪止损</div>
      <div class="doc-strat"><strong>Balanced</strong> — 均衡风险与回报</div>
      <div class="doc-strat"><strong>Aggressive</strong> — 高风险高回报，无追踪止损</div>
      <div class="doc-strat"><strong>KOL Follower</strong> — 跟踪 KOL 持仓行为</div>
      <div class="doc-strat"><strong>Holder Watcher</strong> — 关注持有者变化趋势</div>
      <div class="doc-strat"><strong>Momentum</strong> — 追踪动量信号</div>
      <div class="doc-strat"><strong>Contrarian</strong> — 反向操作策略</div>
      <div class="doc-strat"><strong>Sniper</strong> — 快进快出狙击手</div>
    </div>
    <br>每个 agent 拥有独立的止盈策略、止损阈值和持有者行为分析权重。系统通过<strong>综合评分</strong>（胜率、盈亏、交易经验、一致性、存活状态）筛选高分 agent，elizaOK 自动<strong>收购</strong>表现优异的 agent，吸收其策略参数，让主组合不断进化。<br><br>
    被收购后，agent 死亡，系统自动<strong>重生新 agent</strong>（最低保持 4 个活跃），维持竞技场多样性。`,
    sec2_flywheel_t: "收益飞轮",
    sec2_flywheel: `所有利润按以下比例自动分配：
    <div class="doc-flywheel">
      <div class="doc-fw-node doc-fw-profit">利润 →</div>
      <div class="doc-fw-node doc-fw-reinvest">70% 再投资</div>
      <div class="doc-fw-node doc-fw-buyback">15% 回购 $elizaOK</div>
      <div class="doc-fw-node doc-fw-airdrop">15% 空投储备</div>
    </div>
    这个飞轮确保系统资金持续滚动增长，同时为持有者创造价值。`,
    sec3t: "Dashboard 功能总览",
    sec3: `<table class="doc-table">
      <tr><td><strong>Agent Terminal</strong></td><td>实时系统状态终端：扫描结果、持仓概览、执行参数、钱包余额</td></tr>
      <tr><td><strong>Token Explorer</strong></td><td>评分代币卡片网格，≥60分显示，点击直达 DEX 交易，活跃持仓展示</td></tr>
      <tr><td><strong>Portfolio Ledger</strong></td><td>活跃仓位（入场价、当前价、BNB成本、未实现P&L、止盈阶段），策略回测报告、胜负排行榜、观察仓位、已退出仓位详细卡片</td></tr>
      <tr><td><strong>Strategy Performance</strong></td><td>按退出策略分组的回测报告：胜率、总P&L、最佳/最差交易、平均持仓时间</td></tr>
      <tr><td><strong>Revenue Flywheel</strong></td><td>利润分配：再投资 70%、$elizaOK 回购 15%、空投储备 15%。胜/负统计、智能退出次数</td></tr>
      <tr><td><strong>Goo Intelligence & Strategy DNA</strong></td><td>Goo Economy Arena 代理舰队概览、收购候选排名、策略吸收状态</td></tr>
      <tr><td><strong>Live Feed</strong></td><td>实时事件流：买入、卖出、收购、重生（右侧栏）</td></tr>
      <tr><td><strong>Execution Desk</strong></td><td>执行控制、风险参数、模型分配 vs 组合初始对比、交易账本</td></tr>
      <tr><td><strong>Value Distribution</strong></td><td>$elizaOK 持有者快照、飞轮利润分配计划</td></tr>
      <tr><td><strong>Goo Intelligence</strong></td><td>Goo 候选代币评估</td></tr>
      <tr><td><strong>ElizaCloud</strong></td><td>云端 Agent 管理入口，一键登录、对话、Credits 余额</td></tr>
    </table>`,
    sec4t: "Goo Economy Arena",
    sec4: `访问 <a href="/goo">/goo</a> 进入 Goo Economy Arena。这里你可以：<ul>
      <li>查看所有 agent 的实时表现和排名</li>
      <li>比较两个 agent 的策略和收益（<a href="/goo/compare">对比页面</a>）</li>
      <li>手动收购高分 agent，加速 elizaOK 进化</li>
      <li>发射新 agent 增加竞技场多样性</li>
      <li>查看每个 agent 的详细 P&L 图表</li>
    </ul>
    Agent 生命周期：<code>ACTIVE → STARVING → DYING → DEAD</code><br>
    Treasury 耗尽后进入饥饿状态，若无法恢复则逐步死亡。`,
    sec5t: "ElizaCloud 集成",
    sec5: `elizaOK 与 <strong>ElizaCloud</strong>（elizaOS 官方云平台）深度集成：<ul>
      <li><strong>注册 & 登录</strong> — 在 <a href="https://elizacloud.ai" target="_blank">elizacloud.ai</a> 免费注册账号，一键登录 elizaOK Dashboard</li>
      <li><strong>与 Agent 对话</strong> — 登录后可直接和 elizaOK Agent 实时聊天，询问交易建议、市场分析、策略解读</li>
      <li><strong>云端 Agent 管理</strong> — 在 ElizaCloud 上部署和管理 elizaOK 实例，随时随地监控</li>
      <li><strong>Credits 系统</strong> — 使用 ElizaCloud credits 运行 AI 推理（当前余额显示在 Dashboard 侧边栏）</li>
      <li><strong>多 Agent 编排</strong> — 支持多个 elizaOK 实例协同交易，共享策略</li>
    </ul>
    ElizaCloud 是 elizaOS 生态的核心基础设施，为所有 agent 提供统一的部署、对话和管理能力。访问 <a href="https://elizacloud.ai" target="_blank">elizacloud.ai</a> 立即注册。`,
    sec6t: "技术架构",
    sec6: `<ul>
      <li><strong>运行时</strong> — Bun + TypeScript + elizaOS 2.0</li>
      <li><strong>数据源</strong> — GeckoTerminal API（实时链上数据）</li>
      <li><strong>链</strong> — BNB Smart Chain (BSC) 专用</li>
      <li><strong>DEX</strong> — PancakeSwap V2, Four.Meme 等</li>
      <li><strong>执行模式</strong> — Paper Trading (模拟) / Dry-Run / Live</li>
      <li><strong>推理引擎</strong> — OpenAI / ElizaCloud 模型</li>
      <li><strong>存储</strong> — 本地 JSON 文件 + 内存缓存</li>
    </ul>`,
    sec7t: "路线图",
    sec7: `<div class="doc-roadmap">
      <div class="doc-rm-item doc-rm-done"><span class="doc-rm-dot"></span><div><strong>Phase 1 — MVP ✅</strong><br>BSC 代币发现、评分、Paper Trading、Goo Economy Arena、Dashboard</div></div>
      <div class="doc-rm-item doc-rm-done"><span class="doc-rm-dot"></span><div><strong>Phase 2 — 策略进化 ✅</strong><br>多阶段止盈、追踪止损、Smart Exit、KOL 反推止盈、策略吸收</div></div>
      <div class="doc-rm-item doc-rm-done"><span class="doc-rm-dot"></span><div><strong>Phase 3 — 飞轮 & UI ✅</strong><br>收益飞轮、实时通知、事件时间线、P&L 图表、移动端适配</div></div>
      <div class="doc-rm-item doc-rm-active"><span class="doc-rm-dot"></span><div><strong>Phase 4 — Live Trading 🔄</strong><br>真实 BNB 执行、风险控制、钱包集成</div></div>
      <div class="doc-rm-item doc-rm-future"><span class="doc-rm-dot"></span><div><strong>Phase 5 — 多链扩展</strong><br>扩展到其他 EVM 链、跨链套利</div></div>
      <div class="doc-rm-item doc-rm-future"><span class="doc-rm-dot"></span><div><strong>Phase 6 — DAO 治理</strong><br>$elizaOK 持有者投票决定策略参数、利润分配比例</div></div>
    </div>`,
    sec8t: "API 接口",
    sec8: `<table class="doc-table">
      <tr><td><code>GET /api/elizaok/candidates</code></td><td>当前候选代币列表和评分</td></tr>
      <tr><td><code>GET /api/goo/agents</code></td><td>所有 Goo agent 数据</td></tr>
      <tr><td><code>GET /api/notifications</code></td><td>实时事件通知</td></tr>
      <tr><td><code>GET /api/absorption/status</code></td><td>策略吸收状态</td></tr>
      <tr><td><code>GET /api/market-intel/signals</code></td><td>市场智能信号</td></tr>
      <tr><td><code>POST /api/goo/agents/spawn</code></td><td>发射新 Goo agent</td></tr>
      <tr><td><code>POST /api/goo/agents/:id/acquire</code></td><td>收购指定 agent</td></tr>
    </table>`,
    sec9t: "常见问题",
    sec9: `<div class="doc-faq">
      <details><summary>elizaOK 会用我的真钱交易吗？</summary><p>默认为 Paper Trading（模拟交易），使用真实市场数据但不执行实际链上交易。只有在切换到 Live 模式并输入确认短语后才会使用真实 BNB。</p></details>
      <details><summary>Goo Economy Arena 的 agent 是真实的吗？</summary><p>Goo agent 使用真实市场数据进行模拟交易竞技。它们的策略和表现是真实计算的，但不涉及实际链上交易。</p></details>
      <details><summary>代币数据从哪里来？</summary><p>所有代币数据来自 GeckoTerminal API，是 BSC 链上的实时数据，包括价格、流动性、成交量、买卖笔数等。</p></details>
      <details><summary>$elizaOK 代币是什么？</summary><p>$elizaOK 是 elizaOK 生态的治理和价值捕获代币。飞轮中 15% 的利润用于回购 $elizaOK，为持有者创造价值。</p></details>
      <details><summary>如何参与空投？</summary><p>持有 $elizaOK 代币即有资格获得空投。飞轮中 15% 的利润进入空投储备，定期分发给合格持有者。</p></details>
      <details><summary>如何注册 ElizaCloud？</summary><p>访问 <a href="https://elizacloud.ai" target="_blank">elizacloud.ai</a> 免费注册账号。注册后可以一键登录 elizaOK Dashboard，与 Agent 实时聊天，获取交易建议和市场分析。</p></details>
    </div>`,
    footer: "由 elizaOS 驱动 · BSC 链专属 · Paper Trading 模式",
  } : {
    title: "elizaOK Documentation",
    subtitle: "Value Layer on BNB Chain",
    home: "Home",
    dash: "Dashboard",
    langBtn: "中文",
    toc: "Table of Contents",
    sec1t: "What is elizaOK?",
    sec1: `Built on the <strong>elizaOS</strong> framework, elizaOK is the <strong>value layer</strong> that automates alpha discovery, position building, and real value delivery through dedicated vaults on <strong>BNB Chain</strong>.<br><br>
    Through Goo Economy (AI acquiring AI), elizaOK continuously absorbs winning strategy parameters from the arena's top performers, self-evolving to sharpen every trading decision.`,
    sec2t: "Core Features",
    sec2_discovery_t: "BSC Token Discovery Engine",
    sec2_discovery: `Scans BSC every 15 minutes for new and trending pools, applying an AI scoring engine that evaluates liquidity, volume, buy/sell pressure, valuation, pool age, and trend signals. Each token receives a 0-100 composite score and is classified into <strong>buy, watch, monitor, reject</strong> tiers.`,
    sec2_portfolio_t: "Portfolio Management",
    sec2_portfolio: `elizaOK employs a multi-layer risk management system, managing each position independently. Core strategies include <strong>progressive take-profit</strong> (multi-stage partial harvesting), <strong>hard stop-loss</strong>, <strong>trailing stop</strong>, <strong>on-chain smart exits</strong> (monitoring whale/KOL behavior), and <strong>score decay exit</strong>. All strategy parameters continuously evolve through the Goo Economy Arena.`,
    sec2_goo_t: "Goo Economy — AI Acquiring AI",
    sec2_goo: `The Goo Economy Arena is elizaOK's strategy evolution engine. It runs <strong>8 agents with different strategies</strong> competing in the same market:
    <div class="doc-strat-grid">
      <div class="doc-strat"><strong>Conservative</strong> — Low risk, strict filters, trailing stop</div>
      <div class="doc-strat"><strong>Balanced</strong> — Balanced risk/reward</div>
      <div class="doc-strat"><strong>Aggressive</strong> — High risk/reward, no trailing stop</div>
      <div class="doc-strat"><strong>KOL Follower</strong> — Tracks KOL behavior</div>
      <div class="doc-strat"><strong>Holder Watcher</strong> — Monitors holder trends</div>
      <div class="doc-strat"><strong>Momentum</strong> — Chases momentum signals</div>
      <div class="doc-strat"><strong>Contrarian</strong> — Counter-trend strategy</div>
      <div class="doc-strat"><strong>Sniper</strong> — Quick in-and-out</div>
    </div>
    <br>Each agent has independent take-profit strategies, stop-loss thresholds, and holder behavior analysis weights. The system uses a <strong>composite scoring algorithm</strong> (win rate, P&L, trade experience, consistency, survival status) to rank agents. elizaOK <strong>auto-acquires</strong> top-performing agents, absorbing their strategy parameters to make the main portfolio continuously evolve.<br><br>
    After acquisition, the agent dies and the system <strong>auto-respawns</strong> new agents (minimum 4 alive) to maintain arena diversity.`,
    sec2_flywheel_t: "Revenue Flywheel",
    sec2_flywheel: `All profits are automatically distributed:
    <div class="doc-flywheel">
      <div class="doc-fw-node doc-fw-profit">Profit →</div>
      <div class="doc-fw-node doc-fw-reinvest">70% Reinvest</div>
      <div class="doc-fw-node doc-fw-buyback">15% $elizaOK Buyback</div>
      <div class="doc-fw-node doc-fw-airdrop">15% Airdrop Reserve</div>
    </div>
    This flywheel ensures continuous compounding growth while creating value for holders.`,
    sec3t: "Dashboard Overview",
    sec3: `<table class="doc-table">
      <tr><td><strong>Agent Terminal</strong></td><td>Live system status terminal: scan results, portfolio overview, execution params, wallet balance</td></tr>
      <tr><td><strong>Token Explorer</strong></td><td>Scored token tile grid, score ≥60 shown, click to trade on DEX, active portfolio display</td></tr>
      <tr><td><strong>Portfolio Ledger</strong></td><td>Active positions with entry/current price, BNB cost basis, unrealized P&L, TP stages, strategy backtest report, win/loss leaderboard, watching positions, exited position detail cards</td></tr>
      <tr><td><strong>Strategy Performance</strong></td><td>Backtest report grouped by exit strategy: win rate, total P&L, best/worst trade, avg hold time</td></tr>
      <tr><td><strong>Revenue Flywheel</strong></td><td>Profit split: 70% reinvest, 15% $elizaOK buyback, 15% airdrop reserve. Win/loss stats, smart exit counts</td></tr>
      <tr><td><strong>Goo Intelligence & Strategy DNA</strong></td><td>Goo Economy Arena agent fleet overview, acquisition candidate ranking, strategy absorption status — AI Acquiring AI</td></tr>
      <tr><td><strong>Live Feed</strong></td><td>Live event feed: buys, exits, acquisitions, respawns (right sidebar)</td></tr>
      <tr><td><strong>Execution Desk</strong></td><td>Execution controls, risk parameters, model allocation vs portfolio cross-reference, trade ledger</td></tr>
      <tr><td><strong>Value Distribution</strong></td><td>$elizaOK holder snapshot, flywheel profit distribution plan</td></tr>
      <tr><td><strong>Goo Intelligence</strong></td><td>Goo candidate evaluation</td></tr>
      <tr><td><strong>ElizaCloud</strong></td><td>Cloud Agent management entry, one-click login, chat, credits balance</td></tr>
    </table>`,
    sec4t: "Goo Economy Arena",
    sec4: `Visit <a href="/goo">/goo</a> to enter the Goo Economy Arena. Here you can:<ul>
      <li>View all agents' live performance and rankings</li>
      <li>Compare two agents' strategies and returns (<a href="/goo/compare">Compare page</a>)</li>
      <li>Manually acquire top agents to accelerate elizaOK's evolution</li>
      <li>Launch new agents to increase arena diversity</li>
      <li>View each agent's detailed P&L charts</li>
    </ul>
    Agent lifecycle: <code>ACTIVE → STARVING → DYING → DEAD</code><br>
    When treasury depletes, agents enter starvation. If unrecovered, they progressively die.`,
    sec5t: "ElizaCloud Integration",
    sec5: `elizaOK is deeply integrated with <strong>ElizaCloud</strong> (the official elizaOS cloud platform):<ul>
      <li><strong>Register & Login</strong> — Create a free account at <a href="https://elizacloud.ai" target="_blank">elizacloud.ai</a>, then one-click login to the elizaOK Dashboard</li>
      <li><strong>Chat with Agent</strong> — Once logged in, chat with elizaOK Agent in real-time — ask for trade advice, market analysis, strategy breakdowns</li>
      <li><strong>Cloud Agent Management</strong> — Deploy and manage elizaOK instances on ElizaCloud, monitor from anywhere</li>
      <li><strong>Credits System</strong> — Use ElizaCloud credits for inference (current balance shown in Dashboard sidebar)</li>
      <li><strong>Multi-Agent Orchestration</strong> — Run multiple elizaOK instances trading together, sharing strategies</li>
    </ul>
    ElizaCloud is the core infrastructure of the elizaOS ecosystem, providing unified deployment, conversation, and management for all agents. Visit <a href="https://elizacloud.ai" target="_blank">elizacloud.ai</a> to register now.`,
    sec6t: "Technical Architecture",
    sec6: `<ul>
      <li><strong>Runtime</strong> — Bun + TypeScript + elizaOS 2.0</li>
      <li><strong>Data Source</strong> — GeckoTerminal API (real-time on-chain data)</li>
      <li><strong>Chain</strong> — BNB Smart Chain (BSC) exclusive</li>
      <li><strong>DEX</strong> — PancakeSwap V2, Four.Meme, etc.</li>
      <li><strong>Execution Modes</strong> — Paper Trading / Dry-Run / Live</li>
      <li><strong>Inference Engine</strong> — OpenAI / ElizaCloud models</li>
      <li><strong>Storage</strong> — Local JSON files + in-memory cache</li>
    </ul>`,
    sec7t: "Roadmap",
    sec7: `<div class="doc-roadmap">
      <div class="doc-rm-item doc-rm-done"><span class="doc-rm-dot"></span><div><strong>Phase 1 — MVP ✅</strong><br>BSC token discovery, scoring, Paper Trading, Goo Economy Arena, Dashboard</div></div>
      <div class="doc-rm-item doc-rm-done"><span class="doc-rm-dot"></span><div><strong>Phase 2 — Strategy Evolution ✅</strong><br>Multi-stage TP, trailing stop, Smart Exit, KOL-adaptive TP, strategy absorption</div></div>
      <div class="doc-rm-item doc-rm-done"><span class="doc-rm-dot"></span><div><strong>Phase 3 — Flywheel & UI ✅</strong><br>Revenue flywheel, live notifications, event timeline, P&L charts, mobile responsive</div></div>
      <div class="doc-rm-item doc-rm-active"><span class="doc-rm-dot"></span><div><strong>Phase 4 — Live Trading 🔄</strong><br>Real BNB execution, risk controls, wallet integration</div></div>
      <div class="doc-rm-item doc-rm-future"><span class="doc-rm-dot"></span><div><strong>Phase 5 — Multi-Chain</strong><br>Expand to other EVM chains, cross-chain arbitrage</div></div>
      <div class="doc-rm-item doc-rm-future"><span class="doc-rm-dot"></span><div><strong>Phase 6 — DAO Governance</strong><br>$elizaOK holders vote on strategy parameters & profit distribution</div></div>
    </div>`,
    sec8t: "API Reference",
    sec8: `<table class="doc-table">
      <tr><td><code>GET /api/elizaok/candidates</code></td><td>Current candidate tokens with scores</td></tr>
      <tr><td><code>GET /api/goo/agents</code></td><td>All Goo agent data</td></tr>
      <tr><td><code>GET /api/notifications</code></td><td>Live event notifications</td></tr>
      <tr><td><code>GET /api/absorption/status</code></td><td>Strategy absorption state</td></tr>
      <tr><td><code>GET /api/market-intel/signals</code></td><td>Market intelligence signals</td></tr>
      <tr><td><code>POST /api/goo/agents/spawn</code></td><td>Launch new Goo agent</td></tr>
      <tr><td><code>POST /api/goo/agents/:id/acquire</code></td><td>Acquire specific agent</td></tr>
    </table>`,
    sec9t: "FAQ",
    sec9: `<div class="doc-faq">
      <details><summary>Does elizaOK trade with real money?</summary><p>By default it runs in Paper Trading mode — real market data, no actual on-chain transactions. Only Live mode (with confirmation phrase) uses real BNB.</p></details>
      <details><summary>Are the Goo Economy Arena agents real?</summary><p>Goo agents use real market data for simulated paper trading. Their strategies and performance are genuinely calculated, but no actual on-chain transactions occur.</p></details>
      <details><summary>Where does the token data come from?</summary><p>All token data comes from the GeckoTerminal API — real-time BSC on-chain data including prices, liquidity, volume, and transaction counts.</p></details>
      <details><summary>What is the $elizaOK token?</summary><p>$elizaOK is the governance and value-capture token. 15% of flywheel profits go to buyback, creating value for holders.</p></details>
      <details><summary>How do I qualify for airdrops?</summary><p>Hold $elizaOK tokens. 15% of flywheel profits go to the airdrop reserve, distributed periodically to eligible holders.</p></details>
      <details><summary>How do I register for ElizaCloud?</summary><p>Visit <a href="https://elizacloud.ai" target="_blank">elizacloud.ai</a> to create a free account. Once registered, you can one-click login to the elizaOK Dashboard, chat with the Agent in real-time, and get trade advice and market analysis.</p></details>
    </div>`,
    footer: "Powered by elizaOS · BSC Exclusive · Paper Trading Mode",
  };

  const sections = [
    { id:'intro', t:t.sec1t, c:t.sec1 },
    { id:'features', t:t.sec2t, c:`
      <h3>${t.sec2_discovery_t}</h3>${t.sec2_discovery}
      <h3>${t.sec2_portfolio_t}</h3>${t.sec2_portfolio}
      <h3>${t.sec2_goo_t}</h3>${t.sec2_goo}
      <h3>${t.sec2_flywheel_t}</h3>${t.sec2_flywheel}` },
    { id:'dashboard', t:t.sec3t, c:t.sec3 },
    { id:'goo-arena', t:t.sec4t, c:t.sec4 },
    { id:'eliza-cloud', t:t.sec5t, c:t.sec5 },
    { id:'tech', t:t.sec6t, c:t.sec6 },
    { id:'roadmap', t:t.sec7t, c:t.sec7 },
    { id:'api', t:t.sec8t, c:t.sec8 },
    { id:'faq', t:t.sec9t, c:t.sec9 },
  ];

  const tocHtml = sections.map(s => `<a href="#${s.id}">${s.t}</a>`).join('');
  const bodyHtml = sections.map(s => `<section id="${s.id}"><h2>${s.t}</h2><div class="doc-content">${s.c}</div></section>`).join('');

  return `<!DOCTYPE html><html lang="${lang}"><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${t.title} | elizaOK</title>
${renderHeadBrandAssets(t.title)}
<link href="https://fonts.googleapis.com/css2?family=Martian+Mono:wght@100..800&display=swap" rel="stylesheet"/>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
:root{--bg:#0a0a09;--surface:rgba(18,18,16,.92);--surface2:rgba(26,26,22,.75);--border:rgba(246,231,15,.1);--border2:rgba(246,231,15,.18);--text:#f5f5f0;--dim:rgba(245,245,240,.45);--yellow:#F6E70F;--yr:246,231,15;--green:#22c55e;--red:#ef4444;--cyan:#00C7D2;--purple:#8b5cf6;--orange:#f59e0b;}
html{scrollbar-width:none;}html::-webkit-scrollbar{display:none;}
body{background:var(--bg);color:var(--text);font-family:'Martian Mono',monospace;line-height:1.7;overflow-x:hidden;-webkit-overflow-scrolling:touch;overscroll-behavior-y:contain;}
body::before{content:"";position:fixed;inset:0;pointer-events:none;z-index:0;background:
  radial-gradient(ellipse 600px 400px at 10% 10%, rgba(246,231,15,.04), transparent),
  radial-gradient(ellipse 500px 500px at 90% 20%, rgba(0,199,210,.03), transparent),
  radial-gradient(ellipse 600px 400px at 50% 80%, rgba(139,92,246,.025), transparent);}
body::after{content:"";position:fixed;inset:0;pointer-events:none;z-index:0;
  background-image:radial-gradient(circle, rgba(246,231,15,.06) 1px, transparent 1px);
  background-size:24px 24px;opacity:.4;}
a{color:var(--yellow);text-decoration:none;}
a:hover{text-decoration:underline;}

/* ── Topbar ── */
.doc-topbar{position:sticky;top:0;z-index:100;display:flex;align-items:center;justify-content:space-between;padding:10px 28px;background:rgba(10,10,9,.92);backdrop-filter:blur(16px) saturate(1.4);border-bottom:1px solid var(--border);}
.doc-topbar__left{display:flex;align-items:center;gap:14px;}
.doc-avatar{width:36px;height:36px;border-radius:10px;overflow:hidden;border:1px solid rgba(246,231,15,.2);box-shadow:0 0 0 0 rgba(246,231,15,0);transition:box-shadow .4s,transform .3s;cursor:pointer;flex-shrink:0;position:relative;}
.doc-avatar:hover{box-shadow:0 0 24px rgba(246,231,15,.35),0 0 48px rgba(246,231,15,.12);transform:translateY(-2px) scale(1.05);}
.doc-avatar img{width:100%;height:100%;object-fit:cover;display:block;}
.doc-avatar::after{content:"";position:absolute;inset:-4px;border-radius:14px;border:1px solid rgba(246,231,15,0);transition:border-color .4s;pointer-events:none;}
.doc-avatar:hover::after{border-color:rgba(246,231,15,.25);}
.doc-topbar__title{font-size:15px;font-weight:700;color:var(--yellow);letter-spacing:-.01em;}
.doc-topbar__sub{font-size:9px;color:var(--dim);letter-spacing:.04em;margin-top:1px;}
.doc-topbar__right{display:flex;gap:6px;align-items:center;}
.doc-btn{padding:7px 16px;border-radius:8px;font-family:inherit;font-size:9px;font-weight:500;border:1px solid rgba(255,255,255,.06);background:rgba(255,255,255,.03);color:var(--dim);cursor:pointer;text-decoration:none;transition:all .25s;letter-spacing:.03em;text-transform:uppercase;}
.doc-btn:hover{border-color:var(--yellow);color:var(--yellow);background:rgba(var(--yr),.06);text-decoration:none;transform:translateY(-1px);box-shadow:0 4px 12px rgba(var(--yr),.08);}
.doc-btn--active{border-color:rgba(var(--yr),.4);color:var(--yellow);background:rgba(var(--yr),.1);box-shadow:inset 0 0 12px rgba(var(--yr),.06);}
.doc-btn-sep{width:1px;height:20px;background:var(--border);margin:0 2px;}

/* ── Layout ── */
.doc-layout{display:grid;grid-template-columns:190px 1fr;max-width:1200px;margin:0 auto;gap:0;position:relative;z-index:1;}
@media(max-width:900px){.doc-layout{grid-template-columns:1fr;}.doc-toc{display:none;}}
.doc-toc{position:sticky;top:56px;align-self:start;padding:28px 12px;border-right:1px solid var(--border);height:calc(100vh - 56px);overflow-y:auto;}
.doc-toc__label{font-size:9px;font-weight:700;color:rgba(var(--yr),.5);margin-bottom:14px;text-transform:uppercase;letter-spacing:.14em;padding-left:10px;}
.doc-toc a{display:block;padding:7px 10px;font-size:9.5px;color:var(--dim);border-radius:6px;margin-bottom:1px;transition:all .2s;border-left:2px solid transparent;}
.doc-toc a:hover{color:var(--yellow);background:rgba(var(--yr),.05);text-decoration:none;border-left-color:rgba(var(--yr),.3);}
.doc-toc a.active{color:var(--yellow);background:rgba(var(--yr),.08);text-decoration:none;border-left-color:var(--yellow);}

/* ── Main ── */
.doc-main{padding:40px 56px 40px 48px;max-width:none;}
@media(max-width:900px){.doc-main{padding:24px 16px;}}
section{margin-bottom:56px;scroll-margin-top:72px;animation:docFadeIn .5s ease-out both;}
@keyframes docFadeIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
h2{font-size:17px;font-weight:700;color:var(--yellow);margin-bottom:20px;padding-bottom:12px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px;}
h2::before{content:"";width:3px;height:20px;border-radius:2px;background:var(--yellow);box-shadow:0 0 8px rgba(var(--yr),.3);}
h3{font-size:12.5px;font-weight:700;color:var(--cyan);margin:24px 0 12px;text-transform:uppercase;letter-spacing:.06em;display:flex;align-items:center;gap:8px;}
h3::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--cyan);opacity:.5;}

/* ── Content ── */
.doc-content{font-size:12.5px;color:rgba(245,245,240,.82);line-height:1.85;}
.doc-content ul{margin:12px 0;padding-left:22px;}
.doc-content li{margin-bottom:8px;padding-left:4px;}
.doc-content li::marker{color:rgba(var(--yr),.4);}
.doc-content code{background:rgba(var(--yr),.07);padding:2px 8px;border-radius:5px;font-size:11px;color:var(--yellow);border:1px solid rgba(var(--yr),.08);}
.doc-content strong{color:var(--text);font-weight:600;}
.doc-content a{border-bottom:1px dashed rgba(var(--yr),.3);transition:border-color .2s;}
.doc-content a:hover{border-bottom-color:var(--yellow);text-decoration:none;}

/* ── Section card wrapper ── */
section .doc-content{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:28px 32px;box-shadow:0 4px 24px rgba(0,0,0,.12);transition:border-color .3s,box-shadow .3s;}
section .doc-content:hover{border-color:var(--border2);box-shadow:0 8px 32px rgba(0,0,0,.18),0 0 0 1px rgba(var(--yr),.04);}

.doc-table{width:100%;border-collapse:collapse;margin:12px 0;font-size:10.5px;}
.doc-table td{padding:9px 14px;border-bottom:1px solid rgba(255,255,255,.04);}
.doc-table td:first-child{width:42%;color:var(--text);white-space:nowrap;}
.doc-table td:last-child{color:var(--dim);}
.doc-table tr:hover td{background:rgba(var(--yr),.03);}
.doc-strat-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:14px 0;}
@media(max-width:500px){.doc-strat-grid{grid-template-columns:1fr;}}
.doc-strat{padding:9px 14px;background:rgba(255,255,255,.02);border:1px solid var(--border);border-radius:8px;font-size:10px;transition:border-color .2s,background .2s;}
.doc-strat:hover{border-color:var(--border2);background:rgba(var(--yr),.03);}
.doc-flywheel{display:flex;gap:8px;margin:14px 0;flex-wrap:wrap;}
.doc-fw-node{padding:12px 16px;border-radius:10px;font-size:10.5px;font-weight:600;text-align:center;flex:1;min-width:100px;transition:transform .2s,box-shadow .2s;}
.doc-fw-node:hover{transform:translateY(-2px);box-shadow:0 4px 16px rgba(0,0,0,.2);}
.doc-fw-profit{background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.2);color:var(--green);}
.doc-fw-reinvest{background:rgba(0,199,210,.1);border:1px solid rgba(0,199,210,.2);color:var(--cyan);}
.doc-fw-buyback{background:rgba(139,92,246,.1);border:1px solid rgba(139,92,246,.2);color:var(--purple);}
.doc-fw-airdrop{background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.2);color:var(--orange);}
.doc-roadmap{margin:14px 0;}
.doc-rm-item{display:flex;gap:14px;padding:14px 0;border-left:2px solid var(--border);margin-left:8px;padding-left:22px;position:relative;font-size:10.5px;transition:background .2s;}
.doc-rm-item:hover{background:rgba(var(--yr),.015);border-radius:0 8px 8px 0;}
.doc-rm-dot{position:absolute;left:-6px;top:18px;width:10px;height:10px;border-radius:50%;border:2px solid var(--border);background:var(--bg);transition:transform .3s;}
.doc-rm-item:hover .doc-rm-dot{transform:scale(1.3);}
.doc-rm-done .doc-rm-dot{background:var(--green);border-color:var(--green);}
.doc-rm-active .doc-rm-dot{background:var(--yellow);border-color:var(--yellow);box-shadow:0 0 10px rgba(var(--yr),.5);}
.doc-rm-active{border-left-color:var(--yellow);}
.doc-rm-future .doc-rm-dot{background:var(--surface);border-color:var(--dim);}
.doc-faq{margin:10px 0;}
.doc-faq details{margin-bottom:6px;border:1px solid var(--border);border-radius:10px;overflow:hidden;transition:border-color .2s;}
.doc-faq details[open]{border-color:var(--border2);}
.doc-faq summary{padding:12px 16px;font-size:11px;font-weight:600;cursor:pointer;transition:background .2s;list-style:none;}
.doc-faq summary::-webkit-details-marker{display:none;}
.doc-faq summary::before{content:"▸";margin-right:8px;color:var(--yellow);transition:transform .2s;display:inline-block;}
details[open] summary::before{transform:rotate(90deg);}
.doc-faq summary:hover{background:rgba(var(--yr),.04);}
.doc-faq p{padding:8px 16px 16px;font-size:11px;color:var(--dim);line-height:1.7;}
.doc-footer{text-align:center;padding:36px;font-size:9px;color:var(--dim);border-top:1px solid var(--border);letter-spacing:.04em;}
@media(max-width:768px){
  .doc-topbar{padding:8px 14px;flex-wrap:wrap;gap:8px;}
  .doc-topbar__right{flex-wrap:wrap;gap:4px;}
  .doc-btn{padding:5px 10px;font-size:8px;}
  .doc-avatar{width:28px;height:28px;}
  .doc-main{padding:20px 14px;}
  h2{font-size:14px;margin-bottom:14px;padding-bottom:8px;}
  h3{font-size:11px;margin:16px 0 8px;}
  section .doc-content{padding:16px 14px;border-radius:12px;}
  .doc-content{font-size:11.5px;line-height:1.7;}
  .doc-flywheel{flex-direction:column;}
  .doc-fw-node{min-width:0;padding:10px 12px;font-size:10px;}
  .doc-strat-grid{grid-template-columns:1fr;}
  .doc-strat{font-size:9px;padding:7px 10px;}
  .doc-table td{padding:6px 8px;font-size:9.5px;}
  .doc-table td:first-child{white-space:normal;}
  .doc-rm-item{font-size:9.5px;padding-left:16px;}
  .doc-faq summary{font-size:10px;padding:10px 12px;}
  .doc-faq p{font-size:10px;padding:6px 12px 12px;}
}
</style></head><body>
<div class="doc-topbar">
  <div class="doc-topbar__left">
    <div class="doc-avatar">${renderBrandLogoImage("doc-avatar-img")}<style>.doc-avatar-img{width:100%;height:100%;object-fit:cover;display:block;}</style></div>
    <div><div class="doc-topbar__title">elizaOK</div><div class="doc-topbar__sub">${escapeHtml(t.subtitle)}</div></div>
  </div>
  <div class="doc-topbar__right">
    <a class="doc-btn" href="/">${t.home}</a>
    <a class="doc-btn" href="/dashboard">${t.dash}</a>
    <a class="doc-btn" href="/goo">Goo Economy Arena</a>
    <div class="doc-btn-sep"></div>
    <a class="doc-btn${lang === 'en' ? ' doc-btn--active' : ''}" href="/docs?lang=en">EN</a>
    <a class="doc-btn${lang === 'zh' ? ' doc-btn--active' : ''}" href="/docs?lang=zh">中文</a>
  </div>
</div>
<div class="doc-layout">
  <nav class="doc-toc"><div class="doc-toc__label">${t.toc}</div>${tocHtml}</nav>
  <main class="doc-main">
    ${bodyHtml}
    <div class="doc-footer">${t.footer}</div>
  </main>
</div>
<script>
var links = document.querySelectorAll('.doc-toc a');
var sections = document.querySelectorAll('section');
var observer = new IntersectionObserver(function(entries) {
  entries.forEach(function(e) {
    if (e.isIntersecting) {
      var idx = Array.from(sections).indexOf(e.target);
      links.forEach(function(l){ l.classList.remove('active'); });
      if (links[idx]) links[idx].classList.add('active');
    }
  });
}, { rootMargin: '-20% 0px -60% 0px' });
sections.forEach(function(s) { observer.observe(s); });
</script></body></html>`;
}

/* ─── Strategy Backtest Page ──────────────────────────────────────── */
function renderBacktestPage(
  agents: GooPaperAgent[],
  snapshot: any,
  bnbPrice: number = 600,
): string {
  const fmtUsd = (v: number) => `$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const fmtBnb = (v: number) => v.toFixed(4);

  const sorted = [...agents].sort((a, b) => b.acquisitionScore - a.acquisitionScore);
  const totalTrades = agents.reduce((s, a) => s + a.totalTradesCount, 0);
  const totalPnl = agents.reduce((s, a) => s + a.totalPnlUsd, 0);
  const avgWinRate = agents.length > 0 ? agents.reduce((s, a) => s + a.winRate, 0) / agents.length : 0;
  const bestAgent = sorted[0];
  const worstAgent = sorted[sorted.length - 1];
  const totalFlywheelBnb = agents.reduce((s, a) => s + (a.flywheel?.totalProfitBnb ?? 0), 0);

  const strategyGroups = new Map<string, { label: string; agents: GooPaperAgent[] }>();
  for (const a of agents) {
    const key = a.strategy.id;
    if (!strategyGroups.has(key)) strategyGroups.set(key, { label: a.strategy.label, agents: [] });
    strategyGroups.get(key)!.agents.push(a);
  }

  const strategyRows = Array.from(strategyGroups.entries()).map(([id, group]) => {
    const ga = group.agents;
    const trades = ga.reduce((s, a) => s + a.totalTradesCount, 0);
    const wins = ga.reduce((s, a) => s + a.winCount, 0);
    const losses = ga.reduce((s, a) => s + a.lossCount, 0);
    const pnl = ga.reduce((s, a) => s + a.totalPnlUsd, 0);
    const wr = trades > 0 ? (wins / (wins + losses || 1)) * 100 : 0;
    const treasury = ga.reduce((s, a) => s + a.treasuryBnb, 0);
    const avgScore = ga.reduce((s, a) => s + a.acquisitionScore, 0) / ga.length;
    const best = ga.reduce((s, a) => Math.max(s, a.bestTradeUsd), 0);
    const worst = ga.reduce((s, a) => Math.min(s, a.worstTradeUsd), 0);
    const pnlCls = pnl >= 0 ? 'bt-pos' : 'bt-neg';
    return `<tr>
      <td><strong>${escapeHtml(group.label)}</strong><br/><span class="bt-dim">${ga.length} agent${ga.length > 1 ? 's' : ''}</span></td>
      <td>${trades}</td>
      <td><span class="bt-pos">${wins}</span> / <span class="bt-neg">${losses}</span></td>
      <td>${wr.toFixed(1)}%</td>
      <td class="${pnlCls}">${pnl >= 0 ? '+' : '-'}${fmtUsd(pnl)}</td>
      <td>${fmtBnb(treasury)}</td>
      <td class="bt-pos">+${fmtUsd(best)}</td>
      <td class="bt-neg">-${fmtUsd(Math.abs(worst))}</td>
      <td>${avgScore.toFixed(0)}</td>
    </tr>`;
  }).join('');

  const agentRows = sorted.map((a, i) => {
    const pnlCls = a.totalPnlUsd >= 0 ? 'bt-pos' : 'bt-neg';
    const statColor: Record<string, string> = { active:'#00C7D2', starving:'#ca8a04', dying:'#ea580c', dead:'#D1D5DB' };
    const initialBnb = a.initialTreasuryBnb || 1;
    const agentInvestedUsd = initialBnb * bnbPrice;
    const roi = agentInvestedUsd > 0 ? (a.totalPnlUsd / agentInvestedUsd) * 100 : 0;
    const activePos = a.positions.filter(p => p.state === 'active').length;
    const exitedPos = a.positions.filter(p => p.state === 'exited').length;
    const maxDrawdown = a.worstTradeUsd < 0 ? a.worstTradeUsd : 0;
    return `<tr>
      <td><strong>#${i + 1}</strong></td>
      <td>
        <div style="display:flex;align-items:center;gap:6px">
          <span class="bt-dot" style="background:${statColor[a.chainState] || '#888'}"></span>
          <div><strong>${escapeHtml(a.agentName)}</strong><br/><span class="bt-dim">${escapeHtml(a.strategy.label)}</span></div>
        </div>
      </td>
      <td style="color:${statColor[a.chainState]}">${a.chainState.toUpperCase()}</td>
      <td>${a.totalTradesCount}</td>
      <td>${a.winRate.toFixed(1)}%</td>
      <td class="${pnlCls}">${a.totalPnlUsd >= 0 ? '+' : '-'}${fmtUsd(a.totalPnlUsd)}</td>
      <td class="${roi >= 0 ? 'bt-pos' : 'bt-neg'}">${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%</td>
      <td>${fmtBnb(a.treasuryBnb)}</td>
      <td>${a.acquisitionScore}/100</td>
      <td>${activePos}/${exitedPos}</td>
    </tr>`;
  }).join('');

  const tradeLogRows = sorted.flatMap(a => a.tradeHistory.map(t => ({
    ...t, agentName: a.agentName, strategy: a.strategy.label,
  }))).sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)).slice(0, 50).map(t => {
    const sideCls = t.side === 'buy' ? 'bt-buy' : 'bt-sell';
    const pnlCls = t.pnlUsd >= 0 ? 'bt-pos' : 'bt-neg';
    const time = new Date(t.timestamp);
    const timeStr = `${time.getMonth()+1}/${time.getDate()} ${time.toTimeString().slice(0,5)}`;
    return `<tr>
      <td class="bt-dim">${timeStr}</td>
      <td><span class="${sideCls}">${t.side.toUpperCase()}</span></td>
      <td>${escapeHtml(t.tokenSymbol)}</td>
      <td>${escapeHtml((t as any).agentName)}</td>
      <td>${fmtUsd(t.amountUsd)}</td>
      <td class="${pnlCls}">${t.pnlUsd >= 0 ? '+' : '-'}${fmtUsd(t.pnlUsd)}</td>
      <td class="bt-dim">${escapeHtml(t.reason)}</td>
    </tr>`;
  }).join('');

  const riskParams = sorted.map(a => `<tr>
    <td><strong>${escapeHtml(a.agentName)}</strong></td>
    <td>${escapeHtml(a.strategy.label)}</td>
    <td>${a.strategy.minScore}</td>
    <td>${a.strategy.maxPositions}</td>
    <td>${a.strategy.buyPct}%</td>
    <td>${a.strategy.stopLossPct}%</td>
    <td>${a.strategy.takeProfitRules.map(r => r.label).join(', ')}</td>
    <td>${a.strategy.trailingStopEnabled ? `${a.strategy.trailingStopPct}%` : 'Off'}</td>
    <td>${a.strategy.exitOnHolderDrop ? `${a.strategy.holderDropThreshold}` : 'Off'}</td>
    <td>${a.strategy.exitOnKolExit ? `Min ${a.strategy.minKolCount}` : 'Off'}</td>
  </tr>`).join('');

  const runDuration = agents.length > 0 ? Date.now() - Date.parse(agents[0].createdAt) : 0;
  const durationStr = runDuration > 86400000 ? `${(runDuration / 86400000).toFixed(1)}d` :
    runDuration > 3600000 ? `${(runDuration / 3600000).toFixed(1)}h` : `${(runDuration / 60000).toFixed(0)}m`;

  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>Strategy Backtest | elizaOK</title>
<link href="https://fonts.googleapis.com/css2?family=Martian+Mono:wght@100..800&display=swap" rel="stylesheet"/>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0a0a09;--surface:rgba(18,18,16,.85);--border:rgba(246,231,15,.1);--text:#f5f5f0;--dim:rgba(245,245,240,.45);--yellow:#F6E70F;--green:#22c55e;--red:#ef4444;--cyan:#00C7D2;--orange:#f97316;}
body{background:var(--bg);color:var(--text);font-family:'Martian Mono',monospace;min-height:100vh;}
a{color:var(--yellow);text-decoration:none;}
.bt-wrap{max-width:1200px;margin:0 auto;padding:24px 20px 40px;}
.bt-topbar{display:flex;align-items:center;justify-content:space-between;padding:12px 0 20px;border-bottom:1px solid var(--border);margin-bottom:24px;}
.bt-topbar h1{font-size:16px;font-weight:700;display:flex;align-items:center;gap:10px;}
.bt-topbar__nav{display:flex;gap:12px;font-size:11px;}
.bt-topbar__nav a{color:var(--dim);padding:4px 10px;border-radius:6px;transition:all .2s;}
.bt-topbar__nav a:hover,.bt-topbar__nav a.active{color:var(--text);background:rgba(246,231,15,.08);}
.bt-badge{display:inline-block;background:rgba(246,231,15,.12);color:var(--yellow);font-size:9px;padding:2px 8px;border-radius:4px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;}
.bt-badge--live{background:rgba(34,197,94,.15);color:var(--green);animation:bt-pulse 2s infinite;}
@keyframes bt-pulse{0%,100%{opacity:1}50%{opacity:.5}}
.bt-logo-avatar{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:50%;overflow:hidden;position:relative;vertical-align:middle;margin-right:4px;}
.bt-logo-avatar img{width:100%;height:100%;object-fit:cover;border-radius:50%;position:relative;z-index:1;}
.bt-logo-avatar::before{content:'';position:absolute;inset:-3px;border-radius:50%;background:conic-gradient(var(--yellow),var(--green),var(--cyan),var(--yellow));animation:bt-glow-spin 3s linear infinite;z-index:0;}
.bt-logo-avatar::after{content:'';position:absolute;inset:0;border-radius:50%;box-shadow:0 0 12px 4px rgba(246,231,15,.3);animation:bt-glow-pulse 2s ease-in-out infinite;z-index:0;}
@keyframes bt-glow-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
@keyframes bt-glow-pulse{0%,100%{box-shadow:0 0 8px 2px rgba(246,231,15,.2)}50%{box-shadow:0 0 18px 6px rgba(246,231,15,.45)}}
.bt-summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:28px;}
.bt-kpi{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px 16px;text-align:center;}
.bt-kpi span{font-size:9px;color:var(--dim);text-transform:uppercase;letter-spacing:.08em;display:block;margin-bottom:6px;}
.bt-kpi strong{font-size:18px;font-weight:700;display:block;}
.bt-section{margin-bottom:28px;}
.bt-section h2{font-size:13px;font-weight:600;margin-bottom:12px;display:flex;align-items:center;gap:8px;padding-bottom:8px;border-bottom:1px solid var(--border);}
.bt-table-wrap{overflow-x:auto;border-radius:10px;border:1px solid var(--border);background:var(--surface);}
table.bt-table{width:100%;border-collapse:collapse;font-size:11px;}
.bt-table th{font-size:9px;color:var(--dim);text-transform:uppercase;letter-spacing:.06em;text-align:left;padding:10px 12px;border-bottom:1px solid var(--border);font-weight:500;white-space:nowrap;}
.bt-table td{padding:8px 12px;border-bottom:1px solid rgba(246,231,15,.04);vertical-align:middle;}
.bt-table tbody tr:hover{background:rgba(246,231,15,.03);}
.bt-table tbody tr:last-child td{border-bottom:none;}
.bt-pos{color:var(--green);}
.bt-neg{color:var(--red);}
.bt-dim{color:var(--dim);font-size:10px;}
.bt-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;display:inline-block;}
.bt-buy{color:var(--cyan);font-weight:600;font-size:10px;}
.bt-sell{color:var(--orange);font-weight:600;font-size:10px;}
.bt-method{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:16px;font-size:11px;line-height:1.7;}
.bt-method h3{font-size:12px;font-weight:600;margin-bottom:8px;color:var(--yellow);}
.bt-method ul{padding-left:18px;color:var(--dim);}
.bt-method li{margin-bottom:4px;}
.bt-method li strong{color:var(--text);}
.bt-footer{text-align:center;padding:20px;font-size:10px;color:var(--dim);border-top:1px solid var(--border);margin-top:20px;}
@media(max-width:768px){
  .bt-summary{grid-template-columns:repeat(2,1fr);}
  .bt-topbar{flex-direction:column;gap:12px;align-items:flex-start;}
  .bt-kpi strong{font-size:14px;}
}
</style>
<meta http-equiv="refresh" content="60"/>
</head>
<body>
<div class="bt-wrap">
  <div class="bt-topbar">
    <h1><span class="bt-logo-avatar"><img src="/assets/avatar.png" alt="elizaOK" /></span> Strategy Backtest <span class="bt-badge--live">LIVE</span></h1>
    <nav class="bt-topbar__nav">
      <a href="/">Home</a>
      <a href="/dashboard">Dashboard</a>
      <a href="/backtest" class="active">Backtest</a>
      <a href="/goo">Goo Arena</a>
      <a href="/docs">Docs</a>
    </nav>
  </div>

  <div class="bt-method">
    <h3>Methodology</h3>
    <p>elizaOK runs <strong>${agents.length} parallel agents</strong> with distinct strategy configurations against <strong>live BSC market data</strong> from GeckoTerminal. Each agent starts with <strong>1.0 BNB</strong> treasury and independently scans, scores, enters, manages, and exits positions using real-time on-chain metrics. This is a live forward-test (paper trading) — not simulated historical replay.</p>
    <ul>
      <li><strong>Data source:</strong> GeckoTerminal BSC new_pools + trending_pools, enriched with GMGN holder/KOL/whale data</li>
      <li><strong>Scoring:</strong> 0-100 composite score (liquidity, volume, buy/sell ratio, FDV, pool age, KOL holdings, holder distribution)</li>
      <li><strong>Execution:</strong> Paper execution at discovery FDV — each agent manages positions independently</li>
      <li><strong>Risk management:</strong> Per-strategy stop-loss, multi-stage take-profit, trailing stop, smart exit (holder attrition, KOL exits, whale dumps)</li>
      <li><strong>Duration:</strong> ${durationStr} elapsed · scans every 15 minutes</li>
    </ul>
  </div>

  <div class="bt-summary">
    <div class="bt-kpi"><span>Strategies</span><strong>${strategyGroups.size}</strong></div>
    <div class="bt-kpi"><span>Agents</span><strong>${agents.length}</strong></div>
    <div class="bt-kpi"><span>Total Trades</span><strong>${totalTrades}</strong></div>
    <div class="bt-kpi"><span>Avg Win Rate</span><strong>${avgWinRate.toFixed(1)}%</strong></div>
    <div class="bt-kpi"><span>Total P&L</span><strong class="${totalPnl >= 0 ? 'bt-pos' : 'bt-neg'}">${totalPnl >= 0 ? '+' : '-'}${fmtUsd(totalPnl)}</strong></div>
    <div class="bt-kpi"><span>Flywheel Profit</span><strong>${fmtBnb(totalFlywheelBnb)} BNB</strong></div>
    <div class="bt-kpi"><span>Run Duration</span><strong>${durationStr}</strong></div>
    <div class="bt-kpi"><span>Best Agent</span><strong style="font-size:12px">${bestAgent ? escapeHtml(bestAgent.agentName) : 'n/a'}</strong></div>
  </div>

  <div class="bt-section">
    <h2>&#x1F3AF; Strategy Comparison</h2>
    <div class="bt-table-wrap"><table class="bt-table">
      <thead><tr>
        <th>Strategy</th><th>Trades</th><th>W / L</th><th>Win Rate</th><th>P&L</th><th>Treasury</th><th>Best</th><th>Worst</th><th>Acq. Score</th>
      </tr></thead>
      <tbody>${strategyRows || '<tr><td colspan="9" style="text-align:center;padding:20px;color:var(--dim)">Waiting for first cycle...</td></tr>'}</tbody>
    </table></div>
  </div>

  <div class="bt-section">
    <h2>&#x1F3C6; Agent Leaderboard</h2>
    <div class="bt-table-wrap"><table class="bt-table">
      <thead><tr>
        <th>Rank</th><th>Agent</th><th>Status</th><th>Trades</th><th>Win Rate</th><th>P&L</th><th>ROI</th><th>Treasury</th><th>Score</th><th>Pos (A/E)</th>
      </tr></thead>
      <tbody>${agentRows || '<tr><td colspan="10" style="text-align:center;padding:20px;color:var(--dim)">Waiting for first cycle...</td></tr>'}</tbody>
    </table></div>
  </div>

  <div class="bt-section">
    <h2>&#x2699;&#xFE0F; Risk Parameters Matrix</h2>
    <div class="bt-table-wrap"><table class="bt-table">
      <thead><tr>
        <th>Agent</th><th>Strategy</th><th>Min Score</th><th>Max Pos.</th><th>Buy Size</th><th>Stop Loss</th><th>Take Profit</th><th>Trailing Stop</th><th>Holder Exit</th><th>KOL Exit</th>
      </tr></thead>
      <tbody>${riskParams}</tbody>
    </table></div>
  </div>

  <div class="bt-section">
    <h2>&#x1F4DD; Trade Log (Latest ${Math.min(50, sorted.flatMap(a => a.tradeHistory).length)})</h2>
    <div class="bt-table-wrap"><table class="bt-table">
      <thead><tr>
        <th>Time</th><th>Side</th><th>Token</th><th>Agent</th><th>Amount</th><th>P&L</th><th>Reason</th>
      </tr></thead>
      <tbody>${tradeLogRows || '<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--dim)">No trades yet. Agents will trade on the next discovery cycle.</td></tr>'}</tbody>
    </table></div>
  </div>

  <div class="bt-footer">
    elizaOK Strategy Backtest Engine &middot; Live Paper Trading &middot; Powered by <a href="https://github.com/HertzFlow/goo-launch">Goo Economy</a> &middot; Auto-refresh 60s
  </div>
</div>
</body></html>`;
}

/* ─── Agent Compare Page ─────────────────────────────────────────── */
function renderGooComparePage(agents: GooPaperAgent[]): string {
  const fmtUsd = (v: number) => `$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const fmtBnb = (v: number) => v.toFixed(4);
  const optionRows = agents.map(a =>
    `<option value="${escapeHtml(a.id)}">${escapeHtml(a.agentName)} (${escapeHtml(a.strategy.label)}) — ${a.winRate.toFixed(1)}% WR</option>`
  ).join('');

  function agentCard(a: GooPaperAgent): string {
    const pnl = a.totalPnlUsd;
    const pnlCls = pnl >= 0 ? 'cmp-pos' : 'cmp-neg';
    const statColor: Record<string, string> = { active:'#00C7D2', starving:'#ca8a04', dying:'#ea580c', dead:'#D1D5DB' };
    return `
    <div class="cmp-card">
      <div class="cmp-card__name"><span class="cmp-dot" style="background:${statColor[a.chainState] || '#888'}"></span>${escapeHtml(a.agentName)}</div>
      <div class="cmp-card__strategy">${escapeHtml(a.strategy.label)}</div>
      <div class="cmp-stat-grid">
        <div class="cmp-stat"><span>P&L</span><strong class="${pnlCls}">${pnl >= 0 ? '+' : ''}${fmtUsd(pnl)}</strong></div>
        <div class="cmp-stat"><span>Win Rate</span><strong>${a.winRate.toFixed(1)}%</strong></div>
        <div class="cmp-stat"><span>Trades</span><strong>${a.totalTradesCount}</strong></div>
        <div class="cmp-stat"><span>Win / Loss</span><strong><span class="cmp-pos">${a.winCount}</span> / <span class="cmp-neg">${a.lossCount}</span></strong></div>
        <div class="cmp-stat"><span>Best Trade</span><strong class="cmp-pos">+${fmtUsd(a.bestTradeUsd)}</strong></div>
        <div class="cmp-stat"><span>Worst Trade</span><strong class="cmp-neg">${fmtUsd(a.worstTradeUsd)}</strong></div>
        <div class="cmp-stat"><span>Treasury</span><strong>${fmtBnb(a.treasuryBnb)} BNB</strong></div>
        <div class="cmp-stat"><span>Sharpe Est.</span><strong>${a.sharpeEstimate.toFixed(2)}</strong></div>
        <div class="cmp-stat"><span>Status</span><strong style="color:${statColor[a.chainState] || '#888'}">${a.chainState.toUpperCase()}</strong></div>
        <div class="cmp-stat"><span>Acq. Score</span><strong>${a.acquisitionScore}</strong></div>
        <div class="cmp-stat"><span>Active Pos.</span><strong>${a.positions.filter(p => p.state === 'active').length}</strong></div>
        <div class="cmp-stat"><span>Flywheel Profit</span><strong>${fmtBnb(a.flywheel?.totalProfitBnb ?? 0)} BNB</strong></div>
      </div>
      <div class="cmp-strat-detail">
        <div class="cmp-stat"><span>Min Score</span><strong>${a.strategy.minScore}</strong></div>
        <div class="cmp-stat"><span>Max Positions</span><strong>${a.strategy.maxPositions}</strong></div>
        <div class="cmp-stat"><span>Stop Loss</span><strong>${a.strategy.stopLossPct}%</strong></div>
        <div class="cmp-stat"><span>Take Profit Rules</span><strong>${a.strategy.takeProfitRules.length} stages</strong></div>
        <div class="cmp-stat"><span>Exit On KOL Exit</span><strong>${a.strategy.exitOnKolExit ? 'Yes' : 'No'}</strong></div>
        <div class="cmp-stat"><span>Holder Drop Exit</span><strong>${a.strategy.exitOnHolderDrop ? 'Yes' : 'No'}</strong></div>
      </div>
    </div>`;
  }

  const allData = JSON.stringify(agents.map(a => ({
    id: a.id, name: a.agentName, strategy: a.strategy.label, winRate: a.winRate,
    pnlUsd: a.totalPnlUsd, trades: a.totalTradesCount, winCount: a.winCount,
    lossCount: a.lossCount, bestTradeUsd: a.bestTradeUsd, worstTradeUsd: a.worstTradeUsd,
    treasuryBnb: a.treasuryBnb, sharpe: a.sharpeEstimate, chainState: a.chainState,
    acquisitionScore: a.acquisitionScore, activePositions: a.positions.filter(p => p.state === 'active').length,
    flywheelProfit: a.flywheel?.totalProfitBnb ?? 0, minScore: a.strategy.minScore,
    maxPositions: a.strategy.maxPositions, stopLossPct: a.strategy.stopLossPct,
    takeProfitRules: a.strategy.takeProfitRules.length, exitOnKolExit: a.strategy.exitOnKolExit,
    exitOnHolderDrop: a.strategy.exitOnHolderDrop,
  })));

  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>Agent Compare | elizaOK</title>
<link href="https://fonts.googleapis.com/css2?family=Martian+Mono:wght@100..800&display=swap" rel="stylesheet"/>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0a0a09;--surface:rgba(18,18,16,.85);--border:rgba(246,231,15,.1);--text:#f5f5f0;--dim:rgba(245,245,240,.45);--yellow:#F6E70F;--green:#22c55e;--red:#ef4444;--cyan:#00C7D2;}
body{background:var(--bg);color:var(--text);font-family:'Martian Mono',monospace;padding:24px;min-height:100vh;}
a{color:var(--yellow);text-decoration:none;}
.cmp-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;}
.cmp-header h1{font-size:16px;font-weight:600;}
.cmp-select-row{display:flex;gap:16px;margin-bottom:24px;flex-wrap:wrap;}
.cmp-select-row label{font-size:11px;color:var(--dim);display:flex;flex-direction:column;gap:4px;flex:1;min-width:200px;}
.cmp-select-row select{background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:8px 12px;font-family:inherit;font-size:11px;cursor:pointer;}
.cmp-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;}
@media(max-width:768px){.cmp-grid{grid-template-columns:1fr;}}
.cmp-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px;}
.cmp-card__name{font-size:14px;font-weight:700;display:flex;align-items:center;gap:8px;margin-bottom:4px;}
.cmp-card__strategy{font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:.08em;margin-bottom:16px;}
.cmp-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;}
.cmp-stat-grid,.cmp-strat-detail{display:grid;grid-template-columns:1fr 1fr;gap:6px 12px;}
.cmp-strat-detail{margin-top:12px;padding-top:12px;border-top:1px solid var(--border);}
.cmp-stat{display:flex;justify-content:space-between;padding:4px 0;font-size:11px;}
.cmp-stat span{color:var(--dim);}
.cmp-stat strong{font-weight:600;}
.cmp-pos{color:var(--green);}
.cmp-neg{color:var(--red);}
.cmp-diff{margin-top:24px;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px;}
.cmp-diff h3{font-size:13px;margin-bottom:12px;color:var(--yellow);}
.cmp-diff-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;font-size:11px;}
.cmp-diff-row{display:contents;}
.cmp-diff-row span:first-child{color:var(--dim);}
.cmp-diff-row strong{text-align:center;}
.cmp-winner{color:var(--yellow);font-weight:700;}
</style></head><body>
<div class="cmp-header">
  <h1>Agent Compare</h1>
  <a href="/goo">&larr; Back to Arena</a>
</div>
<div class="cmp-select-row">
  <label>Agent A<select id="selA">${optionRows}</select></label>
  <label>Agent B<select id="selB">${agents.length > 1 ? agents.map((a, i) =>
    `<option value="${escapeHtml(a.id)}"${i === 1 ? ' selected' : ''}>${escapeHtml(a.agentName)} (${escapeHtml(a.strategy.label)}) — ${a.winRate.toFixed(1)}% WR</option>`
  ).join('') : optionRows}</select></label>
</div>
<div class="cmp-grid" id="cmpGrid"></div>
<div class="cmp-diff" id="cmpDiff"></div>
<script>
var agents = ${allData};
var fU = function(v){return '$'+Math.abs(v).toFixed(2);};
var fB = function(v){return v.toFixed(4)+' BNB';};
var sC = {active:'#00C7D2',starving:'#ca8a04',dying:'#ea580c',dead:'#D1D5DB'};
function card(a){
  var pc = a.pnlUsd>=0?'cmp-pos':'cmp-neg';
  return '<div class="cmp-card"><div class="cmp-card__name"><span class="cmp-dot" style="background:'+(sC[a.chainState]||'#888')+'"></span>'+a.name+'</div>'+
    '<div class="cmp-card__strategy">'+a.strategy+'</div>'+
    '<div class="cmp-stat-grid">'+
    '<div class="cmp-stat"><span>P&L</span><strong class="'+pc+'">'+(a.pnlUsd>=0?'+':'')+fU(a.pnlUsd)+'</strong></div>'+
    '<div class="cmp-stat"><span>Win Rate</span><strong>'+a.winRate.toFixed(1)+'%</strong></div>'+
    '<div class="cmp-stat"><span>Trades</span><strong>'+a.trades+'</strong></div>'+
    '<div class="cmp-stat"><span>Win/Loss</span><strong><span class="cmp-pos">'+a.winCount+'</span>/<span class="cmp-neg">'+a.lossCount+'</span></strong></div>'+
    '<div class="cmp-stat"><span>Best Trade</span><strong class="cmp-pos">+'+fU(a.bestTradeUsd)+'</strong></div>'+
    '<div class="cmp-stat"><span>Worst Trade</span><strong class="cmp-neg">'+fU(a.worstTradeUsd)+'</strong></div>'+
    '<div class="cmp-stat"><span>Treasury</span><strong>'+fB(a.treasuryBnb)+'</strong></div>'+
    '<div class="cmp-stat"><span>Sharpe</span><strong>'+a.sharpe.toFixed(2)+'</strong></div>'+
    '<div class="cmp-stat"><span>Status</span><strong style="color:'+(sC[a.chainState]||'#888')+'">'+a.chainState.toUpperCase()+'</strong></div>'+
    '<div class="cmp-stat"><span>Acq. Score</span><strong>'+a.acquisitionScore+'</strong></div>'+
    '</div>'+
    '<div class="cmp-strat-detail">'+
    '<div class="cmp-stat"><span>Score Threshold</span><strong>'+a.scoreThreshold+'</strong></div>'+
    '<div class="cmp-stat"><span>Max Positions</span><strong>'+a.maxPositions+'</strong></div>'+
    '<div class="cmp-stat"><span>Stop Loss</span><strong>'+a.stopLossPct+'%</strong></div>'+
    '<div class="cmp-stat"><span>Take Profit</span><strong>'+a.takeProfitPct+'%</strong></div>'+
    '</div></div>';
}
function diff(a,b){
  var rows = [
    ['P&L', a.pnlUsd, b.pnlUsd, '$'],
    ['Win Rate', a.winRate, b.winRate, '%'],
    ['Trades', a.trades, b.trades, ''],
    ['Sharpe', a.sharpe, b.sharpe, ''],
    ['Acq. Score', a.acquisitionScore, b.acquisitionScore, ''],
    ['Treasury', a.treasuryBnb, b.treasuryBnb, ' BNB'],
  ];
  var h = '<h3>Head-to-Head</h3><div class="cmp-diff-grid">';
  h += '<div class="cmp-diff-row"><span>Metric</span><strong>'+a.name+'</strong><strong>'+b.name+'</strong></div>';
  rows.forEach(function(r){
    var av = typeof r[1]==='number'?r[1]:0, bv = typeof r[2]==='number'?r[2]:0;
    var aCls = av>bv?'cmp-winner':'', bCls = bv>av?'cmp-winner':'';
    h += '<div class="cmp-diff-row"><span>'+r[0]+'</span><strong class="'+aCls+'">'+av.toFixed(2)+r[3]+'</strong><strong class="'+bCls+'">'+bv.toFixed(2)+r[3]+'</strong></div>';
  });
  return h+'</div>';
}
function update(){
  var aId = document.getElementById('selA').value;
  var bId = document.getElementById('selB').value;
  var a = agents.find(function(x){return x.id===aId;});
  var b = agents.find(function(x){return x.id===bId;});
  if(!a||!b) return;
  document.getElementById('cmpGrid').innerHTML = card(a)+card(b);
  document.getElementById('cmpDiff').innerHTML = diff(a,b);
}
document.getElementById('selA').onchange = update;
document.getElementById('selB').onchange = update;
update();
</script></body></html>`;
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
    flywheel: { totalProfitUsd: 0, reinvestedUsd: 0, elizaOKBuybackUsd: 0, airdropReserveUsd: 0, cycleCount: 0, lastCycleAt: null, trailingStopSaves: 0, gmgnExitSaves: 0 },
    winCount: 0,
    lossCount: 0,
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

  if (pathname === "/assets/avatar.png" || pathname === "/assets/cloud-banner.png" || pathname === "/assets/goo-economy-logo.png") {
    const fileName = pathname.split("/").pop()!;
    const filePath = path.join(ELIZAOK_ASSET_DIR, fileName);
    try {
      const content = await readFile(filePath);
      res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=86400" });
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
    return;
  }

  if (pathname === "/assets/bgm.mp3") {
    const mp3Path = path.join(ELIZAOK_ASSET_DIR, "bgm.mp3");
    try {
      const stat = await import("fs/promises").then(m => m.stat(mp3Path));
      const total = stat.size;
      const rangeHeader = req.headers.range;
      if (rangeHeader) {
        const [startStr, endStr] = rangeHeader.replace("bytes=", "").split("-");
        const start = parseInt(startStr, 10);
        const end = endStr ? parseInt(endStr, 10) : Math.min(start + 500_000, total - 1);
        const chunkSize = end - start + 1;
        const { createReadStream } = await import("fs");
        const stream = createReadStream(mp3Path, { start, end });
        res.writeHead(206, {
          "content-type": "audio/mpeg",
          "content-range": `bytes ${start}-${end}/${total}`,
          "accept-ranges": "bytes",
          "content-length": String(chunkSize),
          "cache-control": "public, max-age=86400",
        });
        stream.pipe(res);
      } else {
        const content = await readFile(mp3Path);
        res.writeHead(200, {
          "content-type": "audio/mpeg",
          "accept-ranges": "bytes",
          "content-length": String(total),
          "cache-control": "public, max-age=86400",
        });
        res.end(content);
      }
    } catch {
      sendJson(res, 404, { error: "Audio asset not found" });
    }
    return;
  }

  if (pathname === "/assets/videobg.mp4") {
    const videoPath = path.join(ELIZAOK_ASSET_DIR, "videobg.mp4");
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

  // ── Goo Paper Agent API ──

  if (pathname === "/api/absorption/status") {
    const absState = await loadAbsorptionState(config.reportsDir);
    sendJson(res, 200, absState);
    return;
  }

  if (pathname === "/api/market-intel/signals") {
    sendJson(res, 200, getGmgnSignals() ?? { signals: [], totalScanned: 0, critical: 0, warning: 0 });
    return;
  }

  if (pathname === "/api/notifications") {
    const since = requestUrl.searchParams.get("since") || undefined;
    sendJson(res, 200, { notifications: getNotifications(since), seq: getNotificationSeq() });
    return;
  }

  if (pathname === "/api/goo/agents") {
    const agents = getPaperAgents();
    const summary = getPaperSummary();
    sendJson(res, 200, { agents, summary });
    return;
  }

  if (pathname.startsWith("/api/goo/agents/") && pathname.endsWith("/detail")) {
    const agentId = pathname.split("/")[4];
    const agents = getPaperAgents();
    const agent = agents.find(a => a.id === agentId || a.agenterId === agentId);
    if (!agent) { sendJson(res, 404, { error: "Agent not found" }); return; }
    sendJson(res, 200, agent);
    return;
  }

  if (pathname === "/api/goo/agents/spawn" && req.method === "POST") {
    const body = await readRequestBody(req);
    const parsed = JSON.parse(body);
    const strategyId = (parsed.strategy || "balanced") as StrategyId;
    const treasury = parsed.treasury ?? 1.0;
    const newAgent = spawnPaperAgent(strategyId, treasury);
    const agents = [...getPaperAgents(), newAgent];
    setPaperAgents(agents);
    setPaperSummary(buildGooPaperSummary(agents));
    await savePaperAgents(config.reportsDir, agents);
    sendJson(res, 201, newAgent);
    return;
  }

  if (pathname.startsWith("/api/goo/agents/") && pathname.endsWith("/acquire") && req.method === "POST") {
    const agentId = pathname.split("/")[4];
    let agents = getPaperAgents();
    const idx = agents.findIndex(a => a.id === agentId || a.agenterId === agentId);
    if (idx === -1) { sendJson(res, 404, { error: "Agent not found" }); return; }

    // Absorb strategy into elizaOK before killing the agent
    const absState = await loadAbsorptionState(config.reportsDir);
    const newAbsState = absorbAgentStrategy(agents[idx], config.treasury, absState);
    await saveAbsorptionState(config.reportsDir, newAbsState);

    // Apply overrides to live config
    const upgraded = applyAbsorptionOverrides(config.treasury, newAbsState);
    Object.assign(config.treasury, upgraded);

    agents[idx] = acquireAgent(agents[idx]);
    setPaperAgents(agents);
    setPaperSummary(buildGooPaperSummary(agents));
    await savePaperAgents(config.reportsDir, agents);
    sendJson(res, 200, {
      acquired: true,
      agent: agents[idx],
      absorption: {
        totalAbsorbed: newAbsState.totalAbsorbed,
        parameterChanges: newAbsState.absorptions[newAbsState.absorptions.length - 1]?.parameterChanges ?? [],
        scoreWeightBoosts: newAbsState.scoreWeightBoosts,
      },
    });
    return;
  }

  if (pathname === "/api/goo/acquisition-candidates") {
    const candidates = getAcquisitionCandidates(getPaperAgents());
    sendJson(res, 200, { candidates });
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

  if (pathname === "/api/eliza-cloud/chat/send") {
    if (req.method !== "POST") { sendJson(res, 405, { error: "Method not allowed" }); return; }
    if (!cloudSession?.apiKey) { sendJson(res, 401, { error: "Not connected to ElizaCloud" }); return; }
    const payload = await readRequestJson<{ text?: string; history?: { role: string; content: string }[] }>(req);
    const text = payload?.text?.trim() || "";
    if (!text) { sendJson(res, 400, { error: "text is required" }); return; }

    const chatApiKey = cloudSession.apiKey || process.env.ELIZAOS_API_KEY?.trim() || "";
    if (!chatApiKey) { sendJson(res, 401, { error: "No API key. Please reconnect ElizaCloud." }); return; }

    const systemPrompt = `You are elizaOK Agent, an AI assistant powered by elizaOS Cloud (https://www.elizacloud.ai).

About elizaOK:
- Built on the elizaOS framework, elizaOK is the value layer on BNB Chain that automates alpha discovery, position building, and real value delivery through dedicated vaults.
- It specializes in memecoin discovery, portfolio management, trade execution, and airdrop distribution on BNB Chain.
- Core features: real-time token scanning via DexScreener, automated signal scoring (0-100), paper trading simulation, portfolio tracking, and airdrop distribution to token holders.
- elizaOK runs 24/7 scanning for new token pools, scoring them on liquidity, volume, holder distribution, and market dynamics.
- It supports dry-run mode for safe simulation and live execution mode for real trades.
- Dashboard provides full visibility: discovery signals, portfolio ledger, execution plans, distribution status, and system health.

About elizaOS Cloud:
- elizaOS Cloud (elizacloud.ai) is a managed hosting platform for AI agents built on elizaOS framework.
- It provides multi-model AI generation (text, image, video), voice cloning, and agent deployment.
- Features include: chat completions API, image/video generation, text-to-speech, speech-to-text, voice cloning, and a full API explorer with 21+ endpoints.
- Supports models from OpenAI, Anthropic, Google, DeepSeek, Alibaba Qwen, Meta, and more.
- Users manage agents, API keys, credits, and budgets through the cloud dashboard.

Guidelines:
- Be helpful, concise, and knowledgeable about crypto, DeFi, and AI agents.
- When asked about yourself, explain you are elizaOK's agent running on elizaOS Cloud.
- When asked about elizaOS Cloud features, refer to the API capabilities naturally.
- Don't force project information into every response — only share when relevant to the user's question.
- Respond in the same language the user uses (English, Chinese, etc.).`;

    const uiMessages: { role: string; parts: { type: string; text: string }[] }[] = [
      { role: "system", parts: [{ type: "text", text: systemPrompt }] },
    ];
    if (Array.isArray(payload?.history)) {
      for (const m of payload.history) {
        if (m && typeof m.role === "string" && typeof m.content === "string") {
          uiMessages.push({ role: m.role, parts: [{ type: "text", text: m.content }] });
        }
      }
    }
    uiMessages.push({ role: "user", parts: [{ type: "text", text }] });

    try {
      const chatRes = await fetch("https://www.elizacloud.ai/api/v1/chat", {
        method: "POST",
        headers: { ...elizaCloudAuthHeaders(chatApiKey), "content-type": "application/json" },
        body: JSON.stringify({ messages: uiMessages, id: "google/gemini-2.0-flash" }),
      });

      const rawText = await chatRes.text().catch(() => "");
      if (!chatRes.ok) {
        let errMsg = "Chat request failed";
        try {
          const errData = JSON.parse(rawText);
          if (typeof errData === "string") errMsg = errData;
          else if (typeof errData?.error === "string") errMsg = errData.error;
          else if (typeof errData?.error?.message === "string") errMsg = errData.error.message;
          else if (typeof errData?.message === "string") errMsg = errData.message;
        } catch {}
        sendJson(res, chatRes.status, { error: errMsg });
        return;
      }

      let reply = "";
      const chunks = rawText.split(/(?:^|\s)data:\s*/);
      for (const chunk of chunks) {
        const cleaned = chunk.trim();
        if (!cleaned || cleaned === "[DONE]") continue;
        try {
          const parsed = JSON.parse(cleaned);
          if (parsed?.type === "text-delta" && typeof parsed?.delta === "string") { reply += parsed.delta; continue; }
          if (parsed?.type === "error" && typeof parsed?.errorText === "string") { reply = "Error: " + parsed.errorText; break; }
        } catch {}
      }
      if (!reply.trim()) reply = "No response from agent.";

      sendJson(res, 200, { reply: reply.trim() });
    } catch (err) {
      sendJson(res, 500, { error: "Chat request failed" });
    }
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

  if (pathname === "/backtest") {
    const agents = getPaperAgents();
    const snapshot = getLatestSnapshot();
    const bnbPx = getBnbPriceUsd() || 600;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderBacktestPage(agents, snapshot, bnbPx));
    return;
  }

  if (pathname === "/goo") {
    const agents = getPaperAgents();
    const summary = getPaperSummary();
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderGooPaperPage(agents, summary));
    return;
  }

  if (pathname === "/goo/compare") {
    const agents = getPaperAgents();
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderGooComparePage(agents));
    return;
  }

  if (pathname.startsWith("/goo/agent/")) {
    const agentId = pathname.split("/")[3];
    const agents = getPaperAgents();
    const agent = agents.find(a => a.id === agentId || a.agenterId === agentId);
    if (!agent) {
      res.writeHead(302, { Location: "/goo" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderGooAgentDetail(agent));
    return;
  }

  if (pathname === "/dashboard") {
    const refreshedCloud = await refreshElizaCloudSession(cloudSession);
    cloudSession = refreshedCloud.session;
    const [sidebarWalletBalanceLabel, bnbPrice] = await Promise.all([
      fetchWalletNativeBalanceLabel(
        config.execution.rpcUrl,
        "0x2D6C3358A3acFe3be42b2Bdf7419e87091270c5F",
      ),
      getBnbPriceUsd(),
    ]);
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
        bnbPrice,
      ),
    );
    return;
  }

  if (pathname === "/docs") {
    const lang = (requestUrl.searchParams.get("lang") === "zh" ? "zh" : "en") as "en" | "zh";
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderDocsPage(lang));
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
