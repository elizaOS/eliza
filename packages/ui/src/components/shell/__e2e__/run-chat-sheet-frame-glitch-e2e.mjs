/**
 * #9142 Part-2 — single-frame visual-glitch e2e for the continuous-chat sheet.
 *
 * Part 1 (the *static* invisible-drag-handle regression) is already fixed and
 * guarded. This is the missing Part 2: a harness that catches *transient*
 * glitches — a wrong state that shows for ONE frame mid-animation — which a
 * post-settle screenshot can never see.
 *
 * Animations are ON (no determinism shim). The harness drives a REAL pointer
 * gesture that opens the sheet from its collapsed pill, captures a dense CDP
 * screencast frame burst across the spring transition, and runs two detectors:
 *
 *   1. SINGLE-FRAME FLASH — pixelmatch every consecutive frame pair. A monotonic
 *      animation diffs smoothly; a one-frame flash at frame k is an OUTLIER: it
 *      differs hard from BOTH neighbours while the neighbours agree with each
 *      other (diff(k-1,k+1) ≪ diff(k-1,k), diff(k,k+1)). Flag those k.
 *
 *   2. "TWO PILLS" CROSSFADE — every rAF, sample the EFFECTIVE opacity (product
 *      up the DOM tree) of the pill bar (`chat-pill`) and the grabber bar
 *      (`chat-sheet-grabber`). The component crossfades them with NO overlap
 *      (pill fades out over openProgress [0,0.55]; grabber fades in over
 *      [0.55,0.95]). Assert they are never BOTH visible at once — the exact
 *      "two bars stranded on screen" bug #9142 calls out.
 *
 * A `--canary` run uses a fresh burst as detector input, injects a one-frame
 * wrong state into BOTH detectors, and asserts each FIRES. The preceding
 * non-canary workflow step owns the product gate; the canary owns detector
 * sensitivity and does not duplicate the timing-sensitive product assertion.
 *
 * Evidence (frame burst, per-frame diff overlays, opacity trace, summary, logs)
 * → test-results/evidence/9142-frame-glitch/.
 *
 * Run: bun run --cwd packages/ui test:chat-sheet-frame-glitch-e2e
 *      add --canary to run the self-test that the detectors fire.
 * Exits non-zero on any real glitch or a failed canary.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import {
  stubElizaCore,
  stubNodeBuiltins,
} from "../../../testing/e2e-runner/esbuild-stubs.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..", "..", "..");
const outDir = join(here, "output-frame-glitch");
const evidenceDir = join(
  repoRoot,
  "test-results", "evidence",
  "9142-frame-glitch",
);
const CANARY = process.argv.includes("--canary");

const packageRequire = createRequire(join(repoRoot, "packages", "ui", "package.json"));
const bunStoreRequire = createRequire(
  join(repoRoot, "node_modules", ".bun", "node_modules", "package.json"),
);

function resolveHarnessPackage(name) {
  try {
    return packageRequire.resolve(name);
  } catch (primaryError) {
    try {
      return bunStoreRequire.resolve(name);
    } catch {
      throw new Error(
        `Unable to resolve ${name}. Run bun install from the repo root; ${name} must be available to the Node-run frame-glitch harness.`,
        { cause: primaryError },
      );
    }
  }
}

async function importHarnessPackage(name) {
  return import(pathToFileURL(resolveHarnessPackage(name)).href);
}

const { build } = await importHarnessPackage("esbuild");
const pixelmatchModule = await importHarnessPackage("pixelmatch");
const pixelmatch = pixelmatchModule.default ?? pixelmatchModule;
const { PNG } = await importHarnessPackage("pngjs");

function ensureSharedI18nData() {
  const ensureScript = join(
    repoRoot,
    "packages",
    "app-core",
    "scripts",
    "ensure-shared-i18n-data.mjs",
  );
  if (!existsSync(ensureScript)) return;
  execFileSync(process.execPath, [ensureScript], { stdio: "inherit" });
}

let failures = 0;
function assert(cond, msg) {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures += 1;
  return cond;
}

// Bundle the fixture with the shared shell stubs (same as run-chat-sheet-e2e):
// @elizaos/core + node builtins (dead at render in the browser) → no-op
// proxies. The stubs are type-only esbuild consumers, so this node-run harness
// (which resolves esbuild itself, below) can import them without pulling
// runtime esbuild.
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await mkdir(evidenceDir, { recursive: true });
ensureSharedI18nData();

const result = await build({
  entryPoints: [join(here, "chat-sheet-fixture.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  loader: { ".tsx": "tsx", ".ts": "ts" },
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [stubElizaCore(), stubNodeBuiltins()],
  write: false,
});
const js = result.outputFiles[0].text;
const html = `<!doctype html><html><head><meta charset="utf-8"><title>chat sheet frame-glitch e2e</title>
<script src="https://cdn.tailwindcss.com"></script>
<script>window.process=window.process||{env:{NODE_ENV:"production"},platform:"browser",cwd:function(){return "/"}};</script>
<style>html,body{margin:0;height:100%;background:#0a0d16}</style>
</head><body><div id="root"></div><script>${js}</script></body></html>`;
const htmlPath = join(outDir, "chat-sheet.html");
await writeFile(htmlPath, html);
const url = `file://${htmlPath}`;

// ── DOM probes ───────────────────────────────────────────────────────────────
const chatState = (p) =>
  p.getByTestId("chat-sheet").getAttribute("data-chat-state");

/** Effective opacity of a testid'd element: product of computed opacity up the
 * tree (so an ancestor wrapper's framer-motion opacity is included). 0 if the
 * element is absent. */
