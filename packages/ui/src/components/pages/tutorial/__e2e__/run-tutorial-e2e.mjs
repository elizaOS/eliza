/**
 * Real-browser e2e for the interactive tutorial spotlight (#9957) — no app
 * server. Bundles tutorial-fixture.tsx (the REAL TutorialSpotlight over a chat
 * scaffold) with esbuild, loads it in headless chromium, and for every frame of
 * the real tour script asserts:
 *   - the glow rect frames the correct on-screen target (and skips an off-screen
 *     duplicate `chat-composer-action`), never silently full-dimming;
 *   - the spotlight sits at the registered Z_TUTORIAL (9500), not a max-int z;
 *   - under dark / light / gold themes, the glow color equals the themed
 *     `--accent-rgb` and the Continue button equals the themed `--accent` — i.e.
 *     no hardcoded orange leaks into a non-orange theme.
 * Captures desktop + mobile screenshots per frame and a mobile video walkthrough.
 *
 * Run: bun run --cwd packages/ui test:tutorial-e2e
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const stylesDir = join(here, "../../../../styles");
const outDir = join(here, "output-tutorial");
await mkdir(outDir, { recursive: true });

let failures = 0;
function assert(cond, msg) {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures += 1;
  return cond;
}

const baseCss = await readFile(join(stylesDir, "base.css"), "utf8");
const goldCss = await readFile(join(stylesDir, "brand-gold.css"), "utf8");

// The spotlight card uses a handful of Tailwind v4 token utilities; map them to
// the same CSS variables so the card renders themed under the v3 Play CDN.
const TOKEN_SHIM = `
.bg-card{background-color:var(--card)}
.text-card-foreground{color:var(--card-foreground)}
.text-muted{color:var(--muted)}
.border-border{border-color:var(--border)}
`;

// The three themes the issue requires, each a real selector from base.css /
// brand-gold.css. `extra` CSS (gold tokens) is layered after base.
const THEMES = [
  { name: "dark", htmlClass: "dark", extra: "" },
  { name: "light", htmlClass: "theme-cloud", extra: "" },
  { name: "gold", htmlClass: "dark", extra: goldCss },
];

const result = await build({
  entryPoints: [join(here, "tutorial-fixture.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  loader: { ".tsx": "tsx", ".ts": "ts" },
  define: { "process.env.NODE_ENV": '"production"' },
  write: false,
});
const js = result.outputFiles[0].text;
const html = `<!doctype html><html><head><meta charset="utf-8"><title>tutorial e2e</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>html,body{margin:0;height:100%;background:var(--bg,#0a0d16)}</style>
<style>${TOKEN_SHIM}</style>
</head><body><div id="root"></div><script>${js}</script></body></html>`;
const htmlPath = join(outDir, "tutorial.html");
await writeFile(htmlPath, html);
const url = `file://${htmlPath}`;

const sink = { errors: [] };
const browser = await chromium.launch();
let shot = 0;
async function snap(p, name) {
  shot += 1;
  const file = `${String(shot).padStart(2, "0")}-${name}.png`;
  await p.screenshot({ path: join(outDir, file) });
  console.log(`  📸 ${file}`);
}

/** Apply a theme's real token CSS + class to a freshly-loaded page. */
async function applyTheme(page, theme) {
  await page.addStyleTag({ content: baseCss });
  if (theme.extra) await page.addStyleTag({ content: theme.extra });
  await page.evaluate((cls) => {
    document.documentElement.className = cls;
  }, theme.htmlClass);
}

