/**
 * Real-browser e2e for the chromeless desktop bottom bar (#9953) — no app
 * server. Bundles bottombar-fixture.tsx with esbuild, loads it in headless
 * chromium via Playwright, drives the resting→open→type→vision flow with real
 * pointer input, screenshots each state, and asserts the #9953 acceptance
 * criteria on the REAL shipped components (HomePill + AssistantOverlay +
 * ChatSurface glass composer):
 *
 *   - resting surface is the chromeless bar (HomePill), not the full <App>;
 *   - the open composer shows mic + a VISION button + send;
 *   - the VISION tap fires a screen-vision turn (pulses the button);
 *   - NO hardcoded blue anywhere (the #9953 `is-sky` brand violation is gone).
 *
 * Run: bun run --cwd packages/ui test:bottombar-e2e
 * Exits non-zero on any failed assertion or page/console error.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

const here = dirname(fileURLToPath(import.meta.url));
const uiRoot = resolve(here, "../../../.."); // packages/ui
const stylesDir = join(uiRoot, "src/styles");
const toUrl = (p) => p.replace(/\\/g, "/");

// Compile the REAL @elizaos/ui Tailwind v4 theme + utilities for the exact shell
// components this fixture renders, so the captured pixels carry the shipped brand
// (dark glass + orange accent), not a CDN-Tailwind approximation. `source(none)`
// disables auto-detection; `@source` scopes the scan to the rendered surface.
async function compileTheme() {
  const input = `@import "tailwindcss" source(none);
@import "${toUrl(join(stylesDir, "base.css"))}";
@import "${toUrl(join(stylesDir, "theme.css"))}";
@import "${toUrl(join(stylesDir, "tailwind-theme.css"))}";
@source "${toUrl(join(uiRoot, "src/components/shell"))}";
@source "${toUrl(here)}";
`;
  const res = await postcss([tailwind()]).process(input, {
    from: toUrl(join(stylesDir, "styles.css")),
  });
  return res.css;
}
const outDir = process.env.BOTTOMBAR_OUT || join(here, "output-bottombar");
await mkdir(outDir, { recursive: true });

let failures = 0;
function assert(cond, msg) {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures += 1;
  return cond;
}

// Same browser-stub strategy as run-chat-sheet-e2e: the shell import graph
// transitively reaches server-only @elizaos/core init that touches `process` +
// node builtins (dead in the browser). Production Vite resolves core's `browser`
// export; this raw esbuild bundle replaces it with a no-op Proxy instead.
const stubElizaCore = {
  name: "stub-eliza-core",
  setup(b) {
    b.onResolve({ filter: /^@elizaos\/core$/ }, (args) => ({
      path: args.path,
      namespace: "eliza-core-stub",
    }));
    b.onLoad({ filter: /.*/, namespace: "eliza-core-stub" }, () => ({
      contents: `
        const noop = new Proxy(() => noop, { get: () => noop });
        module.exports = new Proxy(
          {
            isViewVisible: () => true,
            dedupeModalities: (m) => Array.from(new Set(Array.isArray(m) ? m : [])),
            findInteractionRegions: () => [],
          },
          { get: (t, p) => (p in t ? t[p] : noop) },
        );
      `,
      loader: "js",
    }));
  },
};
const nodeBuiltins = new Set([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]);
const stubNodeBuiltins = {
  name: "stub-node-builtins",
  setup(b) {
    b.onResolve({ filter: /.*/ }, (args) => {
      const bare = args.path.replace(/^node:/, "").split("/")[0];
      if (
        args.path.startsWith("node:") ||
        nodeBuiltins.has(args.path) ||
        builtinModules.includes(bare)
      ) {
        return { path: args.path, namespace: "node-stub" };
      }
      return null;
    });
    b.onLoad({ filter: /.*/, namespace: "node-stub" }, () => ({
      contents:
        "const n=()=>noop;const noop=new Proxy(n,{get:()=>noop});module.exports=noop;",
      loader: "js",
    }));
  },
};

async function bundleFixture(params = "") {
  const result = await build({
    entryPoints: [join(here, "bottombar-fixture.tsx")],
    bundle: true,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    loader: { ".tsx": "tsx", ".ts": "ts" },
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [stubElizaCore, stubNodeBuiltins],
    write: false,
  });
  const js = result.outputFiles[0].text;
  const themeCss = await compileTheme();
  // `class="dark"` activates the shipped dark-glass theme tokens (base.css/.dark).
  const html = `<!doctype html><html class="dark"><head><meta charset="utf-8"><title>bottom bar e2e</title>
<script>window.process=window.process||{env:{NODE_ENV:"production"},platform:"browser",cwd:function(){return "/"}};</script>
<style>${themeCss}</style>
<style>html,body{margin:0;height:100%;background:#08080d}</style>
</head><body><div id="root"></div><script>${js}</script></body></html>`;
  const htmlPath = join(outDir, `bottombar${params ? `-${params}` : ""}.html`);
  await writeFile(htmlPath, html);
  return `file://${htmlPath}`;
}

let shot = 0;
async function snap(p, name) {
  shot += 1;
  const file = `${String(shot).padStart(2, "0")}-${name}.png`;
  await p.screenshot({ path: join(outDir, file) });
  console.log(`  \u{1F4F8} ${file}`);
}

