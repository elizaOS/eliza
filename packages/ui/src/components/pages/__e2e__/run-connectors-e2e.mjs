/**
 * Real-browser e2e + screenshots for the connector card's config/setup-panel
 * co-rendering (#10705) — no app server. Bundles connectors-fixture.tsx with
 * esbuild (real ConnectorPluginGroups + real PluginConfigForm + real
 * ConnectorSetupPanel/ConnectorAccountList; only the state/api barrels are
 * stubbed), compiles the real Tailwind v4 theme (base.css + tailwind-theme.css),
 * loads it in headless chromium via Playwright, and:
 *
 *   - asserts the Signal config form AND the delegated account-management
 *     setup panel co-render (the #10705 fix),
 *   - captures screenshots at desktop (1280×900) and mobile (390×844).
 *
 * With --with-baseline it ALSO builds the fixture against the pre-fix
 * plugin-view-connectors.tsx from origin/develop (via `git show`) and asserts
 * the inverse — the config form is dropped — capturing before/* screenshots
 * that visually document the regression.
 *
 * Exits non-zero on any failed assertion or page error.
 *
 * Run: bun run --cwd packages/ui test:connectors-e2e [-- --with-baseline]
 */

import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindPostcss from "@tailwindcss/postcss";
import { build } from "esbuild";
import { chromium } from "playwright";
import postcss from "postcss";

const here = dirname(fileURLToPath(import.meta.url));
const pagesDir = resolve(here, "..");
const uiSrc = resolve(here, "../../..");
const repoRoot = resolve(uiSrc, "../../..");
const outDir = join(here, "output-connectors");
await mkdir(outDir, { recursive: true });

const withBaseline = process.argv.includes("--with-baseline");

let failures = 0;
function assert(cond, msg) {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures += 1;
  return cond;
}

// ── esbuild stubs (mirrors run-launcher-e2e.mjs) ────────────────────────────
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
        module.exports = new Proxy({}, { get: () => noop });
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

// Swap the `state`/`api` barrels for the fixture stubs. Only the bare barrel
// specifiers are intercepted — submodules (e.g. state/TranslationContext.hooks)
// stay real.
const stubBarrels = {
  name: "stub-state-api-barrels",
  setup(b) {
    b.onResolve({ filter: /^(\.\.\/)+state$/ }, () => ({
      path: join(here, "connectors-fixture-state-stub.ts"),
    }));
    b.onResolve({ filter: /^(\.\.\/)+api$/ }, () => ({
      path: join(here, "connectors-fixture-api-stub.ts"),
    }));
  },
};

/**
 * Redirect the fixture's `../plugin-view-connectors` import to a provided
 * file — used by the --with-baseline build to bundle the pre-fix component
 * from origin/develop.
 */
function redirectComponent(toPath) {
  return {
    name: "redirect-plugin-view-connectors",
    setup(b) {
      b.onResolve({ filter: /plugin-view-connectors$/ }, (args) => {
        if (args.importer.includes("__e2e__")) return { path: toPath };
        return null;
      });
    },
  };
}

async function bundleFixture(extraPlugins = []) {
  const result = await build({
    entryPoints: [join(here, "connectors-fixture.tsx")],
    bundle: true,
    format: "iife",
    platform: "browser",
    conditions: ["eliza-source", "browser"],
    jsx: "automatic",
    loader: { ".tsx": "tsx", ".ts": "ts" },
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [...extraPlugins, stubBarrels, stubElizaCore, stubNodeBuiltins],
    write: false,
    absWorkingDir: repoRoot,
  });
  return result.outputFiles[0].text;
}

// ── Real theme CSS: Tailwind v4 over the bundled fixture ────────────────────
async function compileCss(bundleJsPath) {
  const input = `
@import "tailwindcss";
@import "${join(uiSrc, "styles/base.css")}";
@import "${join(uiSrc, "styles/tailwind-theme.css")}";
@source "${bundleJsPath}";
`;
  const from = join(outDir, "fixture-input.css");
  const result = await postcss([tailwindPostcss()]).process(input, { from });
  return result.css;
}

let shot = 0;
async function snap(page, name) {
  const file = `${name}.png`;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.screenshot({
        path: join(outDir, file),
        animations: "disabled",
        fullPage: true,
      });
      shot += 1;
      console.log(`  📸 ${file}`);
      return;
    } catch (err) {
      lastErr = err;
      await page.waitForTimeout(300);
    }
  }
  assert(false, `screenshot ${file} failed after retries: ${lastErr}`);
}

