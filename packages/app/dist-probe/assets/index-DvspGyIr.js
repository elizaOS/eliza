import{mC as T,_ as Z,lP as Jn,lM as Gt}from"./index-Bfd-e4HW.js";import{u as g,s as m,e as Zn,a as hr,K as Xn,m as Yn,w as Qn,r as L,d as yr,j as _e,c as eo,b as ue,f as to,g as It,T as ro,p as no,h as oo,i as so,z as qr,k as qt,o as Hr,l as kr,n as ao}from"./index.browser-gdtp2n1F.js";import{f as Vr}from"./_native-stub_node_url-VYgAtYfY.js";import{B as Er}from"./contracts-BXKIuX75.js";import{a as Ii,b as Pi,c as Ni,d as Wi,e as Li,f as $i}from"./contracts-BXKIuX75.js";const Ht="lifeops_browser_plugin";var io={};const co=m.dirname(Vr()),lo=["ELIZA_BROWSER_STAGEHAND_COMMAND_URL","STAGEHAND_BROWSER_COMMAND_URL","ELIZA_STAGEHAND_COMMAND_URL"],uo=["ELIZA_BROWSER_STAGEHAND_URL","STAGEHAND_SERVER_URL","ELIZA_STAGEHAND_SERVER_URL"],po="ELIZA_BROWSER_STAGEHAND_AUTO_SETUP",fo="ELIZA_BROWSER_ALLOW_STAGEHAND_ON_MOBILE";async function wo(e=io){if(Sr(e.ELIZA_BROWSER_STAGEHAND_ENABLED))return null;if(_o(e)&&!So(e[fo]))return g.debug("[BrowserService] stagehand target skipped on mobile; using the app browser surface instead"),null;Sr(e[po])||yo(e);const r=mo(e);return r?{id:"stagehand",name:"Stagehand Browser",description:"Fallback Stagehand/Playwright browser backend reached through a local or remote stagehand command endpoint.",kind:"stagehand",priority:10,score:({mobile:o})=>o?null:10,available:async()=>bo(r,e),execute:async o=>go(r,o)}:(g.debug("[BrowserService] stagehand target skipped; set ELIZA_BROWSER_STAGEHAND_COMMAND_URL or STAGEHAND_SERVER_URL to enable it"),null)}function mo(e){for(const t of lo){const r=Pt(e[t]);if(r)return r}for(const t of uo){const r=Pt(e[t]);if(r)return new URL("/api/browser-command",r).toString()}return null}async function bo(e,t){const r=Pt(t.ELIZA_BROWSER_STAGEHAND_HEALTH_URL);if(!r)return!0;try{return(await fetch(r,{method:"GET"})).ok}catch{return!1}}async function go(e,t){const r=await fetch(e,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({command:t})}),o=await r.json().catch(()=>null);if(!r.ok){const n=o&&typeof o=="object"&&"error"in o?String(o.error):`Stagehand command endpoint returned HTTP ${r.status}`;throw new Error(n)}return ho(t,o)}function ho(e,t){if(t&&typeof t=="object"){const r=t;return{...r.result&&typeof r.result=="object"?r.result:r,mode:"cloud",subaction:e.subaction}}return{mode:"cloud",subaction:e.subaction,value:t}}function yo(e){const t=ko(e);if(!t)return!1;const r=m.join(t,"dist","index.js");if(T.existsSync(r))return!0;const o=m.join(t,"src","index.ts");if(!T.existsSync(o))return!1;try{T.existsSync(m.join(t,"node_modules"))||Zn("bun install --ignore-scripts",{cwd:t,stdio:"ignore",timeout:6e4});const n=m.join(t,"node_modules",".bin","tsc");return T.existsSync(n)?hr(n,[],{cwd:t,stdio:"ignore",timeout:6e4}):hr("bunx",["tsc"],{cwd:t,stdio:"ignore",timeout:6e4}),g.info("[BrowserService] stagehand-server built successfully"),T.existsSync(r)}catch(n){const s=n instanceof Error?n.message:String(n);return g.debug(`[BrowserService] stagehand-server auto-setup failed: ${s}`),!1}}function ko(e){const r=[e.ELIZA_BROWSER_STAGEHAND_DIR?.trim(),...Eo(co).flatMap(o=>[m.join(o,"stagehand-server"),m.join(o,"plugins","plugin-browser","stagehand-server"),m.join(o,"eliza","plugins","plugin-browser","stagehand-server")])].filter(o=>!!o);for(const o of r){const n=m.resolve(o);if(T.existsSync(m.join(n,"dist","index.js"))||T.existsSync(m.join(n,"src","index.ts")))return n}return null}function Eo(e){const t=[];let r=m.resolve(e);for(;;){t.push(r);const o=m.dirname(r);if(o===r)return t;r=o}}function Pt(e){if(!e?.trim())return null;try{return new URL(e.trim()).toString()}catch{return null}}function So(e){return e==="1"||e?.toLowerCase()==="true"}function Sr(e){return e==="0"||e?.toLowerCase()==="false"}function _o(e){const t=(e.ELIZA_MOBILE_PLATFORM??e.ELIZA_PLATFORM??e.CAPACITOR_PLATFORM??"").toLowerCase();return t==="ios"||t==="android"||t==="mobile"}var _r={};const Vt="browser";class Te extends Xn{static serviceType=Vt;capabilityDescription="Single browser dispatcher with a pluggable target registry. Targets (workspace / bridge / computeruse / …) register themselves; the BROWSER action picks the active target or honors a pinned override.";targets=new Map;targetOrder=[];async stop(){this.targets.clear(),this.targetOrder.length=0}static async start(t){const r=new Te(t);r.registerTarget(vo());try{const o=await Ao(t);o&&r.registerTarget(o)}catch(o){const n=o instanceof Error?o.message:String(o);g.debug(`[BrowserService] bridge target not registered at start: ${n}`)}try{const o=await wo();o&&r.registerTarget(o)}catch(o){const n=o instanceof Error?o.message:String(o);g.debug(`[BrowserService] stagehand target not registered at start: ${n}`)}return r}registerTarget(t){this.targets.has(t.id)||this.targetOrder.push(t.id),this.targets.set(t.id,t),g.debug(`[BrowserService] registered target "${t.id}" (${t.name})`)}unregisterTarget(t){const r=this.targets.delete(t);if(r){const o=this.targetOrder.indexOf(t);o>=0&&this.targetOrder.splice(o,1)}return r}listTargets(){return this.targetOrder.map(t=>this.targets.get(t)).filter(t=>t!==void 0)}async resolveTarget(t,r={subaction:"state"}){return(await this.resolveTargets(t,r))[0]??null}async resolveTargets(t,r={subaction:"state"}){if(t){const s=this.targets.get(t);if(!s)return[];try{return await s.available()?[s]:[]}catch{return[]}}const o={command:r,env:_r,mobile:Ro(_r)},n=[];for(const s of this.targetOrder){const i=this.targets.get(s);if(i)try{const u=i.score?i.score(o):i.priority??0;if(u===null)continue;await i.available()&&n.push({score:u,order:this.targetOrder.indexOf(s),target:i})}catch{}}return n.sort((s,i)=>i.score-s.score||s.order-i.order).map(({target:s})=>s)}async execute(t,r){const o=await this.resolveTargets(r,t);if(o.length===0){const s=this.targetOrder.join(", ")||"(none)";throw new Error(r?`Browser target "${r}" is not available. Registered targets: ${s}.`:`No browser target is available. Registered targets: ${s}.`)}let n=null;for(const s of o)try{return await s.execute(t)}catch(i){if(n=i,r)break;const u=i instanceof Error?i.message:String(i);g.debug(`[BrowserService] target "${s.id}" failed; trying next target: ${u}`)}throw n instanceof Error?n:new Error("Browser target execution failed.")}}function vo(){return{id:"workspace",name:"Browser Workspace",description:"Eliza's electrobun-embedded BrowserView (desktop) or JSDOM fallback (web). Always available.",kind:"app",priority:100,score:({mobile:e})=>e?120:100,available:async()=>!0,execute:async e=>{const{executeBrowserWorkspaceCommand:t}=await Z(async()=>{const{executeBrowserWorkspaceCommand:r}=await Promise.resolve().then(()=>ls);return{executeBrowserWorkspaceCommand:r}},void 0,import.meta.url);return t(e)}}}async function Ao(e){const t=e.getService(Ht);return t?{id:"bridge",name:"Browser Bridge (Chrome / Safari companion)",description:"Routes commands to the user's real Chrome or Safari via the Agent Browser Bridge companion extension. Subset of subactions supported (open / navigate / close / list / state / show / hide / tab / get).",kind:"companion",priority:80,score:({mobile:r})=>r?null:80,available:async()=>{try{return(await t.listBrowserCompanions()).length>0}catch{return!1}},execute:async r=>{const{dispatchBridgeCommand:o}=await Z(async()=>{const{dispatchBridgeCommand:n}=await import("./bridge-target-CnkcDvJb.js");return{dispatchBridgeCommand:n}},[],import.meta.url);return o(t,r)}}:null}function Ro(e){const t=(e.ELIZA_MOBILE_PLATFORM??e.ELIZA_PLATFORM??e.CAPACITOR_PLATFORM??"").toLowerCase();return t==="ios"||t==="android"||t==="mobile"}const Bo=["unknown","ready","auth_pending","needs_reauth","manual_handoff"],k={nextId:1,tabs:[]},ut=new Map,Ze=new Map;let G="";function ze(e){G=e}let Nt=Promise.resolve();function K(e){const t=Nt.then(e,e);return Nt=t.then(()=>{},()=>{}),t}function To(){Nt=Promise.resolve()}function xo(){return{consoleEntries:[],currentFrame:null,dialog:null,errors:[],frameDoms:new Map,highlightedSelector:null,lastScreenshotData:null,lastSnapshot:null,mouse:{buttons:[],x:0,y:0},networkHar:{active:!1,entries:[],startedAt:null},networkNextRequestId:1,networkRequests:[],networkRoutes:[],settings:{credentials:null,device:null,geo:null,headers:{},media:null,offline:!1,viewport:null},trace:{active:!1,entries:[]},profiler:{active:!1,entries:[]}}}function Kr(e,t){return`${e}:${t}`}function z(e,t){const r=Kr(e,t);let o=Ze.get(r);return o||(o=xo(),Ze.set(r,o)),o}function Jr(e,t){Ze.delete(Kr(e,t))}function Kt(e){e.currentFrame=null,e.dialog=null,e.frameDoms.clear(),e.highlightedSelector=null}function Jt(e,t){return`${e}:${t}`}function le(e,t){ut.delete(Jt(e,t))}function Wt(e,t,r){if(r.length===0)return le(e,t),[];const o=new Map,n=r.map((s,i)=>{const u=`@e${i+1}`;return o.set(u,s.selector),{...s,ref:u}});return ut.set(Jt(e,t),o),n}function Co(e,t,r){return ut.get(Jt(e,t))?.get(r.trim())??null}function Zr(e,t){e.trace.active&&e.trace.entries.push({...t,timestamp:O()})}function Xr(e,t){e.profiler.active&&e.profiler.entries.push({...t,timestamp:O()})}function O(){return new Date().toISOString()}async function Oo(){await K(async()=>{k.nextId=1,k.tabs=[],ut.clear(),Ze.clear(),G=""}),To()}var Yr={};const dt=12e3,Qr=120,en="persist:eliza-browser",Zt="persist:connector-",Xe=globalThis.fetch.bind(globalThis);function Ye(e){if(typeof e!="string")return null;const t=e.trim();return t.length>0?t:null}function E(e){return String(e??"").replace(/\s+/g," ").trim()}function je(e){if(typeof e=="number"&&Number.isFinite(e))return e;if(typeof e!="string")return;const t=Number.parseFloat(e.trim());return Number.isFinite(t)?t:void 0}function me(e){const t=e.trim();if(t==="about:blank")return t;let r;try{r=new URL(t)}catch{throw new Error(`browser workspace rejected invalid URL: ${e}`)}if(r.protocol!=="http:"&&r.protocol!=="https:")throw new Error(`browser workspace only supports http/https URLs, got ${r.protocol}`);return r.toString()}function X(e){if(e==="about:blank")return"New Tab";try{return new URL(e).hostname.replace(/^www\./,"")||"Eliza Browser"}catch{return"Eliza Browser"}}function vr(e,t){const r=e.trim().toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").replace(/-{2,}/g,"-").slice(0,64);if(!r)throw new Error(`Eliza browser connector session requires ${t}.`);return r}function Io(e,t){const r=`${e.trim().toLowerCase()}\0${t.trim().toLowerCase()}`;let o=2166136261;for(let n=0;n<r.length;n++)o^=r.charCodeAt(n),o=Math.imul(o,16777619)>>>0;return o.toString(36).padStart(7,"0")}function pt(e,t){const r=vr(e,"provider"),o=vr(t,"accountId"),n=Io(e,t);return`${Zt}${r}-${o}-${n}`}function Xt(e){return(e??"").trim().toLowerCase().startsWith(Zt)}function Fe(e,t){const r=e.partition?.trim();if(r)return r;const o=e.connectorProvider?.trim(),n=e.connectorAccountId?.trim();return o&&n?pt(o,n):t}function te(e,t){if(Xt(e))throw new Error(`Connector browser sessions do not allow raw cookie, token, storage, or state export (${t}). Use the returned partition/profile/session handle instead.`)}function ft(e){return new Error(`Browser workspace request failed (404): Tab ${e} was not found.`)}function Yt(e){return new Error(`Eliza browser workspace ${e} requires a current tab. Open or show a tab first, or pass an explicit id.`)}async function Qe(e){await new Promise(t=>setTimeout(t,e))}async function Q(e,t){const r=L();return await Yn(),await Qn(),r}function Qt(e){const t=e,r=typeof t.subaction=="string"?t.subaction.trim().toLowerCase():typeof t.operation=="string"?t.operation.trim().toLowerCase():"",o=r==="goto"?"navigate":r==="read"?"get":e.subaction,n=je(e.timeoutMs)??je(t.ms)??je(t.milliseconds);return{...e,subaction:o,timeoutMs:n,steps:Array.isArray(e.steps)?e.steps.map(s=>Qt(s)):e.steps}}function er(e,t,r){const o=e.selector?.trim();if(!o)return e;const n=o.match(/^(@e\d+)([\s\S]*)$/i);if(!n?.[1])return e;const s=Co(t,r,n[1]);if(!s)throw new Error(`Unknown browser snapshot element ref ${n[1]}. Run snapshot or inspect again before reusing element refs.`);return{...e,selector:`${s}${n[2]??""}`}}function ve(e){return JSON.stringify(e)}const tn="Browser workspace arbitrary script execution is disabled in the JSDOM (web) backend because it runs in the Node.js agent process via unsafe eval patterns (GHSA-mhhr-9ph9-64j7). Use structured subactions (click, fill, get, wait on selector/url/text) or desktop browser workspace mode instead.",rn="Browser workspace arbitrary user script is disabled (GHSA-mhhr-9ph9-64j7). Use structured browser workspace subactions instead.";function tr(e=Yr){const t=Ye(e.ELIZA_BROWSER_WORKSPACE_ALLOW_USER_SCRIPT)?.toLowerCase();return t==="1"||t==="true"||t==="yes"}function wt(e,t,r,o=Yr){if(e?.trim()&&!tr(o)){const n=t==="eval"?"Eval subactions with a user `script` are disabled by default.":"Wait conditions with a user `script` are disabled by default.";throw new Error(`${rn} ${n} Set ELIZA_BROWSER_WORKSPACE_ALLOW_USER_SCRIPT=1 only on trusted single-user hosts.`)}}function rr(e){const t=e==="eval"?"Eval subactions are not supported on the web backend.":"Wait conditions with `script` are not supported on the web backend.";return new Error(`${tn} ${t}`)}function nn(e,t){if(e?.trim())throw rr(t)}const St=Object.freeze(Object.defineProperty({__proto__:null,BROWSER_WORKSPACE_JSDOM_SCRIPT_FORBIDDEN:tn,BROWSER_WORKSPACE_USER_SCRIPT_FORBIDDEN:rn,CONNECTOR_BROWSER_WORKSPACE_PARTITION_PREFIX:Zt,DEFAULT_TIMEOUT_MS:dt,DEFAULT_WAIT_INTERVAL_MS:Qr,DEFAULT_WEB_PARTITION:en,assertBrowserWorkspaceConnectorSecretsNotExported:te,assertBrowserWorkspaceJsdomScriptNotRequested:nn,assertBrowserWorkspaceUrl:me,assertBrowserWorkspaceUserScriptAllowed:wt,browserWorkspacePageFetch:Xe,buildBrowserWorkspaceCssStringLiteral:ve,createBrowserWorkspaceCommandTargetError:Yt,createBrowserWorkspaceJsdomScriptExecutionError:rr,createBrowserWorkspaceNotFoundError:ft,inferBrowserWorkspaceTitle:X,isBrowserWorkspaceUserScriptAllowed:tr,isConnectorBrowserWorkspacePartition:Xt,normalizeBrowserWorkspaceCommand:Qt,normalizeBrowserWorkspaceText:E,normalizeEnvValue:Ye,parseBrowserWorkspaceNumberLike:je,resolveBrowserWorkspaceCommandElementRefs:er,resolveBrowserWorkspaceCommandPartition:Fe,resolveConnectorBrowserWorkspacePartition:pt,sleep:Qe,writeBrowserWorkspaceFile:Q},Symbol.toStringTag,{value:"Module"}));var be={};async function nr(e,t,r){const n=(await M("/tabs",void 0,t)).tabs?.find(s=>s.id===e)??null;te(n?.partition,r)}async function Po(e){try{return(await e.text()).trim().slice(0,240)}catch{return""}}function or(e=be){const t=Ye(e.ELIZA_BROWSER_WORKSPACE_URL);return t?{baseUrl:t.replace(/\/{1,1024}$/,""),token:Ye(e.ELIZA_BROWSER_WORKSPACE_TOKEN)}:null}function y(e=be){return or(e)!==null}function mt(){return"Eliza browser workspace desktop bridge is unavailable."}async function M(e,t,r=be){const o=or(r);if(!o)throw new Error(mt());const n=new Headers(t?.headers??{});n.set("Accept","application/json"),!n.has("Content-Type")&&t?.body&&n.set("Content-Type","application/json"),o.token&&n.set("Authorization",`Bearer ${o.token}`);const s=await fetch(`${o.baseUrl}${e}`,{...t,headers:n,signal:AbortSignal.timeout(dt)});if(!s.ok){const i=await Po(s);throw new Error(`Browser workspace request failed (${s.status})${i?`: ${i}`:""}`)}return await s.json()}async function ge(e,t=be){if(!y(t))throw new Error("Eliza browser workspace eval is only available in the desktop app.");const r={script:e.script};return e.partition!==void 0&&(r.partition=e.partition),(await M(`/tabs/${encodeURIComponent(e.id)}/eval`,{method:"POST",body:JSON.stringify(r)},t)).result}async function No(e,t=be){if(!y(t))throw new Error("Eliza browser workspace snapshot is only available in the desktop app.");return await M(`/tabs/${encodeURIComponent(e)}/snapshot`,void 0,t)}function Wo(e){return tr(e)?`
          if (command.script) {
            const fn = new Function("document", "window", "location", "return (" + command.script + ");");
            if (fn(document, window, location)) {
              resolve({ ok: true, script: true });
              return;
            }
          }`:`
          if (command.script) {
            reject(new Error("Browser workspace wait script is disabled (GHSA-mhhr-9ph9-64j7)."));
            return;
          }`}function Lo(e,t=be){const r=Wo(t);return`
(() => {
  const command = ${JSON.stringify(e)};
  const normalize = (value) => String(value ?? "").replace(/\\s+/g, " ").trim();
  const textMatches = (candidate, wanted, exact = false) => {
    const left = normalize(candidate).toLowerCase();
    const right = normalize(wanted).toLowerCase();
    if (!left || !right) return false;
    return exact ? left === right : left.includes(right);
  };
  const selectorFor = (element) => {
    if (!element) return "";
    if (element.id) return "#" + element.id.replace(/[^a-zA-Z0-9_-]/g, "\\\\$&");
    const testId = element.getAttribute?.("data-testid");
    if (testId) return \`[data-testid="\${testId}"]\`;
    const name = element.getAttribute?.("name");
    if (name) return \`\${element.tagName.toLowerCase()}[name="\${name}"]\`;
    const type = element.getAttribute?.("type");
    if (type) return \`\${element.tagName.toLowerCase()}[type="\${type}"]\`;
    let index = 1;
    let previous = element.previousElementSibling;
    while (previous) {
      if (previous.tagName === element.tagName) index += 1;
      previous = previous.previousElementSibling;
    }
    return \`\${element.tagName.toLowerCase()}:nth-of-type(\${index})\`;
  };
  const serialize = (element) => {
    const value =
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
        ? element.value
        : null;
    return {
      selector: selectorFor(element),
      tag: element.tagName.toLowerCase(),
      text: normalize(value ?? element.textContent),
      type: element.getAttribute?.("type"),
      name: element.getAttribute?.("name"),
      href: element.getAttribute?.("href"),
      value: typeof value === "string" ? value : null,
    };
  };
  const searchTexts = (element) => {
    const labelText = element.id
      ? Array.from(document.querySelectorAll('label[for="' + element.id + '"]'))
          .map((label) => label.textContent)
          .join(" ")
      : "";
    return [
      element.textContent,
      element.getAttribute?.("aria-label"),
      element.getAttribute?.("placeholder"),
      element.getAttribute?.("title"),
      element.getAttribute?.("name"),
      element.getAttribute?.("alt"),
      element.getAttribute?.("data-testid"),
      labelText,
      element.value,
    ]
      .map((value) => normalize(value))
      .filter(Boolean);
  };
  const isVisible = (element) => {
    if (!element) return false;
    if (element.hasAttribute?.("hidden") || element.getAttribute?.("aria-hidden") === "true") {
      return false;
    }
    const style = element.style || {};
    return style.display !== "none" && style.visibility !== "hidden";
  };
  const nativeRole = (element) => {
    const explicit = element.getAttribute?.("role")?.trim()?.toLowerCase();
    if (explicit) return explicit;
    const tag = element.tagName.toLowerCase();
    if (tag === "a" && element.getAttribute?.("href")) return "link";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "option") return "option";
    if (tag === "textarea") return "textbox";
    if (tag === "form") return "form";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "input") {
      const type = (element.type || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      return "textbox";
    }
    return null;
  };
  const findByText = (wanted) => {
    const needle = normalize(wanted).toLowerCase();
    if (!needle) return null;
    const elements = Array.from(document.querySelectorAll(
      "a, button, input, textarea, select, option, label, h1, h2, h3, [role='button'], [data-testid]"
    ));
    for (const element of elements) {
      const haystacks = [
        element.textContent,
        element.getAttribute?.("aria-label"),
        element.getAttribute?.("placeholder"),
        element.getAttribute?.("title"),
        element.getAttribute?.("name"),
        element.value,
      ]
        .map((value) => normalize(value))
        .filter(Boolean)
        .map((value) => value.toLowerCase());
      if (haystacks.some((value) => value.includes(needle))) {
        return element;
      }
    }
    return null;
  };
  const findByLabel = (wanted, exact = false) => {
    const labels = Array.from(document.querySelectorAll("label"));
    for (const label of labels) {
      if (!textMatches(label.textContent, wanted, exact)) continue;
      const forId = label.getAttribute("for");
      if (forId) {
        const explicit = document.getElementById(forId);
        if (explicit) return explicit;
      }
      const nested = label.querySelector("input, textarea, select, button");
      if (nested) return nested;
    }
    return null;
  };
  const findByRole = (role, name, exact = false) => {
    const candidates = Array.from(
      document.querySelectorAll(
        "a, button, input, textarea, select, option, form, h1, h2, h3, h4, h5, h6, [role], [data-testid]"
      )
    );
    for (const candidate of candidates) {
      if (nativeRole(candidate) !== role.trim().toLowerCase()) continue;
      if (!name) return candidate;
      if (searchTexts(candidate).some((value) => textMatches(value, name, exact))) {
        return candidate;
      }
    }
    return null;
  };
  const trimQuoted = (value) => {
    const trimmed = String(value || "").trim();
    const hasTextMatch = trimmed.match(/^has-text\\((?:"([^"]*)"|'([^']*)')\\)$/i);
    if (hasTextMatch?.[1] || hasTextMatch?.[2]) {
      return (hasTextMatch[1] || hasTextMatch[2] || "").trim();
    }
    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
      return trimmed.slice(1, -1).trim();
    }
    return trimmed;
  };
  const normalizeSelectorSyntax = (selector) => {
    let normalized = String(selector || "").trim();
    normalized = normalized.replace(
      /^role\\s*[:=]\\s*([a-z0-9_-]+)\\s+name\\s*[:=]\\s*(.+)$/i,
      "role=$1[name=$2]"
    );
    normalized = normalized.replace(
      /^((?:label|text|placeholder|alt|title|testid|data-testid)\\s*[:=]\\s*(?:has-text\\((?:"[^"]*"|'[^']*')\\)|"[^"]+"|'[^']+'|[^>]+?))\\s+((?:input|textarea|select)[\\s\\S]*)$/i,
      "$1 >> $2"
    );
    return normalized;
  };
  const parseSemanticSelector = (selector) => {
    const trimmed = normalizeSelectorSyntax(selector);
    const match = trimmed.match(/^([a-z-]+)\\s*[:=]\\s*(.+)$/i);
    if (!match) return null;
    const kind = match[1]?.trim()?.toLowerCase();
    const rawValue = match[2]?.trim() || "";
    if (!kind || !rawValue) return null;
    switch (kind) {
      case "alt":
        return { findBy: "alt", text: trimQuoted(rawValue) };
      case "css":
        return { selector: trimQuoted(rawValue) };
      case "data-testid":
      case "testid":
        return { findBy: "testid", text: trimQuoted(rawValue) };
      case "label":
        return { findBy: "label", text: trimQuoted(rawValue) };
      case "placeholder":
        return { findBy: "placeholder", text: trimQuoted(rawValue) };
      case "role": {
        const roleMatch = rawValue.match(
          /^([a-z0-9_-]+)(?:\\s*\\[\\s*name\\s*[:=]\\s*(.+?)\\s*\\])?$/i
        );
        if (!roleMatch?.[1]) return null;
        return {
          findBy: "role",
          name: roleMatch[2] ? trimQuoted(roleMatch[2]) : undefined,
          role: roleMatch[1].trim().toLowerCase(),
        };
      }
      case "text":
        return { findBy: "text", text: trimQuoted(rawValue) };
      case "title":
        return { findBy: "title", text: trimQuoted(rawValue) };
      default:
        return null;
    }
  };
  const mergeSelectorCommand = (selector) => {
    const parsed = parseSemanticSelector(selector);
    if (!parsed) return null;
    return { ...command, ...parsed, selector: parsed.selector };
  };
  const queryOne = (selector) => {
    try {
      return document.querySelector(selector);
    } catch {
      throw new Error("Invalid selector " + selector);
    }
  };
  const queryAll = (selector) => {
    try {
      return Array.from(document.querySelectorAll(selector));
    } catch {
      throw new Error("Invalid selector " + selector);
    }
  };
  const findSemantic = (targetCommand = command) => {
    switch (targetCommand.findBy) {
      case "alt":
        return Array.from(document.querySelectorAll("[alt]")).find((element) =>
          textMatches(
            element.getAttribute("alt"),
            targetCommand.text,
            targetCommand.exact
          )
        ) || null;
      case "first":
        return targetCommand.selector ? queryOne(targetCommand.selector) : null;
      case "label":
        return targetCommand.text
          ? findByLabel(targetCommand.text, targetCommand.exact)
          : null;
      case "last":
        return targetCommand.selector
          ? queryAll(targetCommand.selector).at(-1) || null
          : null;
      case "nth":
        return targetCommand.selector && Number.isInteger(targetCommand.index)
          ? queryAll(targetCommand.selector).at(targetCommand.index) || null
          : null;
      case "placeholder":
        return Array.from(document.querySelectorAll("[placeholder]")).find((element) =>
          textMatches(
            element.getAttribute("placeholder"),
            targetCommand.text,
            targetCommand.exact
          )
        ) || null;
      case "role":
        return targetCommand.role
          ? findByRole(
              targetCommand.role,
              targetCommand.name,
              targetCommand.exact
            )
          : null;
      case "testid":
        return targetCommand.text
          ? document.querySelector('[data-testid="' + targetCommand.text + '"]')
          : null;
      case "text":
        return targetCommand.text ? findByText(targetCommand.text) : null;
      case "title":
        return Array.from(document.querySelectorAll("[title]")).find((element) =>
          textMatches(
            element.getAttribute("title"),
            targetCommand.text,
            targetCommand.exact
          )
        ) || null;
      default:
        return null;
    }
  };
  const findTarget = () => {
    if (command.selector) {
      const selectorChain = normalizeSelectorSyntax(command.selector)
        .split(/s*>>s*/)
        .map((segment) => segment.trim())
        .filter(Boolean);
      if (selectorChain.length > 1) {
        let current = queryTarget(selectorChain[0]);
        for (let index = 1; current && index < selectorChain.length; index += 1) {
          const segment = selectorChain[index];
          if (!segment) continue;
          if (typeof current.matches === "function" && current.matches(segment)) {
            continue;
          }
          if (
            /^(input|textarea|select)(?:[[^]]+])?$/i.test(segment) &&
            (current.tagName === "INPUT" ||
              current.tagName === "TEXTAREA" ||
              current.tagName === "SELECT")
          ) {
            continue;
          }
          current = queryOneWithin(current, segment);
        }
        return current;
      }
      return queryTarget(command.selector);
    }
    if (command.findBy) return findSemantic();
    if (command.text) return findByText(command.text);
    return null;
  };
  const queryOneWithin = (root, selector) => {
    try {
      return root.querySelector(selector);
    } catch {
      throw new Error("Invalid selector " + selector);
    }
  };
  const queryTarget = (selector) => {
    const semantic = mergeSelectorCommand(selector);
    if (semantic) return findSemantic(semantic);
    return queryOne(selector);
  };
  const inspect = () =>
    Array.from(
      document.querySelectorAll(
        "a, button, input, textarea, select, form, [role='button'], [data-testid]"
      )
    )
      .slice(0, 40)
      .map((element) => serialize(element));
  const snapshot = () => ({
    title: document.title,
    url: location.href,
    bodyText: normalize(document.body?.textContent).slice(0, 800),
    elements: inspect(),
  });
  const setInputValue = (appendMode, target) => {
    const element = target || findTarget();
    if (!element) {
      throw new Error("Target element was not found.");
    }
    if (
      !(
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement
      )
    ) {
      throw new Error("Target element is not an input, textarea, or select.");
    }
    const nextValue = appendMode ? \`\${element.value ?? ""}\${command.value ?? ""}\` : (command.value ?? "");
    element.value = nextValue;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return { selector: selectorFor(element), value: element.value };
  };
  const setChecked = (targetValue) => {
    const element = findTarget();
    if (!element) throw new Error("Target element was not found.");
    if (!(element instanceof HTMLInputElement)) {
      throw new Error("Target element is not a checkbox or radio input.");
    }
    const type = (element.type || "").toLowerCase();
    if (type !== "checkbox" && type !== "radio") {
      throw new Error("Target element is not a checkbox or radio input.");
    }
    element.checked = targetValue;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return { checked: element.checked, selector: selectorFor(element) };
  };
  const setSelectValue = () => {
    const element = findTarget();
    if (!element) throw new Error("Target element was not found.");
    if (!(element instanceof HTMLSelectElement)) {
      throw new Error("Target element is not a select.");
    }
    const targetValue = command.value ?? "";
    const option = Array.from(element.options).find(
      (entry) =>
        entry.value === targetValue || textMatches(entry.textContent, targetValue, true)
    );
    if (!option) {
      throw new Error("Select option was not found.");
    }
    element.value = option.value;
    option.selected = true;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return { selector: selectorFor(element), value: element.value };
  };
  const focusElement = (element) => {
    if (!element) throw new Error("Target element was not found.");
    if (typeof element.focus === "function") {
      element.focus();
    }
    return {
      focused: document.activeElement === element,
      selector: selectorFor(element),
    };
  };
  const hoverElement = (element) => {
    if (!element) throw new Error("Target element was not found.");
    element.setAttribute("data-eliza-hover", "true");
    return { hovered: true, selector: selectorFor(element) };
  };
  const activateElement = (subaction, element) => {
    if (!element) throw new Error("Target element was not found.");
    if (subaction === "dblclick") {
      element.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    }
    if (typeof element.click === "function") {
      element.click();
    }
    return {
      clickCount: subaction === "dblclick" ? 2 : 1,
      element: serialize(element),
      url: location.href,
    };
  };
  const ensureTabKit = () => {
    const kit = window.__elizaTabKit;
    if (!kit) {
      throw new Error(
        "browser tab kit not installed (BROWSER_TAB_PRELOAD_SCRIPT missing)",
      );
    }
    return kit;
  };
  const runRealisticSubaction = (subaction) => {
    const kit = ensureTabKit();
    const cursorDuration = Number(command.cursorDurationMs) || 220;
    if (subaction === "cursor-hide") {
      kit.cursor.hide();
      return { hidden: true };
    }
    if (subaction === "cursor-move") {
      const x = Number(command.x);
      const y = Number(command.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error("cursor-move requires x and y");
      }
      kit.cursor.show();
      return Promise.resolve(
        kit.cursor.moveTo({ x: x, y: y }, { durationMs: cursorDuration }),
      ).then(() => ({ x: x, y: y }));
    }
    if (subaction === "realistic-press") {
      const target = findTarget() || document.activeElement || document.body;
      const key = command.key || "Enter";
      target.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: key,
          bubbles: true,
          cancelable: true,
          composed: true,
        }),
      );
      target.dispatchEvent(
        new KeyboardEvent("keyup", {
          key: key,
          bubbles: true,
          cancelable: true,
          composed: true,
        }),
      );
      return { key: key, selector: selectorFor(target), url: location.href };
    }
    const element = findTarget();
    if (!element) {
      throw new Error("Target element was not found.");
    }
    kit.cursor.show();
    if (subaction === "realistic-click") {
      kit.cursor.highlight(element);
      return Promise.resolve(
        kit.dispatchPointerSequence(element, { button: 0 }),
      ).then(() => ({
        element: serialize(element),
        url: location.href,
      }));
    }
    if (subaction === "realistic-fill" || subaction === "realistic-type") {
      const value = command.value ?? command.text ?? "";
      const replace = subaction === "realistic-fill" || command.replace === true;
      const perCharDelayMs = Number(command.perCharDelayMs);
      kit.cursor.highlight(element);
      return Promise.resolve(
        kit
          .dispatchPointerSequence(element, { button: 0 })
          .then(() =>
            kit.typeRealistic(element, value, {
              replace: replace,
              perCharDelayMs: Number.isFinite(perCharDelayMs)
                ? perCharDelayMs
                : undefined,
            }),
          ),
      ).then(() => ({
        element: serialize(element),
        value: element.value,
      }));
    }
    if (subaction === "realistic-upload") {
      const url = (command.files && command.files[0]) || command.url || command.value;
      if (!url) {
        throw new Error("realistic-upload requires files[0] or url");
      }
      if (element.tagName !== "INPUT" || element.type !== "file") {
        throw new Error("realistic-upload target must be input[type=file]");
      }
      kit.cursor.highlight(element);
      return Promise.resolve(kit.setFileInput(element, url, {})).then((info) => ({
        element: serialize(element),
        upload: info,
      }));
    }
    throw new Error("Unsupported realistic subaction: " + subaction);
  };
  const keyboardTarget = () => findTarget() || document.activeElement || document.body;
  const keyboardWrite = (appendMode) => {
    const target = keyboardTarget();
    if (
      !(
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
      )
    ) {
      throw new Error("Keyboard text input requires an input, textarea, or select target.");
    }
    return setInputValue(appendMode, target);
  };
  const keyPhase = (phase) => {
    const target = keyboardTarget();
    const key = command.key || "Enter";
    target.dispatchEvent(new KeyboardEvent(phase, { key, bubbles: true }));
    return { key, phase, selector: selectorFor(target) };
  };
  const scrollTarget = () => findTarget();
  const scroll = () => {
    const target = scrollTarget();
    const direction = command.direction || "down";
    const pixels = Math.max(1, Math.abs(Number(command.pixels) || 240));
    const axis = direction === "left" || direction === "right" ? "x" : "y";
    const delta = direction === "up" || direction === "left" ? -pixels : pixels;
    if (target instanceof HTMLElement) {
      if (axis === "y") {
        target.scrollTop = (target.scrollTop || 0) + delta;
        return { axis, selector: selectorFor(target), value: target.scrollTop };
      }
      target.scrollLeft = (target.scrollLeft || 0) + delta;
      return { axis, selector: selectorFor(target), value: target.scrollLeft };
    }
    if (axis === "y") {
      window.scrollBy(0, delta);
      return { axis, selector: null, value: window.scrollY };
    }
    window.scrollBy(delta, 0);
    return { axis, selector: null, value: window.scrollX };
  };
  const getResult = () => {
    if (command.getMode === "title") return document.title;
    if (command.getMode === "url") return location.href;
    if (command.getMode === "count") {
      if (!command.selector) throw new Error("count requires selector");
      const semantic = mergeSelectorCommand(command.selector);
      return semantic ? Number(Boolean(findSemantic(semantic))) : queryAll(command.selector).length;
    }
    const element = findTarget();
    if (!element) throw new Error("Target element was not found.");
    switch (command.getMode) {
      case "attr":
        if (!command.attribute) throw new Error("attr lookups require attribute");
        return element.getAttribute(command.attribute);
      case "box":
        return element.getBoundingClientRect();
      case "checked":
        return element instanceof HTMLInputElement
          ? Boolean(element.checked)
          : element instanceof HTMLOptionElement
            ? Boolean(element.selected)
            : false;
      case "enabled":
        return "disabled" in element ? !Boolean(element.disabled) : true;
      case "html":
        return element.innerHTML;
      case "styles": {
        const computed = getComputedStyle(element);
        return {
          display: computed.display || null,
          visibility: computed.visibility || null,
          opacity: computed.opacity || null,
        };
      }
      case "text":
        return normalize(element.textContent);
      case "value":
        return element.value ?? element.getAttribute?.("value");
      case "visible":
        return isVisible(element);
      default:
        return normalize(element.textContent);
    }
  };
  const waitForCondition = () =>
    new Promise((resolve, reject) => {
      if (
        !command.selector &&
        !command.findBy &&
        !command.text &&
        !command.url &&
        !command.script &&
        Number.isFinite(Number(command.timeoutMs))
      ) {
        const waitedMs = Math.max(0, Number(command.timeoutMs) || 0);
        setTimeout(() => resolve({ ok: true, waitedMs }), waitedMs);
        return;
      }
      const deadline = Date.now() + (Number(command.timeoutMs) || 4000);
      const check = () => {
        try {
          if (command.selector) {
            const found = findTarget();
            const visible =
              command.state === "hidden"
                ? !found || !isVisible(found)
                : found && isVisible(found);
            if (visible) {
              resolve({ ok: true, selector: command.selector, state: command.state || "visible" });
              return;
            }
          }
          if (command.findBy) {
            const found = findSemantic();
            if (command.state === "hidden" ? !found : found) {
              resolve({ findBy: command.findBy, ok: true });
              return;
            }
          }
          if (command.text && normalize(document.body?.textContent).includes(command.text)) {
            resolve({ ok: true, text: command.text });
            return;
          }
          if (command.url && location.href.includes(command.url)) {
            resolve({ ok: true, url: location.href });
            return;
          }
          ${r}
          if (Date.now() >= deadline) {
            reject(new Error("Timed out waiting for browser workspace condition."));
            return;
          }
          setTimeout(check, 100);
        } catch (error) {
          reject(error);
        }
      };
      check();
    });

  switch (command.subaction) {
    case "inspect":
      return { title: document.title, url: location.href, elements: inspect() };
    case "snapshot":
      return snapshot();
    case "get":
      return { value: getResult() };
    case "find": {
      const element = findTarget();
      if (!element) throw new Error("Target element was not found.");
      switch (command.action) {
        case "check":
          return setChecked(true);
        case "click":
          return activateElement("click", element);
        case "fill":
          return setInputValue(false, element);
        case "focus":
          return focusElement(element);
        case "hover":
          return hoverElement(element);
        case "text":
        case undefined:
          return { element: serialize(element), value: normalize(element.textContent) };
        case "type":
          return setInputValue(true, element);
        case "uncheck":
          return setChecked(false);
        default:
          throw new Error("Unsupported find action.");
      }
    }
    case "click": {
      const element = findTarget();
      return activateElement("click", element);
    }
    case "dblclick": {
      const element = findTarget();
      return activateElement("dblclick", element);
    }
    case "check":
      return setChecked(true);
    case "fill":
      return setInputValue(false);
    case "focus": {
      const element = findTarget();
      return focusElement(element);
    }
    case "hover": {
      const element = findTarget();
      return hoverElement(element);
    }
    case "keyboardinserttext":
      return keyboardWrite(false);
    case "keyboardtype":
      return keyboardWrite(true);
    case "keydown":
      return keyPhase("keydown");
    case "keyup":
      return keyPhase("keyup");
    case "type":
      return setInputValue(true);
    case "press": {
      const target = findTarget() ?? document.activeElement ?? document.body;
      const key = command.key || "Enter";
      target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      target.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
      return { key, url: location.href };
    }
    case "realistic-click":
    case "realistic-fill":
    case "realistic-type":
    case "realistic-press":
    case "realistic-upload":
    case "cursor-move":
    case "cursor-hide":
      return runRealisticSubaction(command.subaction);
    case "scroll":
      return scroll();
    case "scrollinto": {
      const element = findTarget();
      if (!element) throw new Error("Target element was not found.");
      if (typeof element.scrollIntoView === "function") {
        element.scrollIntoView();
      }
      return { scrolled: true, selector: selectorFor(element) };
    }
    case "select":
      return setSelectValue();
    case "uncheck":
      return setChecked(false);
    case "wait":
      return waitForCondition();
    case "back":
      history.back();
      return { url: location.href, title: document.title };
    case "forward":
      history.forward();
      return { url: location.href, title: document.title };
    case "reload":
      location.reload();
      return { url: location.href, title: document.title };
    default:
      throw new Error(\`Unsupported desktop browser subaction: \${command.subaction}\`);
  }
})()
`.trim()}function $o(e){return`
(() => {
  const command = ${JSON.stringify(e)};
  const normalize = (value) => String(value ?? "").replace(/\\s+/g, " ").trim();
  const state =
    window.__elizaBrowserWorkspaceState ||
    (window.__elizaBrowserWorkspaceState = {
      clipboardText: "",
      consoleEntries: [],
      currentFrame: null,
      dialog: null,
      errors: [],
      highlightedSelector: null,
      mouse: { buttons: [], x: 0, y: 0 },
      networkHar: { active: false, entries: [], startedAt: null },
      networkNextRequestId: 1,
      networkRequests: [],
      networkRoutes: [],
      settings: {
        credentials: null,
        device: null,
        geo: null,
        headers: {},
        media: null,
        offline: false,
        viewport: null
      }
    });
  const patternMatches = (pattern, value) => {
    const trimmed = String(pattern ?? "").trim();
    if (!trimmed) return false;
    if (!trimmed.includes("*")) return String(value ?? "").includes(trimmed);
    let wildcard = "";
    for (let i = 0; i < trimmed.length; i += 1) {
      const char = trimmed[i];
      if (char === "*") {
        if (trimmed[i + 1] === "*") {
          wildcard += ".*";
          i += 1;
        } else {
          wildcard += ".*";
        }
      } else {
        wildcard += char.replace(/[|\\\\{}()[\\]^$+?.]/g, "\\\\$&");
      }
    }
    return new RegExp("^" + wildcard + "$", "i").test(String(value ?? ""));
  };
  const buildSelector = (element) => {
    if (!element || !element.tagName) return null;
    const testId = element.getAttribute && element.getAttribute("data-testid");
    if (testId) return '[data-testid="' + testId + '"]';
    const name = element.getAttribute && element.getAttribute("name");
    if (name) return element.tagName.toLowerCase() + '[name="' + name + '"]';
    const title = element.getAttribute && element.getAttribute("title");
    if (title) return element.tagName.toLowerCase() + '[title="' + title + '"]';
    return element.tagName.toLowerCase();
  };
  const activeDocument = (() => {
    if (!state.currentFrame) return document;
    try {
      const frame = document.querySelector(state.currentFrame);
      return frame && frame.contentDocument ? frame.contentDocument : document;
    } catch {
      return document;
    }
  })();
  const queryOne = (selector, root = activeDocument) => {
    try {
      return root.querySelector(selector);
    } catch {
      throw new Error("Invalid selector " + selector);
    }
  };
  const findByText = (needle) => {
    const wanted = normalize(needle).toLowerCase();
    if (!wanted) return null;
    const candidates = Array.from(
      activeDocument.querySelectorAll(
        "a, button, input, textarea, select, option, label, h1, h2, h3, [role='button'], [data-testid]"
      )
    );
    return (
      candidates.find((element) => {
        const haystacks = [
          element.textContent,
          element.getAttribute("aria-label"),
          element.getAttribute("placeholder"),
          element.getAttribute("title"),
          element.getAttribute("name"),
          element.value
        ]
          .map((value) => normalize(value).toLowerCase())
          .filter(Boolean);
        return haystacks.some((value) => value.includes(wanted));
      }) || null
    );
  };
  const resolveTarget = () => {
    if (command.selector) return queryOne(command.selector);
    if (command.text) return findByText(command.text);
    return activeDocument.activeElement || activeDocument.body;
  };
  const recordRequest = (request) => {
    const entry = {
      ...request,
      id: "req_" + state.networkNextRequestId++,
      timestamp: new Date().toISOString()
    };
    state.networkRequests.push(entry);
    if (state.networkHar.active) state.networkHar.entries.push(entry);
    return entry;
  };
  if (!state.consoleWrapped) {
    for (const level of ["log", "info", "warn", "error"]) {
      console[level] = (...args) => {
        state.consoleEntries.push({
          level,
          message: args.map((value) => normalize(value)).join(" "),
          timestamp: new Date().toISOString()
        });
      };
    }
    state.consoleWrapped = true;
  }
  if (!state.dialogWrapped) {
    window.alert = (message) => {
      state.dialog = { defaultValue: null, message: String(message ?? ""), open: true, type: "alert" };
    };
    window.confirm = (message) => {
      state.dialog = { defaultValue: null, message: String(message ?? ""), open: true, type: "confirm" };
      return false;
    };
    window.prompt = (message, defaultValue) => {
      state.dialog = {
        defaultValue: defaultValue ?? null,
        message: String(message ?? ""),
        open: true,
        type: "prompt"
      };
      return null;
    };
    state.dialogWrapped = true;
  }
  if (!state.fetchWrapped) {
    state.originalFetch = window.fetch ? window.fetch.bind(window) : null;
    window.fetch = async (input, init = {}) => {
      const inputUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : typeof input?.url === "string"
              ? input.url
              : String(input);
      const url = new URL(inputUrl, location.href).toString();
      if (state.settings.offline) {
        recordRequest({
          matchedRoute: null,
          method: String(init.method || "GET").toUpperCase(),
          resourceType: "fetch",
          responseBody: null,
          responseHeaders: {},
          status: 0,
          url
        });
        throw new Error("Browser workspace is offline.");
      }
      const route = [...state.networkRoutes].reverse().find((entry) => patternMatches(entry.pattern, url)) || null;
      if (route && route.abort) {
        recordRequest({
          matchedRoute: route.pattern,
          method: String(init.method || "GET").toUpperCase(),
          resourceType: "fetch",
          responseBody: null,
          responseHeaders: route.headers || {},
          status: 0,
          url
        });
        throw new Error("Browser workspace network route aborted request: " + url);
      }
      if (route && (route.body !== null || route.status !== null || Object.keys(route.headers || {}).length > 0)) {
        const response = new Response(route.body || "", {
          headers: route.headers || {},
          status: route.status || 200
        });
        recordRequest({
          matchedRoute: route.pattern,
          method: String(init.method || "GET").toUpperCase(),
          resourceType: "fetch",
          responseBody: route.body || "",
          responseHeaders: route.headers || {},
          status: route.status || 200,
          url
        });
        return response;
      }
      const headers = new Headers(init.headers || {});
      for (const [key, value] of Object.entries(state.settings.headers || {})) {
        if (!headers.has(key)) headers.set(key, value);
      }
      if (state.settings.credentials && state.settings.credentials.username && !headers.has("Authorization")) {
        headers.set(
          "Authorization",
          "Basic " + btoa(state.settings.credentials.username + ":" + state.settings.credentials.password)
        );
      }
      const response = await state.originalFetch(url, { ...init, headers });
      recordRequest({
        matchedRoute: null,
        method: String(init.method || "GET").toUpperCase(),
        resourceType: "fetch",
        responseBody: null,
        responseHeaders: Object.fromEntries(response.headers.entries()),
        status: response.status,
        url: response.url || url
      });
      return response;
    };
    state.fetchWrapped = true;
  }
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    get: () => !state.settings.offline
  });
  switch (command.subaction) {
    case "clipboard": {
      const action = command.clipboardAction || "read";
      if (action === "read") return state.clipboardText;
      if (action === "write") {
        state.clipboardText = command.value || command.text || "";
        return state.clipboardText;
      }
      if (action === "copy") {
        const target = resolveTarget();
        state.clipboardText =
          target && typeof target.value === "string"
            ? String(target.value || "")
            : normalize(target?.textContent || activeDocument.body?.textContent);
        return state.clipboardText;
      }
      const target = resolveTarget();
      if (target && typeof target.value === "string") {
        target.value = String(target.value || "") + state.clipboardText;
        target.setAttribute("value", target.value);
        return { selector: buildSelector(target), value: target.value };
      }
      return state.clipboardText;
    }
    case "mouse": {
      const action = command.mouseAction || "move";
      if (action === "move") {
        state.mouse.x = typeof command.x === "number" ? command.x : state.mouse.x;
        state.mouse.y = typeof command.y === "number" ? command.y : state.mouse.y;
        return state.mouse;
      }
      if (action === "down") {
        const button = command.button || "left";
        state.mouse.buttons = Array.from(new Set([...(state.mouse.buttons || []), button]));
        return state.mouse;
      }
      if (action === "up") {
        const button = command.button || "left";
        state.mouse.buttons = (state.mouse.buttons || []).filter((entry) => entry !== button);
        return state.mouse;
      }
      window.scrollBy(command.deltaX || 0, command.deltaY || command.pixels || 240);
      return { axis: Math.abs(command.deltaY || 0) >= Math.abs(command.deltaX || 0) ? "y" : "x", value: window.scrollY };
    }
    case "drag": {
      const source = resolveTarget();
      const target = command.value ? queryOne(command.value) : null;
      if (!source || !target) throw new Error("Eliza browser workspace drag requires source selector and target selector in value.");
      source.setAttribute("data-eliza-dragging", "true");
      target.setAttribute("data-eliza-drop-target", "true");
      return { source: buildSelector(source), target: buildSelector(target) };
    }
    case "upload": {
      const target = resolveTarget();
      if (!target || target.tagName !== "INPUT") throw new Error("Eliza browser workspace upload requires a file input target.");
      const files = Array.isArray(command.files) ? command.files.map((entry) => String(entry).split(/[\\\\/]/).pop()) : [];
      target.setAttribute("data-eliza-uploaded-files", files.join(","));
      return { files, selector: buildSelector(target) };
    }
    case "set": {
      const action = command.setAction || "viewport";
      if (action === "viewport") {
        state.settings.viewport = { width: command.width || 1280, height: command.height || 720, scale: command.scale || 1 };
      } else if (action === "device") {
        state.settings.device = command.device || null;
      } else if (action === "geo") {
        state.settings.geo =
          typeof command.latitude === "number" && typeof command.longitude === "number"
            ? { latitude: command.latitude, longitude: command.longitude }
            : null;
      } else if (action === "offline") {
        state.settings.offline = Boolean(command.offline);
      } else if (action === "headers") {
        state.settings.headers = command.headers || {};
      } else if (action === "credentials") {
        state.settings.credentials =
          command.username || command.password
            ? { username: command.username || "", password: command.password || "" }
            : null;
      } else if (action === "media") {
        state.settings.media = command.media || null;
      }
      return state.settings;
    }
    case "cookies": {
      const action = command.cookieAction || "get";
      if (action === "clear") {
        const current = document.cookie || "";
        current.split(/;\\s*/).forEach((entry) => {
          const name = entry.split("=")[0];
          if (name) document.cookie = name + "=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
        });
        return { cleared: true };
      }
      if (action === "set") {
        const name = command.name || command.entryKey;
        if (!name) throw new Error("Eliza browser workspace cookies set requires name.");
        document.cookie = name + "=" + (command.value || "") + "; path=/";
      }
      const cookieString = document.cookie || "";
      return Object.fromEntries(
        cookieString
          .split(/;\\s*/)
          .filter(Boolean)
          .map((entry) => {
            const [name, ...rest] = entry.split("=");
            return [name, rest.join("=")];
          })
      );
    }
    case "storage": {
      const storage = command.storageArea === "session" ? sessionStorage : localStorage;
      const action = command.storageAction || "get";
      if (action === "clear") {
        storage.clear();
        return { cleared: true };
      }
      if (action === "set") {
        const key = command.entryKey || command.name;
        if (!key) throw new Error("Eliza browser workspace storage set requires entryKey.");
        storage.setItem(key, command.value || "");
      }
      if (command.entryKey || command.name) {
        return storage.getItem(command.entryKey || command.name);
      }
      const out = {};
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i);
        if (key) out[key] = storage.getItem(key) || "";
      }
      return out;
    }
    case "network": {
      const action = command.networkAction || "requests";
      if (action === "route") {
        if (!command.url) throw new Error("Eliza browser workspace network route requires url pattern.");
        state.networkRoutes.push({
          abort: Boolean(command.offline),
          body: command.responseBody ?? null,
          headers: command.responseHeaders || {},
          pattern: command.url,
          status: typeof command.responseStatus === "number" ? command.responseStatus : null
        });
        return state.networkRoutes;
      }
      if (action === "unroute") {
        state.networkRoutes = command.url
          ? state.networkRoutes.filter((entry) => entry.pattern !== command.url)
          : [];
        return state.networkRoutes;
      }
      if (action === "request") {
        return state.networkRequests.find((entry) => entry.id === command.requestId) || null;
      }
      if (action === "harstart") {
        state.networkHar = { active: true, entries: [], startedAt: new Date().toISOString() };
        return state.networkHar;
      }
      if (action === "harstop") {
        state.networkHar.active = false;
        return { log: { entries: state.networkHar.entries, startedAt: state.networkHar.startedAt } };
      }
      let requests = [...state.networkRequests];
      if (command.filter) requests = requests.filter((entry) => entry.url.includes(command.filter));
      if (command.method) requests = requests.filter((entry) => entry.method === String(command.method).toUpperCase());
      if (command.status) requests = requests.filter((entry) => String(entry.status || "") === String(command.status));
      return requests;
    }
    case "dialog": {
      const action = command.dialogAction || "status";
      if (action === "status") return state.dialog;
      if (state.dialog) state.dialog.open = false;
      const result =
        action === "accept"
          ? { accepted: true, dialog: state.dialog, promptText: command.promptText || command.value || null }
          : { accepted: false, dialog: state.dialog };
      state.dialog = null;
      return result;
    }
    case "console":
      if (command.consoleAction === "clear") state.consoleEntries = [];
      return state.consoleEntries;
    case "errors":
      if (command.consoleAction === "clear") state.errors = [];
      return state.errors;
    case "highlight": {
      const target = resolveTarget();
      if (!target) throw new Error("Target element was not found.");
      target.setAttribute("data-eliza-highlight", "true");
      state.highlightedSelector = buildSelector(target);
      return { selector: state.highlightedSelector };
    }
    case "frame": {
      if ((command.frameAction || "select") === "main") {
        state.currentFrame = null;
        return { frame: null };
      }
      const frame = command.selector ? document.querySelector(command.selector) : null;
      if (!frame || frame.tagName !== "IFRAME") throw new Error("Eliza browser workspace frame select requires an iframe selector.");
      state.currentFrame = buildSelector(frame);
      return { frame: state.currentFrame };
    }
    default:
      throw new Error("Unsupported desktop browser workspace utility subaction: " + command.subaction);
  }
})()
`.trim()}async function Mo(e,t){const r=await C(e,t);(e.subaction==="cookies"||e.subaction==="storage"||e.subaction==="set"&&(e.setAction==="credentials"||e.setAction==="headers"))&&await nr(r,t,e.subaction);const o=Date.now(),n=await ge({id:r,script:$o({...e,id:r})},t),s=z("desktop",r);return Zr(s,{subaction:e.subaction,type:"utility"}),Xr(s,{durationMs:Date.now()-o,subaction:e.subaction,type:"utility"}),{mode:"desktop",subaction:e.subaction,value:n}}async function Ar(e,t){const r=await C(e,t);return await ge({id:r,script:`
(() => {
  const activeDocument = (() => {
    const state = window.__elizaBrowserWorkspaceState || {};
    if (!state.currentFrame) return document;
    try {
      const frame = document.querySelector(state.currentFrame);
      return frame && frame.contentDocument ? frame.contentDocument : document;
    } catch {
      return document;
    }
  })();
  const normalize = (value) => String(value ?? "").replace(/\\s+/g, " ").trim();
  const controlText = Array.from(activeDocument.querySelectorAll("input, textarea, select, option:checked"))
    .map((element) => {
      const name = element.getAttribute("name") || element.getAttribute("id") || element.tagName.toLowerCase();
      const value =
        element.tagName === "SELECT"
          ? element.value
          : typeof element.value === "string"
            ? element.value
            : element.textContent || "";
      return name + ":" + normalize(value);
    })
    .filter(Boolean)
    .join(" ");
  return {
    bodyText: normalize((activeDocument.body?.textContent || "") + " " + controlText),
    title: normalize(document.title),
    url: location.href
  };
})()
      `.trim()},t)}async function Do(e,t){const r=await C(e,t);return await nr(r,t,"state"),await ge({id:r,script:`
(() => {
  const state = window.__elizaBrowserWorkspaceState || {};
  const readStorage = (storage) => {
    const out = {};
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key) out[key] = storage.getItem(key) || "";
    }
    return out;
  };
  const cookies = Object.fromEntries(
    String(document.cookie || "")
      .split(/;\\s*/)
      .filter(Boolean)
      .map((entry) => {
        const [name, ...rest] = entry.split("=");
        return [name, rest.join("=")];
      })
  );
  return {
    clipboard: state.clipboardText || "",
    cookies,
    localStorage: readStorage(localStorage),
    sessionStorage: readStorage(sessionStorage),
    settings: state.settings || {},
    url: location.href
  };
})()
      `.trim()},t)}async function Uo(e,t,r){const o=await C(e,r);await nr(o,r,"state"),await ge({id:o,script:`
(() => {
  const payload = ${JSON.stringify(t)};
  const state =
    window.__elizaBrowserWorkspaceState ||
    (window.__elizaBrowserWorkspaceState = { settings: {} });
  localStorage.clear();
  for (const [key, value] of Object.entries(payload.localStorage || {})) {
    localStorage.setItem(key, String(value ?? ""));
  }
  sessionStorage.clear();
  for (const [key, value] of Object.entries(payload.sessionStorage || {})) {
    sessionStorage.setItem(key, String(value ?? ""));
  }
  for (const [key, value] of Object.entries(payload.cookies || {})) {
    document.cookie = key + "=" + String(value ?? "") + "; path=/";
  }
  state.clipboardText = typeof payload.clipboard === "string" ? payload.clipboard : "";
  state.settings = typeof payload.settings === "object" && payload.settings ? payload.settings : state.settings;
  return { loaded: true };
})()
      `.trim()},r)}async function Rr(e,t){wt(e.script,"wait","desktop",t);const r=await C(e,t),o=Date.now();e=er(e,"desktop",r);const n=await ge({id:r,script:Lo({...e,id:r},t)},t);if(e.subaction==="inspect"||e.subaction==="snapshot"){const i=n&&typeof n=="object"&&!Array.isArray(n)?n:null,u=Wt("desktop",r,Array.isArray(i?.elements)?i.elements:[]);return{mode:"desktop",subaction:e.subaction,elements:u,value:n}}const s=z("desktop",r);return Zr(s,{subaction:e.subaction,type:"dom"}),Xr(s,{durationMs:Date.now()-o,subaction:e.subaction,type:"dom"}),{mode:"desktop",subaction:e.subaction,value:n&&typeof n=="object"&&!Array.isArray(n)?n.value??n:n}}function zo(e){return e.length===0?null:e.find(t=>t.visible)??[...e].sort((t,r)=>{const o=t.lastFocusedAt??t.updatedAt??"";return(r.lastFocusedAt??r.updatedAt??"").localeCompare(o)||t.id.localeCompare(r.id)})[0]??null}async function C(e,t){if(e.id?.trim())return e.id.trim();const r=await M("/tabs",void 0,t),o=Array.isArray(r.tabs)?r.tabs:[],n=zo(o);if(!n)throw Yt(e.subaction);return n.id}function jo(e,t){const r=e.trim();if(!r)return!1;if(!r.includes("*"))return t.includes(r);let o="";for(let n=0;n<r.length;n+=1){const s=r[n]??"";if(s==="*"){r[n+1]==="*"?(o+=".*",n+=1):o+=".*";continue}o+=s.replace(/[|\\{}()[\]^$+?.]/g,"\\$&")}return new RegExp(`^${o}$`,"i").test(t)}function Br(e){return e?Object.fromEntries(Object.entries(e).filter(t=>typeof t[0]=="string"&&t[0].trim().length>0&&typeof t[1]=="string")):{}}function Fo(e,t){return[...e.networkRoutes].reverse().find(r=>jo(r.pattern,t))??null}function Ne(e,t){const r={...t,id:`req_${e.networkNextRequestId++}`,timestamp:O()};return e.networkRequests.push(r),e.networkHar.active&&e.networkHar.entries.push(r),r}async function xe(e,t,r={},o){if(e.settings.offline)throw Ne(e,{matchedRoute:null,method:String(r.method??"GET").toUpperCase(),resourceType:o,responseBody:null,responseHeaders:{},status:0,url:t}),new Error("Browser workspace is offline.");const n=Fo(e,t);if(n?.abort)throw Ne(e,{matchedRoute:n.pattern,method:String(r.method??"GET").toUpperCase(),resourceType:o,responseBody:null,responseHeaders:n.headers,status:0,url:t}),new Error(`Browser workspace network route aborted request: ${t}`);if(n&&(n.body!==null||n.status!==null||Object.keys(n.headers).length>0)){const a=new Response(n?.body??"",{headers:n?.headers,status:n?.status??200});return Ne(e,{matchedRoute:n?.pattern??null,method:String(r.method??"GET").toUpperCase(),resourceType:o,responseBody:n?.body??"",responseHeaders:n?.headers??{},status:n?.status??200,url:t}),a}const s=new Headers(r.headers??{});for(const[a,c]of Object.entries(e.settings.headers))s.has(a)||s.set(a,c);e.settings.credentials&&!s.has("Authorization")&&e.settings.credentials.username&&s.set("Authorization",`Basic ${Buffer.from(`${e.settings.credentials.username}:${e.settings.credentials.password}`).toString("base64")}`);const i=await Xe(t,{...r,headers:s,redirect:r.redirect??"follow",signal:r.signal??AbortSignal.timeout(dt)});let u=null;if(o!=="document"){const a=i.clone();try{u=await a.text()}catch{u=null}}return Ne(e,{matchedRoute:null,method:String(r.method??"GET").toUpperCase(),resourceType:o,responseBody:u,responseHeaders:Object.fromEntries(i.headers.entries()),status:i.status,url:i.url||t}),i}let _t;function on(){const e=n=>{const s=[_e(),_e()];for(const i of s){const u=_e();if(Gt())return u}},t=(n,s)=>{let i=n;for(let u=0;u<s;u+=1){const a=e();if(a)return a;const c=yr();if(c===i)break;i=c}},r=t(yr(),24);if(r)return r;const o=t(process.cwd(),16);if(o)return o;throw new Error("Could not find jsdom on disk (install dependencies: jsdom is listed on @elizaos/agent and apps/app).")}function Pe(){if(!_t){on(),(JSON.parse(Jn()).main??"./lib/api.js").replace(/^\.\//,"");const t=_e();_t=eo()(t).JSDOM}return _t}function sr(e){return new(Pe())('<!doctype html><html lang="en"><head><title>New Tab</title></head><body></body></html>',{pretendToBeVisual:!0,url:e})}function et(e,t){const r=t.settings.viewport;r&&(Object.defineProperty(e.window,"innerWidth",{configurable:!0,value:r.width}),Object.defineProperty(e.window,"innerHeight",{configurable:!0,value:r.height}),Object.defineProperty(e.window,"devicePixelRatio",{configurable:!0,value:r.scale})),Object.defineProperty(e.window.navigator,"onLine",{configurable:!0,get:()=>!t.settings.offline}),t.settings.device&&Object.defineProperty(e.window.navigator,"userAgent",{configurable:!0,value:`ElizaBrowserWorkspace/${t.settings.device}`});const o=n=>{const s=n.includes("prefers-color-scheme")&&(t.settings.media==="dark"&&n.includes("dark")||t.settings.media==="light"&&n.includes("light"));return{addEventListener(){},addListener(){},dispatchEvent(){return!0},matches:s,media:n,onchange:null,removeEventListener(){},removeListener(){}}};Object.defineProperty(e.window,"matchMedia",{configurable:!0,value:o}),Object.defineProperty(e.window.navigator,"clipboard",{configurable:!0,value:{readText:async()=>G,writeText:async n=>{ze(String(n??""))}}}),Object.defineProperty(e.window.navigator,"geolocation",{configurable:!0,value:{getCurrentPosition:n=>{const s=t.settings.geo??{latitude:0,longitude:0};n({coords:{accuracy:1,latitude:s.latitude,longitude:s.longitude},timestamp:Date.now()})}}})}function we(e,t){const r=z("web",e.id);et(t,r),Object.defineProperty(t.window,"__elizaBrowserWorkspaceState",{value:r,writable:!0,configurable:!0});const o=t.window.console;if(!o.__elizaWrapped){for(const n of["log","info","warn","error"])o[n]=(...s)=>{r.consoleEntries.push({level:n,message:s.map(i=>E(i)).join(" "),timestamp:O()})};o.__elizaWrapped=!0}t.window.alert=n=>{r.dialog={defaultValue:null,message:String(n??""),open:!0,type:"alert"}},t.window.confirm=n=>(r.dialog={defaultValue:null,message:String(n??""),open:!0,type:"confirm"},!1),t.window.prompt=(n,s)=>(r.dialog={defaultValue:s??null,message:String(n??""),open:!0,type:"prompt"},null),Object.defineProperty(t.window,"fetch",{configurable:!0,value:async(n,s)=>{const i=typeof n=="string"?n:n instanceof URL?n.toString():typeof n.url=="string"?n.url:String(n);return xe(r,new URL(i,e.url).toString(),{...s,headers:s?.headers??(n.headers?n.headers:void 0),method:s?.method??(typeof n.method=="string"?n.method:void 0)},"fetch")}})}function bt(e){if(e.dom&&e.loadedUrl===e.url)return e.dom;throw new Error(`Browser workspace tab ${e.id} is not loaded yet. Reload or inspect the page first.`)}const Go=Object.freeze(Object.defineProperty({__proto__:null,applyBrowserWorkspaceDomSettings:et,createEmptyWebBrowserWorkspaceDom:sr,ensureBrowserWorkspaceDom:bt,findJsdomPackageJsonPath:on,getJSDOMClass:Pe,installBrowserWorkspaceWebRuntime:we},Symbol.toStringTag,{value:"Module"}));function h(e){const t=globalThis.CSS?.escape,r=typeof t=="function"?t(e.id):e.id.replace(/[^a-zA-Z0-9_-]/g,"\\$&");if(e.id)return`#${r}`;const o=e.getAttribute("data-testid")?.trim();if(o)return`[data-testid=${ve(o)}]`;const n=e.getAttribute("name")?.trim();if(n)return`${e.tagName.toLowerCase()}[name=${ve(n)}]`;const s=e.getAttribute("type")?.trim();if(s)return`${e.tagName.toLowerCase()}[type=${ve(s)}]`;const i=e.parentElement;if(!i)return e.tagName.toLowerCase();const u=i.children;let a=1;for(let c=0;c<u.length;c+=1){const l=u.item(c);if(!(!l||l.tagName!==e.tagName)){if(l===e)break;a+=1}}return`${e.tagName.toLowerCase()}:nth-of-type(${a})`}function sn(e){const t=e.tagName==="INPUT"||e.tagName==="TEXTAREA"||e.tagName==="SELECT",r=t?e.value??null:null;return{selector:h(e),tag:e.tagName.toLowerCase(),text:E(t?r:e.textContent),type:e.getAttribute("type"),name:e.getAttribute("name"),href:e.getAttribute("href"),value:typeof r=="string"?r:null}}function Tr(e){const t=Array.from(e.querySelectorAll("a, button, input, textarea, select, form, [role='button'], [data-testid]")),r=[],o=new Set;for(const n of t){const s=sn(n);if(!o.has(s.selector)&&(o.add(s.selector),r.push(s),r.length>=40))break}return r}function qo(e,t,r){if(!t||t.tagName!=="IFRAME")return null;const o=t,n=o.getAttribute("srcdoc");if(n?.trim()){const s=h(t),i=e.frameDoms.get(s);if(i)return i.window.document;if(o.contentDocument&&E(o.contentDocument.body?.textContent).length>0)return o.contentDocument;const u=new(Pe())(n,{pretendToBeVisual:!0,url:r});return e.frameDoms.set(s,u),u.window.document}return o.contentDocument?o.contentDocument:null}function an(e,t,r){const o=r,n=o.currentFrame?.trim()||null;if(!n)return{document:t.window.document,frameSelector:null};const s=re(t.window.document,n),i=qo(o,s,e.url);return i?{document:i,frameSelector:n}:{document:t.window.document,frameSelector:null}}function Ho(e){const t=e.id&&e.ownerDocument?Array.from(e.ownerDocument.querySelectorAll(`label[for="${e.id}"]`)).map(r=>r.textContent).join(" "):"";return[e.textContent,e.getAttribute("aria-label"),e.getAttribute("placeholder"),e.getAttribute("title"),e.getAttribute("name"),e.getAttribute("alt"),e.getAttribute("data-testid"),t,e.value].map(r=>E(r)).filter(Boolean)}function de(e,t,r=!1){const o=E(e).toLowerCase(),n=E(t).toLowerCase();return!o||!n?!1:r?o===n:o.includes(n)}function vt(e){if(e.hasAttribute("hidden")||e.getAttribute("aria-hidden")==="true")return!1;const t=e,r=t.style?.display?.trim().toLowerCase(),o=t.style?.visibility?.trim().toLowerCase();return!(r==="none"||o==="hidden")}function Vo(e,t,r=!1){const o=Array.from(e.querySelectorAll("label"));for(const n of o){if(!de(n.textContent??"",t,r))continue;const s=n.getAttribute("for")?.trim();if(s){const u=e.getElementById(s);if(u)return u}const i=n.querySelector("input, textarea, select, button");if(i)return i}return null}function Ko(e){const t=e.getAttribute("role")?.trim().toLowerCase();if(t)return t;const r=e.tagName.toLowerCase();if(r==="a"&&e.getAttribute("href"))return"link";if(r==="button")return"button";if(r==="select")return"combobox";if(r==="option")return"option";if(r==="textarea")return"textbox";if(r==="form")return"form";if(/^h[1-6]$/.test(r))return"heading";if(r==="input"){const n=(e.type||"text").toLowerCase();return n==="checkbox"?"checkbox":n==="radio"?"radio":["button","submit","reset","image"].includes(n)?"button":"textbox"}return null}function Jo(e,t,r,o=!1){const n=t.trim().toLowerCase();if(!n)return null;const s=Array.from(e.querySelectorAll("a, button, input, textarea, select, option, form, h1, h2, h3, h4, h5, h6, [role], [data-testid]"));for(const i of s){if(Ko(i)!==n)continue;if(!r?.trim()||Ho(i).some(a=>de(a,r,o)))return i}return null}function J(e){const t=e.trim(),r=t.match(/^has-text\((['"])([\s\S]*?)\1\)$/i);return r?.[2]?r[2].trim():t.startsWith('"')&&t.endsWith('"')||t.startsWith("'")&&t.endsWith("'")?t.slice(1,-1).trim():t}function cn(e){let t=e.trim();return t=t.replace(/^role\s*[:=]\s*([a-z0-9_-]+)\s+name\s*[:=]\s*(.+)$/i,"role=$1[name=$2]"),t=t.replace(/^((?:label|text|placeholder|alt|title|testid|data-testid)\s*[:=]\s*(?:has-text\((['"])[\s\S]*?\2\)|"[^"]+"|'[^']+'|[^>]+?))\s+((?:input|textarea|select)[\s\S]*)$/i,"$1 >> $3"),t}function Zo(e){const r=cn(e).match(/^([a-z-]+)\s*[:=]\s*(.+)$/i);if(!r)return null;const o=r[1]?.trim().toLowerCase(),n=r[2]?.trim()??"";if(!o||!n)return null;switch(o){case"alt":return{findBy:"alt",text:J(n)};case"css":return{selector:J(n)};case"data-testid":case"testid":return{findBy:"testid",text:J(n)};case"label":return{findBy:"label",text:J(n)};case"placeholder":return{findBy:"placeholder",text:J(n)};case"role":{const s=n.match(/^([a-z0-9_-]+)(?:\s*\[\s*name\s*[:=]\s*(.+?)\s*\])?$/i);return s?.[1]?{findBy:"role",name:s[2]?J(s[2]):void 0,role:s[1].trim().toLowerCase()}:null}case"text":return{findBy:"text",text:J(n)};case"title":return{findBy:"title",text:J(n)};default:return null}}function ln(e,t){const r=Zo(t);return r?{...e,...r,selector:r.selector}:null}function Lt(e,t){try{return e.querySelector(t)}catch{throw new Error(`Invalid selector ${t}`)}}function $t(e,t){try{return Array.from(e.querySelectorAll(t))}catch{throw new Error(`Invalid selector ${t}`)}}function un(e,t){const r=E(t).toLowerCase();if(!r)return null;const o=Array.from(e.querySelectorAll("a, button, input, textarea, select, option, label, h1, h2, h3, [role='button'], [data-testid]"));for(const n of o)if([n.textContent,n.getAttribute("aria-label"),n.getAttribute("placeholder"),n.getAttribute("title"),n.getAttribute("name"),n.value].map(i=>E(i)).filter(Boolean).map(i=>i.toLowerCase()).some(i=>i.includes(r)))return n;return null}function tt(e,t){switch(t.findBy){case"alt":return Array.from(e.querySelectorAll("[alt]")).find(r=>de(r.getAttribute("alt")??"",t.text??"",t.exact))??null;case"first":return t.selector?.trim()?Lt(e,t.selector):null;case"label":return t.text?.trim()?Vo(e,t.text,t.exact):null;case"last":return t.selector?.trim()?$t(e,t.selector).at(-1)??null:null;case"nth":return!t.selector?.trim()||typeof t.index!="number"||!Number.isInteger(t.index)?null:$t(e,t.selector).at(t.index)??null;case"placeholder":return Array.from(e.querySelectorAll("[placeholder]")).find(r=>de(r.getAttribute("placeholder")??"",t.text??"",t.exact))??null;case"role":return t.role?.trim()?Jo(e,t.role,t.name,t.exact):null;case"testid":return t.text?.trim()?e.querySelector(`[data-testid=${ve(t.text)}]`):null;case"text":return t.text?.trim()?un(e,t.text):null;case"title":return Array.from(e.querySelectorAll("[title]")).find(r=>de(r.getAttribute("title")??"",t.text??"",t.exact))??null;default:return null}}function re(e,t,r,o){const n=t?cn(t):void 0;if(n){const i=n.split(/\s*>>\s*/).map(a=>a.trim()).filter(Boolean);if(i.length>1){let a=re(e,i[0],void 0,o);for(let c=1;a&&c<i.length;c+=1){const l=i[c];l&&(typeof a.matches=="function"&&a.matches(l)||/^(input|textarea|select)(?:\[[^\]]+\])?$/i.test(l)&&(a.tagName==="INPUT"||a.tagName==="TEXTAREA"||a.tagName==="SELECT")||(a=Lt(a,l)))}return a}const u=ln(o,n);return u?tt(e,u):Lt(e,n)}if(o?.findBy)return tt(e,o);const s=r?.trim();return s?un(e,s):null}function Xo(e){const t=typeof e.getBoundingClientRect=="function"?e.getBoundingClientRect():{bottom:0,height:0,left:0,right:0,top:0,width:0,x:0,y:0};return{bottom:t.bottom,height:t.height,left:t.left,right:t.right,top:t.top,width:t.width,x:t.x,y:t.y}}function Yo(e){if(e.tagName==="INPUT"||e.tagName==="TEXTAREA"||e.tagName==="SELECT"){const t=e;if(e.tagName==="INPUT"){const r=t,o=r.type.trim().toLowerCase();if(o==="checkbox"||o==="radio")return r.checked}return t.value}return null}function Qo(e,t){const r=t.getComputedStyle(e);return{display:r.display||null,visibility:r.visibility||null,opacity:r.opacity||null}}function dn(e){return e?e.tagName==="FORM"?e:e.closest("form"):null}function ie(e,t){if(e.tagName==="INPUT"||e.tagName==="TEXTAREA"||e.tagName==="SELECT")return e;throw new Error(`Eliza browser workspace ${t} requires an input, textarea, or select target.`)}function We(e,t){if(e.tagName==="INPUT"){const r=e,o=r.type.trim().toLowerCase();if(o==="checkbox"||o==="radio")return r}throw new Error(`Eliza browser workspace ${t} requires a checkbox or radio input target.`)}function Ee(e,t){e.value=t,e.tagName==="TEXTAREA"&&(e.textContent=t),e.setAttribute("value",t)}async function At(e,t,r){const o=t.tagName.toLowerCase();if(o==="a"){const u=t.getAttribute("href")?.trim();if(!u)throw new Error("Target link does not have an href.");const a=new URL(u,e.url).toString();return H(e.id),e.url=me(a),e.title=X(e.url),e.dom=null,e.loadedUrl=null,rt(e,e.url),await Ce(e),{mode:"web",subaction:r,tab:q(e),value:{clickCount:r==="dblclick"?2:1,selector:h(t),url:e.url}}}const n=o==="input"?t:null,s=n?.type?.toLowerCase()??"";if(n&&(s==="checkbox"||s==="radio"))return n.checked=s==="radio"?!0:!n.checked,{mode:"web",subaction:r,value:{checked:n.checked,clickCount:r==="dblclick"?2:1,selector:h(t)}};const i=dn(t);return i&&(o==="form"||o==="button"||o==="input"&&["button","image","submit"].includes(s||"submit"))?(await fn(e,i),{mode:"web",subaction:r,tab:q(e),value:{clickCount:r==="dblclick"?2:1,selector:h(t),url:e.url}}):{mode:"web",subaction:r,value:{clickCount:r==="dblclick"?2:1,selector:h(t),text:E(t.textContent)}}}function pn(e,t,r,o){const n=Number.isFinite(o)?Math.max(1,Math.abs(o)):240,s=r==="left"||r==="right"?"x":"y",i=r==="up"||r==="left"?-n:n;if(t&&t instanceof e.window.HTMLElement)return s==="y"?(t.scrollTop=(t.scrollTop||0)+i,{axis:s,selector:h(t),value:t.scrollTop}):(t.scrollLeft=(t.scrollLeft||0)+i,{axis:s,selector:h(t),value:t.scrollLeft});const u=s==="y"?"__elizaScrollY":"__elizaScrollX",c=Number(Reflect.get(e.window,u)??0)+i;return Reflect.set(e.window,u,c),{axis:s,selector:null,value:c}}async function fn(e,t){const r=z("web",e.id),o=bt(e),n=t.getAttribute("action")?.trim()||e.url,s=(t.getAttribute("method")?.trim()||"get").toLowerCase(),i=new URL(n,e.url).toString(),u=new o.window.FormData(t),a=new URLSearchParams;for(const[B,x]of u.entries())a.append(B,String(x));if(s==="get"){const B=new URL(i);B.search=a.toString(),H(e.id),e.url=B.toString(),e.title=X(e.url),e.dom=null,e.loadedUrl=null,rt(e,e.url),await Ce(e);return}const c=await xe(r,i,{body:a.toString(),headers:{"Content-Type":"application/x-www-form-urlencoded; charset=utf-8"},method:s.toUpperCase()},"document");if(!c.ok)throw new Error(`Browser workspace form submit failed (${c.status}): ${i}`);const l=await c.text(),f=me(c.url?.trim()||i),b=new(Pe())(l,{pretendToBeVisual:!0,url:f});we(e,b),Kt(r),H(e.id),e.url=f,e.dom=b,e.loadedUrl=f,e.title=E(b.window.document.title)||X(f),e.updatedAt=O(),rt(e,f)}function H(e){le("web",e)}function q(e){return{id:e.id,title:e.title,url:e.url,partition:e.partition,kind:e.kind,visible:e.visible,createdAt:e.createdAt,updatedAt:e.updatedAt,lastFocusedAt:e.lastFocusedAt}}function rt(e,t){const r=e.history.slice(0,e.historyIndex+1);r.push(t),e.history=r,e.historyIndex=r.length-1}async function Ce(e){const t=z("web",e.id),{createEmptyWebBrowserWorkspaceDom:r}=await Z(async()=>{const{createEmptyWebBrowserWorkspaceDom:u}=await Promise.resolve().then(()=>Go);return{createEmptyWebBrowserWorkspaceDom:u}},void 0,import.meta.url);if(e.url==="about:blank"){e.dom=r(e.url),we(e,e.dom),e.loadedUrl=e.url,e.title="New Tab",e.updatedAt=O();return}const o=await xe(t,e.url,{},"document");if(!o.ok)throw new Error(`Browser workspace web load failed (${o.status}): ${e.url}`);const n=await o.text(),s=me(o.url?.trim()||e.url),i=new(Pe())(n,{pretendToBeVisual:!0,url:s});we(e,i),Kt(t),e.dom=i,e.loadedUrl=s,e.url=s,e.title=E(i.window.document.title)||X(s),e.updatedAt=O(),e.history[e.historyIndex]=s}async function Mt(e){return(!e.dom||e.loadedUrl!==e.url)&&await Ce(e),bt(e)}function es(e){return e.replaceAll("\\","\\\\").replaceAll("(","\\(").replaceAll(")","\\)")}function wn(e,t){const n=`BT
/F1 12 Tf
${[e.trim()||"Eliza Browser Workspace","",...t.split(/\r?\n/).map(c=>c.trim()).filter(Boolean).slice(0,32)].map((c,l)=>`${l===0?"50 750 Td":"0 -18 Td"} (${es(c)}) Tj`).join(`
`)}
ET`,s=["<< /Type /Catalog /Pages 2 0 R >>","<< /Type /Pages /Kids [3 0 R] /Count 1 >>","<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",`<< /Length ${Buffer.byteLength(n,"utf8")} >>
stream
${n}
endstream`,"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];let i=`%PDF-1.4
`;const u=[0];for(let c=0;c<s.length;c+=1)u.push(Buffer.byteLength(i,"utf8")),i+=`${c+1} 0 obj
${s[c]}
endobj
`;const a=Buffer.byteLength(i,"utf8");i+=`xref
0 ${s.length+1}
0000000000 65535 f 
`;for(let c=1;c<u.length;c+=1)i+=`${String(u[c]).padStart(10,"0")} 00000 n 
`;return i+=`trailer
<< /Size ${s.length+1} /Root 1 0 R >>
startxref
${a}
%%EOF`,Buffer.from(i,"utf8")}function xr(e,t,r,o){const n=o?.width??1280,s=o?.height??720,u=[e||"Eliza Browser Workspace",t,"",...r.split(/\r?\n/).map(c=>c.trim()).filter(Boolean).slice(0,18)].map(c=>c.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;")),a=`<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="${n}" height="${s}"><rect width="100%" height="100%" fill="#faf7f1"/><rect x="24" y="24" width="${n-48}" height="${s-48}" rx="18" fill="#ffffff" stroke="#d8d1c4"/><text x="48" y="72" font-family="Menlo, Monaco, monospace" font-size="20" fill="#111111">${u.map((c,l)=>`<tspan x="48" dy="${l===0?0:28}">${c}</tspan>`).join("")}</text></svg>`;return Buffer.from(a,"utf8").toString("base64")}function Ae(e,t,r){return{bodyText:E(r),title:E(e),url:E(t)}}function Ge(e){const t=E(e.body?.textContent),r=Array.from(e.querySelectorAll("input, textarea, select, option:checked")).map(o=>{const n=o.getAttribute("name")||o.getAttribute("id")||o.tagName.toLowerCase(),s=o.tagName==="SELECT"||"value"in o?o.value:o.textContent??"";return`${n}:${E(s)}`}).filter(Boolean).join(" ");return E(`${t} ${r}`)}function nt(e,t){return{changed:!e||e.bodyText!==t.bodyText||e.title!==t.title||e.url!==t.url,previous:e,current:t}}function Rt(e){const t={};for(let r=0;r<e.length;r+=1){const o=e.key(r);o&&(t[o]=e.getItem(o)??"")}return t}function Bt(e){const t=e.cookie||"";return t.trim()?Object.fromEntries(t.split(/;\s*/).map(r=>{const[o,...n]=r.split("=");return[o??"",n.join("=")]}).filter(r=>r[0].trim().length>0)):{}}function ts(e,t){const r=t.localStorage&&typeof t.localStorage=="object"?t.localStorage:{},o=t.sessionStorage&&typeof t.sessionStorage=="object"?t.sessionStorage:{},n=t.cookies&&typeof t.cookies=="object"?t.cookies:{};e.defaultView?.localStorage.clear();for(const[s,i]of Object.entries(r))e.defaultView?.localStorage.setItem(s,String(i??""));e.defaultView?.sessionStorage.clear();for(const[s,i]of Object.entries(o))e.defaultView?.sessionStorage.setItem(s,String(i??""));for(const[s,i]of Object.entries(n))e.cookie=`${s}=${String(i??"")}; path=/`}function mn(e){return k.tabs.findIndex(t=>t.id===e)}function Oe(e){const t=k.tabs.find(r=>r.id===e);if(!t)throw ft(e);return t}function rs(){return k.tabs.length===0?null:k.tabs.find(e=>e.visible)??[...k.tabs].sort((e,t)=>{const r=e.lastFocusedAt??e.updatedAt??"";return(t.lastFocusedAt??t.updatedAt??"").localeCompare(r)||e.id.localeCompare(t.id)})[0]??null}function ee(e){if(e.id?.trim())return e.id.trim();const t=rs();if(!t)throw Yt(e.subaction);return t.id}async function Y(e){return K(async()=>{if(!["clipboard","console","cookies","diff","dialog","drag","errors","eval","frame","highlight","mouse","network","pdf","screenshot","set","state","storage","trace","profiler","upload"].includes(e.subaction))return null;const t=ee(e),r=Oe(t),o=await Mt(r),n=z("web",t),i=an(r,o,n).document,u=()=>re(i,e.selector,e.text,e);switch(e.subaction){case"eval":throw e.script?.trim()?rr("eval"):new Error("Eliza browser workspace eval requires script.");case"screenshot":{const a=xr(r.title,r.url,Ge(i),n.settings.viewport??void 0);if(n.lastScreenshotData=a,e.filePath?.trim()||e.outputPath?.trim()){const c=e.filePath?.trim()||e.outputPath?.trim()||"";return await Q(c,Buffer.from(a,"base64")),{mode:"web",subaction:e.subaction,snapshot:{data:a},value:{path:L()}}}return{mode:"web",subaction:e.subaction,snapshot:{data:a}}}case"clipboard":{const a=e.clipboardAction??"read";if(a==="read")return{mode:"web",subaction:e.subaction,value:G};if(a==="write")return ze(e.value??e.text??""),{mode:"web",subaction:e.subaction,value:G};if(a==="copy"){const l=u();return ze(l&&"value"in l?String(l.value??""):E(l?.textContent??i.body?.textContent)),{mode:"web",subaction:e.subaction,value:G}}const c=u()??i.activeElement;if(c&&(c.tagName==="INPUT"||c.tagName==="TEXTAREA"||c.tagName==="SELECT")){const l=ie(c,"clipboard");return Ee(l,`${l.value??""}${G}`),{mode:"web",subaction:e.subaction,value:{selector:h(l),value:l.value}}}return{mode:"web",subaction:e.subaction,value:G}}case"mouse":{const a=e.mouseAction??"move";if(a==="move")n.mouse.x=e.x??n.mouse.x,n.mouse.y=e.y??n.mouse.y;else if(a==="down"){const c=e.button??"left";n.mouse.buttons=Array.from(new Set([...n.mouse.buttons,c]))}else if(a==="up"){const c=e.button??"left";n.mouse.buttons=n.mouse.buttons.filter(l=>l!==c)}else return{mode:"web",subaction:e.subaction,value:pn(o,u(),(e.deltaY??0)<0?"up":"down",Math.abs(e.deltaY??e.pixels??240))};return{mode:"web",subaction:e.subaction,value:n.mouse}}case"drag":{const a=u(),c=e.value?re(i,e.value):null;if(!a||!c)throw new Error("Eliza browser workspace drag requires source selector and target selector in value.");return a.setAttribute("data-eliza-dragging","true"),c.setAttribute("data-eliza-drop-target","true"),{mode:"web",subaction:e.subaction,value:{source:h(a),target:h(c)}}}case"upload":{const a=u();if(!a||a.tagName!=="INPUT")throw new Error("Eliza browser workspace upload requires a file input target.");const c=(e.files??[]).map(l=>to());return a.setAttribute("data-eliza-uploaded-files",c.join(",")),{mode:"web",subaction:e.subaction,value:{files:c,selector:h(a)}}}case"set":{const a=e.setAction??"viewport";return(a==="credentials"||a==="headers")&&te(r.partition,`set:${a}`),a==="viewport"?n.settings.viewport={height:Math.max(1,Math.round(e.height??720)),scale:Math.max(1,Number(e.scale??1)),width:Math.max(1,Math.round(e.width??1280))}:a==="device"?n.settings.device=e.device??null:a==="geo"?n.settings.geo=typeof e.latitude=="number"&&typeof e.longitude=="number"?{latitude:e.latitude,longitude:e.longitude}:null:a==="offline"?n.settings.offline=!!e.offline:a==="headers"?n.settings.headers=Br(e.headers):a==="credentials"?n.settings.credentials=e.username||e.password?{password:e.password??"",username:e.username??""}:null:a==="media"&&(n.settings.media=e.media??null),et(o,n),{mode:"web",subaction:e.subaction,value:n.settings}}case"cookies":{te(r.partition,"cookies");const a=e.cookieAction??"get";if(a==="clear"){for(const c of Object.keys(Bt(i)))i.cookie=`${c}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;return{mode:"web",subaction:e.subaction,value:{cleared:!0}}}if(a==="set"){const c=e.name?.trim()||e.entryKey?.trim();if(!c)throw new Error("Eliza browser workspace cookies set requires name.");i.cookie=`${c}=${e.value??""}; path=/`}return{mode:"web",subaction:e.subaction,value:Bt(i)}}case"storage":{te(r.partition,"storage");const a=e.storageArea==="session"?o.window.sessionStorage:o.window.localStorage,c=e.storageAction??"get";if(c==="clear")return a.clear(),{mode:"web",subaction:e.subaction,value:{cleared:!0}};if(c==="set"){const l=e.entryKey?.trim()||e.name?.trim();if(!l)throw new Error("Eliza browser workspace storage set requires entryKey.");a.setItem(l,e.value??"")}if(e.entryKey?.trim()||e.name?.trim()){const l=e.entryKey?.trim()||e.name?.trim()||"";return{mode:"web",subaction:e.subaction,value:a.getItem(l)}}return{mode:"web",subaction:e.subaction,value:Rt(a)}}case"network":{const a=e.networkAction??"requests";if(a==="route"){const l=e.url?.trim();if(!l)throw new Error("Eliza browser workspace network route requires url pattern.");return n.networkRoutes.push({abort:!!e.offline,body:e.responseBody??null,headers:Br(e.responseHeaders),pattern:l,status:typeof e.responseStatus=="number"?e.responseStatus:null}),{mode:"web",subaction:e.subaction,value:n.networkRoutes}}if(a==="unroute")return n.networkRoutes=e.url?.trim()?n.networkRoutes.filter(l=>l.pattern!==e.url?.trim()):[],{mode:"web",subaction:e.subaction,value:n.networkRoutes};if(a==="request"){const l=n.networkRequests.find(f=>f.id===e.requestId);return{mode:"web",subaction:e.subaction,value:l??null}}if(a==="harstart")return n.networkHar={active:!0,entries:[],startedAt:O()},{mode:"web",subaction:e.subaction,value:n.networkHar};if(a==="harstop"){n.networkHar.active=!1;const l={log:{entries:n.networkHar.entries,startedAt:n.networkHar.startedAt}};if(e.filePath?.trim()||e.outputPath?.trim()){const f=e.filePath?.trim()||e.outputPath?.trim()||"";return await Q(f,JSON.stringify(l,null,2)),{mode:"web",subaction:e.subaction,value:{path:L(),...l}}}return{mode:"web",subaction:e.subaction,value:l}}let c=[...n.networkRequests];if(e.filter?.trim()&&(c=c.filter(l=>l.url.includes(e.filter??""))),e.method?.trim()&&(c=c.filter(l=>l.method.toUpperCase()===e.method?.trim().toUpperCase())),e.status?.trim()){const l=e.status.trim();c=c.filter(f=>f.status===null?!1:/^\dxx$/i.test(l)?String(f.status).startsWith(l[0]??""):String(f.status)===l)}return{mode:"web",subaction:e.subaction,value:c}}case"dialog":{const a=e.dialogAction??"status";if(a==="status")return{mode:"web",subaction:e.subaction,value:n.dialog};n.dialog&&(n.dialog.open=!1);const c=a==="accept"?{accepted:!0,dialog:n.dialog,promptText:e.promptText??e.value??null}:{accepted:!1,dialog:n.dialog};return n.dialog=null,{mode:"web",subaction:e.subaction,value:c}}case"console":return e.consoleAction==="clear"&&(n.consoleEntries=[]),{mode:"web",subaction:e.subaction,value:n.consoleEntries};case"errors":return e.consoleAction==="clear"&&(n.errors=[]),{mode:"web",subaction:e.subaction,value:n.errors};case"highlight":{const a=u();if(!a)throw new Error("Target element was not found.");return a.setAttribute("data-eliza-highlight","true"),n.highlightedSelector=h(a),{mode:"web",subaction:e.subaction,value:{selector:n.highlightedSelector}}}case"frame":{if((e.frameAction??"select")==="main")return n.currentFrame=null,{mode:"web",subaction:e.subaction,value:{frame:null}};const c=re(o.window.document,e.selector);if(!c||c.tagName!=="IFRAME")throw new Error("Eliza browser workspace frame select requires an iframe selector.");return n.currentFrame=h(c),{mode:"web",subaction:e.subaction,value:{frame:n.currentFrame}}}case"diff":{const a=Ae(r.title,r.url,Ge(i));if(e.diffAction==="url"){const f=e.url?.trim()||r.url,b=e.secondaryUrl?.trim();if(!b)throw new Error("Eliza browser workspace diff url requires secondaryUrl.");const B=await xe(n,f,{},"document"),x=await xe(n,b,{},"document"),U=Ae(f,B.url||f,await B.text()),v=Ae(b,x.url||b,await x.text());return{mode:"web",subaction:e.subaction,value:nt(U,v)}}if(e.diffAction==="screenshot"){const f=n.lastScreenshotData??xr(r.title,r.url,Ge(i),n.settings.viewport??void 0),b=e.baselinePath?.trim()?await ue(L(e.baselinePath.trim())):n.lastScreenshotData;return n.lastScreenshotData=f,{mode:"web",subaction:e.subaction,value:{baselineLength:b?.length??0,changed:b!==f,currentLength:f.length}}}const c=e.baselinePath?.trim()?JSON.parse(await ue(L(e.baselinePath.trim()))):n.lastSnapshot,l=nt(c,a);return n.lastSnapshot=a,{mode:"web",subaction:e.subaction,value:l}}case"trace":{if(e.traceAction==="stop"){n.trace.active=!1;const a={entries:n.trace.entries};if(e.filePath?.trim()||e.outputPath?.trim()){const c=e.filePath?.trim()||e.outputPath?.trim()||"";return await Q(c,JSON.stringify(a,null,2)),{mode:"web",subaction:e.subaction,value:{path:L(),...a}}}return{mode:"web",subaction:e.subaction,value:a}}return n.trace={active:!0,entries:[]},n.trace.entries.push({command:"trace:start",timestamp:O()}),{mode:"web",subaction:e.subaction,value:{active:!0}}}case"profiler":{if(e.profilerAction==="stop"){n.profiler.active=!1;const a={entries:n.profiler.entries};if(e.filePath?.trim()||e.outputPath?.trim()){const c=e.filePath?.trim()||e.outputPath?.trim()||"";return await Q(c,JSON.stringify(a,null,2)),{mode:"web",subaction:e.subaction,value:{path:L(),...a}}}return{mode:"web",subaction:e.subaction,value:a}}return n.profiler={active:!0,entries:[{command:"profiler:start",timestamp:O()}]},{mode:"web",subaction:e.subaction,value:{active:!0}}}case"state":{if(te(r.partition,"state"),e.stateAction==="load"){if(!(e.filePath?.trim()||e.outputPath?.trim()))throw new Error("Eliza browser workspace state load requires filePath.");const f=JSON.parse(await ue());return ts(i,f),f.settings&&typeof f.settings=="object"&&(n.settings={...n.settings,...f.settings},et(o,n)),ze(typeof f.clipboard=="string"?f.clipboard:G),{mode:"web",subaction:e.subaction,value:{loaded:!0}}}const a={clipboard:G,cookies:Bt(i),localStorage:Rt(o.window.localStorage),sessionStorage:Rt(o.window.sessionStorage),settings:n.settings,url:r.url},c=e.filePath?.trim()||e.outputPath?.trim();return c?(await Q(c,JSON.stringify(a,null,2)),{mode:"web",subaction:e.subaction,value:{path:L(),...a}}):{mode:"web",subaction:e.subaction,value:a}}case"pdf":{if(!(e.filePath?.trim()||e.outputPath?.trim()))throw new Error("Eliza browser workspace pdf requires filePath.");const c=wn(r.title,E(i.body?.textContent)),l=await Q();return{mode:"web",subaction:e.subaction,value:{path:l,size:c.byteLength}}}default:return null}})}async function ns(e){return K(async()=>{const t=ee(e);e=er(e,"web",t);const r=Oe(t),o=await Mt(r),n=z("web",t),i=an(r,o,n).document,u=()=>re(i,e.selector,e.text,e);switch(e.subaction){case"inspect":return H(r.id),{mode:"web",subaction:e.subaction,elements:Wt("web",r.id,Tr(i)),value:{title:r.title,url:r.url}};case"snapshot":return H(r.id),{mode:"web",subaction:e.subaction,elements:Wt("web",r.id,Tr(i)),value:{bodyText:Ge(i).slice(0,800),title:r.title,url:r.url}};case"get":{if(e.getMode==="title")return{mode:"web",subaction:e.subaction,value:r.title};if(e.getMode==="url")return{mode:"web",subaction:e.subaction,value:r.url};if(e.getMode==="count"){if(!e.selector?.trim())throw new Error("Eliza browser workspace get count requires selector.");const l=ln(e,e.selector);return{mode:"web",subaction:e.subaction,value:l?+!!tt(i,l):$t(i,e.selector).length}}const a=u();if(!a)throw new Error("Target element was not found.");let c;switch(e.getMode){case"attr":if(!e.attribute?.trim())throw new Error("Eliza browser workspace attr lookups require attribute.");c=a.getAttribute(e.attribute);break;case"box":c=Xo(a);break;case"checked":c=a.tagName==="INPUT"?!!a.checked:a.tagName==="OPTION"?!!a.selected:!1;break;case"enabled":c="disabled"in a?!a.disabled:!0;break;case"html":c=a.innerHTML;break;case"styles":c=Qo(a,o.window);break;case"value":c=Yo(a);break;case"visible":c=vt(a);break;default:c=E(a.textContent);break}return{mode:"web",subaction:e.subaction,value:c}}case"find":{const a=u();if(!a)throw new Error("Target element was not found.");switch(e.action){case"check":{const c=We(a,"check");return c.checked=!0,{mode:"web",subaction:e.subaction,value:{checked:c.checked,selector:h(c)}}}case"click":return{...await At(r,a,"click"),subaction:e.subaction};case"fill":{const c=ie(a,"fill");return Ee(c,e.value??""),{mode:"web",subaction:e.subaction,value:{selector:h(c),value:c.value}}}case"focus":return typeof a.focus=="function"&&a.focus(),{mode:"web",subaction:e.subaction,value:{focused:i.activeElement===a,selector:h(a)}};case"hover":return a.setAttribute("data-eliza-hover","true"),{mode:"web",subaction:e.subaction,value:{hovered:!0,selector:h(a)}};case"type":{const c=ie(a,"type");return Ee(c,`${c.value??""}${e.value??""}`),{mode:"web",subaction:e.subaction,value:{selector:h(c),value:c.value}}}case"uncheck":{const c=We(a,"uncheck");return c.checked=!1,{mode:"web",subaction:e.subaction,value:{checked:c.checked,selector:h(c)}}}case"text":case void 0:return{mode:"web",subaction:e.subaction,value:{element:sn(a),text:E(a.textContent)}};default:throw new Error(`Unsupported browser workspace find action: ${e.action}`)}}case"check":{const a=u();if(!a)throw new Error("Target element was not found.");const c=We(a,"check");return c.checked=!0,{mode:"web",subaction:e.subaction,value:{checked:c.checked,selector:h(c)}}}case"fill":case"type":{const a=u();if(!a)throw new Error("Target element was not found.");const c=ie(a,e.subaction),l=e.subaction==="type"?`${c.value??""}${e.value??""}`:e.value??"";return Ee(c,l),{mode:"web",subaction:e.subaction,value:{selector:h(c),value:l}}}case"focus":{const a=u();if(!a)throw new Error("Target element was not found.");return typeof a.focus=="function"&&a.focus(),{mode:"web",subaction:e.subaction,value:{focused:i.activeElement===a,selector:h(a)}}}case"hover":{const a=u();if(!a)throw new Error("Target element was not found.");return a.setAttribute("data-eliza-hover","true"),{mode:"web",subaction:e.subaction,value:{hovered:!0,selector:h(a)}}}case"keyboardinserttext":case"keyboardtype":{const a=i.activeElement;if(!a||!(a.tagName==="INPUT"||a.tagName==="TEXTAREA"||a.tagName==="SELECT"))throw new Error("Eliza browser workspace keyboard text input requires a focused input target.");const c=ie(a,e.subaction==="keyboardtype"?"type":"keyboardinserttext"),l=e.subaction==="keyboardtype"?`${c.value??""}${e.value??""}`:e.value??"";return Ee(c,l),{mode:"web",subaction:e.subaction,value:{selector:h(c),value:c.value}}}case"keydown":case"keyup":return{mode:"web",subaction:e.subaction,value:{key:e.key?.trim()||"Enter",selector:i.activeElement&&i.activeElement instanceof Element?h(i.activeElement):null}};case"click":{const a=u();if(!a)throw new Error("Target element was not found.");return At(r,a,"click")}case"dblclick":{const a=u();if(!a)throw new Error("Target element was not found.");return At(r,a,"dblclick")}case"press":{const a=e.key?.trim()||"Enter",c=u(),l=dn(c);return a==="Enter"&&l?(await fn(r,l),{mode:"web",subaction:e.subaction,tab:q(r),value:{key:a,url:r.url}}):{mode:"web",subaction:e.subaction,value:{key:a}}}case"scroll":return{mode:"web",subaction:e.subaction,value:pn(o,u(),e.direction??"down",e.pixels??240)};case"scrollinto":{const a=u();if(!a)throw new Error("Target element was not found.");return typeof a.focus=="function"&&a.focus(),{mode:"web",subaction:e.subaction,value:{scrolled:!0,selector:h(a)}}}case"select":{const a=u();if(!a)throw new Error("Target element was not found.");if(a.tagName!=="SELECT")throw new Error("Eliza browser workspace select requires a select target.");const c=ie(a,"select"),l=Array.from(c.options).find(f=>f.value===(e.value??"")||de(f.textContent??"",e.value??"",!0));if(!l)throw new Error("Select option was not found.");return c.value=l.value,l.selected=!0,{mode:"web",subaction:e.subaction,value:{selector:h(c),value:c.value}}}case"uncheck":{const a=u();if(!a)throw new Error("Target element was not found.");const c=We(a,"uncheck");return c.checked=!1,{mode:"web",subaction:e.subaction,value:{checked:c.checked,selector:h(c)}}}case"wait":{if(nn(e.script,"wait"),!e.selector&&!e.findBy&&!e.text&&!e.url&&!e.script&&typeof e.timeoutMs=="number"&&Number.isFinite(e.timeoutMs)){const l=Math.max(0,e.timeoutMs);return await Qe(l),{mode:"web",subaction:e.subaction,value:{waitedMs:l}}}const a=typeof e.timeoutMs=="number"&&Number.isFinite(e.timeoutMs)?Math.max(100,e.timeoutMs):dt,c=Date.now()+a;for(;Date.now()<=c;){await Mt(r);const f=bt(r).window.document,b=e.selector?.trim()?(()=>{const v=re(f,e.selector,void 0,e);return e.state==="hidden"?!v||!vt(v):v?vt(v):!1})():!1,B=e.findBy?(()=>{const v=tt(f,e);return e.state==="hidden"?!v:!!v})():!1,x=e.text?.trim()?E(f.body?.textContent).includes(e.text.trim()):!1,U=e.url?.trim()?r.url.includes(e.url.trim()):!1;if(b||B||x||U||!e.selector&&!e.findBy&&!e.text&&!e.url)return{mode:"web",subaction:e.subaction,value:{findBy:e.findBy??null,selector:e.selector??null,state:e.state??null,text:e.text??null,url:r.url}};await Qe(Qr)}throw new Error("Timed out waiting for browser workspace condition.")}default:throw new Error(`Unsupported web browser workspace subaction: ${e.subaction}`)}})}var D={};const Tt="persist:eliza-browser-agent",os=new Set(["auth_pending","needs_reauth","manual_handoff"]);function _(e=D){return y(e)?"desktop":"web"}function bn(e,t){return pt(e,t)}function Cr(e,t){switch(e){case"unknown":case"ready":case"auth_pending":case"needs_reauth":case"manual_handoff":return e;default:return t}}function gn(e){return os.has(e)}function ss(e){return{kind:e.kind,handleId:e.handleId,partition:e.partition,tabId:e.tabId,browser:e.browser,companionId:e.companionId,profileId:e.profileId,profileLabel:e.profileLabel}}function hn(e){const t=ss(e.ref);return{provider:e.provider,accountId:e.accountId,authState:e.authState,requiresManualHandoff:gn(e.authState),sessionRef:t,partition:t.partition,tabId:t.tabId,companionId:t.companionId,browser:t.browser,profileId:t.profileId,profileLabel:t.profileLabel,created:e.created,message:e.message??null}}function as(e){const t=e.companion.browser?.trim()||null,r=e.companion.companionId?.trim()||null,o=e.companion.profileId?.trim()||null,n=e.companion.profileLabel?.trim()||null;return hn({provider:e.provider,accountId:e.accountId,authState:e.authState,created:!1,message:e.message,ref:{kind:"browser-bridge-companion",handleId:["browser-bridge",t??"browser",r??o??"profile",e.provider,e.accountId].join(":"),partition:null,tabId:null,browser:t,companionId:r,profileId:o,profileLabel:n}})}async function is(e,t,r){const o=await C(e,t),s=(await $(t)).find(i=>i.id===o)??null;te(s?.partition,r)}async function cs(e,t=D){const r=e.provider.trim(),o=e.accountId.trim();if(!r)throw new Error("Eliza browser connector session requires provider.");if(!o)throw new Error("Eliza browser connector session requires accountId.");const n=e.companion??null;if(n?.profileId||n?.companionId){const b=Cr(e.authState,"manual_handoff");return as({provider:r,accountId:o,companion:n,authState:b,message:e.manualHandoffReason??"Use the paired browser companion profile to finish login, MFA, or CAPTCHA if required."})}if(y(t))return(await M("/sessions/acquire",{method:"POST",body:JSON.stringify({accountId:o,authState:e.authState,manualHandoffReason:e.manualHandoffReason,provider:r,reuse:e.reuse,show:e.show,title:e.title,url:e.url})},t)).session;const s=bn(r,o);let c=(e.reuse!==!1?await $(t):[]).find(b=>b.partition===s)??null,l=!1;c?e.show===!0&&(c=await Ie(c.id,t)):(c=await pe({kind:"internal",partition:s,show:e.show??!0,title:e.title,url:e.url},t),l=!0);const f=Cr(e.authState,l?"auth_pending":"ready");return hn({provider:r,accountId:o,authState:f,created:l,message:e.manualHandoffReason??(gn(f)?"Manual login, MFA, or CAPTCHA may be required in this isolated connector browser session.":null),ref:{kind:"internal-browser",handleId:`internal-browser:${s}`,partition:s,tabId:c.id,browser:null,companionId:null,profileId:null,profileLabel:null}})}async function yn(e=D){return{mode:_(e),tabs:await $(e)}}async function $(e=D){if(!y(e))return k.tabs.map(r=>({id:r.id,title:r.title,url:r.url,partition:r.partition,kind:r.kind,visible:r.visible,createdAt:r.createdAt,updatedAt:r.updatedAt,lastFocusedAt:r.lastFocusedAt}));const t=await M("/tabs",void 0,e);return Array.isArray(t.tabs)?t.tabs:[]}async function pe(e,t=D){return y(t)?(await M("/tabs",{method:"POST",body:JSON.stringify(e)},t)).tab:K(()=>{const o=e.kind==="internal"?"internal":"standard",n=O(),s=me(e.url?.trim()||"about:blank"),i=e.show===!0,u=`btab_${k.nextId++}`,a=s==="about:blank"?sr(s):null,c={id:u,title:e.title?.trim()||X(s),url:s,partition:e.partition?.trim()||en,kind:o,visible:i,createdAt:n,updatedAt:n,lastFocusedAt:i?n:null,dom:a,history:[s],historyIndex:0,loadedUrl:s==="about:blank"?s:null};return a&&we(c,a),z("web",c.id),H(c.id),c.visible&&(k.tabs=k.tabs.map(l=>({...l,visible:!1}))),k.tabs=[...k.tabs,c],q(c)})}async function ar(e,t=D){const r=me(e.url);if(!y(t))return K(()=>{const s=mn(e.id);if(s<0)throw ft(e.id);const i=k.tabs[s],u=O(),a=z("web",i.id);H(i.id),rt(i,r);const c=r==="about:blank"?sr(r):null,l={...i,title:X(r),url:r,updatedAt:u,dom:c,loadedUrl:r==="about:blank"?r:null};return c&&we(l,c),Kt(a),k.tabs[s]=l,q(l)});const o={url:r};return e.partition!==void 0&&(o.partition=e.partition),(await M(`/tabs/${encodeURIComponent(e.id)}/navigate`,{method:"POST",body:JSON.stringify(o)},t)).tab}async function Ie(e,t=D){return y(t)?(await M(`/tabs/${encodeURIComponent(e)}/show`,{method:"POST"},t)).tab:K(()=>{Oe(e);const o=O();return k.tabs=k.tabs.map(n=>({...n,visible:n.id===e,lastFocusedAt:n.id===e?o:n.lastFocusedAt,updatedAt:n.id===e?o:n.updatedAt})),q(Oe(e))})}async function ir(e,t=D){return y(t)?(await M(`/tabs/${encodeURIComponent(e)}/hide`,{method:"POST"},t)).tab:K(()=>{const o=mn(e);if(o<0)throw ft(e);const n=O(),s={...k.tabs[o],visible:!1,updatedAt:n};return k.tabs[o]=s,q(s)})}async function ot(e,t=D){return y(t)?(await M(`/tabs/${encodeURIComponent(e)}`,{method:"DELETE"},t)).closed===!0:K(()=>{const o=k.tabs.length;return H(e),Jr("web",e),k.tabs=k.tabs.filter(n=>n.id!==e),k.tabs.length!==o})}async function gt(e,t=D){return ge(e,t)}async function st(e,t=D){return No(e,t)}async function ht(e,t=D){switch(e=Qt(e),e.subaction){case"batch":{const r=Array.isArray(e.steps)?e.steps:[];if(r.length===0)throw new Error("Eliza browser workspace batch requires at least one step.");const o=[];for(const n of r)o.push(await ht(n,t));return{mode:_(t),subaction:e.subaction,steps:o,value:o.at(-1)?.value}}case"list":return{mode:_(t),subaction:e.subaction,tabs:await $(t)};case"open":{const r=await pe({partition:Fe(e,Tt),show:e.show,title:e.title,url:e.url},t);return le(_(t),r.id),{mode:_(t),subaction:e.subaction,tab:r}}case"navigate":{const r=y(t)?await C(e,t):ee(e);return le(_(t),r),{mode:_(t),subaction:e.subaction,tab:await ar({id:r,url:e.url??""},t)}}case"show":{const r=y(t)?await C(e,t):ee(e);return{mode:_(t),subaction:e.subaction,tab:await Ie(r,t)}}case"hide":{const r=y(t)?await C(e,t):ee(e);return{mode:_(t),subaction:e.subaction,tab:await ir(r,t)}}case"close":{const r=y(t)?await C(e,t):ee(e);return le(_(t),r),Jr(_(t),r),{mode:_(t),subaction:e.subaction,closed:await ot(r,t)}}case"eval":{if(!y(t))return await Y(e);wt(e.script,"eval","desktop",t);const r=await C(e,t);return{mode:"desktop",subaction:e.subaction,value:await gt({id:r,script:e.script??""},t)}}case"screenshot":{if(!y(t))return await Y(e);const r=await C(e,t);return{mode:"desktop",subaction:e.subaction,snapshot:await st(r,t)}}case"clipboard":case"console":case"cookies":case"dialog":case"drag":case"errors":case"frame":case"highlight":case"mouse":case"network":case"set":case"storage":case"upload":return y(t)?Mo(e,t):await Y(e);case"diff":{if(!y(t))return await Y(e);const r=await C(e,t),o=z("desktop",r),n=await Ar(e,t);if(e.diffAction==="screenshot"){const a=(await st(r,t)).data,c=e.baselinePath?.trim()?await ue(L(e.baselinePath.trim())):o.lastScreenshotData;return o.lastScreenshotData=a,{mode:"desktop",subaction:e.subaction,value:{baselineLength:c?.length??0,changed:c!==a,currentLength:a.length}}}if(e.diffAction==="url"){const u=e.url?.trim()||n.url,a=e.secondaryUrl?.trim();if(!a)throw new Error("Eliza browser workspace diff url requires secondaryUrl.");const c=await Xe(u),l=await Xe(a);return{mode:"desktop",subaction:e.subaction,value:nt(Ae(u,c.url||u,await c.text()),Ae(a,l.url||a,await l.text()))}}const s=e.baselinePath?.trim()?JSON.parse(await ue(L(e.baselinePath.trim()))):o.lastSnapshot,i=nt(s,n);return o.lastSnapshot=n,{mode:"desktop",subaction:e.subaction,value:i}}case"trace":case"profiler":{if(!y(t))return await Y(e);const r=await C(e,t),o=z("desktop",r),n=e.subaction==="trace"?o.trace:o.profiler;if(e.subaction==="trace"?e.traceAction==="stop":e.profilerAction==="stop"){n.active=!1;const i={entries:n.entries},u=e.filePath?.trim()||e.outputPath?.trim();if(u){const{writeBrowserWorkspaceFile:a}=await Z(async()=>{const{writeBrowserWorkspaceFile:c}=await Promise.resolve().then(()=>St);return{writeBrowserWorkspaceFile:c}},void 0,import.meta.url);return await a(u,JSON.stringify(i,null,2)),{mode:"desktop",subaction:e.subaction,value:{path:L(),...i}}}return{mode:"desktop",subaction:e.subaction,value:i}}return n.active=!0,n.entries=[{command:`${e.subaction}:start`,timestamp:O()}],{mode:"desktop",subaction:e.subaction,value:{active:!0}}}case"state":{if(!y(t))return await Y(e);if(await is(e,t,"state"),e.stateAction==="load"){if(!(e.filePath?.trim()||e.outputPath?.trim()))throw new Error("Eliza browser workspace state load requires filePath.");const s=JSON.parse(await ue());return await Uo(e,s,t),{mode:"desktop",subaction:e.subaction,value:{loaded:!0}}}const r=await Do(e,t),o=e.filePath?.trim()||e.outputPath?.trim();if(o){const{writeBrowserWorkspaceFile:n}=await Z(async()=>{const{writeBrowserWorkspaceFile:s}=await Promise.resolve().then(()=>St);return{writeBrowserWorkspaceFile:s}},void 0,import.meta.url);return await n(o,JSON.stringify(r,null,2)),{mode:"desktop",subaction:e.subaction,value:{path:L(),...r}}}return{mode:"desktop",subaction:e.subaction,value:r}}case"pdf":{if(!y(t))return await Y(e);const r=e.filePath?.trim()||e.outputPath?.trim();if(!r)throw new Error("Eliza browser workspace pdf requires filePath.");const o=await Ar(e,t),n=wn(o.title,o.bodyText),{writeBrowserWorkspaceFile:s}=await Z(async()=>{const{writeBrowserWorkspaceFile:u}=await Promise.resolve().then(()=>St);return{writeBrowserWorkspaceFile:u}},void 0,import.meta.url),i=await s(r,n);return{mode:"desktop",subaction:e.subaction,value:{path:i,size:n.byteLength}}}case"tab":{const r=e.tabAction??"list";if(r==="list")return{mode:_(t),subaction:e.subaction,tabs:await $(t)};if(r==="new")return{mode:_(t),subaction:e.subaction,tab:await pe({partition:Fe(e,Tt),show:e.show??!0,title:e.title,url:e.url,width:e.width,height:e.height},t)};if(r==="switch"){const n=await $(t),s=e.id?.trim()?n.find(i=>i.id===e.id?.trim()):typeof e.index=="number"?n[e.index]??null:null;if(!s)throw new Error("Eliza browser workspace tab switch requires a valid id or index.");return{mode:_(t),subaction:e.subaction,tab:await Ie(s.id,t)}}const o=e.id?.trim()||(await $(t))[e.index??-1]?.id;if(!o)throw new Error("Eliza browser workspace tab close requires a valid id or index.");return{mode:_(t),subaction:e.subaction,closed:await ot(o,t)}}case"window":return{mode:_(t),subaction:e.subaction,tab:await pe({partition:Fe(e,Tt),show:!0,title:e.title,url:e.url,width:e.width,height:e.height},t)};case"back":case"forward":case"reload":{if(y(t)){const r=await C(e,t);return le("desktop",r),Rr(e,t)}return K(async()=>{const r=ee(e),o=Oe(r);if(e.subaction==="reload")return H(o.id),o.dom=null,o.loadedUrl=null,await Ce(o),{mode:"web",subaction:e.subaction,tab:q(o),value:{url:o.url,title:o.title}};const n=e.subaction==="back"?-1:1,s=o.historyIndex+n;return s<0||s>=o.history.length?{mode:"web",subaction:e.subaction,tab:q(o),value:{url:o.url,title:o.title,changed:!1}}:(o.historyIndex=s,o.url=o.history[s]??o.url,o.title=X(o.url),H(o.id),o.dom=null,o.loadedUrl=null,await Ce(o),{mode:"web",subaction:e.subaction,tab:q(o),value:{url:o.url,title:o.title,changed:!0}})})}case"inspect":case"snapshot":case"check":case"click":case"dblclick":case"find":case"fill":case"focus":case"get":case"hover":case"keydown":case"keyup":case"keyboardinserttext":case"keyboardtype":case"press":case"scroll":case"scrollinto":case"select":case"type":case"uncheck":case"wait":case"realistic-click":case"realistic-fill":case"realistic-type":case"realistic-press":case"realistic-upload":case"cursor-move":case"cursor-hide":if(e.subaction==="wait"&&!e.selector&&!e.findBy&&!e.text&&!e.url&&!e.script&&typeof e.timeoutMs=="number"&&Number.isFinite(e.timeoutMs)){const r=Math.max(0,e.timeoutMs);return await Qe(r),{mode:_(t),subaction:e.subaction,value:{waitedMs:r}}}return y(t)?Rr(e,t):ns(e);default:{const r=e.subaction;throw new Error(`Unsupported browser workspace subaction: ${r}`)}}}const ls=Object.freeze(Object.defineProperty({__proto__:null,BROWSER_WORKSPACE_CONNECTOR_AUTH_STATES:Bo,__resetBrowserWorkspaceStateForTests:Oo,acquireBrowserWorkspaceConnectorSession:cs,closeBrowserWorkspaceTab:ot,evaluateBrowserWorkspaceTab:gt,executeBrowserWorkspaceCommand:ht,getBrowserWorkspaceMode:_,getBrowserWorkspaceSnapshot:yn,getBrowserWorkspaceUnavailableMessage:mt,hideBrowserWorkspaceTab:ir,isBrowserWorkspaceBridgeConfigured:y,listBrowserWorkspaceTabs:$,navigateBrowserWorkspaceTab:ar,openBrowserWorkspaceTab:pe,resolveBrowserWorkspaceBridgeConfig:or,resolveBrowserWorkspaceConnectorPartition:bn,showBrowserWorkspaceTab:Ie,snapshotBrowserWorkspaceTab:st},Symbol.toStringTag,{value:"Module"}));var us={};function ds(e){const t=e?.content;return typeof t=="string"?t:typeof t?.text=="string"?t.text:""}function kn(e){return e.match(/https?:\/\/[^\s<>"'`]+/i)?.[0]??null}function ps(e,t){const r=cr(e?.action);if(r==="autofill-login"||e?.subaction==="autofill-login")return"autofill-login";const o=fs(r);if(o)return o;if(e?.subaction)return e.subaction;if(e?.tabAction)return"tab";const n=e?.watchMode===!0;return e?.selector&&e?.text?n?"realistic-fill":"type":e?.selector?n?"realistic-click":"click":e?.url?.trim()||kn(t)?e?.id?"navigate":"open":"state"}function cr(e){switch(e){case"realistic_click":return"realistic-click";case"realistic_fill":return"realistic-fill";case"realistic_type":return"realistic-type";case"realistic_press":return"realistic-press";case"cursor_move":return"cursor-move";case"cursor_hide":return"cursor-hide";case"autofill_login":return"autofill-login";default:return e}}function fs(e){const t=cr(e);switch(t){case"info":case"context":case"get_context":return"state";case"list_tabs":case"open_tab":case"close_tab":case"switch_tab":return"tab";case"autofill-login":return;case void 0:return;default:return ws(t)?t:void 0}}function ws(e){return e==="back"||e==="click"||e==="close"||e==="forward"||e==="get"||e==="hide"||e==="navigate"||e==="open"||e==="press"||e==="reload"||e==="screenshot"||e==="show"||e==="snapshot"||e==="state"||e==="tab"||e==="type"||e==="wait"||e==="realistic-click"||e==="realistic-fill"||e==="realistic-type"||e==="realistic-press"||e==="cursor-move"||e==="cursor-hide"}function ms(e){switch(cr(e)){case"list_tabs":return"list";case"open_tab":return"new";case"close_tab":return"close";case"switch_tab":return"switch";default:return}}function bs(e,t){if(t.tabs){const r=t.tabs.map(o=>`- ${o.title} (${o.url})`).join(`
`);return r?`Browser tabs (${t.mode}):
${r}`:`No browser session tabs are open (${t.mode}).`}if(t.closed)return`Browser closed (${t.mode}).`;if(t.tab)return`${e.subaction} completed in ${t.mode} mode.
${t.tab.title}
${t.tab.url}`;if(t.value!==void 0){if(e.subaction==="cursor-move"&&t.value!==null&&typeof t.value=="object"&&"x"in t.value&&"y"in t.value){const o=t.value;return`Cursor moved to (${Math.round(o.x)}, ${Math.round(o.y)}) in ${t.mode} mode.`}const r=typeof t.value=="string"?t.value:JSON.stringify(t.value,null,2);return`Browser ${e.subaction} result (${t.mode}):
${r}`}return t.snapshot?.data?`Browser ${e.subaction} captured a preview in ${t.mode} mode.`:`Browser ${e.subaction} completed in ${t.mode} mode.`}const En={name:"BROWSER",contexts:["browser","web","automation","secrets"],roleGate:{minRole:"OWNER"},similes:["BROWSE_SITE","BROWSER_SESSION","CONTROL_BROWSER","CONTROL_BROWSER_SESSION","MANAGE_ELIZA_BROWSER_WORKSPACE","NAVIGATE_SITE","OPEN_SITE","USE_BROWSER","BROWSER_ACTION","BROWSER_AUTOFILL_LOGIN","AGENT_AUTOFILL","AUTOFILL_BROWSER_LOGIN","AUTOFILL_LOGIN","FILL_BROWSER_CREDENTIALS","LOG_INTO_SITE","SIGN_IN_TO_SITE"],description:"BROWSER action. Control registered browser target: app workspace, bridge Chrome/Safari companion, computeruse Chromium, or Stagehand fallback. BrowserService picks target if omitted. action=autofill_login + domain vault-gated autofills open workspace tab.",descriptionCompressed:"Browser open|navigate|click|type|screenshot|state|autofill_login; bridge status elsewhere",validate:async()=>!0,handler:async(e,t,r,o)=>{const n=o?.parameters,s=ds(t),i=ps(n,s);if(i==="autofill-login"){const{executeBrowserAutofillLogin:l}=await Z(async()=>{const{executeBrowserAutofillLogin:f}=await Promise.resolve().then(()=>xs);return{executeBrowserAutofillLogin:f}},void 0,import.meta.url);return l(e,t,o)}const u=n?.url?.trim()||kn(s)||void 0,a={id:n?.id?.trim(),key:n?.key?.trim(),pixels:n?.pixels,script:n?.script,selector:n?.selector?.trim(),subaction:i,tabAction:n?.tabAction??ms(n?.action),text:n?.text,value:n?.text,timeoutMs:n?.timeoutMs,url:u,cursorDurationMs:n?.cursorDurationMs,perCharDelayMs:n?.perCharDelayMs,replace:n?.replace,x:n?.x,y:n?.y},c=e.getService(Vt);try{g.info(`[BROWSER] ${a.subaction} via target=${n?.target??"auto"} (workspace mode=${_(us)})`);const l=c?await c.execute(a,n?.target):await ht(a);return{text:bs(a,l),success:!0,values:{success:!0,mode:l.mode,subaction:l.subaction},data:{actionName:"BROWSER",command:a,result:l}}}catch(l){const f=l instanceof Error?l.message:"Browser action failed";return g.warn(`[BROWSER] Failed: ${f}`),{text:`Browser action failed: ${f}`,success:!1,values:{success:!1,error:"BROWSER_FAILED"},data:{actionName:"BROWSER",command:a}}}},parameters:[{name:"target",description:"Optional browser target id. Common values: workspace, bridge, computeruse, stagehand.",required:!1,schema:{type:"string"}},{name:"action",description:"Browser action. Snake_case canonical; legacy kebab-case and subaction accepted.",required:!1,schema:{type:"string",enum:["back","click","close","context","forward","get","get_context","hide","info","list_tabs","navigate","open","open_tab","press","reload","screenshot","show","snapshot","state","tab","type","wait","close_tab","switch_tab","realistic_click","realistic_fill","realistic_type","realistic_press","cursor_move","cursor_hide","autofill_login"]}},{name:"tabAction",description:"Tab operation when subaction is tab",required:!1,schema:{type:"string",enum:["close","list","new","switch"]}},{name:"domain",description:"Required for action=autofill_login: registrable hostname, e.g. github.com.",required:!1,schema:{type:"string"}},{name:"username",description:"For autofill-login: saved login username; omit for latest.",required:!1,schema:{type:"string"}},{name:"submit",description:"For autofill-login: submit after filling. Default false.",required:!1,schema:{type:"boolean"}},{name:"id",description:"Session or tab id to target",required:!1,schema:{type:"string"}},{name:"url",description:"URL for open or navigate",required:!1,schema:{type:"string"}},{name:"selector",description:"Selector for click, type, or wait",required:!1,schema:{type:"string"}},{name:"text",description:"Text for type",required:!1,schema:{type:"string"}},{name:"key",description:"Keyboard key for press",required:!1,schema:{type:"string"}},{name:"pixels",description:"Scroll distance in pixels",required:!1,schema:{type:"number"}},{name:"timeoutMs",description:"Command timeout in milliseconds",required:!1,schema:{type:"number"}},{name:"script",description:"Script for eval",required:!1,schema:{type:"string"}},{name:"watchMode",description:"User watching hint; prefer realistic-* click/fill, visible cursor, pointer events.",required:!1,schema:{type:"boolean"}},{name:"cursorDurationMs",description:"Cursor animation duration (ms) for realistic-* subactions",required:!1,schema:{type:"number"}},{name:"perCharDelayMs",description:"Per-character delay for realistic-type/realistic-fill (ms)",required:!1,schema:{type:"number"}},{name:"replace",description:"For realistic-fill: replace existing input, not append.",required:!1,schema:{type:"boolean"}},{name:"x",description:"Cursor target X (CSS pixels) for cursor-move",required:!1,schema:{type:"number"}},{name:"y",description:"Cursor target Y (CSS pixels) for cursor-move",required:!1,schema:{type:"number"}}],examples:[[{name:"{{name1}}",content:{text:"Open elizaos.ai in a new browser tab."}},{name:"{{agentName}}",content:{text:`open completed in desktop mode.
elizaOS
https://elizaos.ai`}}],[{name:"{{name1}}",content:{text:"Click the sign-in button on that page."}},{name:"{{agentName}}",content:{text:"click completed in desktop mode."}}]]},Sn=async()=>null,gs=async()=>!1,hs={getSecret:Sn,setSecret:async()=>{},deleteSecret:async()=>{},listSecrets:async()=>[]},ys=()=>({vault:hs}),ks=gs,Or=Sn,Es=async()=>[];var Ss={};const A="autofill-login",_s=100,vs=240;let Ir=null;function As(){return Ir??=ys().vault,Ir}function Rs(e,t){if(!e)return!1;let r;try{r=new URL(e).hostname}catch{return!1}return r.toLowerCase()===t.toLowerCase()}function Bs(e){return`
(() => {
  const USERNAME = ${JSON.stringify(e.username)};
  const PASSWORD = ${JSON.stringify(e.password)};
  const SUBMIT = ${e.submit?"true":"false"};

  function setNativeInputValue(input, value) {
    const proto = Object.getPrototypeOf(input);
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && typeof desc.set === "function") {
      desc.set.call(input, value);
    } else {
      input.value = value;
    }
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function findPrecedingTextInput(passwordInput) {
    const root = passwordInput.form || document.body;
    const candidates = root.querySelectorAll(
      'input[type="text"], input[type="email"], input:not([type])'
    );
    let lastBefore = null;
    for (const el of candidates) {
      if (el.compareDocumentPosition(passwordInput) & Node.DOCUMENT_POSITION_FOLLOWING) {
        lastBefore = el;
      }
    }
    return lastBefore;
  }

  const password = document.querySelector('input[type="password"]');
  if (!password) {
    return { ok: false, reason: "no_password_input" };
  }
  const form = password.form;
  const username =
    (form && form.querySelector(
      'input[type="email"], input[name*="user" i], input[name*="email" i], input[name*="login" i]'
    )) || findPrecedingTextInput(password);

  if (username) setNativeInputValue(username, USERNAME);
  setNativeInputValue(password, PASSWORD);

  if (SUBMIT) {
    if (form && typeof form.requestSubmit === "function") {
      form.requestSubmit();
    } else if (form && typeof form.submit === "function") {
      form.submit();
    } else {
      const button =
        (form && form.querySelector('button[type="submit"], input[type="submit"]')) ||
        document.querySelector('button[type="submit"], input[type="submit"]');
      if (button) (button).click();
    }
  }

  return {
    ok: true,
    filled: { username: !!username, password: true },
    submitted: SUBMIT,
  };
})();
`}function Ts(e){if(!e||typeof e!="object")return{filled:!1,fillReason:null};const t=e,r="filled"in t&&!!t.filled;let o=null;const n="reason"in t?t.reason:void 0;return typeof n=="string"&&(o=n.slice(0,vs)),{filled:r,fillReason:o}}async function _n(e,t,r){const o=r?.parameters,n=o?.domain?.trim().toLowerCase()??"",s=o?.username?.trim(),i=o?.submit===!0;if(!n)return{text:`BROWSER requires subaction "${A}" and a \`domain\` parameter.`,success:!1,values:{success:!1,error:"BROWSER_AUTOFILL_BAD_PARAMS",subaction:A},data:{actionName:"BROWSER",subaction:A}};if(!y(Ss))return{text:`BROWSER ${A} requires the desktop browser workspace bridge.`,success:!1,values:{success:!1,error:"BROWSER_BRIDGE_UNAVAILABLE",subaction:A},data:{actionName:"BROWSER",subaction:A}};const u=As();if(!await ks()){const v=`User has not pre-authorized agent autofill for ${n}. Toggle "Allow agent to autofill" for this domain under Settings -> Vault -> Logins.`;return{text:v,success:!1,values:{success:!1,error:"AGENT_AUTOFILL_NOT_AUTHORIZED",domain:n,subaction:A},data:{actionName:"BROWSER",subaction:A,domain:n,reason:v}}}let c=null;if(s){if(c=await Or(),!c)return{text:`No saved login for ${s} on ${n}.`,success:!1,values:{success:!1,error:"AGENT_AUTOFILL_NO_LOGIN",domain:n,username:s,subaction:A},data:{actionName:"BROWSER",subaction:A}}}else{const v=await Es();if(v.length===0)return{text:`No saved logins for ${n}.`,success:!1,values:{success:!1,error:"AGENT_AUTOFILL_NO_LOGIN",domain:n,subaction:A},data:{actionName:"BROWSER",subaction:A}};const w=[...v].sort((S,P)=>P.lastModified-S.lastModified)[0];if(!w)return{text:`No saved logins for ${n}.`,success:!1,values:{success:!1,error:"AGENT_AUTOFILL_NO_LOGIN",domain:n,subaction:A},data:{actionName:"BROWSER",subaction:A}};if(c=await Or(u,n,w.username),!c)return{text:`Saved login ${w.username} on ${n} disappeared between list and reveal.`,success:!1,values:{success:!1,error:"AGENT_AUTOFILL_RACE",domain:n,subaction:A},data:{actionName:"BROWSER",subaction:A}}}const f=(await $()).slice(0,_s).find(v=>Rs(v.url,n));if(!f)return{text:`No open browser tab on ${n}. Open one with BROWSER (open/navigate) first.`,success:!1,values:{success:!1,error:"AGENT_AUTOFILL_NO_TAB",domain:n,subaction:A},data:{actionName:"BROWSER",subaction:A}};const b=Bs({username:c.username,password:c.password,submit:i}),B=await gt({id:f.id,script:b}),{filled:x,fillReason:U}=Ts(B);return g.info(`[browser-autofill-login] domain=${n} tabId=${f.id} submit=${i} filled=${x}`),{text:i?`Filled and submitted login on ${n} (tab ${f.id}).`:`Filled login on ${n} (tab ${f.id}). User must click submit.`,success:!0,values:{success:!0,domain:n,tabId:f.id,submitted:i,filled:x,subaction:A,...U?{fillReason:U}:{}},data:{actionName:"BROWSER",subaction:A,domain:n,tabId:f.id,filled:x,...U?{fillReason:U}:{}}}}const xs=Object.freeze(Object.defineProperty({__proto__:null,executeBrowserAutofillLogin:_n},Symbol.toStringTag,{value:"Module"}));var lr={};const vn=m.dirname(Vr()),An=m.resolve(vn,"../../../"),Cs=m.resolve(An,"../");function Rn(e){return[...new Set(e.map(t=>m.resolve(t)))]}function Pr(e){const t=[];let r=m.resolve(e);for(;;){t.push(r);const o=m.dirname(r);if(o===r)return t;r=o}}const ur=Rn([process.cwd(),Cs,An,...Pr(vn),...Pr(process.cwd())]),Bn=ur.flatMap(e=>[m.join(e,"packages","browser-bridge-extension"),m.join(e,"eliza","packages","browser-bridge-extension"),m.join(e,"eliza","apps","browser-bridge"),m.join(e,"apps","browser-bridge"),m.join(e,"apps","app-lifeops","extensions","lifeops-browser"),m.join(e,"eliza","apps","app-lifeops","extensions","lifeops-browser"),m.join(e,"apps","extensions","lifeops-browser"),m.join(e,"eliza","apps","extensions","lifeops-browser")]),Tn=ur.flatMap(e=>[m.join(e,"package.json"),m.join(e,"eliza","package.json")]),xn=Rn(Bn.map(e=>m.join(e,"package.json"))),Os=ur.flatMap(e=>[m.join(e,"dist","build-info.json"),m.join(e,"eliza","dist","build-info.json")]),Is=Date.UTC(2020,0,1),Ps="elizaos/eliza";function ce(e){return T.existsSync(e)?e:null}function Ns(e){for(const t of e){const r=ce(t);if(r)return r}return null}function xt(e){if(!T.existsSync(e))return null;const t=JSON.parse(T.readFileSync(e,"utf8"));return typeof t.version=="string"&&t.version.trim()?t.version.trim():null}function Cn(e){if(typeof e=="string"){const t=e.trim().replace(/^git\+/,"");if(!t)return null;const r=t.match(/^([^/\s]+)\/([^/\s]+)$/);if(r)return`${r[1]}/${r[2]}`;const o=t.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/i);return o?`${o[1]}/${o[2]}`:null}return e&&typeof e=="object"&&!Array.isArray(e)?Cn(e.url):null}function Nr(e){if(!T.existsSync(e))return null;const t=JSON.parse(T.readFileSync(e,"utf8"));return Cn(t.repository)}function Ws(){for(const e of xn){const t=xt(e);if(t)return t}for(const e of Tn){const t=xt(e);if(t)return t}for(const e of Os){const t=xt(e);if(t)return t}return"0.0.0"}function Ls(e=lr){const t=typeof e.GITHUB_REPOSITORY=="string"&&e.GITHUB_REPOSITORY.trim()?e.GITHUB_REPOSITORY.trim():null;if(t)return t;for(const r of xn){const o=Nr(r);if(o)return o}for(const r of Tn){const o=Nr(r);if(o)return o}return Ps}function $s(e){const t=e.trim();return t?t.startsWith("v")?t.slice(1):t:null}function Ms(e){const t=$s(e);if(!t)return null;const r=t.match(/^(\d+)\.(\d+)\.(\d+)(?:-(beta|rc|nightly)\.([0-9A-Za-z.-]+))?$/);if(!r)return null;const o=r[1],n=r[2],s=r[3];if(!o||!n||!s)return null;const i=Number.parseInt(o,10),u=Number.parseInt(n,10),a=Number.parseInt(s,10),c=r[4]??null,l=r[5]??null;return{raw:t,tag:`v${t}`,major:i,minor:u,patch:a,prereleaseLabel:c,prereleaseValue:l,baseVersion:`${i}.${u}.${a}`,hasPrerelease:c!==null}}function qe(e,t,r){return Math.min(r,Math.max(t,e))}function On(e){if(!e)return 0;const t=Number.parseInt(e,10);return Number.isFinite(t)?t:0}function Ds(e){if(typeof e=="string"&&/^\d{8}$/.test(e)){const o=Number.parseInt(e.slice(0,4),10),n=Number.parseInt(e.slice(4,6),10),s=Number.parseInt(e.slice(6,8),10),i=Date.UTC(o,n-1,s);if(Number.isFinite(i))return qe(Math.floor((i-Is)/864e5)+1,1,9999)}const t=On(e);if(t>0)return qe(t,1,9999);let r=0;for(const o of String(e??""))r=(r*33+o.charCodeAt(0))%9999;return qe(r,1,9999)}function In(e){return!e.hasPrerelease||!e.prereleaseLabel?0:e.prereleaseLabel==="nightly"?Ds(e.prereleaseValue):qe(On(e.prereleaseValue),0,9999)}function Us(e){let t=6e4;if(e.hasPrerelease&&e.prereleaseLabel){const r=In(e);t=e.prereleaseLabel==="rc"?5e4+r:e.prereleaseLabel==="beta"?4e4+r:1e4+r}return[e.major,e.minor,e.patch,t].join(".")}function zs(e){const t=In(e),r=!e.hasPrerelease||!e.prereleaseLabel?9e3:e.prereleaseLabel==="rc"?8e3+t:e.prereleaseLabel==="beta"?7e3+t:5e3+t;return{marketingVersion:e.baseVersion,buildVersion:String(e.major*1e8+e.minor*1e6+e.patch*1e4+r)}}function Wr(e,t,r){return`${e}-${r.tag}.${t.replace(/^\./,"")}`}function js(e,t){return`https://github.com/${e}/releases/tag/${t.tag}`}function Le(e,t,r){return`https://github.com/${e}/releases/download/${t.tag}/${r}`}function Fs(e=lr){const t=typeof e.ELIZA_BROWSER_BRIDGE_CHROME_STORE_URL=="string"&&e.ELIZA_BROWSER_BRIDGE_CHROME_STORE_URL.trim()?e.ELIZA_BROWSER_BRIDGE_CHROME_STORE_URL.trim():null,r=typeof e.ELIZA_BROWSER_BRIDGE_SAFARI_STORE_URL=="string"&&e.ELIZA_BROWSER_BRIDGE_SAFARI_STORE_URL.trim()?e.ELIZA_BROWSER_BRIDGE_SAFARI_STORE_URL.trim():null;return{chromeWebStoreUrl:t,safariAppStoreUrl:r}}function Gs(e,t=lr){const r=Ms(e);if(!r)return null;const o=Ls(t),n=Fs(t),s=Wr("browser-bridge-chrome","zip",r),i=Wr("browser-bridge-safari","zip",r),u=zs(r);return{schema:"browser_bridge_release_v2",releaseTag:r.tag,releaseVersion:r.raw,repository:o,releasePageUrl:js(o,r),chromeVersion:Us(r),chromeVersionName:r.raw,safariMarketingVersion:u.marketingVersion,safariBuildVersion:u.buildVersion,chrome:{installKind:n.chromeWebStoreUrl?"chrome_web_store":"github_release",installUrl:n.chromeWebStoreUrl??Le(o,r,s),storeListingUrl:n.chromeWebStoreUrl,asset:{fileName:s,downloadUrl:Le(o,r,s)}},safari:{installKind:n.safariAppStoreUrl?"apple_app_store":"github_release",installUrl:n.safariAppStoreUrl??Le(o,r,i),storeListingUrl:n.safariAppStoreUrl,asset:{fileName:i,downloadUrl:Le(o,r,i)}},generatedAt:new Date().toISOString()}}function qs(e){const t=m.join(e,"browser-bridge-release-manifest.json");if(!T.existsSync(t))return null;try{return JSON.parse(T.readFileSync(t,"utf8"))}catch{return null}}function Lr(e,t){if(e){const r=qs(e);if(r)return r}return t?.allowSynthesis?Gs(t.version??Ws(),t.env):null}function Hs(){return Ns(Bn)}function Vs(e){return e==="safari"?"package-safari.mjs":"package-chrome.mjs"}function ne(e,t,r){return new Promise((o,n)=>{const s=It();let i="";s.stderr.on("data",u=>{i+=String(u)}),s.on("error",n),s.on("exit",u=>{if(u===0){o();return}n(new Error(i.trim()||`${e} ${t.join(" ")} exited with code ${u??"unknown"}`))})})}function Pn(){return Hs()}function Ks(e,t){switch(t){case"extension_root":return e.extensionPath;case"chrome_build":return e.chromeBuildPath;case"chrome_package":return e.chromePackagePath;case"safari_web_extension":return e.safariWebExtensionPath;case"safari_app":return e.safariAppPath;case"safari_package":return e.safariPackagePath;default:return null}}async function Js(e,t){const r=t&&T.existsSync(e)&&T.statSync(e).isDirectory()?e:m.dirname(e);switch(process.platform){case"darwin":await ne("open",t?["-R",e]:[e]);return;case"win32":await ne(t?"explorer.exe":"cmd",t?[`/select,${e}`]:["/c","start","",e]);return;case"linux":await ne("xdg-open",[t?r:e]);return;default:throw new Error(`Opening local paths is not supported on ${process.platform}`)}}async function Zs(){switch(process.platform){case"darwin":await ne("open",["-a","Google Chrome","chrome://extensions/"]);return;case"win32":await ne("cmd",["/c","start","","chrome","chrome://extensions/"]);return;case"linux":await ne("xdg-open",["chrome://extensions/"]);return;default:throw new Error(`Opening the Chrome extensions manager is not supported on ${process.platform}`)}}function he(){const e=Pn();if(!e)return{extensionPath:null,chromeBuildPath:null,chromePackagePath:null,safariWebExtensionPath:null,safariAppPath:null,safariPackagePath:null,releaseManifest:Lr(null,{allowSynthesis:!0})};const t=m.join(e,"dist"),r=m.join(t,"artifacts");return{extensionPath:e,chromeBuildPath:ce(m.join(t,"chrome")),chromePackagePath:ce(m.join(r,"browser-bridge-chrome.zip")),safariWebExtensionPath:ce(m.join(t,"safari")),safariAppPath:ce(m.join(r,"Agent Browser Bridge.app")),safariPackagePath:ce(m.join(r,"browser-bridge-safari.zip")),releaseManifest:Lr(r,{allowSynthesis:!0})}}function Xs(e){const t=he(),r=e==="safari"?t.safariPackagePath:t.chromePackagePath;if(!r)throw new Error(`${e==="safari"?"Safari":"Chrome"} package has not been built yet`);return{path:r,filename:m.basename(r),contentType:"application/zip"}}async function dr(e,t){const r=t?.revealOnly??!1,o=he(),n=Ks(o,e);if(!n)throw new Error(`Browser Bridge path is not available for ${e}`);return await Js(n,r),{target:e,path:n,revealOnly:r}}async function pr(e){if(e!=="chrome")throw new Error("Only Chrome exposes a local extensions manager for unpacked install");return await Zs(),{browser:e}}async function Nn(e){const t=Pn();if(!t)throw new Error("Browser Bridge extension workspace is not available");return await ne("bun",[m.join(t,"scripts",Vs(e))]),he()}const V="MANAGE_BROWSER_BRIDGE",yt=3e3,Ys=3e4,fr=["install","reveal_folder","open_manager","refresh"],Qs=["browser","browsers","browser bridge","agent browser bridge","bridge","extension","extensions","companion","companions","connection","pair","paired","pairing","chrome","safari","firefox","brave","edge","arc","opera","vivaldi","install","installer","installed","uninstall","reveal","show folder","open folder","open manager","manager","refresh","reload","reconnect","connect","disconnect","status","settings","setting","configuration","config","folder","load unpacked","chrome://extensions","navegador","navegadores","extensión","extensiones","instalar","instalador","desinstalar","carpeta","actualizar","conectar","conexión","puente","navigateur","navigateurs","installer","désinstaller","dossier","actualiser","rafraîchir","connexion","pont","browser","erweiterung","erweiterungen","installieren","deinstallieren","ordner","aktualisieren","verbindung","brücke","navigatore","estensione","estensioni","installare","disinstallare","cartella","aggiornare","collegamento","ponte","navegador","extensão","extensões","instalar","pasta","atualizar","conexão","ponte","браузер","расширение","установить","обновить","папка","соединение","мост","ブラウザ","拡張機能","インストール","フォルダ","更新","接続","ブリッジ","浏览器","瀏覽器","扩展","擴充","安装","安裝","文件夹","資料夾","刷新","重新整理","连接","連線","桥","橋","브라우저","확장","설치","폴더","새로고침","연결","브리지","متصفح","إضافة","تثبيت","مجلد","تحديث","اتصال","جسر","ब्राउज़र","एक्सटेंशन","इंस्टॉल","फ़ोल्डर","रिफ्रेश","कनेक्शन","tarayıcı","uzantı","yükle","klasör","yenile","bağlantı","köprü","trình duyệt","tiện ích","cài đặt","thư mục","làm mới","kết nối","cầu nối","เบราว์เซอร์","ส่วนขยาย","ติดตั้ง","โฟลเดอร์","รีเฟรช","เชื่อมต่อ","przeglądarka","rozszerzenie","zainstaluj","folder","odśwież","połączenie","most","browser","extensie","installeer","map","vernieuw","verbinding","brug","peramban","penjelajah","ekstensi","pasang","folder","muat ulang","koneksi","jembatan","דפדפן","הרחבה","התקנה","תיקייה","רענון","חיבור"];function Wn(e){return e instanceof Error?e.message:String(e)}function Re(e,t){return Promise.race([e,new Promise((r,o)=>setTimeout(()=>o(new Error(`${t} timed out`)),Ys))])}const ea=["browser","files","connectors","settings","automation","admin"];function ta(e){const t=new Set,r=n=>{if(Array.isArray(n))for(const s of n)typeof s=="string"&&t.add(s)};r(e?.values?.selectedContexts),r(e?.data?.selectedContexts);const o=e?.data?.contextObject;return r(o?.trajectoryPrefix?.selectedContexts),r(o?.metadata?.selectedContexts),ea.some(n=>t.has(n))}function ra(e,t){const r=[typeof e.content?.text=="string"?e.content.text:"",typeof t?.values?.recentMessages=="string"?t.values.recentMessages:""].join(`
`).toLowerCase();return Qs.some(o=>r.includes(o.toLowerCase()))}function $r(e){if(!e)return null;const t=e.trim().toLowerCase().replace(/[\s-]+/g,"_");return fr.includes(t)?t:null}function na(e){const t=e.toLowerCase();return/\b(reveal|show|open).{0,12}(folder|build folder|directory)\b/.test(t)&&!/\bextension manager\b/.test(t)?"reveal_folder":/\bopen.{0,8}(extensions?|extension manager|chrome:\/\/extensions)\b/.test(t)?"open_manager":/\b(refresh|reload|reconnect|status|settings?|config(?:uration)?|update|sync|update status|connection state)\b/.test(t)?"refresh":"install"}async function oa(){let e=he();e.chromeBuildPath||(e=await Re(Nn("chrome"),"browser bridge package build"));const t=await Re(dr("chrome_build",{revealOnly:!0}),"browser bridge reveal");let r=!0;try{await Re(pr("chrome"),"browser bridge manager open")}catch(n){r=!1,g.warn(`[${V}] could not open chrome://extensions: ${Wn(n)}`)}return{text:(r?`Chrome is ready. Click Load unpacked and choose ${t.path}.`:`The Agent Browser Bridge folder is ready at ${t.path}. Open chrome://extensions, click Load unpacked, and choose that folder.`).slice(0,yt),success:!0,values:{success:!0,subaction:"install",openedManager:r},data:{actionName:V,subaction:"install",path:t.path,openedManager:r,status:e}}}async function sa(){const e=await Re(dr("chrome_build",{revealOnly:!0}),"browser bridge reveal");return{text:`Revealed the Agent Browser Bridge folder at ${e.path}.`.slice(0,yt),success:!0,values:{success:!0,subaction:"reveal_folder"},data:{actionName:V,subaction:"reveal_folder",path:e.path}}}async function aa(){return await Re(pr("chrome"),"browser bridge manager open"),{text:"Opened Chrome extensions. Click Load unpacked and choose the Agent Browser Bridge folder.".slice(0,yt),success:!0,values:{success:!0,subaction:"open_manager"},data:{actionName:V,subaction:"open_manager"}}}async function ia(e){const t=he();let r=null,o=[];const n=e.getService(Ht);if(!n)return{text:"Agent Browser Bridge package status is available, but companion status cannot be read because the Browser Bridge service is not registered.",success:!1,values:{success:!1,subaction:"refresh",error:"BROWSER_BRIDGE_SERVICE_UNAVAILABLE"},data:{actionName:V,subaction:"refresh",status:t,settings:r,companions:o}};r=await n.getBrowserSettings(),o=(await n.listBrowserCompanions()).slice(0,25);const s=o.length>0;return{text:["Refreshed Agent Browser Bridge settings.",`Tracking: ${r.trackingMode}.`,`Browser control: ${r.allowBrowserControl?"on":"off"}.`,s?`Companions: ${o.length} paired.`:"Companions: none paired."].join(" "),success:!0,values:{success:!0,subaction:"refresh",connected:s,trackingMode:r.trackingMode,allowBrowserControl:r.allowBrowserControl,companionCount:o.length},data:{actionName:V,subaction:"refresh",status:t,settings:r,companions:o}}}const Ln={name:V,contexts:["browser","files","connectors","settings"],contextGate:{anyOf:["browser","files","connectors","settings"]},roleGate:{minRole:"OWNER"},similes:["INSTALL_BROWSER_BRIDGE","SETUP_BROWSER_BRIDGE","PAIR_BROWSER","CONNECT_BROWSER","ADD_BROWSER_EXTENSION","REVEAL_BROWSER_BRIDGE_FOLDER","OPEN_BROWSER_BRIDGE_FOLDER","SHOW_BROWSER_EXTENSION_FOLDER","OPEN_CHROME_EXTENSIONS","OPEN_BROWSER_BRIDGE_MANAGER","OPEN_EXTENSION_MANAGER","REFRESH_BROWSER_BRIDGE","REFRESH_BROWSER_BRIDGE_CONNECTION","RELOAD_BROWSER_BRIDGE_STATUS","RECONNECT_BROWSER","MANAGE_CHROME_EXTENSION","MANAGE_SAFARI_EXTENSION","BROWSER_BRIDGE_INSTALL","BROWSER_BRIDGE_REVEAL_FOLDER","BROWSER_BRIDGE_OPEN_MANAGER","BROWSER_BRIDGE_REFRESH"],description:"Owner-only Agent Browser Bridge management for Chrome/Safari. Actions: refresh status/settings/connection, install build+reveal setup, reveal_folder open build folder, open_manager chrome://extensions only on explicit ask. Infer action if omitted.",descriptionCompressed:"Browser Bridge: refresh|install|reveal_folder|open_manager chrome://extensions",validate:async(e,t,r)=>ta(r)||ra(t,r),handler:async(e,t,r,o)=>{const n=o?.parameters,s=$r(n?.action)??$r(n?.subaction)??na(typeof t.content?.text=="string"?t.content.text:"");try{switch(s){case"install":return await oa();case"reveal_folder":return await sa();case"open_manager":return await aa();case"refresh":return await ia(e);default:{const i=s;throw new Error(`Unsupported MANAGE_BROWSER_BRIDGE subaction: ${i}`)}}}catch(i){const u=`Failed MANAGE_BROWSER_BRIDGE ${s}: ${Wn(i)}`.slice(0,yt);return g.warn(`[${V}] ${u}`),{text:u,success:!1,values:{success:!1,subaction:s,error:`MANAGE_BROWSER_BRIDGE_${s.toUpperCase()}_FAILED`},data:{actionName:V,subaction:s}}}},parameters:[{name:"action",description:"Bridge action. refresh=status/settings; open_manager only explicit chrome://extensions; install setup; reveal_folder build folder. Infer if omitted.",required:!1,schema:{type:"string",enum:[...fr]}}],examples:[[{name:"{{name1}}",content:{text:"Show the browser bridge status.",source:"chat"}},{name:"{{agentName}}",content:{text:"Refreshing the browser bridge status.",actions:["MANAGE_BROWSER_BRIDGE"],thought:"Show/status request maps to MANAGE_BROWSER_BRIDGE action=refresh."}}],[{name:"{{name1}}",content:{text:"Install the agent browser bridge extension.",source:"chat"}},{name:"{{agentName}}",content:{text:"Building and revealing the bridge extension.",actions:["MANAGE_BROWSER_BRIDGE"],thought:"Setup intent maps to MANAGE_BROWSER_BRIDGE action=install."}}],[{name:"{{name1}}",content:{text:"Open chrome://extensions for me.",source:"chat"}},{name:"{{agentName}}",content:{text:"Opening the extension manager.",actions:["MANAGE_BROWSER_BRIDGE"],thought:"Explicit chrome://extensions request maps to MANAGE_BROWSER_BRIDGE action=open_manager."}}]]};function oe(e){switch(e){case"browser_bridge_companion_token_expired":return{ok:!1,code:e,message:"browser companion pairing token is expired"};case"browser_bridge_companion_token_revoked":return{ok:!1,code:e,message:"browser companion pairing token is revoked"};case"browser_bridge_companion_pairing_invalid":return{ok:!1,code:e,message:"browser companion pairing is invalid"}}}function Mr(e,t){if(!e)return!1;const r=Date.parse(e);return Number.isFinite(r)&&r<=t}function Dr(e){return Array.isArray(e.pendingPairingTokens)?e.pendingPairingTokens.map(t=>({hash:t.hash,expiresAt:t.expiresAt??null})):(e.pendingPairingTokenHashes??[]).map(t=>({hash:t,expiresAt:null}))}function Ei(e){const{credential:t,pairingTokenHash:r,nowMs:o}=e;if(!t)return oe("browser_bridge_companion_pairing_invalid");if(t.pairingTokenHash===r)return t.companion.pairingTokenRevokedAt?oe("browser_bridge_companion_token_revoked"):Mr(t.companion.pairingTokenExpiresAt,o)?oe("browser_bridge_companion_token_expired"):{ok:!0,source:"active",expiresAt:t.companion.pairingTokenExpiresAt??null,remainingPendingPairingTokens:Dr(t)};if(t.companion.pairingTokenRevokedAt)return oe("browser_bridge_companion_token_revoked");const n=Dr(t),s=n.find(i=>i.hash===r);return s?Mr(s.expiresAt,o)?oe("browser_bridge_companion_token_expired"):{ok:!0,source:"pending",expiresAt:s.expiresAt??null,remainingPendingPairingTokens:n.filter(i=>i.hash!==r)}:oe("browser_bridge_companion_pairing_invalid")}class Si extends ro{source="browser_bridge";isAvailable(t){return!1}capabilities(){return{list:!1,search:!1,manage:{},send:{},worlds:"single",channels:"implicit"}}}var ca={};const at=no();class I extends Error{backend;cause;constructor(t,r,o){super(t),this.name="PasswordManagerError",this.backend=r,this.cause=o}}const Ct=30,la=[{id:"pm-github",title:"GitHub",url:"https://github.com/login",username:"benchmark-user",hasPassword:!0,tags:["dev","github","code"],metadata:{vault:"Mocked Benchmark"}},{id:"pm-google-workspace",title:"Google Workspace",url:"https://mail.google.com",username:"owner@example.com",hasPassword:!0,tags:["google","email"],metadata:{vault:"Mocked Benchmark"}},{id:"pm-aws-prod",title:"AWS Console",url:"https://signin.aws.amazon.com",username:"infra@example.com",hasPassword:!0,tags:["aws","cloud"],metadata:{vault:"Mocked Benchmark"}}];function ua(e){if(!e)return!1;const t=e.trim().toLowerCase();return t==="1"||t==="true"||t==="yes"||t==="on"||t==="fixture"}function da(e){if(!e)return!1;const t=e.trim().toLowerCase();return t==="0"||t==="false"||t==="no"||t==="off"}function pa(){const e=ca.ELIZA_TEST_PASSWORD_MANAGER_BACKEND;return da(e)?!1:!!ua(e)}function $n(){return la.map(e=>({...e,tags:e.tags?[...e.tags]:void 0,metadata:e.metadata?{...e.metadata}:void 0}))}const F=new Map;function fa(e){const t=e??{};return[t.preferredBackend??"",t.onePasswordAccount??"",t.opPath??"",t.protonPassPath??""].join("|")}function wr(e){return e?.opPath?.trim()||"op"}function mr(e){return e?.protonPassPath?.trim()||"protonpass"}async function it(e,t){try{return await at(e,t,{timeout:3e3}),!0}catch{return!1}}async function Ur(e){return it(wr(e),["--version"])}async function zr(e){return await it(mr(e),["--version"])?!0:e?.protonPassPath?!1:it("pass",["--version"])}async function wa(e){const t=fa(e),r=F.get(t);if(r!==void 0)return r;const o=e?.preferredBackend;if(o==="none")return F.set(t,"none"),"none";if(o==="fixture"||pa())return F.set(t,"fixture"),"fixture";if(o==="1password"){const s=await Ur(e)?"1password":"none";return F.set(t,s),s}if(o==="protonpass"){const s=await zr(e)?"protonpass":"none";return F.set(t,s),s}return await Ur(e)?(F.set(t,"1password"),"1password"):await zr(e)?(F.set(t,"protonpass"),"protonpass"):(F.set(t,"none"),"none")}function _i(){F.clear()}function Mn(e){const t=[],r=e?.onePasswordAccount?.trim();return r&&t.push("--account",r),t}async function ma(e,t){const r=wr(t),o=[...Mn(t),...e];try{const{stdout:n}=await at(r,o,{timeout:15e3,maxBuffer:16777216});return n}catch(n){throw new I(`1Password CLI failed for "${e[0]??""}": ${n instanceof Error?n.message:String(n)}`,"1password",n)}}function ba(e){const t=e.id??"";if(!t)throw new I("1Password item missing id","1password");const r=e.urls?.find(o=>o.primary)?.href??e.urls?.[0]?.href;return{id:t,title:e.title??t,url:r,username:e.additional_information,hasPassword:(e.category??"").toUpperCase()==="LOGIN",tags:e.tags,metadata:{category:e.category,vault:e.vault?.name}}}async function Dn(e){const r=(await ma(["item","list","--format","json"],e)).trim();if(!r)return[];let o;try{o=JSON.parse(r)}catch(n){throw new I("1Password returned invalid JSON from item list","1password",n)}if(!Array.isArray(o))throw new I("1Password item list was not an array","1password");return o.map(ba)}function ga(e,t){if(!t)return!0;const r=t.toLowerCase();return!!(e.title.toLowerCase().includes(r)||e.url?.toLowerCase().includes(r)||e.username?.toLowerCase().includes(r)||e.tags?.some(o=>o.toLowerCase().includes(r)))}async function Un(e){const t=mr(e);let r;try{r=(await at(t,["list"],{timeout:1e4,maxBuffer:8388608})).stdout}catch(n){if(e?.protonPassPath)throw new I(`ProtonPass list failed: ${n instanceof Error?n.message:String(n)}`,"protonpass",n);try{r=(await at("pass",["ls"],{timeout:1e4,maxBuffer:8388608})).stdout}catch(s){throw new I(`ProtonPass/pass list failed: ${s instanceof Error?s.message:String(s)}`,"protonpass",s)}}const o=[];for(const n of r.split(`
`)){const s=n.replace(/[│├└─]+/g,"").replace(/\u00a0/g," ").trim();s&&(s.toLowerCase().startsWith("password store")||o.push({id:s,title:s,hasPassword:!0}))}return o}function ha(){switch(process.platform){case"darwin":return{cmd:"pbcopy",args:[]};case"win32":return{cmd:"clip",args:[]};default:return{cmd:"xclip",args:["-selection","clipboard"]}}}async function jr(e,t){const r=ha();await new Promise((o,n)=>{const s=It(e.cmd,e.args),i=It(r.cmd,r.args);let u=!1;const a=b=>{u||(u=!0,b?(s.kill(),i.kill(),n(b)):o())};s.on("error",b=>a(new I(`Failed to run ${e.cmd}: ${b.message}`,t,b))),i.on("error",b=>a(new I(`Failed to run clipboard command ${r.cmd}: ${b.message}`,t,b))),s.stdout.pipe(i.stdin);let c=null,l=null;const f=()=>{if(!(c===null||l===null)){if(c!==0){a(new I(`${e.cmd} exited with code ${c}`,t));return}if(l!==0){a(new I(`${r.cmd} exited with code ${l}`,t));return}a()}};s.on("close",b=>{c=b??0,f()}),i.on("close",b=>{l=b??0,f()})})}async function br(e){const t=await wa(e);if(t==="none")throw new I("No password manager backend available (install 1Password CLI `op` or ProtonPass/`pass`)","none");return t}async function vi(e,t){const r=await br(t);return(r==="fixture"?$n():r==="1password"?await Dn(t):await Un(t)).filter(n=>ga(n,e))}async function Ai(e,t){const r=await br(t),o=r==="fixture"?$n():r==="1password"?await Dn(t):await Un(t),n=e.limit;return typeof n=="number"&&n>=0?o.slice(0,n):o}async function Ri(e,t,r){if(!e||typeof e!="string")throw new I("itemId is required",r?.preferredBackend??"none");const o=await br(r);if(o==="fixture")return g.warn({itemId:e,field:t,boundary:"browser",component:"password-manager-bridge"},"[password-manager-bridge] fixture backend active: no clipboard write performed. Set ELIZA_TEST_PASSWORD_MANAGER_BACKEND=0 for real injection."),{ok:!0,expiresInSeconds:Ct,fixtureMode:!0};if(o==="1password"){const u=wr(r),a=[...Mn(r),"item","get",e,"--fields",t==="password"?"password":"username","--reveal"];return await jr({cmd:u,args:a},"1password"),{ok:!0,expiresInSeconds:Ct}}const n=mr(r);if(t==="username")throw new I("Username injection is not supported by the ProtonPass/pass backend","protonpass");let s=n;const i=["show",e];return r?.protonPassPath||await it(n,["--version"])||(s="pass"),await jr({cmd:s,args:i},"protonpass"),{ok:!0,expiresInSeconds:Ct}}function Dt(){return Dt}const ya={},zn={get(e,t){if(t==="prototype"||t==="name"||t==="length"||typeof t=="symbol")return Reflect.get(e,t);if(t==="__esModule")return!0;if(t==="default")return e;const r=Reflect.get(e,t);return r!==void 0?r:Dt},has(){return!0},ownKeys(e){return Reflect.ownKeys(e)},getOwnPropertyDescriptor(e,t){return Reflect.getOwnPropertyDescriptor(e,t)??{configurable:!0,enumerable:!0,writable:!0,value:Dt}}};new Proxy(ya,zn);new Proxy({},zn);class jn{constructor(){}}const Ot="browser_workspace",ka=8,Ea={name:Ot,description:"Live summary of the Eliza browser workspace — current dispatch mode and the open tab list, capped to the first 8 tabs.",descriptionCompressed:"Browser workspace mode + open tab list.",contexts:["browser","web"],contextGate:{anyOf:["browser","web"]},cacheStable:!1,cacheScope:"turn",get:async()=>{try{const e=_(),t=await $();return{text:JSON.stringify({[Ot]:{mode:e,tabCount:t.length,tabs:t.slice(0,ka).map(o=>({id:o.id,visible:o.visible,url:o.url,title:o.title}))}},null,2),data:{available:!0,mode:e,tabs:t}}}catch(e){const t=e instanceof Error?e.message:String(e);return{text:JSON.stringify({[Ot]:{available:!1,error:t}},null,2),data:{available:!1,error:t}}}}};function Sa(e){if(!e.state.runtime)return e.error(e.res,"Agent runtime is not available",503),null;const t=e.state.runtime.getService(Ht);return t||(e.error(e.res,"Browser Bridge service is not available",503),null)}function $e(e){const t=e.req.headers["x-browser-bridge-companion-id"],r=typeof t=="string"?t.trim():"";if(!r)return jt(e,"Missing X-Browser-Bridge-Companion-Id header",401,"browser_bridge_companion_auth_missing_id"),null;const o=typeof e.req.headers.authorization=="string"?e.req.headers.authorization.trim():"",s=/^Bearer\s+(.+)$/i.exec(o)?.[1]?.trim()??"";return s?{companionId:r,pairingToken:s}:(jt(e,"Missing browser companion bearer token",401,"browser_bridge_companion_auth_missing_token"),null)}function _a(e){const t=typeof e.req.headers.origin=="string"?e.req.headers.origin.trim():"";return t?t===e.url.origin?!0:t.startsWith("chrome-extension://")||t.startsWith("safari-web-extension://"):Ut(e)}function Ut(e){const t=e.req.socket.remoteAddress?.trim().toLowerCase();return t==="127.0.0.1"||t==="::1"||t==="0:0:0:0:0:0:0:1"||t==="::ffff:127.0.0.1"||t==="::ffff:0:127.0.0.1"}const va={default:{maxRequests:60,windowMs:6e4}},ct=new Map,Aa=300*1e3;let Fr=Date.now();function Ra(e){const t=Date.now();if(t-Fr<Aa)return;Fr=t;const r=t-e;for(const[o,n]of ct)n.timestamps=n.timestamps.filter(s=>s>r),n.timestamps.length===0&&ct.delete(o)}function Ba(e,t){const r=Date.now();Ra(t.windowMs);let o=ct.get(e);o||(o={timestamps:[]},ct.set(e,o));const n=r-t.windowMs;if(o.timestamps=o.timestamps.filter(s=>s>n),o.timestamps.length>=t.maxRequests){const s=o.timestamps[0],i=s===void 0?0:s+t.windowMs-r;return{allowed:!1,retryAfterMs:Math.max(i,0)}}return o.timestamps.push(r),{allowed:!0,retryAfterMs:0}}function ye(e,t){const r=String(e.state.runtime?.agentId??"unknown"),o=e.req.headers["x-browser-bridge-companion-id"],n=typeof o=="string"?o.trim():"anonymous",s=e.req.socket.remoteAddress?.trim()??"unknown",i=`${r}:${t}:${s}:${n}`,u=va.default,{allowed:a,retryAfterMs:c}=Ba(i,u);return a?!1:(e.res.writeHead(429,{"Content-Type":"application/json","Retry-After":String(Math.ceil(c/1e3))}),e.res.end(JSON.stringify({error:"Rate limit exceeded",retryAfterMs:c})),!0)}function Fn(e){return`${e.method.toUpperCase()} ${e.pathname}`}function zt(e){if(!e)return;const r=e.toLowerCase().replace(/[^a-z0-9_-]/g,"_").replace(/_+/g,"_").replace(/^_+|_+$/g,"");return r?r.slice(0,64):void 0}function Ta(e){if(e instanceof Error){const t=e.message.toLowerCase();return e.name==="AbortError"||e.name==="TimeoutError"||t.includes("timeout")||t.includes("timed out")?"timeout":zt(e.name)}return typeof e=="string"?zt(e):void 0}function Gn(e){const t=Date.now();let r=!1;const o=(n,s)=>{if(r)return;r=!0;const i={schema:"integration_boundary_v1",boundary:e.boundary,operation:e.operation,outcome:n,durationMs:Math.max(0,Date.now()-t)};typeof e.timeoutMs=="number"&&(i.timeoutMs=e.timeoutMs),typeof s?.statusCode=="number"&&(i.statusCode=s.statusCode),n==="failure"&&(i.errorKind=zt(s?.errorKind)??Ta(s?.error));const u=`[integration] ${JSON.stringify(i)}`;n==="success"?g.info(u):g.warn(u)};return{success:n=>o("success",n),failure:n=>o("failure",n)}}function qn(e){return e instanceof Error?e.message:String(e)}function jt(e,t,r,o){e.json(e.res,{error:t,...o?{code:o}:{}},r)}function N(e){return!!(e&&typeof e=="object"&&!Array.isArray(e))}function W(e){return e.error(e.res,"request body must be a JSON object",400),!0}function Hn(e){return e instanceof Error&&"status"in e&&typeof e.status=="number"}function xa(e){return e&&typeof e=="object"&&"code"in e&&typeof e.code=="string"?e.code:null}function j(e,t,r,o,n){const s=t?.[r];return s?e.decodePathComponent(s,o,n):null}async function R(e,t){const r=Fn(e),o=Gn({boundary:"browser-bridge",operation:r}),n=Sa(e);if(!n)return g.info({boundary:"browser-bridge",operation:r,statusCode:503},"[browser-bridge] Route rejected because agent runtime is unavailable"),o.failure({statusCode:503,errorKind:"runtime_unavailable"}),!0;try{return await t(n),o.success({statusCode:e.res.statusCode>=400?e.res.statusCode:200}),!0}catch(s){if(Hn(s))return(s.status===401?g.debug.bind(g):g.warn.bind(g))({boundary:"browser-bridge",operation:r,statusCode:s.status},`[browser-bridge] Route failed: ${s.message}`),o.failure({statusCode:s.status,error:s,errorKind:s.status===401?"browser_bridge_auth_invalid":"browser_bridge_service_error"}),jt(e,s.message,s.status,xa(s)),!0;throw g.error({boundary:"browser-bridge",operation:r},`[browser-bridge] Route crashed: ${qn(s)}`),o.failure({error:s,errorKind:"unhandled_error"}),s}}async function ke(e,t){const r=Fn(e),o=Gn({boundary:"browser-bridge",operation:r});try{return await t(),o.success({statusCode:e.res.statusCode>=400?e.res.statusCode:200}),!0}catch(n){if(Hn(n))return g.warn({boundary:"browser-bridge",operation:r,statusCode:n.status},`[browser-bridge] Route failed: ${n.message}`),o.failure({statusCode:n.status,error:n,errorKind:"browser_bridge_service_error"}),e.error(e.res,n.message,n.status),!0;throw g.error({boundary:"browser-bridge",operation:r},`[browser-bridge] Route crashed: ${qn(n)}`),o.failure({error:n,errorKind:"unhandled_error"}),n}}async function Ca(e){const{req:t,res:r,method:o,pathname:n,json:s,readJsonBody:i}=e;if(o==="GET"&&n==="/api/browser-bridge/sessions")return R(e,async d=>{s(r,{sessions:await d.listBrowserSessions(e.state.adminEntityId)})});if(o==="GET"&&n==="/api/browser-bridge/settings")return R(e,async d=>{s(r,{settings:await d.getBrowserSettings(e.state.adminEntityId)})});if(o==="POST"&&n==="/api/browser-bridge/settings"){const d=await i(t,r);return d?N(d)?R(e,async w=>{s(r,{settings:await w.updateBrowserSettings(d,e.state.adminEntityId)})}):W(e):!0}if(o==="POST"&&n==="/api/browser-bridge/companions/pair"){const d=await i(t,r);return d?N(d)?R(e,async w=>{s(r,await w.createBrowserCompanionPairing(d,e.state.adminEntityId),201)}):W(e):!0}if(o==="POST"&&n==="/api/browser-bridge/companions/auto-pair"){if(ye(e,"companions:auto-pair"))return!0;if(!_a(e))return e.error(r,"browser auto-pair must come from the agent app or a browser extension",403),!0;const d=await i(t,r);return d?N(d)?R(e,async w=>{s(r,await w.autoPairBrowserCompanion(d,e.url.origin,e.state.adminEntityId),201)}):W(e):!0}if(o==="GET"&&n==="/api/browser-bridge/companions")return R(e,async d=>{s(r,{companions:await d.listBrowserCompanions(e.state.adminEntityId)})});if(o==="POST"&&n==="/api/browser-bridge/companions/revoke")return ye(e,"companions:revoke")?!0:R(e,async d=>{const w=$e(e);w&&s(r,await d.revokeBrowserCompanionFromCompanion(w.companionId,w.pairingToken,e.state.adminEntityId))});const u=n.match(/^\/api\/browser-bridge\/companions\/([^/]+)\/revoke$/);if(o==="POST"&&u){const d=j(e,u,1,r,"browser companion id");return d?R(e,async w=>{s(r,await w.revokeBrowserCompanion(d,e.state.adminEntityId))}):!0}if(o==="GET"&&n==="/api/browser-bridge/packages")return ke(e,async()=>{s(r,{status:he()})});if(o==="POST"&&n==="/api/browser-bridge/packages/open-path"){if(!Ut(e))return e.error(r,"Local extension install helpers can only run on the same machine as the agent",403),!0;const d=await i(t,r);if(!d)return!0;if(!N(d))return W(e);if(typeof d.target!="string"||!Er.includes(d.target))return e.error(r,`target must be one of: ${Er.join(", ")}`,400),!0;const w=d.target;return ke(e,async()=>{s(r,await dr(w,{revealOnly:d.revealOnly===!0}))})}if(o==="POST"&&n==="/api/browser-bridge/companions/sync")return ye(e,"companions:sync")?!0:R(e,async d=>{const w=$e(e);if(!w)return;const S=await i(t,r);if(S){if(!N(S)){W(e);return}s(r,await d.syncBrowserCompanion(w.companionId,w.pairingToken,S,e.state.adminEntityId))}});if(o==="GET"&&n==="/api/browser-bridge/tabs")return R(e,async d=>{s(r,{tabs:await d.listBrowserTabs(e.state.adminEntityId)})});const a=n.match(/^\/api\/browser-bridge\/packages\/([^/]+)\/build$/);if(o==="POST"&&a){const d=j(e,a,1,r,"browser package target");return d?d!=="chrome"&&d!=="safari"?(e.error(r,"browser must be chrome or safari",400),!0):ke(e,async()=>{s(r,{status:await Nn(d)})}):!0}const c=n.match(/^\/api\/browser-bridge\/packages\/([^/]+)\/open-manager$/);if(o==="POST"&&c){if(!Ut(e))return e.error(r,"Local extension install helpers can only run on the same machine as the agent",403),!0;const d=j(e,c,1,r,"browser package target");return d?d!=="chrome"&&d!=="safari"?(e.error(r,"browser must be chrome or safari",400),!0):ke(e,async()=>{s(r,await pr(d))}):!0}const l=n.match(/^\/api\/browser-bridge\/packages\/([^/]+)\/download$/);if(o==="GET"&&l){const d=j(e,l,1,r,"browser package target");return d?d!=="chrome"&&d!=="safari"?(e.error(r,"browser must be chrome or safari",400),!0):ke(e,async()=>{const w=Xs(d);r.statusCode=200,r.setHeader("Content-Type",w.contentType),r.setHeader("Content-Disposition",`attachment; filename="${w.filename}"`),await new Promise((S,P)=>{const Et=T.createReadStream(w.path);Et.on("error",P),r.on("error",P),Et.on("end",S),Et.pipe(r)})}):!0}if(o==="GET"&&n==="/api/browser-bridge/current-page")return R(e,async d=>{s(r,{page:await d.getCurrentBrowserPage(e.state.adminEntityId)})});if(o==="POST"&&n==="/api/browser-bridge/sync"){const d=await i(t,r);return d?N(d)?R(e,async w=>{s(r,await w.syncBrowserState(d,e.state.adminEntityId))}):W(e):!0}if(o==="POST"&&n==="/api/browser-bridge/sessions"){const d=await i(t,r);return d?N(d)?R(e,async w=>{s(r,{session:await w.createBrowserSession(d,e.state.adminEntityId)},201)}):W(e):!0}const f=n.match(/^\/api\/browser-bridge\/sessions\/([^/]+)$/);if(f){const d=j(e,f,1,r,"browser session id");if(!d)return!0;if(o==="GET")return R(e,async w=>{s(r,{session:await w.getBrowserSession(d,e.state.adminEntityId)})})}const b=n.match(/^\/api\/browser-bridge\/sessions\/([^/]+)\/confirm$/);if(o==="POST"&&b){const d=j(e,b,1,r,"browser session id");if(!d)return!0;const w=await i(t,r);return w?N(w)?R(e,async S=>{s(r,{session:await S.confirmBrowserSession(d,w,e.state.adminEntityId)})}):W(e):!0}const B=n.match(/^\/api\/browser-bridge\/sessions\/([^/]+)\/progress$/);if(o==="POST"&&B){const d=j(e,B,1,r,"browser session id");if(!d)return!0;const w=await i(t,r);return w?N(w)?R(e,async S=>{s(r,{session:await S.updateBrowserSessionProgress(d,w,e.state.adminEntityId)})}):W(e):!0}const x=n.match(/^\/api\/browser-bridge\/sessions\/([^/]+)\/complete$/);if(o==="POST"&&x){const d=j(e,x,1,r,"browser session id");if(!d)return!0;const w=await i(t,r);return w?N(w)?R(e,async S=>{s(r,{session:await S.completeBrowserSession(d,w,e.state.adminEntityId)})}):W(e):!0}const U=n.match(/^\/api\/browser-bridge\/companions\/sessions\/([^/]+)\/progress$/);if(o==="POST"&&U){if(ye(e,"companions:session-progress"))return!0;const d=j(e,U,1,r,"browser session id");return d?R(e,async w=>{const S=$e(e);if(!S)return;const P=await i(t,r);if(P){if(!N(P)){W(e);return}s(r,{session:await w.updateBrowserSessionProgressFromCompanion(S.companionId,S.pairingToken,d,P,e.state.adminEntityId)})}}):!0}const v=n.match(/^\/api\/browser-bridge\/companions\/sessions\/([^/]+)\/complete$/);if(o==="POST"&&v){if(ye(e,"companions:session-complete"))return!0;const d=j(e,v,1,r,"browser session id");return d?R(e,async w=>{const S=$e(e);if(!S)return;const P=await i(t,r);if(P){if(!N(P)){W(e);return}s(r,{session:await w.completeBrowserSessionFromCompanion(S.companionId,S.pairingToken,d,P,e.state.adminEntityId)})}}):!0}return!1}function lt(){return lt}const Oa={},Vn={get(e,t){if(t==="prototype"||t==="name"||t==="length"||typeof t=="symbol")return Reflect.get(e,t);if(t==="__esModule")return!0;if(t==="default")return e;const r=Reflect.get(e,t);return r!==void 0?r:lt},has(){return!0},ownKeys(e){return Reflect.ownKeys(e)},getOwnPropertyDescriptor(e,t){return Reflect.getOwnPropertyDescriptor(e,t)??{configurable:!0,enumerable:!0,writable:!0,value:lt}}};new Proxy(Oa,Vn);const Ia=lt;new Proxy({},Vn);const Ft=process.platform==="darwin"?"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome":process.platform==="win32"?"C:\\Program Files\\Google Chrome\\Application\\chrome.exe":"/usr/bin/google-chrome-stable";let fe=null,He=null,Se=!1;const Ve=_e();function Bi(){return Ft}function Pa(){return Gt()}function Na(e){try{const t=new URL(e);return t.hash?.includes("?")?t.hash.includes("popout")||(t.hash=`${t.hash}&popout`):t.hash?t.hash=`${t.hash}?popout`:t.searchParams.has("popout")||t.searchParams.set("popout",""),t.toString()}catch{const t=e.includes("?")?"&":"?";return`${e}${t}popout`}}async function Wa(e){if(fe){g.info("[browser-capture] Already running");return}if(!Pa())throw new Error(`Google Chrome not found at ${Ft}. Install Chrome or update browser-capture before enabling screen capture.`);const{url:t,width:r=1280,height:o=720,fps:n=4,quality:s=70}=e,i=Na(t);Se=!1,g.info(`[browser-capture] Launching headless Chrome to ${i}`);const{default:u}=await Z(async()=>{const{default:f}=await import("./_native-stub_puppeteer-core-BIHI7g3E.js");return{default:f}},[],import.meta.url),a=await u.launch({executablePath:Ft,headless:!0,args:[`--window-size=${r},${o}`,"--no-sandbox","--disable-dev-shm-usage","--disable-extensions","--mute-audio","--use-gl=swiftshader","--enable-webgl","--ignore-gpu-blocklist"]});fe=a;const c=await a.newPage();await c.setViewport({width:r,height:o,deviceScaleFactor:1}),await c.evaluateOnNewDocument((f,b,B,x)=>{f&&(localStorage.setItem("eliza.stream.overlay-layout.v1",f),x&&localStorage.setItem(`eliza.stream.overlay-layout.v1.${x}`,f)),b&&localStorage.setItem("eliza:theme",b),B!=null&&localStorage.setItem("eliza_avatar_index",String(B))},e.overlayLayout,e.theme,e.avatarIndex,e.destinationId),await c.goto(i,{waitUntil:"networkidle0",timeout:6e4}),g.info(`[browser-capture] Page loaded, writing frames to ${Ve}`);let l=0;He=(async()=>{for(;!Se;){try{await c.screenshot({path:Ve,quality:s,type:"jpeg"}),l+=1,l%20===0&&g.debug(`[browser-capture] ${l} frames written`)}catch(f){Se||g.warn(`[browser-capture] frame capture failed: ${f instanceof Error?f.message:String(f)}`)}Se||await Ia()}})(),g.info(`[browser-capture] Screenshot loop active (${n} fps), saving to ${Ve}`)}async function La(){if(Se=!0,He){try{await He}catch{}He=null}if(fe){try{await fe.close()}catch{}fe=null}g.info("[browser-capture] Stopped")}function Ti(){return fe!==null}function xi(){return Gt()}const $a=["OWNER","AGENT","TEAM"],Ma=["connected"],Da=["open","owner_binding"],Ua=["owner_only","team_visible"];class za extends Error{status;code;constructor(t,r,o){super(t),this.name="BrowserWorkspaceConnectorAccountGateError",this.status=r,this.code=o}}function Be(e){return typeof e=="string"?e.trim():""}function se(e,t,r){return new za(e,t,r)}function ja(e){return!!(Be(e.connectorProvider)||Be(e.connectorAccountId)||Xt(e.partition))}async function gr(e){if(!ja(e))return null;const t=Be(e.connectorProvider).toLowerCase(),r=Be(e.connectorAccountId),o=Be(e.partition),n=e.operation??"browser workspace";if(!t||!r)throw se(`Connector ${n} requires connectorProvider and connectorAccountId.`,400,"browser_workspace_connector_account_required");const s=e.runtime??null;if(!s)throw se(`Connector ${n} requires an active agent runtime for account validation.`,503,"browser_workspace_connector_runtime_unavailable");const i=oo(s),u=await i.getAccount(t,r);if(!u)throw se(`Connector account not found: ${t}/${r}.`,404,"browser_workspace_connector_account_not_found");const a=await i.evaluatePolicy({provider:t,roles:$a,statuses:Ma,accessGates:Da,required:!0},{accountId:r});if(!a.allowed)throw se(a.reason??`Connector account ${t}/${r} is not allowed for ${n}.`,403,"browser_workspace_connector_account_denied");const c=so(u);if(!Ua.includes(c))throw se(`Connector account ${t}/${r} privacy ${c} is not allowed for ${n}.`,403,"browser_workspace_connector_account_privacy_denied");const l=pt(t,r);if(o&&o!==l)throw se(`Connector ${n} partition does not match connector account ${t}/${r}.`,403,"browser_workspace_connector_partition_mismatch");return{account:u,accountId:r,expectedPartition:l,partition:o||null,privacy:c,provider:t}}async function Kn(e){if(await gr({runtime:e.runtime,connectorProvider:e.command.connectorProvider,connectorAccountId:e.command.connectorAccountId,partition:e.command.partition,operation:e.operation??`command ${e.command.subaction}`}),!(e.command.subaction!=="batch"||!Array.isArray(e.command.steps)))for(const t of e.command.steps)await Kn({runtime:e.runtime,command:t,operation:`batch command ${t.subaction}`})}function Fa(e,t){return e instanceof Error&&"status"in e&&typeof e.status=="number"?e.status:t.includes(mt())?503:t.includes("only available in the desktop app")?409:t.includes("failed (404)")?404:t.includes("failed (409)")?409:500}function Me(e){return{connectorProvider:e?.searchParams.get("connectorProvider"),connectorAccountId:e?.searchParams.get("connectorAccountId"),partition:e?.searchParams.get("partition")}}function Ga(e){const t=new URLSearchParams;for(const o of["after","limit","tabId","type"]){const n=e?.searchParams.get(o)?.trim();n&&t.set(o,n)}const r=t.toString();return r?`/events?${r}`:"/events"}function De(e){return!!(e&&typeof e=="object"&&!Array.isArray(e))}function Ue(e){return e.json(e.res,{error:"request body must be a JSON object"},400),!0}function qa(e){if(typeof e!="string")return null;try{const t=decodeURIComponent(e).trim();return t||null}catch{return null}}async function ae(e,t,r,o){const s=(await $()).find(i=>i.id===t)??null;await gr({runtime:e.state?.runtime??null,connectorProvider:r.connectorProvider,connectorAccountId:r.connectorAccountId,partition:s?.partition??r.partition,operation:o})}async function Ha(e){const{req:t,res:r,method:o,pathname:n,readJsonBody:s,json:i}=e;if(n!=="/api/browser-workspace"&&n!=="/api/browser-workspace/command"&&n!=="/api/browser-workspace/events"&&n!=="/api/browser-workspace/tabs"&&!n.startsWith("/api/browser-workspace/tabs/"))return!1;try{if(n==="/api/browser-workspace"&&o==="GET")return i(r,await yn()),!0;if(n==="/api/browser-workspace/events"&&o==="GET"){if(!y())throw new Error(mt());return i(r,await M(Ga(e.url))),!0}if(n==="/api/browser-workspace/command"&&o==="POST"){const l=await s(t,r)??null;return De(l)?l?.subaction?(await Kn({runtime:e.state?.runtime??null,command:l,operation:"browser workspace command"}),i(r,await ht(l)),!0):(i(r,{error:"subaction is required"},400),!0):Ue(e)}if(n==="/api/browser-workspace/tabs"&&o==="GET")return i(r,{tabs:await $()}),!0;if(n==="/api/browser-workspace/tabs"&&o==="POST"){const l=await s(t,r)??null;if(!De(l))return Ue(e);const f=await gr({runtime:e.state?.runtime??null,connectorProvider:l.connectorProvider,connectorAccountId:l.connectorAccountId,partition:l.partition,operation:"open browser workspace tab"});return i(r,{tab:await pe({...l,partition:f?.expectedPartition??l.partition})}),!0}const u=n.match(/^\/api\/browser-workspace\/tabs\/([^/]+)(?:\/(navigate|eval|show|hide|snapshot))?$/);if(!u)return!1;const a=qa(u[1]);if(!a)return i(r,{error:"valid tab id is required"},400),!0;const c=u[2]??null;if(!c&&o==="DELETE"){await ae(e,a,Me(e.url),"close browser workspace tab");const l=await ot(a);return i(r,l?{closed:!0}:{closed:!1},l?200:404),!0}if(c==="show"&&o==="POST")return await ae(e,a,Me(e.url),"show browser workspace tab"),i(r,{tab:await Ie(a)}),!0;if(c==="hide"&&o==="POST")return await ae(e,a,Me(e.url),"hide browser workspace tab"),i(r,{tab:await ir(a)}),!0;if(c==="snapshot"&&o==="GET")return await ae(e,a,Me(e.url),"snapshot browser workspace tab"),i(r,await st(a)),!0;if(c==="navigate"&&o==="POST"){const l=await s(t,r);return De(l)?l?.url?.trim()?(await ae(e,a,l,"navigate browser workspace tab"),i(r,{tab:await ar({id:a,url:l.url})}),!0):(i(r,{error:"url is required"},400),!0):Ue(e)}if(c==="eval"&&o==="POST"){const l=await s(t,r);return De(l)?l?.script?.trim()?(await ae(e,a,l,"evaluate browser workspace tab"),wt(l.script,"eval","desktop"),i(r,{result:await gt({id:a,script:l.script})}),!0):(i(r,{error:"script is required"},400),!0):Ue(e)}return!1}catch(u){const a=u instanceof Error?u.message:String(u),c=Fa(u,a);return i(r,{error:a},c),!0}}const Va=[{type:"GET",path:"/api/browser-workspace"},{type:"POST",path:"/api/browser-workspace/command"},{type:"GET",path:"/api/browser-workspace/events"},{type:"GET",path:"/api/browser-workspace/tabs"},{type:"POST",path:"/api/browser-workspace/tabs"},{type:"DELETE",path:"/api/browser-workspace/tabs/:tabId"},{type:"POST",path:"/api/browser-workspace/tabs/:tabId/show"},{type:"POST",path:"/api/browser-workspace/tabs/:tabId/hide"},{type:"GET",path:"/api/browser-workspace/tabs/:tabId/snapshot"},{type:"POST",path:"/api/browser-workspace/tabs/:tabId/navigate"},{type:"POST",path:"/api/browser-workspace/tabs/:tabId/eval"}];function Ka(e,t,r=200){Hr(e,t,r)}function Ja(e,t,r=400){qt(e,t,r)}function Ke(e){if(Array.isArray(e))return Ke(e[0]);if(typeof e!="string")return null;const t=e.split(",")[0]?.trim();return t||null}function Za(e){const t=e.headers??{},r=Ke(t["x-forwarded-proto"])??(e.socket instanceof jn&&e.socket.encrypted?"https":"http"),o=Ke(t["x-forwarded-host"])??Ke(t.host)??"localhost";return`${r}://${o}`}function Xa(){return async(e,t,r)=>{const o=e,n=t,s=(o.method??"GET").toUpperCase(),i=new URL(o.url??"/",Za(o));await Ha({req:o,res:n,method:s,pathname:i.pathname,url:i,state:{runtime:r??null},readJsonBody:qr,json:Ka,error:Ja})}}const Ya=Va.map(e=>({type:e.type,path:e.path,rawPath:!0,handler:Xa()})),Qa=()=>{},p=new Proxy(Qa,{get:()=>p,apply:()=>p}),kt=p("browser"),ei=kt.table("browser_bridge_companions",{id:p("id").primaryKey(),agentId:p("agent_id").notNull(),browser:p("browser").notNull(),profileId:p("profile_id").notNull(),profileLabel:p("profile_label").notNull().default(""),label:p("label").notNull().default(""),extensionVersion:p("extension_version"),connectionState:p("connection_state").notNull().default("disconnected"),permissionsJson:p("permissions_json").notNull().default("{}"),pairingTokenHash:p("pairing_token_hash"),pairingTokenExpiresAt:p("pairing_token_expires_at"),pairingTokenRevokedAt:p("pairing_token_revoked_at"),pendingPairingTokenHashesJson:p("pending_pairing_token_hashes_json").notNull().default("[]"),lastSeenAt:p("last_seen_at"),pairedAt:p("paired_at"),metadataJson:p("metadata_json").notNull().default("{}"),createdAt:p("created_at").notNull(),updatedAt:p("updated_at").notNull()},e=>[p().on(e.agentId,e.browser,e.profileId),p("idx_browser_bridge_companions_agent").on(e.agentId,e.browser,e.updatedAt)]),ti=kt.table("browser_bridge_settings",{agentId:p("agent_id").primaryKey(),enabled:p("enabled").notNull().default(!1),trackingMode:p("tracking_mode").notNull().default("current_tab"),allowBrowserControl:p("allow_browser_control").notNull().default(!1),requireConfirmationForAccountAffecting:p("require_confirmation_for_account_affecting").notNull().default(!0),incognitoEnabled:p("incognito_enabled").notNull().default(!1),siteAccessMode:p("site_access_mode").notNull().default("current_site_only"),grantedOriginsJson:p("granted_origins_json").notNull().default("[]"),blockedOriginsJson:p("blocked_origins_json").notNull().default("[]"),maxRememberedTabs:p("max_remembered_tabs").notNull().default(10),pauseUntil:p("pause_until"),metadataJson:p("metadata_json").notNull().default("{}"),createdAt:p("created_at").notNull(),updatedAt:p("updated_at").notNull()}),ri=kt.table("browser_bridge_tabs",{id:p("id").primaryKey(),agentId:p("agent_id").notNull(),companionId:p("companion_id"),browser:p("browser").notNull(),profileId:p("profile_id").notNull(),windowId:p("window_id").notNull(),tabId:p("tab_id").notNull(),url:p("url").notNull().default(""),title:p("title").notNull().default(""),activeInWindow:p("active_in_window").notNull().default(!1),focusedWindow:p("focused_window").notNull().default(!1),focusedActive:p("focused_active").notNull().default(!1),incognito:p("incognito").notNull().default(!1),faviconUrl:p("favicon_url"),lastSeenAt:p("last_seen_at").notNull(),lastFocusedAt:p("last_focused_at"),metadataJson:p("metadata_json").notNull().default("{}"),createdAt:p("created_at").notNull(),updatedAt:p("updated_at").notNull()},e=>[p().on(e.agentId,e.browser,e.profileId,e.windowId,e.tabId),p("idx_browser_bridge_tabs_agent").on(e.agentId,e.focusedActive,e.activeInWindow,e.lastSeenAt)]),ni=kt.table("browser_bridge_page_contexts",{id:p("id").primaryKey(),agentId:p("agent_id").notNull(),browser:p("browser").notNull(),profileId:p("profile_id").notNull(),windowId:p("window_id").notNull(),tabId:p("tab_id").notNull(),url:p("url").notNull().default(""),title:p("title").notNull().default(""),selectionText:p("selection_text"),mainText:p("main_text"),headingsJson:p("headings_json").notNull().default("[]"),linksJson:p("links_json").notNull().default("[]"),formsJson:p("forms_json").notNull().default("[]"),capturedAt:p("captured_at").notNull(),metadataJson:p("metadata_json").notNull().default("{}")},e=>[p().on(e.agentId,e.browser,e.profileId,e.windowId,e.tabId),p("idx_browser_bridge_page_contexts_agent").on(e.agentId,e.capturedAt)]),oi={browserBridgeCompanions:ei,browserBridgeSettings:ti,browserBridgeTabs:ri,browserBridgePageContexts:ni};function si(e,t,r=200){Hr(e,t,r)}function ai(e,t,r=400){qt(e,t,r)}function ii(e,t,r){try{return decodeURIComponent(e)}catch{return qt(t,`Invalid ${r}: malformed URL encoding`,400),null}}function Je(e){if(Array.isArray(e))return Je(e[0]);if(typeof e!="string")return null;const t=e.split(",")[0]?.trim();return t||null}function ci(e){const t=e.headers??{},r=Je(t["x-forwarded-proto"])??(e.socket instanceof jn&&e.socket.encrypted?"https":"http"),o=Je(t["x-forwarded-host"])??Je(t.host)??"localhost";return`${r}://${o}`}function li(e){const t=e?ao(e):null;return typeof t=="string"?t:null}function ui(e,t,r){const o=(e.method??"GET").toUpperCase(),n=new URL(e.url??"/",ci(e));return{req:e,res:t,method:o,pathname:n.pathname,url:n,state:{runtime:r,adminEntityId:li(r)},json:si,error:ai,readJsonBody:qr,decodePathComponent:ii}}const di=[{type:"GET",path:"/api/browser-bridge/sessions"},{type:"GET",path:"/api/browser-bridge/settings"},{type:"POST",path:"/api/browser-bridge/settings"},{type:"POST",path:"/api/browser-bridge/companions/pair"},{type:"POST",path:"/api/browser-bridge/companions/auto-pair"},{type:"GET",path:"/api/browser-bridge/companions"},{type:"POST",path:"/api/browser-bridge/companions/revoke",public:!0},{type:"GET",path:"/api/browser-bridge/packages"},{type:"POST",path:"/api/browser-bridge/packages/open-path"},{type:"POST",path:"/api/browser-bridge/companions/sync",public:!0},{type:"GET",path:"/api/browser-bridge/tabs"},{type:"GET",path:"/api/browser-bridge/current-page"},{type:"POST",path:"/api/browser-bridge/sync"},{type:"POST",path:"/api/browser-bridge/sessions"}],pi=[{type:"GET",path:"/api/browser-bridge/sessions/:id"},{type:"POST",path:"/api/browser-bridge/sessions/:id/confirm"},{type:"POST",path:"/api/browser-bridge/sessions/:id/progress"},{type:"POST",path:"/api/browser-bridge/sessions/:id/complete"},{type:"POST",path:"/api/browser-bridge/companions/:id/revoke"},{type:"POST",path:"/api/browser-bridge/companions/sessions/:id/progress",public:!0},{type:"POST",path:"/api/browser-bridge/companions/sessions/:id/complete",public:!0},{type:"POST",path:"/api/browser-bridge/packages/:browser/build"},{type:"POST",path:"/api/browser-bridge/packages/:browser/open-manager"},{type:"GET",path:"/api/browser-bridge/packages/:browser/download"}];function Gr(){return async(e,t,r)=>{const s=ui(e,t,r??null);await Ca(s)}}const fi=[...di.map(e=>({type:e.type,path:e.path,rawPath:!0,...e.public?{public:!0}:{},handler:Gr()})),...pi.map(e=>({type:e.type,path:e.path,rawPath:!0,...e.public?{public:!0}:{},handler:Gr()}))],wi={name:"@elizaos/plugin-browser",description:"Browser plugin: BROWSER (including action=autofill_login) + MANAGE_BROWSER_BRIDGE; workspace browser command router (electrobun-embedded BrowserView + JSDOM fallback) and Chrome/Safari companion bridge (settings, pairing, tab + page-context sync, packaging artifacts).",schema:oi,routes:[...fi,...Ya],services:[Te],providers:[Ea],actions:[...kr(En),...kr(Ln)],autoEnable:{shouldEnable:(e,t)=>{const r=t?.features?.browser;return r===!0||typeof r=="object"&&r!==null&&r.enabled!==!1}},async dispose(e){await e.getService(Te.serviceType)?.stop()}},mi=[Vt,Te,_n,En,fr,Ln,wi,Ve,Wa,La],bi=globalThis;bi.__bundle_safety_PLUGINS_PLUGIN_BROWSER_SRC_INDEX__=mi;export{Ii as BROWSER_BRIDGE_ACTION_KINDS,Pi as BROWSER_BRIDGE_COMPANION_AUTH_ERROR_CODES,Ni as BROWSER_BRIDGE_COMPANION_CONNECTION_STATES,Wi as BROWSER_BRIDGE_KINDS,Er as BROWSER_BRIDGE_PACKAGE_PATH_TARGETS,Ht as BROWSER_BRIDGE_ROUTE_SERVICE_TYPE,Li as BROWSER_BRIDGE_SITE_ACCESS_MODES,fr as BROWSER_BRIDGE_SUBACTIONS,$i as BROWSER_BRIDGE_TRACKING_MODES,Vt as BROWSER_SERVICE_TYPE,Bo as BROWSER_WORKSPACE_CONNECTOR_AUTH_STATES,Si as BrowserBridgeAdapter,Te as BrowserService,Ve as FRAME_FILE,I as PasswordManagerError,Oo as __resetBrowserWorkspaceStateForTests,cs as acquireBrowserWorkspaceConnectorSession,Ei as authenticateBrowserBridgeCompanionCredential,En as browserAction,oe as browserBridgeCompanionAuthFailure,ei as browserBridgeCompanions,ni as browserBridgePageContexts,oi as browserBridgeSchema,ti as browserBridgeSettings,ri as browserBridgeTabs,kt as browserPgSchema,wi as browserPlugin,Nn as buildBrowserBridgeCompanionPackage,Gs as buildBrowserBridgeReleaseManifestForVersion,_i as clearPasswordManagerBackendCache,ot as closeBrowserWorkspaceTab,wa as detectPasswordManagerBackend,gt as evaluateBrowserWorkspaceTab,_n as executeBrowserAutofillLogin,ht as executeBrowserWorkspaceCommand,Xs as getBrowserBridgeCompanionDownloadFile,he as getBrowserBridgeCompanionPackageStatus,Bi as getBrowserCaptureExecutablePath,_ as getBrowserWorkspaceMode,yn as getBrowserWorkspaceSnapshot,mt as getBrowserWorkspaceUnavailableMessage,Ca as handleBrowserBridgeRoutes,xi as hasFrameFile,ir as hideBrowserWorkspaceTab,Ri as injectCredentialToClipboard,Ti as isBrowserCaptureRunning,Pa as isBrowserCaptureSupported,y as isBrowserWorkspaceBridgeConfigured,$ as listBrowserWorkspaceTabs,Ai as listPasswordItems,Ln as manageBrowserBridgeAction,ar as navigateBrowserWorkspaceTab,pr as openBrowserBridgeCompanionManager,dr as openBrowserBridgeCompanionPackagePath,pe as openBrowserWorkspaceTab,ye as rateLimitRequest,Ks as resolveBrowserBridgeCompanionPackagePath,Pn as resolveBrowserBridgeExtensionPath,Lr as resolveBrowserBridgeReleaseManifest,or as resolveBrowserWorkspaceBridgeConfig,bn as resolveBrowserWorkspaceConnectorPartition,vi as searchPasswordItems,Ie as showBrowserWorkspaceTab,st as snapshotBrowserWorkspaceTab,Wa as startBrowserCapture,La as stopBrowserCapture};
//# sourceMappingURL=index-DvspGyIr.js.map