const EFFECTIVE_OPACITY_FN = `(sel) => {
  let el = document.querySelector(sel);
  if (!el) return 0;
  let o = 1;
  while (el && el !== document.documentElement) {
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden") return 0;
    o *= Number.parseFloat(s.opacity || "1");
    el = el.parentElement;
  }
  return o;
}`;

// ── Frame-burst capture via CDP screencast ───────────────────────────────────
async function captureTransition(page, drive) {
  const client = await page.context().newCDPSession(page);
  const frames = [];
  client.on("Page.screencastFrame", async (f) => {
    frames.push({ data: f.data, t: f.metadata.timestamp });
    try {
      await client.send("Page.screencastFrameAck", { sessionId: f.sessionId });
    } catch {
      /* page may be tearing down */
    }
  });

  // In-page rAF sampler of the pill/grabber effective opacity + open progress.
  await page.evaluate((effFn) => {
    const eff = eval(`(${effFn})`);
    window.__samples = [];
    const sheet = () => document.querySelector('[data-testid="chat-sheet"]');
    const tick = () => {
      window.__samples.push({
        t: performance.now(),
        pill: eff('[data-testid="chat-pill"]'),
        grabber: eff('[data-testid="chat-sheet-grabber"]'),
        state: sheet()?.getAttribute("data-chat-state") ?? null,
      });
      window.__raf = requestAnimationFrame(tick);
    };
    window.__raf = requestAnimationFrame(tick);
  }, EFFECTIVE_OPACITY_FN);

  await client.send("Page.startScreencast", {
    format: "png",
    everyNthFrame: 1,
  });

  await drive();
  // Let the spring settle and the screencast flush.
  await page.waitForTimeout(700);

  await client.send("Page.stopScreencast");
  const samples = await page.evaluate(() => {
    cancelAnimationFrame(window.__raf);
    return window.__samples;
  });
  await client.detach();
  return { frames, samples };
}

// ── Detector 1: single-frame flash via consecutive-frame pixelmatch ──────────
function decode(b64) {
  return PNG.sync.read(Buffer.from(b64, "base64"));
}
function diffCount(a, b) {
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  // pixelmatch needs equal dims; crop both to the common box.
  const ca = crop(a, w, h);
  const cb = crop(b, w, h);
  const out = new PNG({ width: w, height: h });
  const n = pixelmatch(ca.data, cb.data, out.data, w, h, { threshold: 0.1 });
  return { n, out, w, h };
}
function crop(png, w, h) {
  if (png.width === w && png.height === h) return png;
  const o = new PNG({ width: w, height: h });
  PNG.bitblt(png, o, 0, 0, w, h, 0, 0);
  return o;
}

