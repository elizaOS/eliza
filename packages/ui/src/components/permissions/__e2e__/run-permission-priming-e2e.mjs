/**
 * Real-browser e2e for the onboarding permission-priming modal — no app server.
 * Bundles permission-priming-fixture.tsx (the REAL modal on its live hook) with
 * esbuild, stubs the `api/client` singleton so OS requests are deterministic,
 * and drives the soft-ask gesture flow end to end in headless chromium:
 *   - the first card (microphone) shows Enable / Not now;
 *   - tapping Enable fires the (stubbed) OS request and advances to the next card;
 *   - a scripted denial keeps the card active and surfaces the recovery callout;
 *   - Continue advances past the denied card;
 *   - granting the last card completes the sequence (body[data-primed]).
 * Captures desktop + mobile screenshots (each state) and a mobile video.
 *
 * Run: bun run --cwd packages/ui test:permission-priming-e2e
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const stylesDir = join(here, "../../../styles");
const outDir = join(here, "output-permission-priming");
await mkdir(outDir, { recursive: true });

let failures = 0;
function assert(cond, msg) {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures += 1;
  return cond;
}

const baseCss = await readFile(join(stylesDir, "base.css"), "utf8");
const TOKEN_SHIM = `
.bg-accent{background-color:var(--accent)}
.bg-accent-subtle{background-color:var(--accent-subtle)}
.text-accent{color:var(--accent)}
.text-accent-fg{color:var(--accent-foreground)}
.bg-bg-accent{background-color:var(--bg-accent)}
.border-warn\\/30{border-color:rgba(234,179,8,0.3)}
.bg-warn\\/10{background-color:rgba(234,179,8,0.1)}
`;

// Deterministic client stub: an in-memory permission store; requestPermission
// grants unless window.__deny[id] is set. Written to the gitignored output dir.
const clientStub = join(outDir, "client-stub.mjs");
await writeFile(
  clientStub,
  `const store = (globalThis.__perm ||= {});
function snap(id) {
  const status = store[id] ?? "not-determined";
  return { id, status, canRequest: status === "not-determined", platform: "web", lastChecked: 0 };
}
export const client = {
  async getPermission(id) { return snap(id); },
  async requestPermission(id) {
    const denied = globalThis.__deny && globalThis.__deny[id];
    store[id] = denied ? "denied" : "granted";
    return snap(id);
  },
  async openPermissionSettings() {},
};
`,
);
const stubClient = {
  name: "stub-client",
  setup(b) {
    b.onResolve({ filter: /api\/client(\.[tj]s)?$/ }, () => ({
      path: clientStub,
    }));
  },
};

// The modal's graph incidentally reaches `@elizaos/core` (a UI util imports the
// `@elizaos/shared` barrel, whose HTTP helpers import core). The modal never
// executes any of it, so stub core to a proxy of undefineds and shim node
// builtins — same "stub heavy deps with esbuild onResolve" pattern the other
// __e2e__ runners use for their network deps.
// CJS stub (`.cjs` so esbuild wraps it and `module` is defined): arbitrary
// named imports of core resolve to `undefined` via CJS interop, since the modal
// never executes any core code path.
const coreStub = join(outDir, "core-stub.cjs");
await writeFile(coreStub, "module.exports = {};\n");
const stubCore = {
  name: "stub-core",
  setup(b) {
    b.onResolve({ filter: /^@elizaos\/core($|\/)/ }, () => ({ path: coreStub }));
  },
};
const NODE_BUILTINS =
  /^(node:|fs$|fs\/promises$|path$|crypto$|os$|util$|events$|stream$|child_process$|http$|https$|net$|tls$|url$|zlib$|buffer$|assert$|readline$|worker_threads$|perf_hooks$|module$|constants$|string_decoder$|tty$|dns$|querystring$|vm$|v8$|async_hooks$)/;
const shimNodeBuiltins = {
  name: "shim-node-builtins",
  setup(b) {
    b.onResolve({ filter: NODE_BUILTINS }, (a) => ({
      path: a.path,
      namespace: "node-empty",
    }));
    b.onLoad({ filter: /.*/, namespace: "node-empty" }, () => ({
      // CJS so arbitrary named builtin imports resolve to undefined via interop.
      contents: "module.exports = {};",
      loader: "js",
    }));
  },
};

