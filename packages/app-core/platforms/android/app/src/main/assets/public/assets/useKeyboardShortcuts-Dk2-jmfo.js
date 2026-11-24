import{r as T}from"./vendor-react-S1QEnNN_.js";import{b9 as g,gM as w,ba as F,b2 as b,b6 as y}from"./index-DOK35GOm.js";const c={targetFps:60},R=1.05;function k(e=c){return 1e3/e.targetFps}const M=e=>({sampleCount:0,fps:0,meanFrameMs:0,p95FrameMs:0,worstFrameMs:0,droppedFrames:0,longTasks:0,budgetMs:e});function A(e,t){if(e.length===0)return 0;const n=[...e].sort((a,i)=>a-i),s=Math.min(1,Math.max(0,t)),r=Math.ceil(s*n.length),l=Math.min(n.length-1,Math.max(0,r-1));return n[l]}function P(e,t=0,n=c){const s=k(n),r=e.filter(o=>Number.isFinite(o)&&o>=0);if(r.length===0)return{...M(s),longTasks:t};const a=r.reduce((o,f)=>o+f,0)/r.length,i=r.reduce((o,f)=>Math.max(o,f),0),u=r.filter(o=>o>s*R).length;return{sampleCount:r.length,fps:a>0?1e3/a:0,meanFrameMs:a,p95FrameMs:A(r,.95),worstFrameMs:i,droppedFrames:u,longTasks:t,budgetMs:s}}function v(e,t={}){if(e.sampleCount===0)return!1;const n=Math.max(1,t.p95BudgetFactor??1.25),s=t.droppedFrameRatio??.1;return(t.reportOnLongTask??!0)&&e.longTasks>0||e.p95FrameMs>e.budgetMs*n?!0:e.droppedFrames/e.sampleCount>=s}class L{windowSize;budget;raf;cancelRaf;onFrame;observeLongTasks;deltas=[];lastTimestamp=null;longTaskCount=0;handle=null;observer=null;constructor(t={}){this.windowSize=Math.max(1,t.windowSize??120),this.budget=t.budget??c,this.onFrame=t.onFrame,this.observeLongTasks=t.observeLongTasks??!0,this.raf=t.raf??(n=>typeof requestAnimationFrame=="function"?requestAnimationFrame(n):0),this.cancelRaf=t.cancelRaf??(n=>{typeof cancelAnimationFrame=="function"&&cancelAnimationFrame(n)})}get running(){return this.handle!==null}get longTasks(){return this.longTaskCount}push(t){this.lastTimestamp!==null&&(this.deltas.push(t-this.lastTimestamp),this.deltas.length>this.windowSize&&this.deltas.splice(0,this.deltas.length-this.windowSize)),this.lastTimestamp=t}summary(){return P(this.deltas,this.longTaskCount,this.budget)}start(){if(this.handle!==null)return;if(this.observeLongTasks&&typeof PerformanceObserver=="function")try{this.observer=new PerformanceObserver(n=>{this.longTaskCount+=n.getEntries().length}),this.observer.observe({entryTypes:["longtask"]})}catch{this.observer=null}const t=n=>{this.push(n),this.onFrame?.(n,this),this.handle=this.raf(t)};this.handle=this.raf(t)}stop(){this.handle!==null&&(this.cancelRaf(this.handle),this.handle=null),this.observer?.disconnect(),this.observer=null}reset(){this.deltas=[],this.lastTimestamp=null,this.longTaskCount=0}}const x=`
(() => {
  const w = window;
  if (w.__ELIZA_FRAME) return;
  let deltas = [];
  let longTasks = 0;
  let last = null;
  let raf = null;
  let obs = null;
  const tick = (now) => {
    if (last !== null) deltas.push(now - last);
    last = now;
    raf = requestAnimationFrame(tick);
  };
  w.__ELIZA_FRAME = {
    start() {
      deltas = [];
      longTasks = 0;
      last = null;
      try {
        obs = new PerformanceObserver((list) => {
          longTasks += list.getEntries().length;
        });
        obs.observe({ entryTypes: ['longtask'] });
      } catch {
        obs = null;
      }
      if (raf === null) raf = requestAnimationFrame(tick);
    },
    stop() {
      if (raf !== null) {
        cancelAnimationFrame(raf);
        raf = null;
      }
      if (obs) {
        obs.disconnect();
        obs = null;
      }
    },
    read() {
      return { deltas: deltas.slice(), longTasks };
    },
  };
})();
`,S={},m="eliza:perf-toggle",_="eliza:perf-hud";function d(){return typeof window>"u"?void 0:window}function E(){return d()?.__ELIZA_PERF_HUD__===!0}function h(e){const t=d();if(t){t.__ELIZA_PERF_HUD__=e;try{w(()=>t.localStorage?.setItem(_,e?"1":"0"))}catch{}typeof Event=="function"&&t.dispatchEvent(new Event(m))}}function H(){const e=!E();return h(e),e}function N(){const e=d();if(!e||e.__ELIZA_PERF_HUD__===!0)return;const n=S?.VITE_ELIZA_PERF_HUD;let s=n==="1"||n==="true";if(!s)try{s=e.localStorage?.getItem(_)==="1"}catch{s=!1}s&&h(!0)}function B(){const e=d();if(!e||!g())return()=>{};e.__elizaPerfHud=n=>{const s=typeof n=="boolean"?n:!E();return h(s),s};const t=n=>{if((n.metaKey||n.ctrlKey)&&n.shiftKey&&(n.key==="P"||n.key==="p")){n.preventDefault();const s=H();console.info(`[PerfHUD] ${s?"on":"off"} - FPS/jank HUD + frame-budget telemetry (reflow + re-render telemetry stay on in dev)`)}};return e.addEventListener("keydown",t),()=>{e.removeEventListener("keydown",t),e.__elizaPerfHud&&(e.__elizaPerfHud=void 0)}}function O(){return typeof window>"u"||globalThis.__ELIZA_PERF_HUD__!==!0?!1:g()}function C(e){const t=globalThis;Array.isArray(t.__ELIZA_RENDER_TELEMETRY__)&&t.__ELIZA_RENDER_TELEMETRY__.push(e),typeof window<"u"&&typeof CustomEvent<"u"&&window.dispatchEvent(new CustomEvent(b,{detail:e}))}function p(e={}){if(!O()||typeof requestAnimationFrame!="function")return()=>{};const t=e.budget??c,n=e.windowMs??1e3,s=e.emitHealthy??!1;let r=null;const l=new L({budget:t,windowSize:1024,onFrame:(a,i)=>{if(r===null&&(r=a),a-r<n)return;const u=i.summary(),o=v(u,e);(s||o)&&C({source:"frameBudget",severity:o?"error":"info",summary:u,windowMs:n,at:a,sequence:F(),route:y()}),i.reset(),r=a}});return l.start(),()=>l.stop()}function Z(e={}){T.useEffect(()=>{let t=p(e);if(typeof window>"u")return t;const n=()=>{t(),t=p(e)};return window.addEventListener(m,n),()=>{window.removeEventListener(m,n),t()}},[])}const D="open-command-palette",I="show-keyboard-shortcuts",q=[{id:D,key:"k",ctrl:!0,description:"Open command palette",scope:"global"},{id:"send-message",key:"Enter",description:"Send message",scope:"chat"},{id:"close-modal",key:"Escape",description:"Close modal / Cancel",scope:"global"},{id:I,key:"?",shift:!0,description:"Show keyboard shortcuts",scope:"global"},{id:"focus-composer",key:"/",description:"Focus chat composer",scope:"global"}];export{q as C,c as D,x as F,m as P,D as S,L as a,p as b,P as c,I as d,N as e,k as f,B as g,O as i,A as p,v as s,Z as u};
