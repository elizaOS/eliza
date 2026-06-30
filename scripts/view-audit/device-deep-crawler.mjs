/**
 * DEVICE deep crawler — the deep (tabs/modals/sub-pages) crawl on the STABLE
 * built APK via CDP, where there is no HMR/reconnect noise (unlike the web dev
 * server). Per view: re-navigate fresh, then click every enabled non-destructive
 * tab/card/button, capturing on-device exceptions + error-boundary + render-state
 * in the resulting sub-page. Restart-tolerant: if the app process recycles, it
 * re-resolves the CDP target and continues from the next view.
 *
 * Usage: bun device-deep-crawler.mjs --cdp http://127.0.0.1:9222 --out <dir>
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { ROUTES } from "./routes.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, v, i, arr) => {
    if (v.startsWith("--")) a.push([v.slice(2), arr[i + 1]]);
    return a;
  }, []),
);
const OUT = args.out || "/tmp/view-audit/device-deep";
const CDP = args.cdp || "http://127.0.0.1:9222";
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DESTRUCTIVE =
  /delete|remove|reset|disconnect|sign ?out|log ?out|\bclear\b|wipe|revoke|leave|uninstall|deactivate|forget|erase|unpair|trash|destroy|purge|\bdrop\b|stop agent|shut ?down|factory/i;
const ERR_RE =
  /is not a function|cannot read prop|undefined is not|maximum update depth|objects are not valid as a react child|invalid hook call/i; // strict: real JS faults only (not network text)
const MAX = 24;

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
      exc.push((d?.exception?.description || d?.text || "exc").slice(0, 200));
    } else if (
      m.method === "Runtime.consoleAPICalled" &&
      m.params?.type === "error"
    ) {
      const t = (m.params.args || [])
        .map((a) => a.value ?? a.description ?? "")
        .join(" ");
      if (t.trim()) exc.push("console:" + t.slice(0, 200));
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
      sleep(7000).then(() => ({ __timeout: 1 })),
    ]);
  };
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.__timeout || r.__dead) return { __fail: 1 };
    return r.result?.result?.value;
  };
  await new Promise((r) => {
    ws.onopen = r;
    setTimeout(r, 3500);
  });
  await send("Runtime.enable", {});
  return {
    ws,
    ev,
    exc,
    close: () => {
      try {
        ws.close();
      } catch {}
    },
  };
}

const DISCOVER = `(()=>{const lbl=(e)=>((e.getAttribute("aria-label")||e.getAttribute("title")||e.textContent||"").replace(/\\s+/g," ").trim());const vis=(e)=>!!(e.offsetParent||e.getClientRects().length);const seen=new Set();const out=[];const push=(e,k)=>{const l=lbl(e);if(!l||l.length>60)return;const key=k+"|"+l;if(seen.has(key))return;seen.add(key);if(!vis(e)||e.disabled||e.getAttribute("aria-disabled")==="true")return;out.push({l,k});};document.querySelectorAll('[role="tab"]').forEach(e=>push(e,"tab"));document.querySelectorAll('button,[role="button"]').forEach(e=>push(e,"button"));document.querySelectorAll('[data-testid*="-item"],[data-testid*="-card"],[data-testid*="-row"],[role="row"]').forEach(e=>push(e,"item"));return JSON.stringify(out);})()`;
const SNAP = `(()=>{const t=document.body?document.body.innerText:"";return JSON.stringify({len:t.replace(/\\s+/g," ").trim().length,path:location.pathname+location.hash,dialog:!!document.querySelector('[role="dialog"],[role="alertdialog"]'),snip:t.replace(/\\s+/g," ").trim().slice(0,150)});})()`;
const clickByLabel = (l) =>
  `(()=>{const lbl=(e)=>((e.getAttribute("aria-label")||e.getAttribute("title")||e.textContent||"").replace(/\\s+/g," ").trim());const el=[...document.querySelectorAll('button,[role="button"],[role="tab"],[data-testid*="-item"],[data-testid*="-card"],[data-testid*="-row"],[role="row"]')].find(e=>lbl(e)===${JSON.stringify(l)}&&(e.offsetParent||e.getClientRects().length)&&!e.disabled);if(el){el.click();return 1}return 0;})()`;
const nav = (u) =>
  `(()=>{history.pushState(null,"",${JSON.stringify(u)});window.dispatchEvent(new PopStateEvent("popstate"));if(${JSON.stringify(u)}.includes("#"))window.dispatchEvent(new HashChangeEvent("hashchange"));return 1})()`;

async function main() {
  let conn = await connect();
  const results = [];
  for (const [route, slug] of ROUTES) {
    const reconnect = async () => {
      conn.close();
      await sleep(1500);
      for (let t = 0; t < 5; t++) {
        try {
          conn = await connect();
          return true;
        } catch {
          await sleep(2500);
        }
      }
      return false;
    };
    await conn.ev(nav(route));
    await sleep(1700);
    let controls = [];
    try {
      controls = JSON.parse((await conn.ev(DISCOVER)) || "[]");
    } catch {}
    if ((await conn.ev("1")) === undefined) {
      if (!(await reconnect())) break;
    }
    controls = controls.filter((c) => !DESTRUCTIVE.test(c.l)).slice(0, MAX);
    const subs = [];
    for (const c of controls) {
      await conn.ev(nav(route));
      await sleep(900);
      conn.exc.length = 0;
      const clicked = await conn.ev(clickByLabel(c.l));
      await sleep(700);
      let snap = {};
      try {
        snap = JSON.parse((await conn.ev(SNAP)) || "{}");
      } catch {}
      if (snap.__fail || clicked?.__fail) {
        if (!(await reconnect())) {
          break;
        }
        continue;
      }
      const exc = [...new Set(conn.exc)];
      const boundary = !!(
        snap.snip &&
        /something went wrong|failed to load view|is not a function|cannot read prop/i.test(
          snap.snip,
        )
      );
      const realExc = exc.filter((e) => ERR_RE.test(e));
      const navd =
        snap.path && snap.path !== route && snap.path !== route.split("#")[0];
      const isBug =
        realExc.length > 0 ||
        (boundary &&
          /is not a function|cannot read|went wrong/i.test(snap.snip || ""));
      if (isBug || snap.dialog || navd || c.k === "tab") {
        subs.push({
          trigger: c.l,
          kind: c.k,
          result: isBug
            ? "ERROR"
            : snap.dialog
              ? "modal"
              : navd
                ? "subpage"
                : "inplace",
          bug: isBug,
          err:
            realExc[0] ||
            (boundary ? "boundary:" + (snap.snip || "").slice(0, 80) : ""),
          snip: (snap.snip || "").slice(0, 90),
        });
      }
      if (snap.dialog) {
        await conn.ev(
          `(()=>{const b=document.querySelector('[aria-label*="lose" i],[aria-label*="ismiss" i]');if(b)b.click();return 1})()`,
        );
        await sleep(150);
      }
    }
    const bugs = subs.filter((s) => s.bug);
    results.push({
      slug,
      route,
      controls: controls.length,
      subStates: subs.length,
      bugs,
    });
    const line = `${slug.padEnd(20)} ctrls=${String(controls.length).padStart(2)} subStates=${String(subs.length).padStart(2)} BUGS=${bugs.length}${
      bugs.length
        ? " -> " +
          bugs
            .map((b) => `"${b.trigger}"(${b.err.slice(0, 50)})`)
            .join(" | ")
            .slice(0, 150)
        : ""
    }`;
    console.error(line);
    appendFileSync(`${OUT}/progress.log`, line + "\n");
    writeFileSync(
      `${OUT}/report-device-deep.json`,
      JSON.stringify({ count: results.length, results }, null, 2),
    );
  }
  const totalBugs = results.reduce((a, r) => a + r.bugs.length, 0);
  console.error(
    `\nDEVICE DEEP DONE: ${results.length} views, ${results.reduce((a, r) => a + r.subStates, 0)} sub-states, ${totalBugs} real-JS-bug sub-states`,
  );
  conn.close();
}
main().then(
  () => process.exit(0),
  (e) => {
    console.error("ERR:", e.message);
    process.exit(1);
  },
);
