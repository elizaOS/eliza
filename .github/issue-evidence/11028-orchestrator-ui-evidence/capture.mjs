// Evidence capture for the orchestrator surfaces (#11028 campaign).
//
// Run from packages/app (playwright is a devDependency there) against a live
// dev stack (`bun run dev`, UI on :2138) with a browser profile that has
// completed first-run onboarding:
//
//   PROFILE_DIR=<onboarded-profile> OUT_DIR=<this dir> MODE=desktop DRIVE_TASK=1 \
//     bun .github/issue-evidence/11028-orchestrator-ui-evidence/capture.mjs
//   PROFILE_DIR=<onboarded-profile> OUT_DIR=<this dir> MODE=mobile \
//     bun .github/issue-evidence/11028-orchestrator-ui-evidence/capture.mjs
//
// MODE=desktop records a .webm of the whole walk; DRIVE_TASK=1 additionally
// drives one real coding task through the cockpit (Claude subscription mode)
// and captures its lifecycle.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const OUT = process.env.OUT_DIR;
const PROFILE = process.env.PROFILE_DIR;
const BASE = process.env.BASE_URL ?? "http://127.0.0.1:2138";
const MODE = process.env.MODE ?? "desktop";
const DRIVE_TASK = process.env.DRIVE_TASK === "1";
if (!OUT || !PROFILE) {
  throw new Error("OUT_DIR and PROFILE_DIR are required");
}

const shotDir = join(OUT, MODE);
const flowDir = join(OUT, "flow");
const logDir = join(OUT, "logs");
for (const d of [shotDir, flowDir, logDir, join(OUT, "video")]) {
  mkdirSync(d, { recursive: true });
}

const consoleLines = [];
const desktopViewport = { width: 1440, height: 900 };
const mobileViewport = { width: 390, height: 844 };
const ctx = await chromium.launchPersistentContext(PROFILE, {
  viewport: MODE === "mobile" ? mobileViewport : desktopViewport,
  ...(MODE === "mobile"
    ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
    : {
        recordVideo: { dir: join(OUT, "video"), size: desktopViewport },
      }),
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
page.on("console", (m) =>
  consoleLines.push(`[${MODE}] [${m.type()}] ${m.text()}`),
);
page.on("pageerror", (e) =>
  consoleLines.push(`[${MODE}] [pageerror] ${e.message}`),
);

const settle = async (extraMs = 3000) => {
  await page
    .getByText("Booting up", { exact: false })
    .first()
    .waitFor({ state: "hidden", timeout: 60000 })
    .catch(() => consoleLines.push("[settle] boot splash still visible"));
  await page
    .waitForLoadState("networkidle", { timeout: 20000 })
    .catch(() => consoleLines.push("[settle] networkidle timeout"));
  await page.waitForTimeout(extraMs);
};

const visit = async (slug, path, extraMs = 4000) => {
  await page.goto(BASE + path, { waitUntil: "domcontentloaded" });
  await settle(extraMs);
  await page.screenshot({ path: join(shotDir, `${slug}.png`), fullPage: true });
  console.log(`${MODE} ${slug} @ ${page.url()}`);
};

// ── Rendered surfaces ────────────────────────────────────────────────
await visit("springboard", "/views", 6000);
await visit("task-coordinator", "/task-coordinator");
await visit("orchestrator", "/orchestrator");
await visit("cockpit", "/cockpit", 6000);

// ── Live orchestrator flow (desktop only, DRIVE_TASK=1) ──────────────
if (DRIVE_TASK && MODE === "desktop") {
  const flowShot = async (name) => {
    await page.screenshot({
      path: join(flowDir, `${name}.png`),
      fullPage: true,
    });
    console.log(`flow ${name}`);
  };

  const goal =
    "Create a file named hello.txt containing exactly the text 'hi' in the workspace. Nothing else.";
  const goalInput = page.getByTestId("cockpit-goal-input");
  await goalInput.waitFor({ state: "visible", timeout: 30000 });
  await goalInput.fill(goal);
  const claudeMode = page.getByTestId("cockpit-mode-claude");
  await claudeMode.click();
  await page.waitForTimeout(1000);
  await flowShot("01-cockpit-form-filled");

  await page.getByTestId("cockpit-start-button").click();
  console.log("clicked Start agent");
  // Wait for the task record + session to land server-side.
  let taskId = null;
  for (let i = 0; i < 60; i++) {
    const res = await fetch(`${BASE}/api/orchestrator/tasks`);
    const body = await res.json().catch(() => null);
    const tasks = Array.isArray(body?.tasks) ? body.tasks : [];
    if (tasks.length > 0) {
      taskId = tasks[0].id ?? null;
      console.log(
        "task visible:",
        JSON.stringify({ id: tasks[0].id, status: tasks[0].status }),
      );
      break;
    }
    await page.waitForTimeout(2000);
  }
  await page.waitForTimeout(3000);
  await flowShot("02-cockpit-task-created");

  // Drill into the task room → live session pane.
  const card = page.getByText("hello.txt", { exact: false }).first();
  if (await card.isVisible().catch(() => false)) {
    await card.click();
    await page.waitForTimeout(4000);
    await flowShot("03-session-pane-live");
  }

  // Poll to terminal status (≤ 8 min), screenshotting progress.
  let lastStatus = "";
  let shots = 0;
  const deadline = Date.now() + 8 * 60 * 1000;
  while (Date.now() < deadline) {
    const res = await fetch(`${BASE}/api/orchestrator/tasks`);
    const body = await res.json().catch(() => null);
    const task = (Array.isArray(body?.tasks) ? body.tasks : []).find(
      (t) => t.id === taskId,
    );
    const status = task?.status ?? "unknown";
    if (status !== lastStatus) {
      console.log(`task status → ${status}`);
      lastStatus = status;
      shots += 1;
      await flowShot(`04-session-status-${shots}-${status}`);
    }
    if (["done", "failed", "archived"].includes(status)) break;
    await page.waitForTimeout(15000);
  }
  await page.waitForTimeout(3000);
  await flowShot("05-session-final");

  // Show the same task on the deck + the other orchestrator surfaces.
  await page.goto(`${BASE}/cockpit`, { waitUntil: "domcontentloaded" });
  await settle(5000);
  await flowShot("06-cockpit-deck-after");
  await page.goto(`${BASE}/orchestrator`, { waitUntil: "domcontentloaded" });
  await settle(5000);
  await flowShot("07-orchestrator-with-task");
  await page.goto(`${BASE}/task-coordinator`, { waitUntil: "domcontentloaded" });
  await settle(5000);
  await flowShot("08-task-coordinator-with-task");
}

await visit("chat", "/chat", 6000);

const video = MODE === "desktop" ? page.video() : null;
await ctx.close();
if (video) {
  console.log("video:", await video.path());
}
writeFileSync(
  join(logDir, `browser-console.${MODE}.log`),
  `${consoleLines.join("\n")}\n`,
);
console.log("done");