// Resolve an ffmpeg binary: PATH first (CI ubuntu via `playwright install
// --with-deps`), else Playwright's bundled win64 binary on this box.
function resolveFfmpeg() {
  const tryRun = (bin) => {
    try {
      execFileSync(bin, ["-version"], { stdio: "ignore" });
      return bin;
    } catch {
      return null;
    }
  };
  if (process.env.FFMPEG_PATH && existsSync(process.env.FFMPEG_PATH)) {
    return process.env.FFMPEG_PATH;
  }
  const onPath = tryRun("ffmpeg");
  if (onPath) return onPath;
  const pwDir = join(homedir(), "AppData", "Local", "ms-playwright");
  if (existsSync(pwDir)) {
    for (const d of readdirSync(pwDir)) {
      if (!d.startsWith("ffmpeg")) continue;
      const exe = join(pwDir, d, "ffmpeg-win64.exe");
      if (existsSync(exe)) return exe;
    }
  }
  return null;
}

// Assemble the full frame burst into an animated GIF — a real "screen recording"
// of the transition for the issue. Best-effort: if ffmpeg is unavailable the run
// still passes (the per-frame PNGs + summary remain the primary evidence).
async function recordTransition(allFrames, gifPath) {
  const ffmpeg = resolveFfmpeg();
  if (!ffmpeg) {
    console.log("  (ffmpeg not found — skipping GIF recording)");
    return false;
  }
  const tmp = join(outDir, "gif-frames");
  await mkdir(tmp, { recursive: true });
  for (let i = 0; i < allFrames.length; i += 1) {
    await writeFile(
      join(tmp, `f-${String(i).padStart(4, "0")}.png`),
      Buffer.from(allFrames[i].data, "base64"),
    );
  }
  try {
    // 12fps, scaled to 360px wide with lanczos + a generated palette for clean
    // colors. Two-pass (palettegen → paletteuse) keeps the GIF small + sharp.
    const palette = join(tmp, "palette.png");
    execFileSync(
      ffmpeg,
      ["-y", "-framerate", "12", "-i", join(tmp, "f-%04d.png"),
       "-vf", "scale=360:-1:flags=lanczos,palettegen", palette],
      { stdio: "ignore" },
    );
    execFileSync(
      ffmpeg,
      ["-y", "-framerate", "12", "-i", join(tmp, "f-%04d.png"), "-i", palette,
       "-lavfi", "scale=360:-1:flags=lanczos[x];[x][1:v]paletteuse", gifPath],
      { stdio: "ignore" },
    );
    console.log(`  🎬 recording → ${gifPath}`);
    return true;
  } catch (err) {
    console.log(`  (ffmpeg GIF failed: ${err.message} — skipping)`);
    return false;
  }
}

// ── main ─────────────────────────────────────────────────────────────────────
const browser = await chromium.launch();
const sink = { logs: [], errors: [], requests: [] };
const page = await browser.newPage({ viewport: { width: 420, height: 880 } });
page.on("console", (m) => sink.logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => sink.errors.push(String(e)));
page.on("requestfailed", (r) =>
  sink.requests.push(`FAILED ${r.method()} ${r.url()}`),
);

await page.goto(url);
await page.getByTestId("continuous-chat-overlay").waitFor({ timeout: 15000 });
// Kill the two notorious per-frame false-positive sources for pixel diffing: the
// blinking text caret in the (focused) composer and any rendered cursor. A caret
// toggles ~every 530ms → a one-frame diff its neighbours undo, i.e. a fake
// "flash". We want REAL transient glitches, not the caret.
await page.addStyleTag({
  content: "*, *::before, *::after { caret-color: transparent !important; }",
});
await page.evaluate(() => document.activeElement?.blur?.());
await page.waitForTimeout(300);
const startState = await chatState(page);
console.log(`start state: ${startState}`);

// A flick (fast, no per-step waits → high velocity) snaps the spring to the next
// detent. `dy>0` pulls DOWN (collapse), `dy<0` UP (open).
async function flick(testid, dy) {
  const b = await page.getByTestId(testid).boundingBox();
  if (!b) return false;
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 6; i += 1) await page.mouse.move(cx, cy + (dy * i) / 6);
  await page.mouse.up();
  return true;
}

// Drive a full round-trip that crosses the pill↔grabber crossfade in BOTH
// directions, so the captured burst always contains it regardless of the
// fixture's start state. The pill (CLOSED) and grabber (INPUT+) bars are
// `chat-pill` / `chat-sheet-grabber`; the morph between them is the #9142 locus.
//   1. flick DOWN → collapse to the pill (grabber fades out, pill fades in)
//   2. flick UP   → open from the pill (pill fades out, grabber fades in)
async function driveCrossfade() {
  await flick("chat-sheet-grabber", 160);
  await page.waitForTimeout(650);
  const handle = (await page.getByTestId("chat-pill").count())
    ? "chat-pill"
    : "chat-sheet-grabber";
  await flick(handle, -540);
  await page.waitForTimeout(650);
}

