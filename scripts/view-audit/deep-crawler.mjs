/**
 * DEEP view crawler — goes BEYOND the landing render of each route. Per view it
 * re-navigates fresh, then activates every tab, opens every detail/sub-page, and
 * triggers every modal/dialog (clicking each enabled, visible, non-destructive
 * control), capturing console/page errors + error-boundary + render-state in the
 * RESULTING sub-page. This is the "pages within views" coverage the landing-only
 * crawl missed.
 *
 * Strategy: for each control, re-nav to the view (known state) → click → observe
 * the result (route change = sub-page; role=dialog = modal; body-text delta =
 * tab/expander) → capture errors + a snippet → recover. Parallel across N
 * chromium contexts against the web dev server.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { ROUTES } from "./routes.mjs";

const OUT = "/tmp/view-audit/deep";
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const N = 4;
const MAX_CONTROLS = 30;
const DESTRUCTIVE =
  /delete|remove|reset|disconnect|sign ?out|log ?out|\bclear\b|wipe|revoke|leave|uninstall|deactivate|forget|erase|unpair|trash|destroy|purge|drop\b|stop agent|shut ?down/i;

const ERR_RE =
  /something went wrong|failed to load|is not a function|cannot read prop|undefined is not|unexpected token|chunkloaderror|maximum update depth|objects are not valid as a react child/i;

const DISCOVER = `(()=>{
  const lbl=(e)=>((e.getAttribute("aria-label")||e.getAttribute("title")||e.textContent||"").replace(/\\s+/g," ").trim());
  const vis=(e)=>!!(e.offsetParent||e.getClientRects().length);
  const out=[];
  const seen=new Set();
  const push=(e,kind)=>{const l=lbl(e); if(!l||l.length>60)return; const key=kind+"|"+l; if(seen.has(key))return; seen.add(key);
    if(!vis(e))return; if(e.disabled||e.getAttribute("aria-disabled")==="true")return; out.push({l,kind});};
  document.querySelectorAll('[role="tab"]').forEach(e=>push(e,"tab"));
  document.querySelectorAll('button,[role="button"]').forEach(e=>push(e,"button"));
  document.querySelectorAll('[data-testid*="-item"],[data-testid*="-card"],[data-testid*="-row"],tr[role="button"],li[role="button"],[role="row"]').forEach(e=>push(e,"item"));
  return JSON.stringify(out);
})()`;

const SNAP = `(()=>{
  const t=document.body?document.body.innerText:"";
  const dialog=!!document.querySelector('[role="dialog"],[role="alertdialog"],[data-state="open"][role],.modal');
  return JSON.stringify({len:t.replace(/\\s+/g," ").trim().length, path:location.pathname+location.hash, dialog, snip:t.replace(/\\s+/g," ").trim().slice(0,160)});
})()`;

async function crawlRoutes(ctx, routes, ci) {
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    try {
      localStorage.setItem(
        "elizaos:active-server",
        JSON.stringify({
          id: "local:dev",
          kind: "remote",
          label: "Local dev agent",
          apiBase: "http://127.0.0.1:31337",
        }),
      );
      localStorage.setItem("eliza:first-run-complete", "1");
    } catch {}
  });
  await page
    .goto("http://127.0.0.1:2138", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    })
    .catch(() => {});
  await sleep(3500);
  const goView = async (route) => {
    await page
      .evaluate((u) => {
        history.pushState(null, "", u);
        window.dispatchEvent(new PopStateEvent("popstate"));
        if (u.includes("#"))
          window.dispatchEvent(new HashChangeEvent("hashchange"));
      }, route)
      .catch(() => {});
    await sleep(1400);
  };
  const results = [];
  for (const [route, slug] of routes) {
    await goView(route);
    let controls = [];
    try {
      controls = JSON.parse(await page.evaluate(DISCOVER));
    } catch {}
    controls = controls
      .filter((c) => !DESTRUCTIVE.test(c.l))
      .slice(0, MAX_CONTROLS);
    const subpages = [];
    for (const c of controls) {
      await goView(route); // fresh state before each control
      const errs = [];
      const onC = (m) => {
        if (m.type() === "error") {
          const x = m.text().slice(0, 200);
          if (x.trim() && !/favicon|DevTools|Download the React/.test(x))
            errs.push("console:" + x);
        }
      };
      const onP = (e) =>
        errs.push("pageerror:" + String(e.message || e).slice(0, 200));
      page.on("console", onC);
      page.on("pageerror", onP);
      let clicked = false;
      try {
        const h = await page.evaluateHandle((lab) => {
          const lbl = (e) =>
            (
              e.getAttribute("aria-label") ||
              e.getAttribute("title") ||
              e.textContent ||
              ""
            )
              .replace(/\s+/g, " ")
              .trim();
          return [
            ...document.querySelectorAll(
              'button,[role="button"],[role="tab"],[data-testid*="-item"],[data-testid*="-card"],[data-testid*="-row"],[role="row"]',
            ),
          ].find(
            (e) =>
              lbl(e) === lab &&
              (e.offsetParent || e.getClientRects().length) &&
              !e.disabled,
          );
        }, c.l);
        const el = h.asElement();
        if (el) {
          await el.click({ timeout: 1500 }).catch(() => {});
          clicked = true;
        }
      } catch {}
      await sleep(750);
      let snap = {};
      try {
        snap = JSON.parse(await page.evaluate(SNAP));
      } catch {}
      let boundary = false;
      try {
        boundary = await page.evaluate(
          (re) => new RegExp(re, "i").test(document.body.innerText || ""),
          ERR_RE.source,
        );
      } catch {}
      page.off("console", onC);
      page.off("pageerror", onP);
      if (!clicked) continue;
      const navigated =
        snap.path && snap.path !== route && snap.path !== route.split("#")[0];
      const result = boundary
        ? "ERROR"
        : snap.dialog
          ? "modal"
          : navigated
            ? "subpage"
            : "inplace";
      const bug = boundary || errs.length > 0;
      if (
        bug ||
        result === "modal" ||
        result === "subpage" ||
        c.kind === "tab"
      ) {
        subpages.push({
          trigger: c.l,
          kind: c.kind,
          result,
          to: navigated ? snap.path : undefined,
          errors: [...new Set(errs)].slice(0, 4),
          boundary,
          snip: snap.snip?.slice(0, 90),
        });
      }
      // recover from a modal
      if (snap.dialog) {
        await page.keyboard.press("Escape").catch(() => {});
        await sleep(150);
      }
    }
    const bugs = subpages.filter((s) => s.boundary || s.errors.length);
    const f = {
      slug,
      route,
      controlsTested: controls.length,
      subStatesFound: subpages.length,
      bugs,
    };
    results.push(f);
    const line = `[c${ci}] ${slug.padEnd(20)} ctrls=${String(controls.length).padStart(2)} substates=${String(subpages.length).padStart(2)} BUGS=${bugs.length}${
      bugs.length
        ? " -> " +
          bugs
            .map(
              (b) =>
                b.trigger +
                "(" +
                (b.boundary ? "boundary" : b.errors[0]?.slice(0, 40)) +
                ")",
            )
            .join(" | ")
            .slice(0, 160)
        : ""
    }`;
    console.error(line);
    appendFileSync(`${OUT}/progress.log`, line + "\n");
    writeFileSync(
      `${OUT}/report-c${ci}.json`,
      JSON.stringify(results, null, 2),
    );
  }
  await page.close();
  return results;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const buckets = Array.from({ length: N }, () => []);
  ROUTES.forEach((r, i) => buckets[i % N].push(r));
  const all = await Promise.all(
    buckets.map(async (routes, ci) => {
      const ctx = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        ignoreHTTPSErrors: true,
      });
      const r = await crawlRoutes(ctx, routes, ci).catch((e) => {
        console.error(`ctx ${ci} err:`, e.message);
        return [];
      });
      await ctx.close();
      return r;
    }),
  );
  const flat = all.flat();
  writeFileSync(
    `${OUT}/report-deep.json`,
    JSON.stringify({ count: flat.length, results: flat }, null, 2),
  );
  const totalBugs = flat.reduce((a, f) => a + f.bugs.length, 0);
  console.error(
    `\nDEEP DONE: ${flat.length} views, ${flat.reduce((a, f) => a + f.subStatesFound, 0)} sub-states, ${totalBugs} bug sub-states`,
  );
  await browser.close();
}
main().then(
  () => process.exit(0),
  (e) => {
    console.error("DEEP ERR:", e.message);
    process.exit(1);
  },
);
