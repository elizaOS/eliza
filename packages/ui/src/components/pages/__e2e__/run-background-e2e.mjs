/**
 * Real-browser integration e2e for the unified app background — no app server.
 * Bundles background-fixture.tsx (real BackgroundView + AppBackground over one
 * real store) with esbuild, loads it in headless chromium, and exercises the
 * whole consolidated system through real UI + real agent events:
 *
 *   1. default warm-orange shader
 *   2. click the "Green" swatch       → background recolors live (color change)
 *   3. upload an image                → cover-image background (upload a picture)
 *   4. agent emits background:apply   → recolors from chat (chat → background)
 *   5. agent emits {op:"undo"}        → reverts to the previous (image)
 *   6. click the Undo control         → reverts again to the Green swatch (UI undo)
 *   7. agent emits {op:"redo"}        → steps forward to the image again (chat redo)
 *   8. click the Redo control         → forward again to the chat teal — the full
 *                                       set→set→undo→redo round-trip (#10694)
 *   9. agent applies a GLSL preset    → the REAL programmable shader compiles and
 *                                       RENDERS (SwiftShader GL, not the fallback):
 *                                       pixel probes assert a non-uniform pattern
 *  10. animation probe                → a later frame differs from an earlier one
 *                                       (u_time actually drives the shader)
 *  11. GLSL recolor                   → changing u_color shifts the rendered pixels
 *  12. unknown preset id              → ignored (never wedges the background)
 *  13. undo from GLSL                 → history integrates the shader config
 *
 * Chromium runs with SwiftShader ANGLE (NOT --disable-gpu) so WebGL frames are
 * genuinely rasterized — previously the GLSL path silently took the no-webgl
 * fallback here and was never exercised (#10694 tail).
 *
 * Captures a screenshot per step + a video walkthrough.
 *
 * Run: bun run --cwd packages/ui test:background-e2e
 */
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "output-background");
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

let failures = 0;
function assert(cond, msg) {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures += 1;
}

// A gradient SVG used as the uploaded "photo".
const uploadSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#059669"/><stop offset="1" stop-color="#e11d48"/>
  </linearGradient></defs>
  <rect width="1200" height="800" fill="url(#g)"/>
  <circle cx="900" cy="240" r="160" fill="#f4f4f5" opacity="0.85"/>
</svg>`;

const result = await build({
  entryPoints: [join(here, "background-fixture.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  loader: { ".tsx": "tsx", ".ts": "ts" },
  define: { "process.env.NODE_ENV": '"production"' },
  write: false,
});
const js = result.outputFiles[0].text;
const html = `<!doctype html><html><head><meta charset="utf-8"><title>background e2e</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>html,body{margin:0;height:100%}</style>
</head><body><div id="root"></div><script>${js}</script></body></html>`;
const htmlPath = join(outDir, "background.html");
await writeFile(htmlPath, html);
const url = `file://${htmlPath}`;

let shot = 0;
async function snap(p, name) {
  shot += 1;
  const file = `bg-${String(shot).padStart(2, "0")}-${name}.png`;
  await p.screenshot({ path: join(outDir, file) });
  console.log(`  📸 ${file}`);
}

const shaderColor = (p) =>
  p.evaluate(
    () =>
      document.querySelector('[data-testid="app-background-shader"]')?.style
        .backgroundColor ?? null,
  );
const count = (p, sel) => p.locator(sel).count();
const settle = (p) => p.waitForTimeout(350);

/**
 * Pixel-probe the COMPOSITED page (screenshot → decode in-page → sample a grid
 * below the control panel). This reads what the GPU (SwiftShader) actually
 * rasterized — a GLSL shader that silently fell back or rendered nothing shows
 * up here as a flat field. Returns per-sample RGB plus summary stats.
 */
async function probePixels(p) {
  const b64 = (await p.screenshot()).toString("base64");
  return p.evaluate(async (data) => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    // Sample a 12×8 grid across the lower 40% of the page — well clear of the
    // centered control panel — where only the background layer paints.
    const samples = [];
    const x0 = Math.round(c.width * 0.04);
    const x1 = Math.round(c.width * 0.96);
    const y0 = Math.round(c.height * 0.62);
    const y1 = Math.round(c.height * 0.97);
    for (let iy = 0; iy < 8; iy += 1) {
      for (let ix = 0; ix < 12; ix += 1) {
        const x = Math.round(x0 + ((x1 - x0) * ix) / 11);
        const y = Math.round(y0 + ((y1 - y0) * iy) / 7);
        const d = ctx.getImageData(x, y, 1, 1).data;
        samples.push([d[0], d[1], d[2]]);
      }
    }
    const n = samples.length;
    const mean = [0, 1, 2].map(
      (ch) => samples.reduce((acc, s) => acc + s[ch], 0) / n,
    );
    const spread = Math.max(
      ...[0, 1, 2].map(
        (ch) =>
          Math.max(...samples.map((s) => s[ch])) -
          Math.min(...samples.map((s) => s[ch])),
      ),
    );
    const unique = new Set(samples.map((s) => s.join(","))).size;
    return { samples, mean, spread, unique };
  }, b64);
}