/** Parsed "r, g, b" channels from any computed color/box-shadow string. */
function rgbTriplet(s) {
  const m = String(s).match(/(\d+)\s*[, ]\s*(\d+)\s*[, ]\s*(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

const steps = (
  await (async () => {
    const probe = await browser.newPage();
    await probe.goto(url);
    await probe.waitForFunction(() => Boolean(window.__tutorial));
    const s = await probe.evaluate(() => window.__tutorial.steps);
    await probe.close();
    return s;
  })()
);
assert(steps.length === 8, `tour has 8 frames (6 original + new-chat + swipe) (${steps.length})`);
assert(
  steps.some((s) => s.id === "new-chat") && steps.some((s) => s.id === "swipe-between-chats"),
  "new-chat + swipe-between-chats frames exist",
);

try {
  // ── Per-theme color correctness — the heart of #9957 ────────────────────────
  for (const theme of THEMES) {
    const page = await browser.newPage({ viewport: { width: 1180, height: 860 } });
    page.on("pageerror", (e) => sink.errors.push(`[${theme.name}] ${e}`));
    await page.goto(url);
    await page.waitForFunction(() => Boolean(window.__tutorial));
    await applyTheme(page, theme);

    const accentRgb = rgbTriplet(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--accent-rgb"),
      ),
    );
    assert(Boolean(accentRgb), `[${theme.name}] --accent-rgb resolves (${accentRgb})`);

    // A targeted frame → the glow must use the themed accent-rgb.
    await page.evaluate(() => window.__tutorial.show("open-chat"));
    await page.waitForSelector('[data-testid="tutorial-glow"]');
    await page.waitForTimeout(120);
    const glowRgb = rgbTriplet(
      await page.evaluate(() => {
        const g = document.querySelector('[data-testid="tutorial-glow"]');
        return g ? getComputedStyle(g).boxShadow : "";
      }),
    );
    assert(
      glowRgb != null &&
        glowRgb[0] === accentRgb[0] &&
        glowRgb[1] === accentRgb[1] &&
        glowRgb[2] === accentRgb[2],
      `[${theme.name}] glow color == themed --accent-rgb (glow ${glowRgb} vs accent ${accentRgb})`,
    );

    // The Continue button must use the themed --accent (resolved), not #FF5800.
    const accentResolved = rgbTriplet(
      await page.evaluate(() => {
        const b = document.querySelector('[data-testid="tutorial-continue"]');
        return b ? getComputedStyle(b).backgroundColor : "";
      }),
    );
    const accentVar = rgbTriplet(
      await page.evaluate(() => {
        // Resolve var(--accent) to rgb via a throwaway element.
        const el = document.createElement("span");
        el.style.color = "var(--accent)";
        document.body.appendChild(el);
        const c = getComputedStyle(el).color;
        el.remove();
        return c;
      }),
    );
    assert(
      accentResolved != null &&
        accentVar != null &&
        accentResolved.join() === accentVar.join(),
      `[${theme.name}] Continue button bg == themed --accent (btn ${accentResolved} vs accent ${accentVar})`,
    );

    // Prove the light theme is NOT orange — the reported bug.
    if (theme.name === "light") {
      assert(
        glowRgb.join() === "255,255,255",
        `light theme glow is white, not orange (${glowRgb})`,
      );
    }
    await snap(page, `${theme.name}-open-chat`);
    await page.close();
  }

  // ── Per-frame targeting + z-index + screenshots (dark theme) ────────────────
  for (const view of [
    { name: "desktop", viewport: { width: 1180, height: 860 } },
    { name: "mobile", viewport: { width: 402, height: 874 } },
  ]) {
    const page = await browser.newPage({ viewport: view.viewport });
    page.on("pageerror", (e) => sink.errors.push(`[${view.name}] ${e}`));
    await page.goto(url);
    await page.waitForFunction(() => Boolean(window.__tutorial));
    await applyTheme(page, THEMES[0]);

    for (const step of steps) {
      await page.evaluate((id) => window.__tutorial.show(id), step.id);
      await page.waitForSelector('[data-testid="tutorial-spotlight"]');
      await page.waitForTimeout(140);

      const z = await page.evaluate(
        () =>
          getComputedStyle(
            document.querySelector('[data-testid="tutorial-spotlight"]'),
          ).zIndex,
      );
      assert(z === "9500", `[${view.name}] ${step.id}: spotlight z is Z_TUTORIAL 9500 (${z})`);

      if (step.targetSelector) {
        const framing = await page.evaluate((sel) => {
          const root = document.querySelector('[data-testid="tutorial-spotlight"]');
          const missing = root?.getAttribute("data-tutorial-target-missing");
          const glow = document.querySelector('[data-testid="tutorial-glow"]');
          // The on-screen target: pick the visible match (mirrors measure()).
          const vw = window.innerWidth;
          const vh = window.innerHeight;
          let target = null;
          for (const el of document.querySelectorAll(sel)) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 && r.height === 0) continue;
            if (r.bottom <= 0 || r.right <= 0 || r.top >= vh || r.left >= vw) continue;
            target = r;
            break;
          }
          const g = glow ? glow.getBoundingClientRect() : null;
          return { missing, hasGlow: Boolean(glow), t: target && { x: target.left, y: target.top, w: target.width, h: target.height }, g: g && { x: g.left, y: g.top, w: g.width, h: g.height } };
        }, step.targetSelector);

        assert(!framing.missing, `[${view.name}] ${step.id}: target resolved (no missing marker)`);
        assert(framing.hasGlow, `[${view.name}] ${step.id}: glow rendered`);
        if (framing.t && framing.g) {
          // Mirror the spotlight's hole math: target grown by PAD (8) on every
          // side, with top/left clamped to the viewport edge (Math.max(0, …)).
          const PAD = 8;
          const dx = Math.abs(framing.g.x - Math.max(0, framing.t.x - PAD));
          const dy = Math.abs(framing.g.y - Math.max(0, framing.t.y - PAD));
          const dw = Math.abs(framing.g.w - (framing.t.w + PAD * 2));
          assert(
            dx <= 2 && dy <= 2 && dw <= 2,
            `[${view.name}] ${step.id}: glow frames the on-screen target (Δ ${dx.toFixed(1)},${dy.toFixed(1)},${dw.toFixed(1)})`,
          );
        }
      }
      await snap(page, `${view.name}-${step.id}`);
    }

    // measure() skips the off-screen duplicate: two actions in the DOM, glow on
    // the visible one.
    if (view.name === "desktop") {
      await page.evaluate((id) => window.__tutorial.show(id), "ask-to-navigate");
      await page.waitForTimeout(140);
      const counts = await page.evaluate(() => {
        const all = document.querySelectorAll('[data-testid="chat-composer-action"]');
        const onScreen = [...all].filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.right > 0 && r.left < window.innerWidth;
        });
        return { all: all.length, onScreen: onScreen.length };
      });
      assert(
        counts.all === 2 && counts.onScreen === 1,
        `ask-to-navigate: a duplicate composer-action exists (${counts.all}) but only one is on-screen (${counts.onScreen})`,
      );
    }
    await page.close();
  }

  // ── Video walkthrough: one mobile pass through all 8 frames ─────────────────
  const ctx = await browser.newContext({
    viewport: { width: 402, height: 874 },
    deviceScaleFactor: 2,
    recordVideo: { dir: outDir, size: { width: 402, height: 874 } },
  });
  const movie = await ctx.newPage();
  movie.on("pageerror", (e) => sink.errors.push(`[video] ${e}`));
  await movie.goto(url);
  await movie.waitForFunction(() => Boolean(window.__tutorial));
  await applyTheme(movie, THEMES[0]);
  for (const step of steps) {
    await movie.evaluate((id) => window.__tutorial.show(id), step.id);
    await movie.waitForTimeout(900);
  }
  const video = await movie.video();
  await movie.close();
  await ctx.close();
  if (video) console.log(`  🎥 ${await video.path()}`);
} finally {
  await browser.close();
}

assert(sink.errors.length === 0, `no page errors (${sink.errors.length})`);
for (const e of sink.errors) console.error(`  ⚠ ${e}`);

console.log(`\nScreenshots (${shot}) → ${outDir}`);
if (failures > 0) {
  console.error(`\nTUTORIAL E2E FAILED (${failures})`);
  process.exit(1);
}
console.log("\nTUTORIAL E2E PASSED");
