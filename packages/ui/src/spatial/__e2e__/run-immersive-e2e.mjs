/**
 * Immersive WebGL framebuffer-readback e2e (#10722) — no app server, no mocks
 * of the code under test. Bundles immersive-fixture.ts (which drives the REAL
 * `enterImmersiveScene()` production export against the IWER emulated Quest 3
 * runtime) with esbuild, loads it in headless Chromium (real WebGL2), and
 * asserts via `gl.readPixels()` on the session framebuffer that:
 *
 *   - an immersive-vr session enters and the render loop advances frames;
 *   - a green canvas-textured quad lands at the math-predicted per-eye pixel
 *     (texture path — the panel's fallback tone is red, so green proves it);
 *   - a `rasterizePanelToCanvas` content panel renders real drawn content:
 *     the card background AND the title accent rule read back at their
 *     predicted texture-space landmarks (a 1×1 fallback texel cannot do that);
 *   - stereo parallax: the same world point lands at measurably different
 *     viewport-local pixels in the left and right eye;
 *   - an origin-unclean texture source (a cross-origin image drawn without
 *     CORS — served from a second local port) throws a real `SecurityError`
 *     and the production `solidColorTexel` fallback renders the panel tone;
 *   - `refreshTextures()` re-uploads repainted content (green → yellow);
 *   - `end()` tears the session down with no dangling RAF loop (frame counter
 *     frozen) and releases the session (a second `requestSession` succeeds).
 *
 * Run: bun run --cwd packages/ui test:immersive-e2e
 */

import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "output-immersive");
await mkdir(outDir, { recursive: true });

let failures = 0;
function assert(cond, msg) {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures += 1;
  return cond;
}

/** |sample - expected| <= tol on every RGBA channel. */
function closeTo(rgba, expected, tol) {
  return (
    Array.isArray(rgba) &&
    rgba.length === 4 &&
    rgba.every((c, i) => Math.abs(c - expected[i]) <= tol)
  );
}

function fmt(rgba) {
  return `(${rgba.join(",")})`;
}

const result = await build({
  entryPoints: [join(here, "immersive-fixture.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  loader: { ".ts": "ts" },
  define: { "process.env.NODE_ENV": '"production"' },
  write: false,
});
const js = result.outputFiles[0].text;

// Two 127.0.0.1 servers on distinct ports = two distinct origins. The taint
// image is loaded from origin B into a page on origin A without CORS, which
// (per the HTML spec) taints any canvas it is drawn to — the deterministic
// way to drive the production SecurityError → solidColorTexel fallback.
// (An SVG foreignObject snapshot no longer taints in current Chromium.)
const TAINT_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#888"/></svg>';
const taintServer = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "image/svg+xml" });
  res.end(TAINT_SVG);
});
await new Promise((r) => taintServer.listen(0, "127.0.0.1", r));
const taintUrl = `http://127.0.0.1:${taintServer.address().port}/taint.svg`;

const html = `<!doctype html><html><head><meta charset="utf-8"><title>immersive e2e</title>
<style>html,body{margin:0;height:100%;background:#000}</style>
</head><body>
<script>window.__taintImageUrl = ${JSON.stringify(taintUrl)};</script>
<script>${js}</script></body></html>`;
await writeFile(join(outDir, "immersive.html"), html);
const pageServer = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
});
await new Promise((r) => pageServer.listen(0, "127.0.0.1", r));
const pageUrl = `http://127.0.0.1:${pageServer.address().port}/`;

