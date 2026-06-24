/**
 * Aesthetic-review evidence capture for the two flagship example apps (#9300).
 *
 * Boots EDAD + Clone Ur Crush locally and captures desktop + mobile screenshots
 * (plus EDAD's login-gated send journey) into this directory. This is the
 * "manual aesthetic review of the final HTML output" gate from #9300, run with
 * the same screenshot discipline as cloud-frontend's `audit:cloud`.
 *
 * Run from the cloud-e2e package so Playwright's chromium resolves:
 *   bun run --cwd packages/test/cloud-e2e \
 *     -e 'import("../../../.github/issue-evidence/9300-showcase-apps/capture.mjs")'
 * or simply (from repo root, after `bunx playwright install chromium`):
 *   node .github/issue-evidence/9300-showcase-apps/capture.mjs
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "@playwright/test";

const OUT = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(OUT, "../../..");

const EDAD_PORT = 4320;
const CRUSH_PORT = 3012; // clone-ur-crush `dev` script binds this

function waitForPort(url, timeoutMs = 120_000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
        if (res.status < 500) return resolve(true);
      } catch {
        // not up yet
      }
      if (Date.now() - start > timeoutMs) return reject(new Error(`timeout waiting for ${url}`));
      setTimeout(tick, 1000);
    };
    tick();
  });
}

const procs = [];
function boot(cmd, args, env) {
  const p = spawn(cmd, args, { cwd: REPO, env: { ...process.env, ...env }, stdio: "inherit" });
  procs.push(p);
  return p;
}
function spawnIn(cwd, cmd, args, env = {}) {
  const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: "inherit" });
  procs.push(p);
  return p;
}

async function shot(page, name, { width, height }) {
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(600);
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log(`captured ${file}`);
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  // ── EDAD (standalone Bun server + static HTML) — reliable, capture first. ──
  boot("bun", ["run", "packages/examples/cloud/edad/server.ts"], { PORT: String(EDAD_PORT) });
  await waitForPort(`http://127.0.0.1:${EDAD_PORT}/health`);
  await page.goto(`http://127.0.0.1:${EDAD_PORT}/`, { waitUntil: "networkidle" });
  await shot(page, "edad-desktop", { width: 1280, height: 900 });
  // login-gated send journey: type + send → graceful in-character error.
  await page.fill("#input", "dad, how do I file my taxes?");
  await page.click("#send-btn");
  await page.waitForTimeout(1200);
  await shot(page, "edad-desktop-journey", { width: 1280, height: 900 });
  await shot(page, "edad-mobile", { width: 390, height: 844 });

  // ── Clone Ur Crush (Next.js dev) — best-effort; its native `dev` script
  // binds CRUSH_PORT. Never fail the whole run on its boot/compile flakiness. ──
  try {
    boot("bun", ["run", "--cwd", "packages/examples/cloud/clone-ur-crush", "dev"], {});
    await waitForPort(`http://127.0.0.1:${CRUSH_PORT}`, 240_000);
    await page.goto(`http://127.0.0.1:${CRUSH_PORT}/`, { waitUntil: "networkidle" });
    await page.waitForTimeout(2000);
    await shot(page, "clone-ur-crush-desktop", { width: 1280, height: 900 });
    await page.fill("input", "Ashley");
    const next = page.getByRole("button", { name: /next/i });
    if (await next.count()) {
      await next.first().click();
      await page.waitForTimeout(900);
      await shot(page, "clone-ur-crush-desktop-step2", { width: 1280, height: 900 });
    }
    await page.goto(`http://127.0.0.1:${CRUSH_PORT}/`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    await shot(page, "clone-ur-crush-mobile", { width: 390, height: 844 });
  } catch (err) {
    console.error(`[clone-ur-crush capture skipped] ${err?.message ?? err}`);
  }

  await browser.close();
}

main()
  .then(() => {
    for (const p of procs) p.kill("SIGTERM");
    console.log("done");
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    for (const p of procs) p.kill("SIGTERM");
    process.exit(1);
  });
