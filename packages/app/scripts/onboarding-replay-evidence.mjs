/**
 * Headless evidence driver for the dev-gated `?onboarding-replay=1` boot
 * wiring (#14382). Runs against an already-booted dev stack (dev-ui.mjs) and
 * proves, in the real app, that:
 *
 *  1. a fully-onboarded agent shows the main app (not onboarding),
 *  2. appending `?onboarding-replay=1` re-renders onboarding,
 *  3. the replay destroys nothing — server first-run status stays complete,
 *     the persisted active-server survives, the durable force-fresh key is
 *     never written, and dropping the param restores the main app.
 *
 * Usage:
 *   ELIZA_UI_PORT=2190 node scripts/onboarding-replay-evidence.mjs --out <dir>
 *
 * Exits non-zero when any invariant breaks; writes numbered screenshots and a
 * summary.json into the output directory for PR evidence.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { chromium } from "@playwright/test";

const UI_PORT = process.env.ELIZA_UI_PORT || "2190";
const BASE = `http://127.0.0.1:${UI_PORT}`;
const outFlag = process.argv.indexOf("--out");
const OUT =
  outFlag > -1
    ? process.argv[outFlag + 1]
    : join(import.meta.dirname, "..", "test-results", "onboarding-replay");
mkdirSync(OUT, { recursive: true });

const failures = [];
function check(name, ok, detail) {
  const line = `${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`;
  console.log(line);
  if (!ok) failures.push(line);
}

async function snapshotState(page, label) {
  const state = await page.evaluate(async () => {
    const status = await fetch("/api/first-run/status").then((r) => r.json());
    return {
      serverFirstRunStatus: status,
      activeServer: window.localStorage.getItem("elizaos:active-server"),
      durableForceFresh: window.localStorage.getItem(
        "elizaos:first-run:force-fresh",
      ),
      firstRunComplete: window.localStorage.getItem("eliza:first-run-complete"),
      replayBadge: window.sessionStorage.getItem(
        "elizaos:onboarding-replay:active",
      ),
      localStorageKeys: Object.keys(window.localStorage).sort(),
    };
  });
  console.log(`\n[${label}]`, JSON.stringify(state, null, 2));
  return state;
}

// The startup coordinator polls the backend with backoff, so the shell can sit
// on "Booting up…" for a while before the session resolves. Wait it out.
async function settle(page) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page
    .waitForFunction(
      () => !document.body.innerText.includes("Booting up"),
      undefined,
      { timeout: 90_000 },
    )
    .catch(() => {});
  await page.waitForTimeout(3000);
}

async function waitForOnboardingSurface(page) {
  return page
    .waitForSelector('[data-testid="chat-first-run-backdrop"]', {
      timeout: 90_000,
    })
    .then(() => true)
    .catch(() => false);
}

const browser = await chromium.launch();
// EVIDENCE_VIDEO=1 records the whole three-phase drive as a webm in OUT
// (convert to MP4 for the PR — GitHub renders MP4 inline).
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  ...(process.env.EVIDENCE_VIDEO === "1"
    ? { recordVideo: { dir: OUT, size: { width: 1440, height: 900 } } }
    : {}),
});
const consoleLog = [];
page.on("console", (msg) =>
  consoleLog.push(`[${msg.type()}] ${msg.text().slice(0, 400)}`),
);

// ── Phase 1: onboarded main app (the "real agent" baseline) ───────────────
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await settle(page);
await page.screenshot({
  path: join(OUT, "01-onboarded-main-app.png"),
  fullPage: true,
});
const before = await snapshotState(page, "before replay");
check(
  "baseline: server reports onboarding complete",
  before.serverFirstRunStatus?.complete === true,
  JSON.stringify(before.serverFirstRunStatus),
);
const onboardingVisibleBaseline = await page
  .locator('[data-testid="chat-first-run-backdrop"]')
  .isVisible()
  .catch(() => false);
check(
  "baseline: onboarding NOT showing on the onboarded agent",
  !onboardingVisibleBaseline,
  `chat-first-run-backdrop visible=${onboardingVisibleBaseline}`,
);

// ── Phase 2: replay — onboarding re-renders on the same agent ─────────────
await page.goto(`${BASE}/?onboarding-replay=1`, {
  waitUntil: "domcontentloaded",
});
const onboardingVisibleDuring = await waitForOnboardingSurface(page);
await page.waitForTimeout(3000);
await page.screenshot({
  path: join(OUT, "02-replay-onboarding.png"),
  fullPage: true,
});
const during = await snapshotState(page, "during replay");
check(
  "replay: session badge set",
  during.replayBadge === "1",
  `sessionStorage badge=${during.replayBadge}`,
);
check(
  "replay: SERVER first-run status still complete (nothing destroyed)",
  during.serverFirstRunStatus?.complete === true,
  JSON.stringify(during.serverFirstRunStatus),
);
check(
  "replay: durable force-fresh key never written",
  during.durableForceFresh === null,
  `durable=${during.durableForceFresh}`,
);
check(
  "replay: persisted active-server untouched",
  during.activeServer === before.activeServer,
  `before=${before.activeServer} during=${during.activeServer}`,
);
// The user-facing proof the overlay armed: the first-run onboarding surface
// renders again, even though the raw server status above stays complete.
check(
  "replay: onboarding surface visible (overlay armed by boot path)",
  onboardingVisibleDuring,
  `chat-first-run-backdrop visible=${onboardingVisibleDuring}`,
);

// ── Phase 3: drop the param — the real agent is exactly as it was ─────────
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await settle(page);
await page.screenshot({
  path: join(OUT, "03-after-replay-main-app.png"),
  fullPage: true,
});
const after = await snapshotState(page, "after replay");
check(
  "after: server still complete",
  after.serverFirstRunStatus?.complete === true,
  JSON.stringify(after.serverFirstRunStatus),
);
check(
  "after: active-server identical",
  after.activeServer === before.activeServer,
  `before=${before.activeServer} after=${after.activeServer}`,
);
const onboardingVisibleAfter = await page
  .locator('[data-testid="chat-first-run-backdrop"]')
  .isVisible()
  .catch(() => false);
check(
  "after: onboarding gone again without the param (overlay lifted)",
  !onboardingVisibleAfter,
  `chat-first-run-backdrop visible=${onboardingVisibleAfter}`,
);

writeFileSync(
  join(OUT, "summary.json"),
  JSON.stringify(
    {
      base: BASE,
      onboardingVisibleBaseline,
      onboardingVisibleDuring,
      onboardingVisibleAfter,
      before,
      during,
      after,
      failures,
    },
    null,
    2,
  ),
);
writeFileSync(join(OUT, "console.log"), consoleLog.join("\n"));

await browser.close();
if (failures.length > 0) {
  console.error(`\n${failures.length} invariant(s) FAILED`);
  process.exit(1);
}
console.log(`\nAll invariants held. Evidence in ${OUT}`);
