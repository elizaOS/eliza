#!/usr/bin/env node

/**
 * walkthrough-e2e.mjs — the single runnable entrypoint for the full-journey
 * walkthrough (#10198 / #10204).
 *
 * One command produces the whole evidence bundle:
 *   1. Runs `full-walkthrough.spec.ts` against the ui-smoke live stack, at the
 *      desktop + mobile viewports, in the keyless `mock` lane (default) or the
 *      `--live` lane (real backend agent + model). Tees the runner output and
 *      extracts the backend `[ClassName]` / `[ui-smoke][api]` lines.
 *   2. Runs the per-step vision review (`scripts/ai-qa/review-walkthrough.mjs`)
 *      when ANTHROPIC_API_KEY is present, writing the committed verdict markdown.
 *   3. Stitches ONE human-speed, step-labeled recording per viewport from the
 *      ordered `NN-<step>.png` frames (ffmpeg) into `e2e-recordings/`, with a
 *      contact sheet + a viewer entry — not 25 headless per-test clips.
 *
 * Generated artifacts stay gitignored (`reports/walkthrough/`, `e2e-recordings/`);
 * only the verdict markdown + JOURNEY.md updates are committed. Final reviewed
 * evidence is attached inline to the PR per AGENTS.md.
 *
 * Usage:
 *   node scripts/walkthrough-e2e.mjs [--live] [--viewports desktop,mobile]
 *     [--reuse-server] [--skip-review] [--skip-stitch] [--platform web|ios|android|device]
 */

import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Pick a free localhost TCP port. The repo runs many concurrent ui-smoke
 * stacks (agent worktrees); the default 2138/31337 collide and silently break a
 * mid-journey run, so the walkthrough binds its own isolated ports. */
function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(APP_DIR, "../..");

function parseArgs(argv) {
  const a = {
    live: false,
    viewports: "desktop,mobile",
    reuseServer: false,
    skipReview: false,
    skipStitch: false,
    platform: "web",
    viewerOnly: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--live") a.live = true;
    else if (arg === "--viewports") a.viewports = argv[++i];
    else if (arg === "--reuse-server") a.reuseServer = true;
    else if (arg === "--skip-review") a.skipReview = true;
    else if (arg === "--skip-stitch") a.skipStitch = true;
    else if (arg === "--platform") a.platform = argv[++i];
    else if (arg === "--viewer-only") a.viewerOnly = argv[++i];
  }
  return a;
}

function gitSha() {
  const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Minimal .env.local loader so the live lane can reach the provider key without
 * leaking it into the keyless mock lane. Only used when `--live`. */
function loadEnvFile(file) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    )
      val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}

function which(bin) {
  const r = spawnSync("which", [bin], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(cmd, args, { ...opts });
    let out = "";
    if (child.stdout) {
      child.stdout.on("data", (c) => {
        out += c;
        process.stdout.write(c);
      });
    }
    if (child.stderr) {
      child.stderr.on("data", (c) => {
        out += c;
        process.stderr.write(c);
      });
    }
    child.on("close", (code) => resolveRun({ code, out }));
  });
}

/** A usable drawtext font, but only if THIS ffmpeg build actually has the
 * drawtext filter (many homebrew builds omit libfreetype). When unavailable we
 * stitch without captions — the human-readable pacing is preserved either way. */
