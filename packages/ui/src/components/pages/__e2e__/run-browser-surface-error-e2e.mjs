/**
 * Real-browser e2e + screenshots for the native-surface error cards on the
 * `native-mobile-webview` render path — no app server, no device. Bundles
 * browser-surface-error-fixture.tsx with esbuild (REAL BrowserWorkspaceView;
 * state/api barrels, the native surface hook, @capacitor/core, and
 * @elizaos/core stubbed), compiles the real Tailwind v4 theme, loads it in
 * headless chromium via Playwright at the Light Phone 3 CSS viewport
 * (360×414), and asserts:
 *
 *   - #permanent (WebView multi-profile capability denial): honest
 *     "Secure browsing not supported here" copy renders, the Open-external
 *     escape hatch is present, and NO Retry button exists,
 *   - #transient (transport fault): the existing "Browser view unavailable"
 *     retryable card renders, Retry works (hook retry invoked), and the
 *     permanent copy is absent,
 *   - screenshots of both cards at 360×414 (LP3) and 390×844 (phone).
 *
 * Exits non-zero on any failed assertion. Run:
 *   bun run --cwd packages/ui test:browser-surface-error-e2e
 */

import { mkdir, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindPostcss from "@tailwindcss/postcss";
import { build } from "esbuild";
import { chromium } from "playwright";
import postcss from "postcss";

const here = dirname(fileURLToPath(import.meta.url));
const uiSrc = resolve(here, "../../..");
const repoRoot = resolve(uiSrc, "../../..");
const outDir = join(here, "output-browser-surface-error");
await mkdir(outDir, { recursive: true });

let failures = 0;
function assert(cond, msg) {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures += 1;
  return cond;
}

// ── esbuild stubs (mirrors run-connectors-e2e.mjs) ──────────────────────────
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
        class ElizaError extends Error {
          constructor(message, options = {}) {
            super(
              message,
              options.cause !== undefined ? { cause: options.cause } : undefined,
            );
            this.name = "ElizaError";
            this.code = options.code;
            this.context = options.context;
            this.severity = options.severity;
            Object.setPrototypeOf(this, new.target.prototype);
          }
        }
        // Real surface-manifest resolution (mirrors
        // packages/core/src/types/surface-manifest.ts): BrowserWorkspaceView
        // derives its native-webview render path from the resolved builtin
        // manifest, so these must be faithful, not noop — and they must be
        // concrete own properties (esbuild's CJS->ESM interop copies own keys;
        // Proxy-getter-only exports come through undefined).
        function resolveSurfaceManifest(decl) {
          const surface = decl == null ? undefined : decl.surface;
          const capabilities = new Set(
            (surface && surface.capabilities) || [],
          );
          const declaredBackground =
            (surface && surface.background) ||
            (decl && decl.backgroundPolicy) ||
            "opaque";
          const background =
            declaredBackground === "shared" && capabilities.has("wallpaper")
              ? "shared"
              : "opaque";
          return {
            background,
            header:
              (surface && surface.header) ||
              (decl && decl.headerPolicy) ||
              "normal",
            isolation: (surface && surface.isolation) || "in-process",
            lifecycle: (surface && surface.lifecycle) || "ephemeral",
            capabilities,
          };
        }
        module.exports = new Proxy(
          {
            ElizaError,
            isElizaError: (v) => v instanceof ElizaError,
            resolveSurfaceManifest,
            resolveSurfaceBackgroundPolicy: (decl) =>
              resolveSurfaceManifest(decl).background,
            surfaceGrants: (manifest, capability) =>
              manifest.capabilities.has(capability),
            IMMERSIVE_WALLPAPER_SURFACE: {
              background: "shared",
              header: "immersive",
              isolation: "immersive",
              capabilities: ["wallpaper", "background:apply"],
            },
          },
          { get: (t, p) => (p in t ? t[p] : noop) },
        );
      `,
      loader: "js",
    }));
  },
};

// @capacitor/core: report a native Android platform so the REAL
// resolveBrowserTabRenderPath picks `native-mobile-webview` — the exact LP3
// production path. openExternalUrl's Browser plugin call records into a
// window hook the assertions read.
const stubCapacitor = {
  name: "stub-capacitor-core",
  setup(b) {
    b.onResolve({ filter: /^@capacitor\/core$/ }, (args) => ({
      path: args.path,
      namespace: "capacitor-stub",
    }));
    b.onLoad({ filter: /.*/, namespace: "capacitor-stub" }, () => ({
      contents: [
        "export const Capacitor = {",
        "  isNativePlatform: function () { return true; },",
        '  getPlatform: function () { return "android"; },',
        "  Plugins: {",
        "    Browser: {",
        "      open: function (options) {",
        "        window.__openedExternally = window.__openedExternally || [];",
        "        window.__openedExternally.push(options.url);",
        "        return Promise.resolve();",
        "      },",
        "    },",
        "  },",
        "};",
        "export const CapacitorHttp = {",
        "  request: function () { return Promise.reject(new Error('no http in fixture')); },",
        "  get: function () { return Promise.reject(new Error('no http in fixture')); },",
        "  post: function () { return Promise.reject(new Error('no http in fixture')); },",
        "};",
        "export function registerPlugin(name) {",
        "  if (name === 'Browser') { return Capacitor.Plugins.Browser; }",
        "  return new Proxy({}, { get: function () { return function () { return Promise.resolve(); }; } });",
        "}",
        "export class WebPlugin {}",
      ].join("\n"),
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

// Swap the `state`/`api` barrels and the surface hook for the fixture stubs.
const stubBarrels = {
  name: "stub-state-api-surface",
  setup(b) {
    b.onResolve({ filter: /^(\.\.\/)+state$/ }, () => ({
      path: join(here, "browser-surface-error-state-stub.ts"),
    }));
    b.onResolve({ filter: /^(\.\.\/)+api$/ }, () => ({
      path: join(here, "browser-surface-error-api-stub.ts"),
    }));
    b.onResolve(
      { filter: /surface\/use-mobile-native-tab-surfaces$/ },
      (args) => {
        if (args.importer.endsWith("BrowserWorkspaceView.tsx")) {
          return { path: join(here, "browser-surface-error-hook-stub.ts") };
        }
        return null;
      },
    );
  },
};

const result = await build({
  entryPoints: [join(here, "browser-surface-error-fixture.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  conditions: ["eliza-source", "browser"],
  jsx: "automatic",
  loader: { ".tsx": "tsx", ".ts": "ts" },
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [stubBarrels, stubCapacitor, stubElizaCore, stubNodeBuiltins],
  write: false,
  absWorkingDir: repoRoot,
});
const js = result.outputFiles[0].text;
console.log(`✓ fixture bundled (${js.length} bytes)`);
const jsPath = join(outDir, "fixture.js");
await writeFile(jsPath, js);

const cssInput = `
@import "tailwindcss";
@import "${join(uiSrc, "styles/base.css")}";
@import "${join(uiSrc, "styles/tailwind-theme.css")}";
@source "${jsPath}";
`;
const css = (
  await postcss([tailwindPostcss()]).process(cssInput, {
    from: join(outDir, "fixture-input.css"),
  })
).css;
console.log(`✓ tailwind theme compiled (${css.length} bytes)`);

const html = `<!doctype html><html class="dark"><head><meta charset="utf-8"><title>browser surface error e2e</title>
<style>${css}</style>
<style>html,body,#root{margin:0;height:100%;background:var(--bg,#000);color:var(--text,#fff)}</style>
<script>window.process=window.process||{env:{NODE_ENV:"production"},platform:"browser",cwd:function(){return "/"}};</script>
</head><body><div id="root"></div><script>${js}</script></body></html>`;
const htmlPath = join(outDir, "fixture.html");
await writeFile(htmlPath, html);

const PERMANENT_TITLE = "Secure browsing not supported here";
const TRANSIENT_TITLE = "Browser view unavailable";

const browser = await chromium.launch();
let shot = 0;
async function snap(page, name) {
  await page.screenshot({
    path: join(outDir, `${name}.png`),
    animations: "disabled",
  });
  shot += 1;
  console.log(`  📸 ${name}.png`);
}

// LP3 CSS viewport (measured on device: 360×414) + a generic phone size.
for (const [vpName, viewport] of [
  ["lp3-360x414", { width: 360, height: 414 }],
  ["phone-390x844", { width: 390, height: 844 }],
]) {
  const errors = [];
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2 });
  page.on("pageerror", (e) => errors.push(String(e)));

  // ── permanent: capability denial ──────────────────────────────────────────
  await page.goto(`file://${htmlPath}#permanent`);
  await page.waitForSelector(`text=${PERMANENT_TITLE}`);
  assert(
    (await page.locator(`text=${PERMANENT_TITLE}`).count()) === 1,
    `${vpName}/permanent: honest unsupported title renders`,
  );
  assert(
    (await page
      .locator("text=can’t keep in-app browsing isolated")
      .count()) === 1,
    `${vpName}/permanent: capability explanation renders`,
  );
  const alertRegion = page.locator('[role="alert"]');
  assert(
    (await alertRegion
      .locator('button:has-text("Retry")')
      .count()) === 0,
    `${vpName}/permanent: NO Retry button inside the error card`,
  );
  const openExternal = alertRegion.locator(
    'button:has-text("Open external")',
  );
  assert(
    (await openExternal.count()) === 1,
    `${vpName}/permanent: Open-external escape hatch renders`,
  );
  await snap(page, `${vpName}-permanent`);
  await openExternal.click();
  await page.waitForTimeout(200);
  const opens = await page.evaluate(() => window.__openedExternally ?? []);
  assert(
    opens.includes("https://example.com/"),
    `${vpName}/permanent: Open external routes the selected tab URL to the device browser`,
  );

  // ── transient: transport fault stays retryable ────────────────────────────
  await page.goto(`file://${htmlPath}#transient`);
  await page.waitForSelector(`text=${TRANSIENT_TITLE}`);
  assert(
    (await page.locator(`text=${PERMANENT_TITLE}`).count()) === 0,
    `${vpName}/transient: permanent copy absent`,
  );
  const retry = page
    .locator('[role="alert"]')
    .locator('button:has-text("Retry")');
  assert(
    (await retry.count()) === 1,
    `${vpName}/transient: Retry button renders`,
  );
  await snap(page, `${vpName}-transient`);
  await retry.click();
  const retries = await page.evaluate(() => window.__surfaceRetries ?? 0);
  assert(
    retries === 1,
    `${vpName}/transient: Retry invokes the surface hook retry`,
  );

  assert(errors.length === 0, `${vpName}: no page errors`);
  for (const e of errors) console.error(`  ⚠ ${e}`);
  await page.close();
}

await browser.close();

console.log(`\nScreenshots (${shot}) → ${outDir}`);
if (failures > 0) {
  console.error(`\nBROWSER SURFACE ERROR E2E FAILED (${failures})`);
  process.exit(1);
}
console.log("\nBROWSER SURFACE ERROR E2E PASSED");
process.exit(0);