const { frames, samples } = await captureTransition(page, driveCrossfade);
console.log(`captured ${frames.length} frames, ${samples.length} opacity samples`);
const endState = await chatState(page);
console.log(`end state: ${endState}`);

assert(frames.length >= 8, `captured a real frame burst (${frames.length} ≥ 8)`);
assert(
  samples.length >= 8,
  `captured a real opacity trace (${samples.length} ≥ 8)`,
);
assert(sink.errors.length === 0, `no page errors (${sink.errors.length})`);

// Confirm the crossfade was actually exercised (otherwise the test is vacuous).
const pillMax = Math.max(...samples.map((s) => s.pill));
const grabberMax = Math.max(...samples.map((s) => s.grabber));
assert(
  pillMax > 0.6 && grabberMax > 0.6,
  `crossfade exercised: pill swept to ${pillMax.toFixed(2)}, grabber to ${grabberMax.toFixed(2)}`,
);

// Decode frames + per-pair diff counts.
const imgs = frames.map((f) => decode(f.data));
const pairDiff = [];
for (let i = 0; i < imgs.length - 1; i += 1) {
  pairDiff.push(diffCount(imgs[i], imgs[i + 1]));
}

// Detector 1 — single-frame flash.
const FLASH_RATIO = 0.4; // neighbours must agree ≥2.5× closer than to frame k
const NOISE = Math.max(40, 0.0002 * imgs[0].width * imgs[0].height); // ~px floor
function neighbourDiff(k) {
  // diff(frame k-1, frame k+1)
  const d = diffCount(imgs[k - 1], imgs[k + 1]);
  return d.n;
}
// A single-frame flash is only meaningful DURING the animation — a frame showing
// the wrong state mid-morph, a large-diff outlier. Once the spring has settled
// the UI is static and any 1-frame diff is sub-pixel/caret noise, not a glitch.
// Gate on activity (in/out diff a real fraction of the peak movement) so the
// static tail can't produce false positives.
const ACTIVE_FRACTION = 0.25;
function detectFlashes(diffSeq) {
  const peak = Math.max(...diffSeq.map((d) => d.n), 1);
  const hits = [];
  for (let k = 1; k < imgs.length - 1; k += 1) {
    const a = diffSeq[k - 1].n; // diff(k-1,k)
    const b = diffSeq[k].n; // diff(k,k+1)
    if (a < NOISE || b < NOISE) continue;
    if (Math.max(a, b) < ACTIVE_FRACTION * peak) continue; // static tail → skip
    const c = neighbourDiff(k); // diff(k-1,k+1)
    if (c < FLASH_RATIO * Math.min(a, b)) {
      hits.push({ frame: k, in: a, out: b, neighbours: c });
    }
  }
  return hits;
}
const flashes = detectFlashes(pairDiff);
if (CANARY) {
  console.log(
    `  canary seed burst: ${flashes.length} product-frame candidate(s) (informational; product gate ran in the preceding step)`,
  );
} else {
  assert(
    flashes.length === 0,
    `no single-frame flashes (found ${flashes.length}${flashes.length ? `: ${JSON.stringify(flashes)}` : ""})`,
  );
}

// Detector 2 — "two pills": pill and grabber never both visible.
const BOTH_VISIBLE = 0.2;
const overlaps = samples
  .map((s) => ({ ...s, both: Math.min(s.pill, s.grabber) }))
  .filter((s) => s.both > BOTH_VISIBLE);
const worstOverlap = Math.max(0, ...samples.map((s) => Math.min(s.pill, s.grabber)));
if (CANARY) {
  console.log(
    `  canary seed trace: ${overlaps.length} product overlap(s) (informational; product gate ran in the preceding step)`,
  );
} else {
  assert(
    overlaps.length === 0,
    `pill+grabber never stranded together (worst min-opacity ${worstOverlap.toFixed(3)} ≤ ${BOTH_VISIBLE})`,
  );
}