function detectFont(ffmpeg) {
  const probe = spawnSync(ffmpeg, ["-hide_banner", "-filters"], {
    encoding: "utf8",
  });
  const hasDrawtext = probe.status === 0 && /\bdrawtext\b/.test(probe.stdout);
  if (!hasDrawtext) return null;
  const candidates = [
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/System/Library/Fonts/SFNS.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/Library/Fonts/Arial.ttf",
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

function escDrawtext(text) {
  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "")
    .replace(/%/g, "")
    .slice(0, 70);
}

/** Stitch one human-speed, step-labeled mp4 from the ordered frames. */
async function stitchViewport({ ffmpeg, runDir, viewport, outDir, font }) {
  const vpDir = join(runDir, viewport);
  if (!existsSync(vpDir)) return null;
  const frames = readdirSync(vpDir)
    .filter((f) => /^\d\d-.*\.png$/.test(f))
    .sort();
  if (!frames.length) return null;

  const clipsDir = join(outDir, `.clips-${viewport}`);
  mkdirSync(clipsDir, { recursive: true });
  const dwell = 2.6; // seconds per step — paced for a human to follow.
  const clipList = [];
  let idx = 0;
  for (const frame of frames) {
    const stepLabel = frame.replace(/\.png$/, "").replace(/-/g, " ");
    const clip = join(clipsDir, `clip-${String(idx).padStart(2, "0")}.mp4`);
    const filters = [
      // pad to even dims and ensure yuv420p compatibility
      "scale=trunc(iw/2)*2:trunc(ih/2)*2",
    ];
    if (font) {
      filters.push(
        `drawbox=x=0:y=ih-44:w=iw:h=44:color=black@0.62:t=fill`,
        `drawtext=fontfile=${font}:text='${escDrawtext(stepLabel)}':x=18:y=ih-32:fontsize=20:fontcolor=white`,
      );
    }
    const args = [
      "-y",
      "-loop",
      "1",
      "-t",
      String(dwell),
      "-i",
      join(vpDir, frame),
      "-vf",
      filters.join(","),
      "-r",
      "30",
      "-pix_fmt",
      "yuv420p",
      "-an",
      clip,
    ];
    const { code } = await run(ffmpeg, args);
    if (code === 0 && existsSync(clip)) clipList.push(clip);
    idx += 1;
  }
  if (!clipList.length) return null;

  const concatFile = join(clipsDir, "concat.txt");
  writeFileSync(
    concatFile,
    clipList.map((c) => `file '${c}'`).join("\n"),
    "utf8",
  );
  const outMp4 = join(outDir, `walkthrough-${viewport}.mp4`);
  const { code } = await run(ffmpeg, [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatFile,
    "-c",
    "copy",
    outMp4,
  ]);
  if (code !== 0 || !existsSync(outMp4)) return null;

  // Contact sheet (tiled frames).
  const contactSheet = join(outDir, `contact-sheet-${viewport}.png`);
  const cols = 5;
  await run(ffmpeg, [
    "-y",
    "-pattern_type",
    "glob",
    "-i",
    join(vpDir, "*.png"),
    "-vf",
    `scale=320:-1,tile=${cols}x${Math.ceil(frames.length / cols)}`,
    "-frames:v",
    "1",
    contactSheet,
  ]);

  return {
    viewport,
    mp4: outMp4,
    contactSheet: existsSync(contactSheet) ? contactSheet : null,
    frameCount: frames.length,
  };
}

/** Per-frame dwell used by {@link stitchViewport}; keep in sync so the viewer's
 * "jump to video" timestamps line up with the stitched MP4. */
const STEP_DWELL_SECONDS = 2.6;

function escHtml(value) {
  return String(value).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
}

function formatClock(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = Math.floor(totalSeconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Copy a viewport's steps.json, per-step screenshots, and logs into the viewer
 * bundle so `outDir` is self-contained (portable evidence). */
function copyViewportArtifacts(runDir, outDir, viewport) {
  const src = join(runDir, viewport);
  if (!existsSync(src)) return;
  const dst = join(outDir, viewport);
  mkdirSync(dst, { recursive: true });
  for (const file of readdirSync(src)) {
    if (/\.(png|json)$/.test(file))
      copyFileSync(join(src, file), join(dst, file));
  }
  const logsSrc = join(src, "logs");
  if (existsSync(logsSrc)) {
    mkdirSync(join(dst, "logs"), { recursive: true });
    for (const file of readdirSync(logsSrc)) {
      copyFileSync(join(logsSrc, file), join(dst, "logs", file));
    }
  }
}

function readViewportSteps(runDir, viewport) {
  const file = join(runDir, viewport, "steps.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Render one step card: thumbnail, route, assertions, error badges, and a
 * "jump to video" link at the step's timestamp in the stitched MP4. */
function renderStepCard(step, viewport, frameIndex) {
  const time = frameIndex * STEP_DWELL_SECONDS;
  const consoleErrors = step.newConsoleErrors?.length ?? 0;
  const serverErrors = step.newServerErrors?.length ?? 0;
  const badge = (label, count) =>
    count > 0
      ? `<span class="bad">${label} ${count}</span>`
      : `<span class="ok">${label} 0</span>`;
  const thumb = step.screenshotRelPath
    ? `<a href="${escHtml(step.screenshotRelPath)}" target="_blank"><img src="${escHtml(step.screenshotRelPath)}" loading="lazy" alt="${escHtml(step.id)}"></a>`
    : '<div class="noshot">skipped</div>';
  const assertions = (step.assertions ?? [])
    .map((a) => `<li>${escHtml(a)}</li>`)
    .join("");
  return `
      <article class="step${step.skipped ? " skipped" : ""}">
        ${thumb}
        <div class="meta">
          <h3>${escHtml(step.n)} · ${escHtml(step.title)}</h3>
          <p class="exp">${escHtml(step.expectation)}</p>
          <p class="route"><code>${escHtml(step.url)}</code></p>
          <p class="badges">
            <a href="#" onclick="jump('vid-${viewport}', ${time.toFixed(2)}); return false;">▶ ${formatClock(time)}</a>
            ${badge("console", consoleErrors)} ${badge("5xx", serverErrors)}
            ${step.skipped ? `<span class="skip">skipped: ${escHtml(step.skipReason ?? "")}</span>` : ""}
          </p>
          ${assertions ? `<details><summary>${step.assertions.length} assertions</summary><ul>${assertions}</ul></details>` : ""}
        </div>
      </article>`;
}

function writeViewerHtml({
  outDir,
  runDir,
  runId,
  lane,
  stitched,
  verdictMdPath,
}) {
  const sections = stitched
    .map((s) => {
      copyViewportArtifacts(runDir, outDir, s.viewport);
      const report = readViewportSteps(runDir, s.viewport);
      const gate = report?.gate;
      const gateLine = gate
        ? `gate ${gate.ok ? "✅" : "❌"} · page/console errors: ${gate.pageAndConsoleErrors ?? 0} · 5xx: ${gate.serverErrors ?? 0}`
        : "gate: (no steps.json)";
      let frameIndex = 0;
      const cards = (report?.steps ?? [])
        .map((step) => {
          const card = renderStepCard(step, s.viewport, frameIndex);
          if (step.screenshotRelPath) frameIndex += 1;
          return card;
        })
        .join("\n");
      return `
    <section>
      <h2>${s.viewport} — ${s.frameCount} captured steps</h2>
      <video id="vid-${s.viewport}" src="walkthrough-${s.viewport}.mp4" controls loop playsinline></video>
      <p class="gate">${gateLine} · <a href="contact-sheet-${s.viewport}.png">contact sheet</a></p>
      <div class="steps">${cards || "<em>(no per-step report — steps.json missing)</em>"}</div>
    </section>`;
    })
    .join("\n");
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Full Walkthrough ${runId}</title>
<style>
body{font-family:system-ui,sans-serif;background:#0d0d0d;color:#eee;max-width:1200px;margin:24px auto;padding:0 16px}
a{color:#ff7a18;text-decoration:none}a:hover{text-decoration:underline}
h1{font-size:20px}h2{font-size:16px;text-transform:capitalize;border-top:1px solid #333;padding-top:16px}
video{max-width:100%;border:1px solid #333;position:sticky;top:8px;background:#000}
.gate{color:#aaa;font-size:13px}
.steps{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px;margin-top:12px}
.step{border:1px solid #262626;border-radius:8px;overflow:hidden;background:#151515}
.step.skipped{opacity:.55}
.step img{width:100%;display:block;border-bottom:1px solid #262626}
.noshot{padding:40px;text-align:center;color:#777;background:#111}
.meta{padding:8px 10px}
.meta h3{font-size:13px;margin:0 0 4px}
.exp{color:#9aa;font-size:12px;margin:0 0 6px}
.route code{font-size:11px;color:#7ab7ff;word-break:break-all}
.badges{display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:12px;margin:6px 0 0}
.ok{color:#4ade80}.bad{color:#f87171;font-weight:600}.skip{color:#fbbf24}
details summary{cursor:pointer;color:#aaa;font-size:12px;margin-top:6px}
details ul{margin:6px 0;padding-left:18px;font-size:12px;color:#bbb}
</style></head>
<body>
<h1>Full Walkthrough — ${runId}</h1>
<p>Lane: <b>${lane}</b> · Verdicts: <code>${escHtml(verdictMdPath)}</code></p>
<p>Each step links its screenshot, route, assertions, console/5xx error counts, and a jump to that moment in the stitched video.</p>
${sections}
<script>
function jump(id, t){var v=document.getElementById(id);if(v){v.currentTime=t;v.play();v.scrollIntoView({behavior:'smooth',block:'center'});}}
</script>
</body></html>`;
  writeFileSync(join(outDir, "index.html"), html, "utf8");
}

/** Re-render the per-step viewer for an already-captured run, without
 * re-walking. Reconstructs the stitched-viewport metadata from the on-disk
 * frames; the MP4s from the original run are reused in place. */
function regenerateViewer(runId, viewports) {
  const runDir = join(REPO_ROOT, "reports", "walkthrough", runId);
  const outDir = join(REPO_ROOT, "e2e-recordings", "app", "walkthrough", runId);
  if (!existsSync(runDir)) {
    console.error(`[walkthrough] no run dir for ${runId} at ${runDir}`);
    return 1;
  }
  mkdirSync(outDir, { recursive: true });
  const stitched = viewports
    .split(",")
    .map((v) => v.trim())
    .map((viewport) => {
      const vpDir = join(runDir, viewport);
      if (!existsSync(vpDir)) return null;
      const frameCount = readdirSync(vpDir).filter((f) =>
        /^\d\d-.*\.png$/.test(f),
      ).length;
      return frameCount ? { viewport, frameCount } : null;
    })
    .filter(Boolean);
  if (!stitched.length) {
    console.error(`[walkthrough] no captured frames under ${runDir}`);
    return 1;
  }
  writeViewerHtml({
    outDir,
    runDir,
    runId,
    lane: runId.endsWith("_live") ? "live" : "mock",
    stitched,
    verdictMdPath: "(regenerated viewer)",
  });
  console.log(`[walkthrough] viewer → ${join(outDir, "index.html")}`);
  return 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.viewerOnly) {
    process.exit(regenerateViewer(args.viewerOnly, args.viewports));
  }

  if (args.platform !== "web") {
    // Native platforms are driven by the device-matrix runner.
    const code = await run(
      process.execPath,
      [
        join(APP_DIR, "scripts", "walkthrough-device-matrix.mjs"),
        ...process.argv.slice(2),
      ],
      { cwd: APP_DIR, env: process.env },
    );
    process.exit(code.code ?? 0);
  }

  const lane = args.live ? "live" : "mock";
  const runId = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19)
    .concat(`_${lane}`);
  const runDir = join(REPO_ROOT, "reports", "walkthrough", runId);
  mkdirSync(join(runDir, "logs"), { recursive: true });

  const childEnv = {
    ...process.env,
    WALKTHROUGH_RUN_ID: runId,
    WALKTHROUGH_LANE: lane,
    WALKTHROUGH_VIEWPORTS: args.viewports,
    WALKTHROUGH_GIT_SHA: gitSha() ?? "",
    WALKTHROUGH_COMMAND: `walkthrough-e2e.mjs --platform web${args.live ? " --live" : ""} --viewports ${args.viewports}`,
  };
  if (args.reuseServer) childEnv.ELIZA_UI_SMOKE_REUSE_SERVER = "1";

  // Isolate ports so a concurrent ui-smoke stack (agent worktrees) can't steal
  // 2138/31337 mid-journey. Honor an explicit override if the caller set one.
  if (!args.reuseServer) {
    const uiPort = process.env.ELIZA_UI_SMOKE_PORT || String(await freePort());
    let apiPort =
      process.env.ELIZA_UI_SMOKE_API_PORT || String(await freePort());
    if (apiPort === uiPort) apiPort = String(await freePort());
    childEnv.ELIZA_UI_SMOKE_PORT = uiPort;
    childEnv.ELIZA_UI_SMOKE_API_PORT = apiPort;
    childEnv.ELIZA_API_PORT = apiPort;
    console.log(`[walkthrough] isolated ports: ui=${uiPort} api=${apiPort}`);
  }

  if (lane === "mock") {
    // Genuinely keyless: force the deterministic stub stack regardless of any
    // provider keys in the environment. Chat is page-mocked by the spec.
    childEnv.ELIZA_UI_SMOKE_FORCE_STUB = "1";
  } else {
    // Live lane: boot the real backend agent + model.
    childEnv.ELIZA_UI_SMOKE_LIVE_STACK = "1";
    delete childEnv.ELIZA_UI_SMOKE_FORCE_STUB;
    const env = {
      ...loadEnvFile(join(REPO_ROOT, ".env")),
      ...loadEnvFile(join(REPO_ROOT, ".env.local")),
    };
    for (const key of [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "GROQ_API_KEY",
      "OPENROUTER_API_KEY",
      "GOOGLE_GENERATIVE_AI_API_KEY",
      "ANTHROPIC_LARGE_MODEL",
      "ANTHROPIC_SMALL_MODEL",
    ]) {
      if (!childEnv[key] && env[key]) childEnv[key] = env[key];
    }
    if (childEnv.ANTHROPIC_API_KEY)
      childEnv.ELIZA_UI_SMOKE_LIVE_PROVIDER = "anthropic";
  }

  console.log(
    `\n=== full-walkthrough: lane=${lane} viewports=${args.viewports} runId=${runId} ===\n`,
  );

  // 1) Run the spec.
  const runnerLog = join(runDir, "logs", "runner.log");
  const result = await run(
    process.execPath,
    [
      join(APP_DIR, "scripts", "run-ui-playwright.mjs"),
      "--config",
      "playwright.ui-smoke.config.ts",
      "test/ui-smoke/full-walkthrough.spec.ts",
    ],
    { cwd: APP_DIR, env: childEnv },
  );
  writeFileSync(runnerLog, result.out, "utf8");

  // Extract backend [ClassName] / [ui-smoke][api] lines.
  const backendLines = result.out
    .split("\n")
    .filter((l) => /\[ui-smoke\]\[api|\[[A-Z][A-Za-z0-9]+\]/.test(l));
  writeFileSync(
    join(runDir, "logs", "backend.txt"),
    backendLines.join("\n") || "(no backend [ClassName] lines captured)\n",
    "utf8",
  );

  const specOk = result.code === 0;
  console.log(
    `\n[walkthrough] spec exit=${result.code} (${specOk ? "PASS" : "FAIL"})`,
  );

  // 2) Vision review (best-effort; gated separately).
  const verdictMd = join(
    REPO_ROOT,
    "packages/app/test/ui-smoke/walkthrough/WALKTHROUGH_VERDICTS.md",
  );
  if (!args.skipReview) {
    const reviewEnv = { ...childEnv };
    if (!reviewEnv.ANTHROPIC_API_KEY) {
      const env = loadEnvFile(join(REPO_ROOT, ".env.local"));
      if (env.ANTHROPIC_API_KEY)
        reviewEnv.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
    }
    await run(
      process.execPath,
      [
        join(REPO_ROOT, "scripts", "ai-qa", "review-walkthrough.mjs"),
        "--run-dir",
        runDir,
        "--verdict-md",
        verdictMd,
      ],
      { cwd: REPO_ROOT, env: reviewEnv },
    );
  }

  // 3) Stitch human-speed recordings.
  const stitched = [];
  if (!args.skipStitch) {
    const ffmpeg = which("ffmpeg");
    if (!ffmpeg) {
      console.warn(
        "[walkthrough] ffmpeg not found — skipping recording stitch (install ffmpeg to enable).",
      );
    } else {
      const outDir = join(
        REPO_ROOT,
        "e2e-recordings",
        "app",
        "walkthrough",
        runId,
      );
      mkdirSync(outDir, { recursive: true });
      const font = detectFont(ffmpeg);
      if (!font)
        console.warn(
          "[walkthrough] ffmpeg lacks the drawtext filter — stitching paced frames without step captions.",
        );
      for (const vp of args.viewports.split(",").map((v) => v.trim())) {
        const s = await stitchViewport({
          ffmpeg,
          runDir,
          viewport: vp,
          outDir,
          font,
        });
        if (s) stitched.push(s);
      }
      if (stitched.length) {
        writeViewerHtml({
          outDir,
          runDir,
          runId,
          lane,
          stitched,
          verdictMdPath: verdictMd,
        });
        console.log(`[walkthrough] recordings → ${outDir}`);
      }
    }
  }

  // 4) Summary.
  console.log("\n=== walkthrough artifact bundle ===");
  console.log(`  run dir:     ${runDir}`);
  console.log(`  steps:       ${runDir}/<viewport>/steps.json`);
  console.log(`  screenshots: ${runDir}/<viewport>/NN-<step>.png`);
  console.log(`  logs:        ${runDir}/logs/ (+ <viewport>/logs/)`);
  if (lane === "live")
    console.log(
      `  trajectory:  ${runDir}/<viewport>/trajectory/chat-step.json`,
    );
  console.log(`  verdicts:    ${verdictMd}`);
  for (const s of stitched) console.log(`  recording:   ${s.mp4}`);
  console.log("");

  process.exit(specOk ? 0 : 1);
}

main().catch((err) => {
  console.error("[walkthrough] fatal", err);
  process.exit(1);
});
