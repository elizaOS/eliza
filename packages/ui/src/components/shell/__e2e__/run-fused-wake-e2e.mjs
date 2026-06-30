/**
 * Real-browser e2e for the fused on-device wake → bottom-bar activation (#10351).
 *
 * Bundles fused-wake-fixture.tsx with esbuild, loads it in headless chromium via
 * Playwright, and proves the consumer half of the #10351 chain on the REAL
 * shipped components + REAL wake hooks (HomePill + AssistantOverlay + ChatSurface
 * driven by useWakeListenWindow → useWakeController):
 *
 *   - RESTING: the chromeless HomePill is the resting surface, no chat composer;
 *   - WAKE: dispatching the genuine `eliza:fused-wake` head-fired CustomEvent
 *     (the exact event the desktop transport emits when libwakeword fires)
 *     activates the bar (ChatSurface mounts) and starts a converse capture;
 *   - the activation is driven by the real controller, not a manual phase flip.
 *
 * This pairs with the Bun real-model fire test
 * (plugins/plugin-local-inference/.../wake-word-real-fire.real.test.ts), which
 * proves the producer half (real libwakeword → detector fires with confidence);
 * together they span the split process boundary the issue requires.
 *
 * Run: bun run --cwd packages/ui test:fused-wake-e2e
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
const outDir = process.env.FUSED_WAKE_OUT || join(here, "output-fused-wake");
await mkdir(outDir, { recursive: true });

let failures = 0;
function assert(cond, msg) {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures += 1;
  return cond;
}

// Same browser-stub strategy as run-bottombar-e2e: the shell import graph
// transitively reaches server-only @elizaos/core init that touches `process` +
// node builtins (dead in the browser). Replace them with no-op Proxies for this
// raw esbuild bundle.
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

async function bundleFixture() {
  const result = await build({
    entryPoints: [join(here, "fused-wake-fixture.tsx")],
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
  const html = `<!doctype html><html class="dark"><head><meta charset="utf-8"><title>fused wake e2e</title>
<script>window.process=window.process||{env:{NODE_ENV:"production"},platform:"browser",cwd:function(){return "/"}};</script>
<style>${themeCss}</style>
<style>html,body{margin:0;height:100%;background:#08080d}</style>
</head><body><div id="root"></div><script>${js}</script></body></html>`;
  const htmlPath = join(outDir, "fused-wake.html");
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

  // 1) RESTING: the chromeless HomePill bar; the composer is not mounted.
  assert(
    (await p.getByTestId("shell-home-pill").count()) === 1,
    "RESTING: chromeless HomePill bar is the resting surface",
  );
  assert(
    (await p.getByTestId("shell-chat-surface").count()) === 0,
    "RESTING: the composer is not mounted before wake",
  );
  // The fused on-device capability is live (set before mount, as the desktop
  // boot does), so the wake controller's openWakeWord head fast-path is armed.
  assert(
    await p.evaluate(
      () => window.__ELIZA_FUSED_WAKE__ === true,
    ),
    "CAPABILITY: window.__ELIZA_FUSED_WAKE__ is set (fused path live)",
  );
  await snap(p, "resting-homepill");

  // 2) WAKE: dispatch the genuine `eliza:fused-wake` head-fired event — exactly
  //    what the desktop transport emits when the native libwakeword head fires.
  const before = sink.logs.length;
  await p.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent("eliza:fused-wake", {
        detail: { stage: "head-fired", confidence: 0.99 },
      }),
    );
  });
  // The bar activates: ChatSurface mounts (the real controller drove it).
  await p.waitForSelector('[data-testid="shell-chat-surface"]', {
    timeout: 8000,
  });
  await p.waitForSelector('[data-testid="shell-assistant-overlay"]', {
    timeout: 8000,
  });
  await p.waitForTimeout(700);

  assert(
    (await p.getByTestId("shell-chat-surface").count()) === 1,
    "WAKE: eliza:fused-wake activates the bar (ChatSurface mounts)",
  );
  assert(
    sink.logs
      .slice(before)
      .some((l) => l.includes("wake -> onOpen: startCapture('converse')")),
    "WAKE: the wake opened the listening window + started a converse capture",
  );
  await snap(p, "wake-bar-active");

  assert(
    sink.errors.length === 0,
    `NO PAGE ERRORS (${JSON.stringify(sink.errors.slice(0, 4))})`,
  );
  const errLogs = sink.logs.filter((l) => l.startsWith("[error]"));
  assert(
    errLogs.length === 0,
    `NO console errors (${JSON.stringify(errLogs.slice(0, 4))})`,
  );

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

console.log(
  `\n${failures === 0 ? "PASS" : `FAIL (${failures})`} — artifacts in ${outDir}`,
);
process.exit(failures === 0 ? 0 : 1);
