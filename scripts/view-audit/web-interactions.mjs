/**
 * Web button/input interaction pass — per view, clicks every enabled, visible,
 * NON-destructive button and types into every text input, capturing JS-level
 * errors (pageerror / error-boundary) that indicate a REAL interaction bug.
 * Network 4xx is ignored (dev-backend config noise); only JS faults count.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { ROUTES } from "./routes.mjs";

const OUT = "/tmp/view-audit/web-interactions";
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DESTRUCTIVE =
  /delete|remove|reset|disconnect|sign out|log ?out|clear|wipe|revoke|leave|uninstall|deactivate|danger|forget|erase|drop|unpair|trash|destroy/i;

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    ignoreHTTPSErrors: true,
  });
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
  await sleep(4000);

  const results = [];
  for (const [route, slug] of ROUTES) {
    const goView = () =>
      page
        .evaluate((u) => {
          history.pushState(null, "", u);
          window.dispatchEvent(new PopStateEvent("popstate"));
          if (u.includes("#"))
            window.dispatchEvent(new HashChangeEvent("hashchange"));
        }, route)
        .catch(() => {});
    await goView();
    await sleep(1500);

    // enumerate enabled, visible, non-destructive buttons + their labels
    let controls = [];
    try {
      controls = await page.evaluate((destrSrc) => {
        const DESTR = new RegExp(destrSrc, "i");
        const lbl = (e) =>
          (
            e.getAttribute("aria-label") ||
            e.getAttribute("title") ||
            e.textContent ||
            ""
          )
            .replace(/\s+/g, " ")
            .trim();
        return [...document.querySelectorAll('button,[role="button"]')]
          .map((e, i) => ({
            i,
            l: lbl(e),
            dis: !!e.disabled || e.getAttribute("aria-disabled") === "true",
            vis: !!(e.offsetParent || e.getClientRects().length),
          }))
          .filter((c) => c.vis && !c.dis && c.l && !DESTR.test(c.l));
      }, DESTRUCTIVE.source);
    } catch {}

    const issues = [];
    const max = Math.min(controls.length, 18);
    for (let k = 0; k < max; k++) {
      const pageErrors = [];
      const onErr = (e) =>
        pageErrors.push(String(e.message || e).slice(0, 200));
      page.on("pageerror", onErr);
      // re-resolve the button each time (DOM may have changed); match by label
      const target = controls[k];
      let clicked = false;
      try {
        const handle = await page.evaluateHandle((lab) => {
          const lbl = (e) =>
            (
              e.getAttribute("aria-label") ||
              e.getAttribute("title") ||
              e.textContent ||
              ""
            )
              .replace(/\s+/g, " ")
              .trim();
          return [...document.querySelectorAll('button,[role="button"]')].find(
            (e) =>
              lbl(e) === lab &&
              (e.offsetParent || e.getClientRects().length) &&
              !e.disabled,
          );
        }, target.l);
        const el = handle.asElement();
        if (el) {
          await el.click({ timeout: 1500 }).catch(() => {});
          clicked = true;
        }
      } catch {}
      await sleep(550);
      // detect error boundary
      let errBoundary = false;
      try {
        errBoundary = await page.evaluate(() =>
          /something went wrong|failed to load|is not a function|cannot read prop/i.test(
            document.body.innerText || "",
          ),
        );
      } catch {}
      page.off("pageerror", onErr);
      if (clicked && (pageErrors.length || errBoundary)) {
        issues.push({
          button: target.l.slice(0, 40),
          jsError: pageErrors[0] || null,
          errorBoundary: errBoundary,
        });
      }
      // recover: if path moved or a dialog/overlay opened, go back to the view + dismiss
      await page.keyboard.press("Escape").catch(() => {});
      const onView = await page
        .evaluate(
          (r) =>
            location.pathname + location.hash === r ||
            location.pathname === r.split("#")[0],
          route,
        )
        .catch(() => true);
      if (!onView) {
        await goView();
        await sleep(900);
      }
    }

    // type into the first few text inputs (smoke: does typing throw?)
    const inputIssues = [];
    try {
      const inputs = await page.$$(
        'input[type="text"],input[type="search"],input:not([type]),textarea',
      );
      for (const inp of inputs.slice(0, 5)) {
        const pe = [];
        const onErr = (e) => pe.push(String(e.message).slice(0, 150));
        page.on("pageerror", onErr);
        await inp.fill("audit-test").catch(() => {});
        await sleep(200);
        page.off("pageerror", onErr);
        if (pe.length) inputIssues.push(pe[0]);
      }
    } catch {}

    const f = {
      slug,
      route,
      buttonsTested: max,
      buttonsAvailable: controls.length,
      buttonIssues: issues,
      inputIssues,
    };
    results.push(f);
    const line = `${slug.padEnd(22)} tested ${String(max).padStart(2)}/${String(controls.length).padStart(2)} btns  issues=${issues.length}  inputErr=${inputIssues.length}${issues.length ? "  -> " + issues.map((x) => x.button).join("|") : ""}`;
    console.error(line);
    appendFileSync(`${OUT}/progress.log`, line + "\n");
    writeFileSync(
      `${OUT}/report-web-interactions.json`,
      JSON.stringify({ count: results.length, results }, null, 2),
    );
  }
  await browser.close();
  console.error("DONE");
}
main().then(
  () => process.exit(0),
  (e) => {
    console.error("ERR:", e.message);
    process.exit(1);
  },
);
