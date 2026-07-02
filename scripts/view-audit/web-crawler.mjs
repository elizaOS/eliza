/**
 * Playwright web view crawler — drives a headless Chromium against the local dev
 * server (UI :2138) through every route, capturing the same per-view signals as
 * the CDP crawler: console errors, page errors, network 4xx/5xx, render-state
 * (error boundary / no-agent / 404 / empty), interactive-element inventory, shot.
 *
 * Usage: bun web-crawler.mjs --url http://127.0.0.1:2138 --out <dir>
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { ROUTES } from "./routes.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, v, i, arr) => {
    if (v.startsWith("--")) a.push([v.slice(2), arr[i + 1]]);
    return a;
  }, []),
);
const BASE = args.url || "http://127.0.0.1:2138";
const OUT = args.out || "/tmp/view-audit/web";
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SNAP = `(()=>{
  const t=document.body?document.body.innerText:"";
  const low=t.toLowerCase();
  const sig={
    errorBoundary: /something went wrong|failed to load|is not a function|cannot read prop|unexpected token|chunkloaderror/i.test(t),
    noAgent: /no agent (is )?(configured|available)|agent is not|no agent connected|not configured/i.test(t),
    notFound: /\\b404\\b|not found|couldn'?t reach|unavailable|markets unavailable|reads blocked/i.test(low),
    offline: /\\boffline\\b|disconnected|not connected/i.test(low),
    emptyish: t.replace(/\\s+/g," ").trim().length < 40,
  };
  const q=(sel)=>[...document.querySelectorAll(sel)];
  const label=(el)=>((el.getAttribute&&(el.getAttribute("aria-label")||el.getAttribute("title")))||el.textContent||el.value||el.placeholder||"").replace(/\\s+/g," ").trim().slice(0,40);
  const buttons=q('button,[role="button"]').map(e=>({l:label(e),d:!!e.disabled||e.getAttribute("aria-disabled")==="true"}));
  const inputs=q('input,textarea,select').map(e=>({l:label(e),type:e.type||e.tagName.toLowerCase(),d:!!e.disabled}));
  const links=q('a[href]').length;
  return {len:t.replace(/\\s+/g," ").trim().length, sig, snip:t.replace(/\\s+/g," ").trim().slice(0,140), buttons, inputs, links, path:location.pathname+location.hash};
})()`;

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    ignoreHTTPSErrors: true,
  });
  const page = await ctx.newPage();

  // Prime auth: force local dev agent active-server so the renderer skips
  // onboarding and reaches the dashboard (mirrors the dev renderer default).
  await page.addInitScript(() => {
    try {
      const local = JSON.stringify({
        id: "local:dev",
        kind: "remote",
        label: "Local dev agent",
        apiBase: "http://127.0.0.1:31337",
      });
      localStorage.setItem("elizaos:active-server", local);
      localStorage.setItem("eliza:first-run-complete", "1");
      localStorage.setItem("eliza:mobile-runtime-mode", "local");
    } catch {}
  });

  await page
    .goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 })
    .catch(() => {});
  await sleep(4000);

  const findings = [];
  for (const [route, slug] of ROUTES) {
    const consoleErrors = [];
    const pageErrors = [];
    const netFailures = [];
    const onConsole = (m) => {
      if (["error", "warning"].includes(m.type())) {
        const txt = m.text().slice(0, 300);
        if (txt.trim() && !/favicon|DevTools/.test(txt))
          consoleErrors.push(`[${m.type()}] ${txt}`);
      }
    };
    const onPageErr = (e) =>
      pageErrors.push(String(e.message || e).slice(0, 300));
    const onResp = (r) => {
      const s = r.status();
      if (s >= 400)
        netFailures.push(
          `${s} ${r
            .url()
            .replace(/^https?:\/\/[^/]+/, "")
            .slice(0, 120)}`,
        );
    };
    page.on("console", onConsole);
    page.on("pageerror", onPageErr);
    page.on("response", onResp);

    await page
      .evaluate((u) => {
        history.pushState(null, "", u);
        window.dispatchEvent(new PopStateEvent("popstate"));
        if (u.includes("#"))
          window.dispatchEvent(new HashChangeEvent("hashchange"));
      }, route)
      .catch(() => {});
    await sleep(2600);

    let parsed = {};
    try {
      parsed = await page.evaluate(SNAP);
    } catch (e) {
      parsed = { __err: String(e.message).slice(0, 80) };
    }
    let shot = null;
    try {
      shot = `${slug}.png`;
      await page.screenshot({ path: `${OUT}/${shot}` });
    } catch {
      shot = null;
    }

    page.off("console", onConsole);
    page.off("pageerror", onPageErr);
    page.off("response", onResp);

    const f = {
      route,
      slug,
      landedPath: parsed.path,
      bodyLen: parsed.len,
      snippet: parsed.snip,
      signals: parsed.sig || {},
      pageErrors: [...new Set(pageErrors)],
      consoleErrors: [...new Set(consoleErrors)].slice(0, 12),
      netFailures: [...new Set(netFailures)].slice(0, 12),
      buttons: parsed.buttons || [],
      inputs: parsed.inputs || [],
      links: parsed.links || 0,
      screenshot: shot,
    };
    findings.push(f);
    const flags = [];
    if (f.signals.errorBoundary) flags.push("ERR-BOUNDARY");
    if (f.pageErrors.length) flags.push(`${f.pageErrors.length}pageerr`);
    if (f.signals.noAgent) flags.push("NO-AGENT");
    if (f.signals.notFound) flags.push("404/unavail");
    if (f.netFailures.length) flags.push(`${f.netFailures.length}net4xx`);
    if (f.signals.emptyish) flags.push("EMPTY");
    const line = `${slug.padEnd(24)} land=${(f.landedPath || "?").padEnd(20)} len=${String(f.bodyLen).padStart(5)} btn=${String(f.buttons.length).padStart(2)} inp=${String(f.inputs.length).padStart(2)} ${flags.join(" ") || "ok"}`;
    console.error(line);
    appendFileSync(`${OUT}/progress.log`, line + "\n");
    writeFileSync(
      `${OUT}/report-web.json`,
      JSON.stringify(
        { surface: "web", count: findings.length, findings },
        null,
        2,
      ),
    );
  }
  await browser.close();
  console.error(`\nWROTE ${OUT}/report-web.json (${findings.length})`);
}
main().then(
  () => process.exit(0),
  (e) => {
    console.error("WEB CRAWLER ERR:", e.message);
    process.exit(1);
  },
);
