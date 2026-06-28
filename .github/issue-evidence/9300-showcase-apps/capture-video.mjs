/**
 * Screen-recording walkthrough of both example apps' user journeys (#9300).
 *
 * Boots EDAD + Clone Ur Crush and records a Playwright .webm of each app's real
 * user journey into this directory — the "screen recorded" half of the #9300
 * aesthetic/UX review (the screenshots come from capture.mjs).
 *
 *   - edad-journey.webm        : landing → type a question → send → the
 *                                login-gated in-character error reply.
 *   - clone-ur-crush-journey.webm : onboarding step 1 (name) → Next → step 2
 *                                (the monetized "Generate" surface).
 *
 * Run from the cloud-e2e package so Playwright's chromium resolves:
 *   node .github/issue-evidence/9300-showcase-apps/capture-video.mjs
 */

import { spawn } from "node:child_process";
import { readdir, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const OUT = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(OUT, "../../..");
const EDAD_PORT = 4320;
const CRUSH_PORT = 3012;

function waitForPort(url, timeoutMs = 240_000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
        if (res.status < 500) return resolve(true);
      } catch {}
      if (Date.now() - start > timeoutMs)
        return reject(new Error(`timeout ${url}`));
      setTimeout(tick, 1000);
    };
    tick();
  });
}

const procs = [];
function boot(cmd, args, env = {}) {
  procs.push(
    spawn(cmd, args, {
      cwd: REPO,
      env: { ...process.env, ...env },
      stdio: "inherit",
    }),
  );
}

/** Record one journey to <name>.webm. */
async function record(browser, name, journey) {
  const ctx = await browser.newContext({
    viewport: { width: 1100, height: 820 },
    recordVideo: { dir: OUT, size: { width: 1100, height: 820 } },
  });
  const page = await ctx.newPage();
  try {
    await journey(page);
  } finally {
    await page.close();
    await ctx.close(); // flushes the video file
  }
  // Playwright names videos by a random hash; rename the newest .webm.
  const webms = (await readdir(OUT))
    .filter((f) => f.endsWith(".webm") && !f.startsWith(`${name}.`))
    .map((f) => ({ f, t: f }));
  if (webms.length) {
    // pick the most recently created unnamed video
    const { statSync } = await import("node:fs");
    webms.sort(
      (a, b) =>
        statSync(path.join(OUT, b.f)).mtimeMs -
        statSync(path.join(OUT, a.f)).mtimeMs,
    );
    await rename(path.join(OUT, webms[0].f), path.join(OUT, `${name}.webm`));
    console.log(`recorded ${name}.webm`);
    return;
  }
  throw new Error(`Playwright did not create a video for ${name}`);
}

async function main() {
  boot("bun", ["run", "packages/examples/cloud/edad/server.ts"], {
    PORT: String(EDAD_PORT),
  });
  boot("bun", [
    "run",
    "--cwd",
    "packages/examples/cloud/clone-ur-crush",
    "dev",
  ]);
  await waitForPort(`http://127.0.0.1:${EDAD_PORT}/health`);

  const browser = await chromium.launch();

  await record(browser, "edad-journey", async (page) => {
    await page.goto(`http://127.0.0.1:${EDAD_PORT}/`, {
      waitUntil: "networkidle",
    });
    await page.waitForTimeout(1200);
    await page.fill("#input", "dad, how do I file my taxes?");
    await page.waitForTimeout(600);
    await page.click("#send-btn");
    await page.waitForTimeout(2000);
  });

  await waitForPort(`http://127.0.0.1:${CRUSH_PORT}`, 240_000);
  await record(browser, "clone-ur-crush-journey", async (page) => {
    await page.goto(`http://127.0.0.1:${CRUSH_PORT}/`, {
      waitUntil: "networkidle",
    });
    await page.waitForTimeout(2000);
    await page.fill("input", "Ashley");
    await page.waitForTimeout(700);
    const next = page.getByRole("button", { name: /next/i });
    if ((await next.count()) === 0) {
      throw new Error("clone-ur-crush Next button not found");
    }
    await next.first().click();
    await page.waitForTimeout(2000);
  });

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
