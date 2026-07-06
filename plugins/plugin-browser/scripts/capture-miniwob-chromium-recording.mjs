#!/usr/bin/env node
/**
 * Screen-recording evidence for the real-Chromium MiniWoB++ lane (#10333).
 *
 * Drives the multi-page `multistep-purchase` oracle (home -> catalog -> buy)
 * through a real Chromium step by step, screenshots each step, and stitches the
 * frames into an animated GIF (via ffmpeg) so a reviewer can watch the agent
 * navigate a real browser end to end. Artifacts land under
 * `test-results/evidence/10333-browser-real-chromium/`.
 *
 * Usage (from repo root):  bun plugins/plugin-browser/scripts/capture-miniwob-chromium-recording.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const OUT = join(
  repoRoot,
  "test-results",
  "evidence",
  "10333-browser-real-chromium",
);
mkdirSync(OUT, { recursive: true });
const framesDir = join(OUT, "_frames");
rmSync(framesDir, { recursive: true, force: true });
mkdirSync(framesDir, { recursive: true });

const { createChromiumBenchmarkEngine } = await import(
  "../src/benchmark/chromium-executor.ts"
);
const { BrowserBenchmarkAdapter } = await import("../src/benchmark/adapter.ts");
const { getTaskById } = await import("../src/benchmark/tasks.ts");
const { OraclePolicy } = await import("../src/benchmark/policy.ts");

const SEED = 0;
const task = getTaskById("multistep-purchase");
const engine = await createChromiumBenchmarkEngine({ headless: true });
console.log(`[recording] engine: ${engine.executablePath}`);

const { executor, dispose } = await engine.makeExecutor();
const page = engine.currentPage();
const adapter = new BrowserBenchmarkAdapter(executor, {
  maxTrajectoryLength: task.maxSteps,
  timestampSource: () => 0,
});
const policy = new OraclePolicy();

let frame = 0;
async function snap(label) {
  if (!page) return;
  const f = String(frame).padStart(3, "0");
  await page.screenshot({ path: join(framesDir, `frame-${f}.png`) });
  // hold each meaningful frame for ~1s of GIF (3 duplicate frames @ ~3fps feel)
  frame += 1;
  console.log(`[recording] frame ${f}: ${label}`);
}

await adapter.loadTask(task, SEED);
await snap("start: shop home");
for (let s = 0; s < task.maxSteps && !adapter.isTerminated(); s++) {
  const observation = await adapter.getObservation();
  const action = await policy.act({
    observation,
    task,
    seed: SEED,
    history: adapter.getTrajectory(),
  });
  await adapter.step(action);
  await snap(
    `after: ${action.type} ${action.selector ?? ""} (${action.note ?? ""})`,
  );
}
const reward = await task.reward(adapter.rewardContext(), SEED);
console.log(
  `[recording] reward=${reward} (${reward >= 1 ? "SOLVED" : "FAILED"})`,
);
await dispose();
await engine.close();

// Stitch frames -> GIF (each frame held ~1.1s). Skip cleanly if ffmpeg absent.
const gifPath = join(OUT, "multistep-purchase-walkthrough.gif");
const ff = spawnSync(
  "ffmpeg",
  [
    "-y",
    "-framerate",
    "0.9",
    "-i",
    join(framesDir, "frame-%03d.png"),
    "-vf",
    "scale=800:-1:flags=lanczos",
    gifPath,
  ],
  { stdio: "inherit" },
);
if (ff.status === 0 && existsSync(gifPath)) {
  console.log(`[recording] GIF -> ${gifPath}`);
  rmSync(framesDir, { recursive: true, force: true });
} else {
  console.log("[recording] ffmpeg unavailable — frames kept in _frames/");
}
process.exit(reward >= 1 ? 0 : 1);