/** Mean absolute per-channel delta between two equally-shaped probes. */
function probeDelta(a, b) {
  let total = 0;
  for (let i = 0; i < a.samples.length; i += 1) {
    for (let ch = 0; ch < 3; ch += 1) {
      total += Math.abs(a.samples[i][ch] - b.samples[i][ch]);
    }
  }
  return total / (a.samples.length * 3);
}

const browser = await chromium.launch({
  args: [
    "--no-sandbox",
    // SwiftShader software GL instead of --disable-gpu: the programmable GLSL
    // background needs a REAL WebGL context to render frames; --disable-gpu
    // forced the no-webgl fallback and left the shader path untested (#10694).
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--disable-dev-shm-usage",
    "--force-color-profile=srgb",
  ],
});
const context = await browser.newContext({
  viewport: { width: 1180, height: 820 },
  recordVideo: { dir: outDir, size: { width: 1180, height: 820 } },
});
const errors = [];
const p = await context.newPage();
p.on("pageerror", (e) => {
  errors.push(String(e));
  console.error(`  ⚠ pageerror: ${e}`);
});
p.on("console", (m) => {
  if (m.type() === "error") console.error(`  ⚠ console: ${m.text()}`);
});
try {
  await p.goto(url);
  await p.waitForSelector('[data-testid="bg-fixture-root"]', { timeout: 8000 });
  await settle(p);

  // 1. Default warm-orange shader.
  assert(
    (await shaderColor(p)) === "rgb(239, 90, 31)",
    "default renders the warm-orange shader",
  );
  await snap(p, "default-orange");

  // 2. Click the Green swatch in the REAL view → background recolors live.
  await p.getByLabel("Set background to Green").click();
  await settle(p);
  assert(
    (await shaderColor(p)) === "rgb(5, 150, 105)",
    "clicking the Green swatch recolors the background live",
  );
  await snap(p, "swatch-green");

  // 3. Upload an image → cover-image background.
  await p.setInputFiles('input[type="file"]', {
    name: "wallpaper.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from(uploadSvg),
  });
  await settle(p);
  assert(
    (await count(p, '[data-testid="app-background-image"]')) === 1,
    "uploading an image switches to a cover-image background",
  );
  assert(
    (await count(p, '[data-testid="app-background-shader"]')) === 0,
    "the shader is replaced by the uploaded image",
  );
  await snap(p, "uploaded-image");

  // 4. Agent chat path: emit background:apply with an arbitrary (non-preset)
  // teal so we prove the chat→background bridge can apply any color, not just a
  // swatch. #0891b2 === rgb(8, 145, 178).
  await p.evaluate(() =>
    window.__emitBgApply?.({ op: "set", mode: "shader", color: "#0891b2" }),
  );
  await settle(p);
  assert(
    (await shaderColor(p)) === "rgb(8, 145, 178)",
    'agent "background:apply" recolors the background from chat',
  );
  await snap(p, "chat-apply-teal");

  // 5. Agent emits undo → reverts to the previous (the uploaded image).
  await p.evaluate(() => window.__emitBgApply?.({ op: "undo" }));
  await settle(p);
  assert(
    (await count(p, '[data-testid="app-background-image"]')) === 1,
    'agent "undo" reverts to the previous (image) background',
  );
  await snap(p, "chat-undo-to-image");

  // 6. Click the Undo control in the view → reverts again, popping the image
  // back off to the prior shader color: the Green swatch from step 2.
  // #059669 === rgb(5, 150, 105).
  await p.getByLabel("Undo background change").click();
  await settle(p);
  assert(
    (await shaderColor(p)) === "rgb(5, 150, 105)",
    "the Undo control reverts to the prior shader color",
  );
  await snap(p, "ui-undo-to-green");

  // 7. Agent chat path: emit {op:"redo"} → steps forward again, restoring the
  // uploaded image that step 6's undo popped off.
  await p.evaluate(() => window.__emitBgApply?.({ op: "redo" }));
  await settle(p);
  assert(
    (await count(p, '[data-testid="app-background-image"]')) === 1,
    'agent "redo" re-applies the undone (image) background',
  );
  await snap(p, "chat-redo-to-image");

  // 8. Click the Redo control → forward once more to the chat-applied teal from
  // step 4 — the full set→set→undo→redo round-trip. #0891b2 === rgb(8, 145, 178).
  await p.getByLabel("Redo background change").click();
  await settle(p);
  assert(
    (await shaderColor(p)) === "rgb(8, 145, 178)",
    "the Redo control round-trips back to the chat-applied teal",
  );
  assert(
    (await count(p, '[aria-label="Redo background change"]')) === 0,
    "the Redo control hides once the redo stack is empty",
  );
  await snap(p, "ui-redo-to-teal");

  // ── Programmable GLSL shader — REAL rendered frames (#10694 tail) ──────
  // 9. Agent applies a GLSL preset through the real background:apply channel.
  // Under SwiftShader the shader must compile AND rasterize: the glsl host
  // stays mounted (no fallback swap) and the composited pixels show a
  // non-uniform pattern — a flat field means the shader never really ran.
  await p.evaluate(() =>
    window.__emitBgApply?.({ op: "set", mode: "glsl", presetId: "plasma" }),
  );
  await p.waitForTimeout(800);
  await p.waitForSelector('[data-testid="app-background-glsl"] canvas', {
    timeout: 8000,
  });
  await p.waitForTimeout(700); // let a few animation frames rasterize
  assert(
    (await count(p, '[data-testid="app-background-shader"]')) === 0,
    "GLSL mode did not fall back to the plain color field",
  );
  const glslProbe = await probePixels(p);
  console.log(
    `  🔬 glsl probe: spread=${glslProbe.spread} unique=${glslProbe.unique} mean=${glslProbe.mean.map((v) => v.toFixed(1)).join(",")}`,
  );
  assert(
    glslProbe.spread >= 25 && glslProbe.unique >= 24,
    `GLSL frame shows a real rendered pattern (spread=${glslProbe.spread}, unique=${glslProbe.unique})`,
  );
  await snap(p, "glsl-plasma");

  // 10. Animation probe: u_time drives the shader, so a later frame differs.
  await p.waitForTimeout(700);
  const glslProbeLater = await probePixels(p);
  const animDelta = probeDelta(glslProbe, glslProbeLater);
  console.log(`  🔬 glsl animation delta=${animDelta.toFixed(2)}`);
  assert(
    animDelta >= 2,
    `GLSL frames animate over time (mean delta=${animDelta.toFixed(2)})`,
  );
  await snap(p, "glsl-plasma-later");

  // 11. Recolor the live shader (same source → in-place u_color update, no
  // remount): the green channel takes over from the teal blue channel.
  // #059669 = emerald.
  await p.evaluate(() =>
    window.__emitBgApply?.({
      op: "set",
      mode: "glsl",
      presetId: "plasma",
      color: "#059669",
    }),
  );
  await p.waitForTimeout(700);
  const greenProbe = await probePixels(p);
  console.log(
    `  🔬 glsl recolor mean=${greenProbe.mean.map((v) => v.toFixed(1)).join(",")}`,
  );
  assert(
    greenProbe.mean[1] > greenProbe.mean[2] + 10 &&
      greenProbe.mean[1] > greenProbe.mean[0] + 10,
    "recoloring the live GLSL shader shifts the rendered pixels to green",
  );
  await snap(p, "glsl-recolor-green");

  // 12. Unknown preset id → ignored; the running shader is never wedged.
  await p.evaluate(() =>
    window.__emitBgApply?.({ op: "set", mode: "glsl", presetId: "nope" }),
  );
  await settle(p);
  assert(
    (await count(p, '[data-testid="app-background-glsl"] canvas')) === 1,
    "an unknown GLSL preset id is ignored (canvas still live)",
  );

  // 13. Undo from GLSL: history integrates the shader configs. First undo
  // steps green-plasma → teal-plasma (still GLSL); second undo pops the shader
  // entirely, restoring the prior plain teal field. #0891b2 = rgb(8,145,178).
  await p.evaluate(() => window.__emitBgApply?.({ op: "undo" }));
  await settle(p);
  assert(
    (await count(p, '[data-testid="app-background-glsl"] canvas')) === 1,
    "first undo steps back to the previous GLSL config (still rendering)",
  );
  await p.evaluate(() => window.__emitBgApply?.({ op: "undo" }));
  await settle(p);
  assert(
    (await count(p, '[data-testid="app-background-glsl"]')) === 0,
    "second undo pops the GLSL background off the history",
  );
  assert(
    (await shaderColor(p)) === "rgb(8, 145, 178)",
    "undo from GLSL restores the prior teal color field",
  );
  await snap(p, "glsl-undo-to-teal");
} finally {
  await context.close(); // flush the video
  await browser.close();
}

// Give the recorded video a stable, committable name.
for (const f of await readdir(outDir)) {
  if (f.endsWith(".webm")) {
    await rename(join(outDir, f), join(outDir, "walkthrough.webm"));
    console.log("  🎥 walkthrough.webm");
    break;
  }
}

assert(errors.length === 0, `no uncaught page errors (${errors.length})`);
for (const e of errors) console.error(`  ⚠ ${e}`);

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\n✅ background integration e2e passed");