const result = await build({
  entryPoints: [join(here, "permission-priming-fixture.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  loader: { ".tsx": "tsx", ".ts": "ts" },
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [stubClient, stubCore, shimNodeBuiltins],
  write: false,
});
const js = result.outputFiles[0].text;
const html = `<!doctype html><html class="dark"><head><meta charset="utf-8"><title>permission priming e2e</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>${baseCss}</style>
<style>${TOKEN_SHIM}</style>
<style>html,body{margin:0;height:100%;background:var(--bg)}</style>
</head><body><div id="root"></div><script>${js}</script></body></html>`;
const htmlPath = join(outDir, "permission-priming.html");
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

async function runFlow(page, label) {
  await page.goto(url);
  await page.waitForSelector('[data-testid="priming-card-microphone"]');
  assert(
    await page.getByTestId("priming-enable-microphone").isVisible(),
    `[${label}] first card (microphone) shows Enable`,
  );
  await snap(page, `${label}-01-microphone`);

  // Enable microphone → granted → advance to location.
  await page.getByTestId("priming-enable-microphone").click();
  await page.waitForSelector('[data-testid="priming-card-location"]');
  assert(
    (await page.getByTestId("priming-card-microphone").count()) === 0,
    `[${label}] granting microphone advances to the next card`,
  );
  await snap(page, `${label}-02-location`);

  // Script a denial for location, then Enable → denied → recovery callout.
  await page.evaluate(() => {
    window.__deny = { location: true };
  });
  await page.getByTestId("priming-enable-location").click();
  await page.waitForSelector('[data-testid="priming-recovery-location"]');
  assert(
    await page.getByTestId("priming-recovery-location").isVisible(),
    `[${label}] a denied permission surfaces the recovery callout`,
  );
  await snap(page, `${label}-03-location-denied`);

  // Continue past the denied card → notifications.
  await page.getByTestId("priming-skip-location").click();
  await page.waitForSelector('[data-testid="priming-card-notifications"]');
  assert(true, `[${label}] Continue advances past the denied card`);

  // Grant notifications (denial cleared) → sequence complete.
  await page.evaluate(() => {
    window.__deny = {};
  });
  await page.getByTestId("priming-enable-notifications").click();
  await page.waitForFunction(() => document.body.dataset.primed === "1");
  assert(true, `[${label}] granting the last card completes the sequence`);
  await snap(page, `${label}-04-complete`);
}

try {
  for (const view of [
    { name: "desktop", viewport: { width: 1180, height: 820 } },
    { name: "mobile", viewport: { width: 402, height: 874 } },
  ]) {
    const ctx = await browser.newContext({ viewport: view.viewport });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => sink.errors.push(`[${view.name}] ${e}`));
    await runFlow(page, view.name);
    await ctx.close();
  }

  // Video walkthrough of the full soft-ask flow (mobile).
  const vctx = await browser.newContext({
    viewport: { width: 402, height: 874 },
    deviceScaleFactor: 2,
    recordVideo: { dir: outDir, size: { width: 402, height: 874 } },
  });
  const movie = await vctx.newPage();
  movie.on("pageerror", (e) => sink.errors.push(`[video] ${e}`));
  await movie.goto(url);
  await movie.waitForSelector('[data-testid="priming-card-microphone"]');
  await movie.waitForTimeout(700);
  await movie.getByTestId("priming-enable-microphone").click();
  await movie.waitForSelector('[data-testid="priming-card-location"]');
  await movie.waitForTimeout(700);
  await movie.evaluate(() => {
    window.__deny = { location: true };
  });
  await movie.getByTestId("priming-enable-location").click();
  await movie.waitForSelector('[data-testid="priming-recovery-location"]');
  await movie.waitForTimeout(700);
  await movie.getByTestId("priming-skip-location").click();
  await movie.waitForSelector('[data-testid="priming-card-notifications"]');
  await movie.evaluate(() => {
    window.__deny = {};
  });
  await movie.getByTestId("priming-enable-notifications").click();
  await movie.waitForFunction(() => document.body.dataset.primed === "1");
  await movie.waitForTimeout(500);
  const video = await movie.video();
  await movie.close();
  await vctx.close();
  if (video) console.log(`  🎥 ${await video.path()}`);
} finally {
  await browser.close();
}

assert(sink.errors.length === 0, `no page errors (${sink.errors.length})`);
for (const e of sink.errors) console.error(`  ⚠ ${e}`);

console.log(`\nScreenshots (${shot}) → ${outDir}`);
if (failures > 0) {
  console.error(`\nPERMISSION PRIMING E2E FAILED (${failures})`);
  process.exit(1);
}
console.log("\nPERMISSION PRIMING E2E PASSED");