// ── Canary — prove both detectors FIRE on an injected one-frame wrong state ───
if (CANARY) {
  console.log("\n— canary: injecting a one-frame wrong state —");
  // (a) Flash detector: clone the burst and overwrite ONE interior frame with a
  // far-off image (a frame its neighbours undo). The detector must flag it.
  const k = Math.floor(imgs.length / 2);
  const bad = new PNG({ width: imgs[k].width, height: imgs[k].height });
  imgs[k].data.copy(bad.data);
  // paint a big opaque block → guaranteed outlier from both neighbours.
  for (let y = 0; y < bad.height; y += 1) {
    for (let x = 0; x < bad.width; x += 1) {
      const idx = (bad.width * y + x) << 2;
      bad.data[idx] = 255;
      bad.data[idx + 1] = 0;
      bad.data[idx + 2] = 255;
      bad.data[idx + 3] = 255;
    }
  }
  const cImgs = imgs.slice();
  cImgs[k] = bad;
  const cDiff = [];
  for (let i = 0; i < cImgs.length - 1; i += 1)
    cDiff.push(diffCount(cImgs[i], cImgs[i + 1]));
  const cNeighbour = (kk) => diffCount(cImgs[kk - 1], cImgs[kk + 1]).n;
  const cPeak = Math.max(...cDiff.map((d) => d.n), 1);
  let canaryFlash = false;
  for (let kk = 1; kk < cImgs.length - 1; kk += 1) {
    const a = cDiff[kk - 1].n;
    const b = cDiff[kk].n;
    if (a < NOISE || b < NOISE) continue;
    if (Math.max(a, b) < ACTIVE_FRACTION * cPeak) continue;
    if (cNeighbour(kk) < FLASH_RATIO * Math.min(a, b)) canaryFlash = true;
  }
  assert(canaryFlash, "canary: flash detector FIRES on the injected bad frame");

  // (b) Two-pills detector: inject a sample where both bars are fully visible.
  const canarySamples = [...samples, { t: 0, pill: 1, grabber: 1, state: "X" }];
  const canaryOverlap = canarySamples.filter(
    (s) => Math.min(s.pill, s.grabber) > BOTH_VISIBLE,
  );
  assert(
    canaryOverlap.length === 1,
    "canary: two-pills detector FIRES on the injected both-visible sample",
  );
}

// ── Evidence ─────────────────────────────────────────────────────────────────
// Persist a representative subset of frames + the diff overlays for flagged or
// max-change pairs, the opacity trace, logs, and a machine-readable summary.
const keepEvery = Math.max(1, Math.floor(frames.length / 6));
for (let i = 0; i < frames.length; i += keepEvery) {
  await writeFile(
    join(evidenceDir, `frame-${String(i).padStart(3, "0")}.png`),
    Buffer.from(frames[i].data, "base64"),
  );
}
// Overlay for the largest-change pair (the steepest part of the animation).
let peak = 0;
for (let i = 1; i < pairDiff.length; i += 1)
  if (pairDiff[i].n > pairDiff[peak].n) peak = i;
await writeFile(
  join(evidenceDir, `diff-overlay-peak-${peak}-${peak + 1}.png`),
  PNG.sync.write(pairDiff[peak].out),
);
// The full burst as an animated GIF — a real recording of the transition.
const gifPath = join(evidenceDir, "transition.gif");
const recorded = await recordTransition(frames, gifPath);
const summary = {
  issue: 9142,
  part: 2,
  generatedAtNote: "stamp added by the caller (Date.now unavailable in-harness)",
  startState,
  endState,
  frames: frames.length,
  samples: samples.length,
  recording: recorded ? "transition.gif" : null,
  crossfade: { pillMax, grabberMax },
  pairDiffs: pairDiff.map((d) => d.n),
  flashes,
  twoPills: { worstOverlap, violations: overlaps.length },
  opacityTrace: samples.map((s) => ({
    pill: Number(s.pill.toFixed(3)),
    grabber: Number(s.grabber.toFixed(3)),
    state: s.state,
  })),
  pageErrors: sink.errors,
  failedRequests: sink.requests,
  canary: CANARY,
  result: failures === 0 ? "passed" : "failed",
};
await writeFile(
  join(evidenceDir, "summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);
await writeFile(
  join(evidenceDir, "console.log"),
  `${sink.logs.join("\n")}\n`,
);

await browser.close();

console.log(
  `\n${failures === 0 ? "PASS" : "FAIL"} — ${frames.length} frames, peak pair-diff ${pairDiff[peak]?.n}, worst two-pills overlap ${worstOverlap.toFixed(3)}`,
);
console.log(`evidence → ${evidenceDir}`);
process.exit(failures === 0 ? 0 : 1);