const url = await bundleFixture();
// Windows/Defender scans the fresh chrome-headless-shell process on first launch,
// which can push the CDP handshake well past Playwright's 30s default. Give it a
// generous launch budget (overridable via PW_LAUNCH_TIMEOUT_MS).
const browser = await chromium.launch({
  timeout: Number(process.env.PW_LAUNCH_TIMEOUT_MS || 300000),
});
const sink = { logs: [], errors: [] };
try {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    recordVideo: { dir: outDir, size: { width: 1440, height: 900 } },
  });
  const p = await ctx.newPage();
  p.on("console", (m) => sink.logs.push(`[${m.type()}] ${m.text()}`));
  p.on("pageerror", (e) => sink.errors.push(String(e)));

  await p.goto(url);
  await p.waitForSelector('[data-testid="shell-home-pill"]', { timeout: 20000 });
  await p.waitForTimeout(900);

  // 1) RESTING: the chromeless bar (HomePill) is the resting surface; the full
  //    AssistantOverlay composer is NOT mounted yet.
  assert(
    (await p.getByTestId("shell-home-pill").count()) === 1,
    "RESTING: chromeless HomePill bar is the resting surface (not <App>)",
  );
  assert(
    (await p.getByTestId("shell-chat-surface").count()) === 0,
    "RESTING: the open composer is not mounted until the bar is opened",
  );
  await snap(p, "resting-homepill");

  // 2) OPEN: click the pill → AssistantOverlay mounts the glass ChatSurface.
  await p.getByTestId("shell-home-pill").click({ force: true });
  await p.waitForSelector('[data-testid="shell-assistant-overlay"]', { timeout: 8000 });
  await p.waitForSelector('[data-testid="shell-chat-surface"]', { timeout: 8000 });
  await p.waitForTimeout(900);
  await snap(p, "open-composer");

  // 3) The composer shows mic + VISION + send (the #9953 acceptance addition).
  const micLabels = await p.$$eval("button", (els) =>
    els.map((e) => e.getAttribute("aria-label") || "").filter((l) => /voice input/i.test(l)),
  );
  const visionLabels = await p.$$eval("button", (els) =>
    els.map((e) => e.getAttribute("aria-label") || "").filter((l) => /my screen/i.test(l)),
  );
  const sendLabels = await p.$$eval("button", (els) =>
    els.map((e) => e.getAttribute("aria-label") || "").filter((l) => /send message/i.test(l)),
  );
  assert(micLabels.length === 1, `COMPOSER: mic button present (${JSON.stringify(micLabels)})`);
  assert(visionLabels.length === 1, `COMPOSER: VISION button present (${JSON.stringify(visionLabels)})`);
  assert(sendLabels.length === 1, `COMPOSER: send button present (${JSON.stringify(sendLabels)})`);

  // 4) NO BLUE: the #9953 `is-sky` (rgba(56,165,255)) brand violation is gone,
  //    and no rendered element carries an is-sky/blue class.
  const skyCount = await p.$$eval("*", (els) =>
    els.filter((e) => e.className && String(e.className).includes("is-sky")).length,
  );
  assert(skyCount === 0, `BRAND: no \`is-sky\` blue elements (${skyCount})`);

  // 5) TYPE → send button enables, Enter sends.
  const input = p.getByTestId("shell-chat-surface").locator('input[type="text"]');
  await input.fill("close out 9953");
  await p.waitForTimeout(300);
  await snap(p, "open-composer-draft");
  const before = sink.logs.length;
  await input.press("Enter");
  await p.waitForTimeout(300);
  assert(
    sink.logs.slice(before).some((l) => l.includes("[fixture] send: close out 9953")),
    "SEND: pressing Enter sends the drafted turn",
  );

  // 6) VISION tap → fires a screen-vision turn (pulses the button).
  const beforeV = sink.logs.length;
  await p.getByRole("button", { name: /my screen/i }).click({ force: true });
  await p.waitForTimeout(300);
  assert(
    sink.logs.slice(beforeV).some((l) => l.includes("captureVision -> screen turn")),
    "VISION: tapping the eye fires a screen-vision turn",
  );
  assert(
    sink.logs.slice(beforeV).some((l) => l.includes("Take a look at my screen")),
    "VISION: the screen-vision turn text is sent to the agent",
  );
  await snap(p, "vision-active");

  // 7) Close → back to the resting chromeless bar.
  await p.keyboard.press("Escape");
  await p.waitForTimeout(700);
  assert(
    (await p.getByTestId("shell-chat-surface").count()) === 0,
    "CLOSE: Escape returns to the resting chromeless bar",
  );
  await snap(p, "closed-back-to-bar");

  assert(sink.errors.length === 0, `NO PAGE ERRORS (${JSON.stringify(sink.errors.slice(0, 4))})`);
  const errLogs = sink.logs.filter((l) => l.startsWith("[error]"));
  assert(errLogs.length === 0, `NO console errors (${JSON.stringify(errLogs.slice(0, 4))})`);

  const videoObj = p.video();
  await p.close();
  if (videoObj) {
    const vp = await videoObj.path().catch(() => null);
    if (vp) console.log(`  \u{1F3A5} video: ${vp}`);
  }
  await ctx.close();
} finally {
  await browser.close();
}

console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`} — artifacts in ${outDir}`);
process.exit(failures === 0 ? 0 : 1);
