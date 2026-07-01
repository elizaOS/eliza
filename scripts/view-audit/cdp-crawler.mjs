/**
 * CDP view crawler — drives a single webview (Android device/sim via adb-forwarded
 * devtools, or any /json CDP endpoint) through every route and captures, per view:
 *   - uncaught exceptions + console.error/warn (Runtime + Log domains)
 *   - network responses with status >= 400 (Network domain)
 *   - render-state text signals (error boundary / "no agent" / 404 / empty)
 *   - full interactive-element inventory (buttons, inputs, links) with labels + disabled
 *   - a screenshot (always; cheap on-device)
 *
 * Output: a single JSON report + per-route PNGs under the out dir.
 *
 * Usage: bun cdp-crawler.mjs --ws <wsUrl> --out <dir> --label <surface>
 *   or   bun cdp-crawler.mjs --cdp http://127.0.0.1:9222 --out <dir> --label device
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, v, i, arr) => {
    if (v.startsWith("--")) a.push([v.slice(2), arr[i + 1]]);
    return a;
  }, []),
);
const OUT = args.out || "/tmp/view-audit";
const LABEL = args.label || "surface";
mkdirSync(OUT, { recursive: true });

// ---- the route work-list (from dev-route-catalog + app-shell registry + the 9 mobile views) ----
const ROUTES = [
  // builtin shell
  ["/chat", "chat"],
  ["/views", "views-catalog"],
  ["/apps", "apps-catalog"],
  ["/apps/plugins", "plugins"],
  ["/apps/skills", "skills"],
  ["/apps/trajectories", "trajectories"],
  ["/apps/relationships", "relationships"],
  ["/apps/memories", "memories"],
  ["/apps/runtime", "runtime"],
  ["/apps/database", "database"],
  ["/apps/logs", "logs"],
  ["/apps/tasks", "tasks"],
  ["/apps/fine-tuning", "fine-tuning"],
  ["/character", "character"],
  ["/character/documents", "knowledge"],
  ["/wallet", "wallet"],
  ["/browser", "browser"],
  ["/stream", "stream"],
  ["/automations", "automations"],
  ["/rolodex", "rolodex"],
  ["/help", "help"],
  ["/tutorial", "tutorial"],
  // android-gated builtin (present on device)
  ["/camera", "camera"],
  ["/phone", "phone"],
  ["/messages", "messages"],
  ["/contacts", "contacts"],
  // app-shell pages
  ["/orchestrator", "orchestrator"],
  ["/inventory", "wallet.inventory"],
  ["/model-tester", "model-tester"],
  ["/phone-companion", "phone-companion"],
  ["/apps/facewear", "facewear"],
  ["/apps/smartglasses", "smartglasses"],
  // the 9 mobile plugin views fixed this session
  ["/trajectory-logger", "trajectory-logger"],
  ["/hyperliquid", "hyperliquid"],
  ["/polymarket", "polymarket"],
  ["/shopify", "shopify"],
  ["/steward", "steward"],
  ["/companion", "companion"],
  // settings + each section
  ["/settings", "settings"],
  ["/settings#ai-model", "settings.ai-model"],
  ["/settings#voice", "settings.voice"],
  ["/settings#capabilities", "settings.capabilities"],
  ["/settings#apps", "settings.apps"],
  ["/settings#connectors", "settings.connectors"],
  ["/settings#runtime", "settings.runtime"],
  ["/settings#appearance", "settings.appearance"],
  ["/settings#remote-plugins", "settings.remote-plugins"],
  ["/settings#wallet-rpc", "settings.wallet-rpc"],
  ["/settings#updates", "settings.updates"],
  ["/settings#advanced", "settings.advanced"],
  ["/settings#app-permissions", "settings.app-permissions"],
  ["/settings#permissions", "settings.permissions"],
  ["/settings#secrets", "settings.secrets"],
  ["/settings#security", "settings.security"],
];

// ---- resolve the CDP page target ----
async function resolveWs() {
  if (args.ws) return args.ws;
  const base = args.cdp || "http://127.0.0.1:9222";
  const list = await (await fetch(`${base}/json`)).json();
  const page = list.find(
    (t) => t.type === "page" && !/devtools/.test(t.url || ""),
  );
  if (!page) throw new Error("no CDP page target");
  return page.webSocketDebuggerUrl;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const ws = new WebSocket(await resolveWs());
  let id = 0;
  const pending = new Map();
  // per-route event buffers
  let consoleErrors = [];
  let exceptions = [];
  let netFailures = [];

  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
      return;
    }
    // events
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params?.exceptionDetails;
      exceptions.push(
        (d?.exception?.description || d?.text || "exception").slice(0, 300),
      );
    } else if (m.method === "Runtime.consoleAPICalled") {
      if (["error", "warning"].includes(m.params?.type)) {
        const txt = (m.params.args || [])
          .map((a) => a.value ?? a.description ?? "")
          .join(" ")
          .slice(0, 300);
        if (txt.trim()) consoleErrors.push(`[${m.params.type}] ${txt}`);
      }
    } else if (m.method === "Log.entryAdded") {
      const ent = m.params?.entry;
      if (ent && ["error", "warning"].includes(ent.level)) {
        consoleErrors.push(
          `[log:${ent.level}] ${(ent.text || "").slice(0, 200)}`,
        );
      }
    } else if (m.method === "Network.responseReceived") {
      const r = m.params?.response;
      if (r && r.status >= 400) {
        netFailures.push(
          `${r.status} ${(r.url || "").replace(/^https?:\/\/[^/]+/, "").slice(0, 120)}`,
        );
      }
    } else if (m.method === "Network.loadingFailed") {
      const u = m.params?.errorText;
      if (u && !/ERR_ABORTED/.test(u)) netFailures.push(`net-fail ${u}`);
    }
  };

  const send = (method, params) => {
    const mid = ++id;
    ws.send(JSON.stringify({ id: mid, method, params }));
    return Promise.race([
      new Promise((res) => pending.set(mid, res)),
      sleep(8000).then(() => ({ __timeout: method })),
    ]);
  };
  const evalJs = async (expr) => {
    const r = await Promise.race([
      send("Runtime.evaluate", {
        expression: expr,
        awaitPromise: true,
        returnByValue: true,
      }),
      sleep(9000).then(() => ({ __timeout: true })),
    ]);
    if (r.__timeout) return { __timeout: true };
    if (r.result?.exceptionDetails) return { __exc: true };
    return r.result?.result?.value;
  };

  await new Promise((r) => {
    ws.onopen = r;
    setTimeout(r, 4000);
  });
  // Runtime (console + exceptions) + Page (screenshot) only. Network/Log flood the
  // WS during on-device navigation and back up responses; user-visible 4xx/404 is
  // caught by the render-state text signals instead.
  await send("Runtime.enable", {});
  await send("Page.enable", {});
  appendFileSync(
    `${OUT}/progress.log`,
    `[setup] domains enabled, crawling ${ROUTES.length} routes\n`,
  );

  const findings = [];
  for (const [route, slug] of ROUTES) {
    consoleErrors = [];
    exceptions = [];
    netFailures = [];
    // navigate (hash routes need a popstate too)
    await evalJs(
      `(()=>{const u=${JSON.stringify(route)};history.pushState(null,"",u);window.dispatchEvent(new PopStateEvent("popstate"));if(u.includes("#"))window.dispatchEvent(new HashChangeEvent("hashchange"));return 1})()`,
    );
    await sleep(2600);

    // render-state + element inventory in one eval
    const snap = await evalJs(`(()=>{
      const t=document.body?document.body.innerText:"";
      const low=t.toLowerCase();
      const sig={
        errorBoundary: /something went wrong|failed to load|is not a function|cannot read prop|unexpected token/i.test(t),
        noAgent: /no agent (is )?(configured|available)|agent is not|no agent connected|not configured/i.test(t),
        notFound: /\\b404\\b|not found|couldn'?t reach|unavailable|markets unavailable|reads blocked/i.test(low),
        offline: /\\boffline\\b|disconnected|not connected/i.test(low),
        emptyish: t.replace(/\\s+/g," ").trim().length < 40,
      };
      const q=(sel)=>[...document.querySelectorAll(sel)];
      const label=(el)=>((el.getAttribute&&(el.getAttribute("aria-label")||el.getAttribute("title")))||el.textContent||el.value||el.placeholder||"").replace(/\\s+/g," ").trim().slice(0,40);
      const buttons=q('button,[role="button"]').map(e=>({l:label(e),d:!!e.disabled||e.getAttribute("aria-disabled")==="true"}));
      const inputs=q('input,textarea,select').map(e=>({l:label(e),type:e.type||e.tagName.toLowerCase(),d:!!e.disabled}));
      const links=q('a[href]').map(e=>({l:label(e),href:(e.getAttribute("href")||"").slice(0,60)}));
      return JSON.stringify({len:t.replace(/\\s+/g," ").trim().length, sig, snip:t.replace(/\\s+/g," ").trim().slice(0,140), buttons, inputs, links, path:location.pathname+location.hash});
    })()`);
    let parsed = {};
    try {
      parsed = JSON.parse(snap);
    } catch {
      parsed = { __unparsed: String(snap).slice(0, 120) };
    }

    // screenshot (heavy over CDP on-device — skip with --no-shots to avoid the
    // memory/load buildup that restarts the app mid-crawl)
    let shot = null;
    if (args["no-shots"] === undefined) {
      try {
        const cap = await send("Page.captureScreenshot", { format: "png" });
        if (cap.result?.data) {
          shot = `${slug}.png`;
          writeFileSync(
            `${OUT}/${shot}`,
            Buffer.from(cap.result.data, "base64"),
          );
        }
      } catch {}
    }

    const f = {
      route,
      slug,
      landedPath: parsed.path,
      bodyLen: parsed.len,
      snippet: parsed.snip,
      signals: parsed.sig || {},
      exceptions: [...new Set(exceptions)],
      consoleErrors: [...new Set(consoleErrors)].slice(0, 12),
      netFailures: [...new Set(netFailures)].slice(0, 12),
      buttons: parsed.buttons || [],
      inputs: parsed.inputs || [],
      links: (parsed.links || []).length,
      screenshot: shot,
    };
    findings.push(f);
    const flags = [];
    if (f.signals.errorBoundary) flags.push("ERR-BOUNDARY");
    if (f.exceptions.length) flags.push(`${f.exceptions.length}exc`);
    if (f.signals.noAgent) flags.push("NO-AGENT");
    if (f.signals.notFound) flags.push("404/unavail");
    if (f.netFailures.length) flags.push(`${f.netFailures.length}net4xx`);
    if (f.signals.emptyish) flags.push("EMPTY");
    const line = `${slug.padEnd(24)} len=${String(f.bodyLen).padStart(5)} btn=${String(f.buttons.length).padStart(2)} inp=${String(f.inputs.length).padStart(2)} ${flags.join(" ") || "ok"}`;
    console.error(line);
    appendFileSync(`${OUT}/progress.log`, line + "\n");
    // incremental write so partial results survive a hang/termination
    writeFileSync(
      `${OUT}/report-${LABEL}.json`,
      JSON.stringify(
        { surface: LABEL, count: findings.length, findings },
        null,
        2,
      ),
    );
  }
  console.error(
    `\nWROTE ${OUT}/report-${LABEL}.json (${findings.length} routes)`,
  );
  ws.close();
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error("CRAWLER ERROR:", e.message);
    process.exit(1);
  },
);