const sink = { pageErrors: [], console: [] };
// SwiftShader flags keep WebGL2 available on GPU-less CI runners; harmless
// where a real GPU/ANGLE backend exists.
const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("pageerror", (e) => sink.pageErrors.push(String(e)));
  page.on("console", (m) => sink.console.push(`[${m.type()}] ${m.text()}`));
  await page.goto(pageUrl);
  await page.waitForFunction(() => window.__immersive?.ready === true, {
    timeout: 15_000,
  });

  // ── Enter: real runtime, real session, real texture uploads ────────────────
  const enter = await page.evaluate(() => window.__immersive.enter());
  assert(enter.capability.present, "navigator.xr present (IWER runtime installed)");
  assert(
    enter.capability.immersiveVR,
    "detectWebXRCapability() reports immersive-vr supported",
  );
  assert(enter.xrWebGLLayerInstalled, "XRWebGLLayer constructor installed");
  assert(
    enter.taintProbe.threw && enter.taintProbe.name === "SecurityError",
    `origin-unclean canvas upload really throws SecurityError (threw=${enter.taintProbe.threw}, name=${enter.taintProbe.name})`,
  );
  assert(
    enter.framesAfterEnter >= 3,
    `render loop advanced ≥3 frames after enter (${enter.framesAfterEnter})`,
  );

  // ── Probe 1: framebuffer readback at math-predicted per-eye pixels ─────────
  const probe1 = await page.evaluate(() => window.__immersive.probe());
  await page.screenshot({ path: join(outDir, "01-immersive-stereo.png") });
  console.log("  📸 01-immersive-stereo.png");

  assert(probe1.views === 2, `viewer pose has 2 views (${probe1.views})`);
  assert(
    probe1.panelsDrawn === 6,
    `3 panels drawn per eye = 6 quads/frame (${probe1.panelsDrawn})`,
  );
  assert(
    probe1.framebufferIsNull,
    "session framebuffer is the canvas default framebuffer (IWER XRWebGLLayer.framebuffer === null)",
  );
  assert(probe1.glError === 0, `gl.getError() clean after readback (${probe1.glError})`);
  const eyes = [...new Set(probe1.samples.map((s) => s.eye))];
  assert(
    eyes.includes("left") && eyes.includes("right"),
    `both eyes probed (${eyes.join(", ")})`,
  );
  const eyeVp = probe1.samples.find((s) => s.eye === "left")?.viewport;
  assert(
    eyeVp && eyeVp.width * 2 === probe1.canvas.width,
    `stereo viewports split the framebuffer (eye ${eyeVp?.width}×${eyeVp?.height}, canvas ${probe1.canvas.width}×${probe1.canvas.height})`,
  );

  const sampleOf = (probe, eye, panel, point) =>
    probe.samples.find((s) => s.eye === eye && s.panel === panel && s.point === point);

  for (const eye of ["left", "right"]) {
    const green = sampleOf(probe1, eye, "green", "center");
    const bg = sampleOf(probe1, eye, "content", "background");
    const accent = sampleOf(probe1, eye, "content", "accent-rule");
    const tainted = sampleOf(probe1, eye, "tainted", "center");
    const clear = sampleOf(probe1, eye, "(none)", "clear");

    for (const s of [green, bg, accent, tainted, clear]) {
      assert(
        s &&
          s.pixel.x >= s.viewport.x &&
          s.pixel.x < s.viewport.x + s.viewport.width &&
          s.pixel.y >= s.viewport.y &&
          s.pixel.y < s.viewport.y + s.viewport.height,
        `[${eye}] ${s?.panel}/${s?.point}: predicted pixel inside the eye viewport (${s?.pixel.x},${s?.pixel.y})`,
      );
    }

    // Texture path, not the red [1,0,0] fallback.
    assert(
      green && green.rgba[1] > 200 && green.rgba[0] < 40 && green.rgba[2] < 40,
      `[${eye}] green canvas texture at predicted pixel — not the red fallback ${fmt(green?.rgba ?? [])}`,
    );
    // rasterizePanelToCanvas content: card background at its landmark…
    assert(
      bg && closeTo(bg.rgba, [255, 0, 255, 255], 12),
      `[${eye}] content panel card background reads magenta ${fmt(bg?.rgba ?? [])}`,
    );
    // …AND the drawn title accent rule — real content, impossible for a 1×1 fallback texel.
    assert(
      accent && closeTo(accent.rgba, [255, 88, 0, 255], 25),
      `[${eye}] content panel accent rule reads brand orange ${fmt(accent?.rgba ?? [])}`,
    );
    // The SecurityError branch fell back to solidColorTexel(panel.color).
    assert(
      tainted && closeTo(tainted.rgba, [255, 153, 0, 255], 12),
      `[${eye}] tainted-source panel renders the solid fallback tone ${fmt(tainted?.rgba ?? [])}`,
    );
    assert(
      clear && closeTo(clear.rgba, [0, 0, 0, 255], 4),
      `[${eye}] off-panel pixel is the loop's clear color ${fmt(clear?.rgba ?? [])}`,
    );
  }

  // Stereo parallax: the same world point lands at different viewport-local x.
  const bgL = sampleOf(probe1, "left", "content", "background");
  const bgR = sampleOf(probe1, "right", "content", "background");
  const parallax = bgL && bgR ? bgL.local.x - bgR.local.x : Number.NaN;
  assert(
    parallax >= 2 && parallax <= 30,
    `ipd parallax between eyes on the same world point (${parallax.toFixed(1)}px)`,
  );

  // ── Probe 2: refreshTextures re-uploads repainted content ──────────────────
  const probe2 = await page.evaluate(() => window.__immersive.refreshAndProbe());
  await page.screenshot({ path: join(outDir, "02-immersive-refreshed.png") });
  console.log("  📸 02-immersive-refreshed.png");
  assert(
    probe2.frames > probe1.frames,
    `render loop still advancing (${probe1.frames} → ${probe2.frames})`,
  );
  for (const eye of ["left", "right"]) {
    const green = sampleOf(probe2, eye, "green", "center");
    const bg = sampleOf(probe2, eye, "content", "background");
    assert(
      green && closeTo(green.rgba, [255, 255, 0, 255], 12),
      `[${eye}] refreshTextures re-uploaded the repainted canvas (now yellow) ${fmt(green?.rgba ?? [])}`,
    );
    assert(
      bg && closeTo(bg.rgba, [255, 0, 255, 255], 12),
      `[${eye}] unrefreshed content panel unchanged ${fmt(bg?.rgba ?? [])}`,
    );
  }

  // ── Teardown: no dangling RAF loop, session actually released ──────────────
  const teardown = await page.evaluate(() => window.__immersive.teardown());
  assert(
    teardown.framesAtEnd >= probe2.frames,
    `frames kept advancing until end() (${teardown.framesAtEnd})`,
  );
  assert(
    teardown.framesAfterWait === teardown.framesAtEnd,
    `no dangling RAF loop after end() — frame counter frozen (${teardown.framesAtEnd} → ${teardown.framesAfterWait})`,
  );
  assert(teardown.endEventFired, "session 'end' event fired");
  assert(
    teardown.secondSessionGranted,
    "a new immersive session is grantable after end() (previous session released)",
  );

  const fixtureErrors = await page.evaluate(() => window.__immersive.errors);
  assert(
    fixtureErrors.length === 0,
    `no onError callbacks from the production loop (${fixtureErrors.length})`,
  );
  for (const e of fixtureErrors) console.error(`  ⚠ onError: ${e}`);

  await writeFile(
    join(outDir, "report.json"),
    JSON.stringify({ enter, probe1, probe2, teardown, fixtureErrors, sink }, null, 2),
  );
  await page.close();
} finally {
  await browser.close();
  taintServer.close();
  pageServer.close();
}

assert(sink.pageErrors.length === 0, `no page errors (${sink.pageErrors.length})`);
for (const e of sink.pageErrors) console.error(`  ⚠ ${e}`);
await writeFile(join(outDir, "console.log"), sink.console.join("\n"));

console.log(`\nArtifacts → ${outDir}`);
if (failures > 0) {
  console.error(`\nIMMERSIVE E2E FAILED (${failures})`);
  process.exit(1);
}
console.log("\nIMMERSIVE E2E PASSED");
