/**
 * Headless checker: loads every Storybook story in isolation and captures
 * render errors (SB error overlay, page errors, console.error).
 *
 * Usage:
 *   node stories/check-stories.mjs [--base http://localhost:6006] [--limit N] [--filter substr] [--globals theme:light]
 */
import { chromium } from "playwright";

const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
};
const base = arg("--base", "http://localhost:6006");
const limit = Number(arg("--limit", "0")) || 0;
const filter = arg("--filter", "");
const globals = arg("--globals", "");

const idsFile = arg("--ids-file", "");
const settle = Number(arg("--settle", "600")) || 600;
const isTransientNavigationError = (message) =>
  /net::ERR_(ABORTED|CONNECTION_REFUSED)|Execution context was destroyed/i.test(
    message,
  );
let ids;
if (idsFile) {
  const fsmod = await import("node:fs");
  ids = fsmod
    .readFileSync(idsFile, "utf8")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
} else {
  const index = await (await fetch(`${base}/index.json`)).json();
  ids = Object.values(index.entries)
    .filter((e) => e.type === "story")
    .map((e) => e.id);
}
if (filter) ids = ids.filter((id) => id.includes(filter));
if (limit) ids = ids.slice(0, limit);

console.log(`Checking ${ids.length} stories at ${base}`);

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1024, height: 768 },
});
const page = await ctx.newPage();

const bad = [];
let n = 0;
for (const id of ids) {
  n++;
  const errs = [];
  const onConsole = (msg) => {
    if (msg.type() === "error") errs.push("console: " + msg.text());
  };
  const onPageErr = (e) => errs.push("pageerror: " + (e?.message || String(e)));
  page.on("console", onConsole);
  page.on("pageerror", onPageErr);
  let overlay = "";
  for (let storyAttempt = 0; storyAttempt < 2; storyAttempt++) {
    errs.length = 0;
    overlay = "";
    try {
      const url = new URL(`${base}/iframe.html`);
      url.searchParams.set("id", id);
      url.searchParams.set("viewMode", "story");
      if (globals) url.searchParams.set("globals", globals);
      let lastGotoError;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await page.goto(url.toString(), {
            waitUntil: "load",
            timeout: 30000,
          });
          lastGotoError = undefined;
          break;
        } catch (e) {
          lastGotoError = e;
          if (!isTransientNavigationError(e.message)) break;
          await page.waitForTimeout(500);
        }
      }
      if (lastGotoError) throw lastGotoError;
      // Let the story render / Vite compile settle.
      await page.waitForTimeout(settle);
      overlay = await page.evaluate(() => {
        const body = document.body;
        if (body && body.classList.contains("sb-show-errordisplay")) {
          const m = document.querySelector("#error-message, .sb-errordisplay");
          return (m?.textContent || "error overlay").trim().slice(0, 400);
        }
        return "";
      });
      break;
    } catch (e) {
      if (storyAttempt === 0 && isTransientNavigationError(e.message)) {
        await page.waitForTimeout(500);
        continue;
      }
      errs.push("goto: " + e.message);
      break;
    }
  }
  page.off("console", onConsole);
  page.off("pageerror", onPageErr);
  // Filter benign noise.
  const realErrs = errs.filter(
    (e) =>
      !/Failed to load resource.*favicon/i.test(e) &&
      !/Download the React DevTools/i.test(e) &&
      !/\[vite\] connect(ing|ed)/i.test(e) &&
      !/Error loading story index/i.test(e) &&
      !/Failed to fetch.*PreviewWeb\.getStoryIndexFromServer/is.test(e) &&
      !/Preview\.onStoriesChanged\(\)`? before initialization/i.test(e) &&
      // ErrorBoundary stories deliberately throw to demonstrate the fallback.
      !/Simulated render failure/i.test(e) &&
      !/The above error occurred in the <Boom>/i.test(e),
  );
  if (overlay || realErrs.length) {
    bad.push({ id, overlay, errs: realErrs.slice(0, 4) });
    process.stdout.write("X");
  } else {
    process.stdout.write(".");
  }
  if (n % 50 === 0) process.stdout.write(` ${n}\n`);
  // Gentle pacing so the dev server's on-demand compiler isn't overwhelmed.
  await page.waitForTimeout(150);
}
process.stdout.write("\n");

await browser.close();

console.log(`\n=== ${bad.length}/${ids.length} stories with issues ===\n`);
for (const b of bad) {
  console.log(`\n## ${b.id}`);
  if (b.overlay) console.log("  OVERLAY: " + b.overlay.replace(/\n/g, " ⏎ "));
  for (const e of b.errs) console.log("  " + e.replace(/\n/g, " ⏎ "));
}

import fs from "node:fs";

fs.writeFileSync(
  new URL("./check-stories-report.json", import.meta.url),
  JSON.stringify(bad, null, 2),
);
console.log(`\nReport: stories/check-stories-report.json`);
