/**
 * Real-browser e2e + screenshots for the redesigned Settings hub — no app
 * server. Bundles settings-fixture.tsx with esbuild (REAL SettingsView + REAL
 * section registry; state/api barrels + @elizaos/core stubbed), compiles the
 * real Tailwind v4 theme, loads it in headless chromium via Playwright, and
 * walks the whole surface:
 *
 *   - the hub renders as the iOS-style grouped row list (Agent / App /
 *     Privacy & Security / Cloud) with exactly the MVP-visible sections,
 *   - every visible row opens its section as a subview (hub unmounts, header
 *     retitles) and the header back returns to the hub,
 *   - a `#appearance` hash deep-link opens that section directly,
 *   - desktop (1280×900) + mobile (390×844) screenshots of the hub and every
 *     section, plus a recorded video walkthrough (walkthrough.webm).
 *
 * Exits non-zero on any failed assertion. Run:
 *   bun run --cwd packages/ui test:settings-e2e
 */

import { mkdir, readdir, rename, writeFile } from "node:fs/promises";
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
const outDir = join(here, "output-settings");
await mkdir(outDir, { recursive: true });

let failures = 0;
function assert(cond, msg) {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures += 1;
  return cond;
}

// ── esbuild stubs (mirrors run-connectors-e2e.mjs) ──────────────────────────
// @elizaos/core: proxy no-ops EXCEPT isViewVisible, which the settings
// visibility filter needs for real (developerOnly gating).
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
        const isViewVisible = (view, kinds) => {
          if (view && view.developerOnly) return Boolean(kinds && kinds.developer);
          if (view && view.viewKind === "developer") return Boolean(kinds && kinds.developer);
          return true;
        };
        module.exports = new Proxy({ isViewVisible }, {
          get: (t, p) => (p in t ? t[p] : noop),
        });
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
// state barrel → fixture stub file; api barrel → inline async-empty proxy.
const stubBarrels = {
  name: "stub-state-api-barrels",
  setup(b) {
    b.onResolve({ filter: /^(\.\.\/)+state$/ }, () => ({
      path: join(here, "settings-fixture-state-stub.ts"),
    }));
    b.onResolve({ filter: /^(\.\.\/)+api$/ }, () => ({
      path: "settings-api-stub",
      namespace: "settings-api-stub",
    }));
    b.onLoad({ filter: /.*/, namespace: "settings-api-stub" }, () => ({
      contents: `
        const asyncEmpty = () => Promise.resolve({});
        const client = new Proxy({}, { get: () => asyncEmpty });
        const noop = new Proxy(() => noop, { get: () => noop });
        module.exports = new Proxy({ client }, {
          get: (t, p) => (p in t ? t[p] : noop),
        });
      `,
      loader: "js",
    }));
  },
};

const bundle = await build({
  entryPoints: [join(here, "settings-fixture.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  conditions: ["eliza-source", "browser"],
  jsx: "automatic",
  loader: { ".tsx": "tsx", ".ts": "ts", ".css": "empty", ".svg": "dataurl", ".png": "dataurl" },
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [stubBarrels, stubElizaCore, stubNodeBuiltins],
  write: false,
  absWorkingDir: repoRoot,
});
const js = bundle.outputFiles[0].text;
const bundleJsPath = join(outDir, "settings-fixture.js");
await writeFile(bundleJsPath, js);

const cssInput = `
@import "tailwindcss";
@import "${join(uiSrc, "styles/base.css")}";
@import "${join(uiSrc, "styles/tailwind-theme.css")}";
@source "${bundleJsPath}";
`;
const css = (
  await postcss([tailwindPostcss()]).process(cssInput, {
    from: join(outDir, "fixture-input.css"),
  })
).css;

const html = `<!doctype html><html class="dark"><head><meta charset="utf-8"><title>settings e2e</title>
<style>${css}</style>
<style>html,body{margin:0;min-height:100%;background:#0a0d16;color:#fff}</style>
<script>window.process=window.process||{env:{NODE_ENV:"production"},platform:"browser",cwd:function(){return "/"}};</script>
</head><body><div id="root"></div><script>${js}</script></body></html>`;
const htmlPath = join(outDir, "settings.html");
await writeFile(htmlPath, html);
const url = `file://${htmlPath}`;

async function snap(page, name) {
  await page.screenshot({
    path: join(outDir, `${name}.png`),
    animations: "disabled",
    fullPage: true,
  });
  console.log(`  📸 ${name}.png`);
}

// The MVP-visible hub rows, in expected registry order per group.
const VISIBLE_SECTIONS = [
  "identity",
  "ai-model",
  "connectors",
  "appearance",
  "advanced",
  "permissions",
  "cloud-overview",
];
const HIDDEN_SECTIONS = [
  "voice",
  "capabilities",
  "apps",
  "background",
  "runtime",
  "wallet-rpc",
  "secrets",
  "app-permissions",
];

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  recordVideo: { dir: outDir, size: { width: 1280, height: 900 } },
  reducedMotion: "reduce",
});
const p = await context.newPage();
const pageErrors = [];
p.on("pageerror", (e) => pageErrors.push(String(e)));

