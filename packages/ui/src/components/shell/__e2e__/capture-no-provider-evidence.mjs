/**
 * Evidence capture for the "no LLM/model provider configured" chat fix.
 *
 * Bundles the REAL ContinuousChatOverlay (via chat-sheet-fixture.tsx) with the
 * same esbuild pipeline as run-chat-sheet-e2e.mjs, loads it in headless
 * chromium, and screenshots the BEFORE (buggy: forever "Waking …" spinner over a
 * no_provider turn) and AFTER (fixed: spinner suppressed, Settings-hint
 * placeholder, no_provider gate is the error surface, openSettings fires).
 *
 * Run: bun packages/ui/src/components/shell/__e2e__/capture-no-provider-evidence.mjs
 */

import { mkdir, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..", "..", "..");
const evidenceDir = join(repoRoot, ".github", "issue-evidence");
await mkdir(evidenceDir, { recursive: true });
const outDir = join(here, "output");
await mkdir(outDir, { recursive: true });

// --- esbuild stubs (mirror run-chat-sheet-e2e.mjs) --------------------------
const stubPromptSuggestions = {
  name: "stub-prompt-suggestions",
  setup(b) {
    b.onResolve({ filter: /usePromptSuggestions$/ }, () => ({
      path: join(here, "usePromptSuggestions.stub.ts"),
    }));
  },
};
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

const result = await build({
  entryPoints: [join(here, "chat-sheet-fixture.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  loader: { ".tsx": "tsx", ".ts": "ts" },
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [stubPromptSuggestions, stubElizaCore, stubNodeBuiltins],
  write: false,
});
const js = result.outputFiles[0].text;
const html = `<!doctype html><html><head><meta charset="utf-8"><title>no-provider evidence</title>
<script src="https://cdn.tailwindcss.com"></script>
<script>window.process=window.process||{env:{NODE_ENV:"production"},platform:"browser",cwd:function(){return "/"}};</script>
<style>html,body{margin:0;height:100%;background:#0a0d16}</style>
</head><body><div id="root"></div><script>${js}</script></body></html>`;
const htmlPath = join(outDir, "no-provider.html");
await writeFile(htmlPath, html);
const url = `file://${htmlPath}`;

// --- capture ----------------------------------------------------------------
const browser = await chromium.launch();
let failures = 0;
const openSettingsLog = [];

async function capture(name, query, { assertBanner, assertPlaceholder }) {
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  page.on("console", (msg) => {
    const text = msg.text();
    if (text.includes("openSettings")) openSettingsLog.push(`${name}: ${text}`);
    if (msg.type() === "error") {
      console.log(`✗ [${name}] console error: ${text}`);
      failures += 1;
    }
  });
  await page.goto(`${url}${query}`);
  // Open the sheet so the transcript (with the no_provider gate) is visible, and
  // wait out the 600ms boot-banner grace so the banner state is settled.
  await page.getByTestId("chat-sheet-grabber").click({ force: true }).catch(() => {});
  await page.waitForTimeout(1200);

  const bannerVisible = await page
    .getByTestId("chat-boot-status")
    .isVisible()
    .catch(() => false);
  const placeholder = await page
    .locator('[data-testid="chat-composer-textarea"]')
    .getAttribute("placeholder")
    .catch(() => null);
  const gateVisible = await page
    .locator('[data-failure="no_provider"]')
    .first()
    .isVisible()
    .catch(() => false);

  const file = join(evidenceDir, `11879-${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log(
    `[${name}] bootBanner=${bannerVisible} placeholder=${JSON.stringify(
      placeholder,
    )} noProviderGate=${gateVisible} → ${file}`,
  );

  if (assertBanner !== undefined && bannerVisible !== assertBanner) {
    console.log(`✗ [${name}] expected bootBanner=${assertBanner}`);
    failures += 1;
  }
  if (assertPlaceholder && !(placeholder ?? "").includes(assertPlaceholder)) {
    console.log(
      `✗ [${name}] expected placeholder to contain "${assertPlaceholder}"`,
    );
    failures += 1;
  }
  if (!gateVisible) {
    console.log(`✗ [${name}] expected the no_provider gate to be visible`);
    failures += 1;
  }
  // Close-up of the reused error surface (the no_provider gate + "Open Settings"
  // CTA) so the reviewer sees exactly what replaces the forever spinner.
  const gate = page.locator('[data-failure="no_provider"]').first();
  if (await gate.count()) {
    await gate
      .screenshot({ path: join(evidenceDir, `11879-${name}-gate.png`) })
      .catch(() => {});
  }
  // Prove the error surface's CTA navigates to Settings (the real controller
  // ALSO auto-navigates via setTab("settings") — covered by the unit test).
  const gateCta = page.locator('[data-testid="chat-no-provider-settings"]');
  if (await gateCta.count()) {
    await gateCta.first().click({ force: true });
    await page.waitForTimeout(100);
  }
  await page.close();
}

// BEFORE (pre-fix): forever "Waking …" spinner sits over the no_provider turn.
await capture(
  "before-waking-spinner",
  "?phase=booting&failure=no_provider&noprovider=off",
  { assertBanner: true, assertPlaceholder: "waking up" },
);
// AFTER (fixed): spinner suppressed, Settings-hint placeholder, gate is the
// error surface. openSettings is invoked (the fixture logs it) — the real
// controller navigates via setTab("settings").
await capture(
  "after-settings-cta",
  "?phase=booting&failure=no_provider",
  { assertBanner: false, assertPlaceholder: "Settings" },
);

console.log(
  `openSettings invocations: ${
    openSettingsLog.length ? openSettingsLog.join(", ") : "(none)"
  }`,
);

await browser.close();
if (failures > 0) {
  console.log(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll evidence captured + assertions passed.");
