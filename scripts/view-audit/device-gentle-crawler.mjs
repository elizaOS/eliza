/**
 * GENTLE device deep crawler — reliable on-device deep audit that doesn't degrade
 * the webview. Per view: navigate ONCE, settle, capture the landing (errors / 404
 * text / RED-on-screen), then click each non-destructive control IN SEQUENCE with
 * soft recovery (close modals, go back from sub-pages) — NO re-nav-per-click (that
 * is what broke the previous run). Health-checks between views (resets to /chat +
 * reconnects if the webview wedges).
 *
 * "Red on screen" = danger/destructive/error-styled elements (class/role) PLUS a
 * bounded computed-color scan for actual red text/background.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { ROUTES } from "./routes.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, v, i, arr) => {
    if (v.startsWith("--")) a.push([v.slice(2), arr[i + 1]]);
    return a;
  }, []),
);
const OUT = args.out || "/tmp/view-audit/device-gentle";
const CDP = args.cdp || "http://127.0.0.1:9222";
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DESTRUCTIVE =
  /delete|remove|reset|disconnect|sign ?out|log ?out|\bclear\b|wipe|revoke|leave|uninstall|deactivate|forget|erase|unpair|trash|destroy|purge|\bdrop\b|stop agent|shut ?down|factory|delete account/i;
const MAX = args.landing ? 0 : 14; // --landing = no clicking (reliable; just scan each view's landing for red/404/errors)

async function connect() {
  const list = await (await fetch(`${CDP}/json`)).json();
  const page = list.find(
    (t) => t.type === "page" && !/devtools/.test(t.url || ""),
  );
  if (!page) throw new Error("no page target");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const exc = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
      return;
    }
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params?.exceptionDetails;
      exc.push((d?.exception?.description || d?.text || "exc").slice(0, 220));
    } else if (
      m.method === "Runtime.consoleAPICalled" &&
      m.params?.type === "error"
    ) {
      const t = (m.params.args || [])
        .map((a) => a.value ?? a.description ?? "")
        .join(" ");
      if (t.trim()) exc.push("console:" + t.slice(0, 220));
    }
  };
  const send = (method, params) => {
    const mid = ++id;
    try {
      ws.send(JSON.stringify({ id: mid, method, params }));
    } catch {
      return Promise.resolve({ __dead: 1 });
    }
    return Promise.race([
      new Promise((r) => pending.set(mid, r)),
      sleep(8000).then(() => ({ __timeout: 1 })),
    ]);
  };
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.__timeout || r.__dead) return { __fail: 1 };
    if (r.result?.result?.value === undefined && r.result?.exceptionDetails)
      return { __fail: 1 };
    return r.result?.result?.value;
  };
  await new Promise((r) => {
    ws.onopen = r;
    setTimeout(r, 3500);
  });
  await send("Runtime.enable", {});
  return {
    ev,
    exc,
    close: () => {
      try {
        ws.close();
      } catch {}
    },
  };
}

// red-on-screen + 404 + render-state, all in one eval
const SCAN = `(()=>{
  const out=[];const seen=new Set();
  const add=(t,how)=>{t=(t||"").replace(/\\s+/g," ").trim();if(!t)return;const k=how+"|"+t.slice(0,50);if(seen.has(k))return;seen.add(k);out.push(how+": "+t.slice(0,70));};
  document.querySelectorAll('[class*="danger" i],[class*="destructive" i],[class*="text-red" i],[class*="bg-red" i],[class*="border-red" i],[class*="-error" i],[role="alert"],[role="alertdialog"],[data-tone="danger"],[aria-invalid="true"]').forEach(el=>{if(el.offsetParent||el.getClientRects().length)add(el.getAttribute("aria-label")||el.textContent,"red-class");});
  const isRed=(c)=>{const m=(c||"").match(/(\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?/);if(!m)return false;const r=+m[1],g=+m[2],b=+m[3],a=m[4]===undefined?1:+m[4];return a>0.45&&r>150&&g<115&&b<115&&(r-g)>55&&(r-b)>55;};
  let n=0;
  for(const el of document.querySelectorAll('span,p,button,td,th,li,h1,h2,h3,h4,strong,label,a,small')){
    if(n++>1400)break; if(!(el.offsetParent||el.getClientRects().length))continue; if(el.children.length>2)continue;
    const s=getComputedStyle(el); const tx=(el.textContent||"").trim();
    if(isRed(s.color)&&tx){add(tx,"red-text");} else if(isRed(s.backgroundColor)){add(tx||"[red box]","red-bg");}
  }
  const body=document.body?document.body.innerText:"";
  const low=body.toLowerCase();
  const txt404=/\\b404\\b|not found|couldn'?t reach|failed to (load|fetch)|something went wrong|is not a function|cannot read prop/i.test(body);
  return JSON.stringify({reds:out.slice(0,10), txt404, path:location.pathname+location.hash, dialog:!!document.querySelector('[role="dialog"],[role="alertdialog"]'), len:body.replace(/\\s+/g," ").trim().length, snip:body.replace(/\\s+/g," ").trim().slice(0,150)});
})()`;
const DISCOVER = `(()=>{const lbl=(e)=>((e.getAttribute("aria-label")||e.getAttribute("title")||e.textContent||"").replace(/\\s+/g," ").trim());const vis=(e)=>!!(e.offsetParent||e.getClientRects().length);const seen=new Set();const out=[];const push=(e,k)=>{const l=lbl(e);if(!l||l.length>60)return;const key=k+"|"+l;if(seen.has(key))return;seen.add(key);if(!vis(e)||e.disabled||e.getAttribute("aria-disabled")==="true")return;out.push({l,k});};document.querySelectorAll('[role="tab"]').forEach(e=>push(e,"tab"));document.querySelectorAll('button,[role="button"]').forEach(e=>push(e,"button"));document.querySelectorAll('[data-testid*="-item"],[data-testid*="-card"],[data-testid*="-row"],[role="row"]').forEach(e=>push(e,"item"));return JSON.stringify(out);})()`;
const clickByLabel = (l) =>
  `(()=>{const lbl=(e)=>((e.getAttribute("aria-label")||e.getAttribute("title")||e.textContent||"").replace(/\\s+/g," ").trim());const el=[...document.querySelectorAll('button,[role="button"],[role="tab"],[data-testid*="-item"],[data-testid*="-card"],[data-testid*="-row"],[role="row"]')].find(e=>lbl(e)===${JSON.stringify(l)}&&(e.offsetParent||e.getClientRects().length)&&!e.disabled);if(el){el.click();return 1}return 0;})()`;
const closeModal = `(()=>{const b=document.querySelector('[aria-label*="lose" i],[aria-label*="ismiss" i],[data-testid*="close" i]');if(b){b.click();return 1}return 0;})()`;
const nav = (u) =>
  `(()=>{history.pushState(null,"",${JSON.stringify(u)});window.dispatchEvent(new PopStateEvent("popstate"));if(${JSON.stringify(u)}.includes("#"))window.dispatchEvent(new HashChangeEvent("hashchange"));return 1})()`;

async function main() {
  let conn = await connect();
  const reconnect = async () => {
    conn.close();
    await sleep(2000);
    for (let t = 0; t < 6; t++) {
      try {
        conn = await connect();
        return true;
      } catch {
        await sleep(3000);
      }
    }
    return false;
  };
  const health = async () => {
    const r = await conn.ev("location.pathname");
    if (r && r.__fail === undefined) return true;
    return await reconnect();
  };
  const scan = async () => {
    try {
      return JSON.parse((await conn.ev(SCAN)) || "{}");
    } catch {
      return {};
    }
  };

  const FROM = +(args.from || 0),
    TO = +(args.to || ROUTES.length);
  const SLICE = ROUTES.slice(FROM, TO);
  const REPORT = args.report || `${OUT}/report.json`;
  const results = [];
  for (const [route, slug] of SLICE) {
    if (!(await health())) {
      await conn.ev(nav("/chat"));
      await sleep(2500);
    }
    await conn.ev(nav(route));
    await sleep(2400); // settle + data fetch
    conn.exc.length = 0;
    const land = await scan();
    if (land.__fail) {
      if (!(await health())) break;
      continue;
    }
    const landErrs = [...new Set(conn.exc)];
    let controls = [];
    try {
      controls = JSON.parse((await conn.ev(DISCOVER)) || "[]");
    } catch {}
    controls = controls.filter((c) => !DESTRUCTIVE.test(c.l)).slice(0, MAX);

    const subStates = [];
    for (const c of controls) {
      conn.exc.length = 0;
      const ok = await conn.ev(clickByLabel(c.l));
      if (ok && ok.__fail) {
        if (!(await health())) break;
        continue;
      }
      await sleep(800);
      const s = await scan();
      if (s.__fail) {
        if (!(await health())) break;
        await conn.ev(nav(route));
        await sleep(1500);
        continue;
      }
      const errs = [...new Set(conn.exc)];
      const navd = s.path && s.path !== route && s.path !== route.split("#")[0];
      if (
        (s.reds || []).length ||
        errs.length ||
        s.dialog ||
        navd ||
        c.k === "tab"
      ) {
        subStates.push({
          trigger: c.l,
          kind: c.k,
          reds: s.reds || [],
          errors: errs,
          txt404: s.txt404,
          modal: s.dialog,
          navigated: navd ? s.path : null,
          snip: (s.snip || "").slice(0, 90),
        });
      }
      // soft recover
      if (s.dialog) {
        await conn.ev(closeModal);
        await conn.ev("document.activeElement&&document.activeElement.blur()");
        await sleep(250);
        const st = await scan();
        if (st.dialog) {
          await conn.ev(nav(route));
          await sleep(1300);
        }
      } else if (navd) {
        await conn.ev(nav(route));
        await sleep(1300);
      } else {
        await sleep(150);
      }
    }
    const f = {
      slug,
      route,
      landReds: land.reds || [],
      land404: !!land.txt404,
      landErrors: landErrs,
      landSnip: (land.snip || "").slice(0, 100),
      controls: controls.length,
      subStates,
    };
    results.push(f);
    const redTotal =
      f.landReds.length + f.subStates.reduce((a, s) => a + s.reds.length, 0);
    const errTotal =
      f.landErrors.length +
      f.subStates.reduce((a, s) => a + s.errors.length, 0);
    const line = `${slug.padEnd(20)} ctrls=${String(f.controls).padStart(2)} subs=${String(f.subStates.length).padStart(2)} RED=${redTotal} ERR=${errTotal} 404land=${f.land404 ? "Y" : "-"}${f.landReds.length ? " | landRed: " + f.landReds.slice(0, 2).join(" ; ").slice(0, 90) : ""}`;
    console.error(line);
    appendFileSync(`${OUT}/progress.log`, line + "\n");
    writeFileSync(
      REPORT,
      JSON.stringify({ count: results.length, results }, null, 2),
    );
  }
  console.error(`\nGENTLE DONE: ${results.length} views`);
  conn.close();
}
main().then(
  () => process.exit(0),
  (e) => {
    console.error("ERR:", e.message);
    process.exit(1);
  },
);