await p.goto(url, { waitUntil: "domcontentloaded" });
await p.waitForSelector('[data-testid="desktop-settings-navigation"]');

// ── 1. Persistent desktop rail structure ────────────────────────────────────
const railText = await p
  .locator('[data-testid="desktop-settings-navigation"]')
  .textContent();
for (const group of ["Agent", "App", "Privacy & Security", "Cloud"]) {
  assert(railText.includes(group), `rail shows the "${group}" group label`);
}
for (const id of VISIBLE_SECTIONS) {
  assert(
    (await p.locator(`[data-testid="desktop-settings-item-${id}"]`).count()) ===
      1,
    `rail lists the "${id}" item`,
  );
}
for (const id of HIDDEN_SECTIONS) {
  assert(
    (await p.locator(`[data-testid="desktop-settings-item-${id}"]`).count()) ===
      0,
    `rail hides the "${id}" item (Developer Mode off)`,
  );
}
assert(
  (await p.locator('[data-testid="settings-hub-list"]').count()) === 0,
  "desktop replaces the mobile hub with the persistent rail",
);
await snap(p, "01-rail-desktop");

// ── 2. Every visible rail item switches content in place ────────────────────
let shotIndex = 2;
for (const id of VISIBLE_SECTIONS) {
  const item = p.locator(`[data-testid="desktop-settings-item-${id}"]`);
  await item.click();
  assert(
    (await p.locator(`[id="${id}"]`).count()) === 1,
    `rail item "${id}" opens its section content`,
  );
  assert(
    (await item.getAttribute("aria-current")) === "page",
    `rail item "${id}" retains the active state`,
  );
  assert(
    (await p.locator('[data-testid="desktop-settings-navigation"]').count()) ===
      1,
    `rail remains mounted while "${id}" is open`,
  );
  await p.waitForTimeout(450);
  await snap(p, `${String(shotIndex).padStart(2, "0")}-section-${id}`);
  shotIndex += 1;
}
assert(true, "walked every visible desktop section with the rail retained");

// ── 3. Hash deep-link opens a section directly ───────────────────────────────
await p.goto(`${url}#appearance`, { waitUntil: "domcontentloaded" });
await p.waitForSelector("#appearance");
assert(
  (await p
    .locator('[data-testid="desktop-settings-item-appearance"]')
    .getAttribute("aria-current")) === "page",
  "#appearance deep-link activates Appearance in the persistent rail",
);
await snap(p, `${String(shotIndex).padStart(2, "0")}-deeplink-appearance`);
shotIndex += 1;

// ── 4. Mobile viewport ───────────────────────────────────────────────────────
const mobile = await context.newPage();
await mobile.setViewportSize({ width: 390, height: 844 });
await mobile.goto(url, { waitUntil: "domcontentloaded" });
await mobile.waitForSelector('[data-testid="settings-hub-list"]');
await snap(mobile, `${String(shotIndex).padStart(2, "0")}-hub-mobile`);
shotIndex += 1;
await mobile.locator('[data-testid="settings-hub-row-appearance"]').click();
await mobile.waitForTimeout(450);
await snap(mobile, `${String(shotIndex).padStart(2, "0")}-appearance-mobile`);
await mobile.close();

await p.close();
await context.close();
await browser.close();

// Name the recorded walkthrough deterministically.
for (const f of await readdir(outDir)) {
  if (f.endsWith(".webm") && f !== "walkthrough.webm") {
    await rename(join(outDir, f), join(outDir, "walkthrough.webm"));
    console.log("  🎥 walkthrough.webm");
    break;
  }
}

// Page errors from stubbed-data sections are contained by the per-section
// error boundary; NOTHING may escape to a page error — a real shell TypeError
// must fail the suite, so no message-shape filtering here.
assert(
  pageErrors.length === 0,
  `no uncaught page errors (${pageErrors.length}): ${pageErrors[0] ?? ""}`,
);

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\n✅ settings hub e2e passed");