const CONFIG_FIELD = "#field-signal-SIGNAL_PHONE_NUMBER";
const PANEL_TITLE = "Signal accounts";
const ACCOUNT_LABEL = "Owner device";

async function capture(browser, { label, js, css, expectConfigForm }) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>connectors e2e — ${label}</title>
<style>${css}</style>
<style>html,body{margin:0;min-height:100%;background:var(--bg,#fff);color:var(--text,#000)}</style>
<script>window.process=window.process||{env:{NODE_ENV:"production"},platform:"browser",cwd:function(){return "/"}};</script>
</head><body><div id="root"></div><script>${js}</script></body></html>`;
  const htmlPath = join(outDir, `${label}.html`);
  await writeFile(htmlPath, html);
  const url = `file://${htmlPath}`;

  for (const [vpName, viewport, dsf] of [
    ["desktop", { width: 1280, height: 900 }, undefined],
    ["mobile", { width: 390, height: 844 }, 2],
  ]) {
    const errors = [];
    const page = await browser.newPage({
      viewport,
      deviceScaleFactor: dsf,
    });
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(url);
    await page.waitForSelector('[data-testid="connector-section-signal"]');
    // The real ConnectorAccountList resolves the (stubbed) account fetch async.
    await page.waitForSelector(`text=${ACCOUNT_LABEL}`);
    await page.waitForTimeout(400);

    const hasConfigField = (await page.locator(CONFIG_FIELD).count()) > 0;
    const hasPanelTitle =
      (await page.locator(`text=${PANEL_TITLE}`).count()) > 0;
    const hasAccount =
      (await page.locator(`text=${ACCOUNT_LABEL}`).count()) > 0;

    assert(
      hasPanelTitle && hasAccount,
      `${label}/${vpName}: delegated setup panel renders ("${PANEL_TITLE}" + "${ACCOUNT_LABEL}")`,
    );
    assert(
      hasConfigField === expectConfigForm,
      `${label}/${vpName}: config form (${CONFIG_FIELD}) ${
        expectConfigForm ? "co-renders with" : "is dropped alongside"
      } the setup panel`,
    );
    assert(errors.length === 0, `${label}/${vpName}: no page errors`);
    for (const e of errors) console.error(`  ⚠ ${e}`);

    await snap(page, `${label}-${vpName}`);
    await page.close();
  }
}

// ── AFTER: current tree (the #10705 fix) ────────────────────────────────────
const afterJs = await bundleFixture();
console.log(`✓ fixture bundled — current tree (${afterJs.length} bytes)`);
const afterJsPath = join(outDir, "fixture-after.js");
await writeFile(afterJsPath, afterJs);
const afterCss = await compileCss(afterJsPath);
console.log(`✓ tailwind theme compiled (${afterCss.length} bytes)`);

const browser = await chromium.launch();
await capture(browser, {
  label: "after",
  js: afterJs,
  css: afterCss,
  expectConfigForm: true,
});

// ── BEFORE (optional): pre-fix component from origin/develop ────────────────
if (withBaseline) {
  const baselinePath = join(
    pagesDir,
    "plugin-view-connectors.__develop_baseline__.tsx",
  );
  const developSource = execFileSync(
    "git",
    [
      "show",
      "origin/develop:packages/ui/src/components/pages/plugin-view-connectors.tsx",
    ],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  await writeFile(baselinePath, developSource);
  try {
    const beforeJs = await bundleFixture([redirectComponent(baselinePath)]);
    console.log(
      `✓ fixture bundled — origin/develop baseline (${beforeJs.length} bytes)`,
    );
    const beforeJsPath = join(outDir, "fixture-before.js");
    await writeFile(beforeJsPath, beforeJs);
    const beforeCss = await compileCss(beforeJsPath);
    await capture(browser, {
      label: "before",
      js: beforeJs,
      css: beforeCss,
      expectConfigForm: false,
    });
  } finally {
    await rm(baselinePath, { force: true });
  }
}

await browser.close();

console.log(`\nScreenshots (${shot}) → ${outDir}`);
if (failures > 0) {
  console.error(`\nCONNECTORS E2E FAILED (${failures})`);
  process.exit(1);
}
console.log("\nCONNECTORS E2E PASSED");
process.exit(0);
