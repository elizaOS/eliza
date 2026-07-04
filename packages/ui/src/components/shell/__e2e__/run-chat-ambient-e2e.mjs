/**
 * Real-browser screenshot + video pass for the /chat ambient background — no app
 * server. Bundles chat-ambient-fixture.tsx, loads it in headless Chromium, and
 * captures the gentle warm pulse at each phase (warm-white rim ↔ brand-orange
 * rim) by sampling the 30s CSS animation while recording a .webm; then verifies a
 * reduced-motion load holds a still orange field. Mechanics come from the shared
 * e2e-runner.
 *
 * Run: bun run --cwd packages/ui test:chat-ambient-e2e
 */

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAssertGate,
  createSnapper,
  finishRun,
  renameRecordedVideo,
  withChromium,
  writeFixturePage,
} from "../../../testing/e2e-runner/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "output");
const videoDir = join(outDir, "video");
await mkdir(outDir, { recursive: true });
await mkdir(videoDir, { recursive: true });

const gate = createAssertGate();
const snap = createSnapper({ outDir, prefix: "ambient-" });
const errors = [];

const url = await writeFixturePage({
  entry: join(here, "chat-ambient-fixture.tsx"),
  outDir,
  htmlName: "chat-ambient.html",
  title: "chat ambient e2e",
});

const viewport = { width: 1180, height: 820 };

await withChromium({}, async (browser) => {
  // Phase page: record the 30s warm pulse across its named peaks.
  const context = await browser.newContext({
    viewport,
    recordVideo: { dir: videoDir, size: viewport },
  });
  const phase = await context.newPage();
  phase.on("pageerror", (e) => errors.push(String(e)));
  await phase.goto(url);
  await phase.waitForSelector('[data-testid="app-background-shader"]');
  await phase.waitForTimeout(400);
  gate.assert(
    (await phase.locator('[data-testid="app-background-shader"]').count()) === 1,
    "ambient background mounts",
  );

  // 30s loop: warm-white rim peaks at 0%/100%, brand-orange rim peaks at 50%
  // (15s). Sample each phase by waiting real time between captures.
  await snap(phase, "phase-white-rim"); // ~t=0.4s, warm-white rim peak
  await phase.waitForTimeout(7600);
  await snap(phase, "phase-mid"); // ~t=8s, crossfade
  await phase.waitForTimeout(7000);
  await snap(phase, "phase-orange-rim"); // ~t=15s, brand-orange rim peak
  await phase.close(); // flush the video
  await context.close();

  // Reduced motion: a still orange field (no pulse).
  const rm = await browser.newPage({ viewport });
  rm.on("pageerror", (e) => errors.push(String(e)));
  await rm.emulateMedia({ reducedMotion: "reduce" });
  await rm.goto(url);
  await rm.waitForSelector('[data-testid="app-background-shader"]');
  await rm.waitForTimeout(500);
  await snap(rm, "reduced-motion-still");
  await rm.close();
});

await renameRecordedVideo({ videoDir, outDir, name: "chat-ambient-pulse.webm" });

gate.assert(errors.length === 0, `no uncaught page errors (${errors.length})`);
if (errors.length) for (const e of errors) console.error(`  ⚠ ${e}`);

finishRun({
  failures: gate.failures,
  passMessage: "\nCHAT-AMBIENT E2E PASSED",
  failMessage: `\nCHAT-AMBIENT E2E FAILED (${gate.failures} assertion(s))`,
});
