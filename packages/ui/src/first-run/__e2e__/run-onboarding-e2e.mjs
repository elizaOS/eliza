/**
 * Real-browser flow + screenshot pass for the in-chat first-run flow (#9952) —
 * no app server. Bundles onboarding-fixture.tsx with esbuild (stubbing the
 * first-run controller + the app-store `setTab`), loads it in headless chromium,
 * drives BOTH the cloud and local paths through the real ChoiceWidget /
 * CredentialRequestWidget callbacks, and asserts the agent greets first, the
 * choices render as in-chat widgets, and `POST /api/first-run` fires exactly
 * once per path (with firstRunComplete persisted). Screenshots every state
 * (desktop + mobile) so copy/widgets can be reviewed.
 *
 * Run: bun run --cwd packages/ui test:onboarding-e2e
 */
import { mkdir, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "output");
await mkdir(outDir, { recursive: true });

let failures = 0;
function assert(cond, msg) {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures += 1;
  return cond;
}

// Stub the first-run controller (runtime/voice/cloud state) and the app-store
// `setTab` selector with browser-pure stand-ins driven by URL params.
const stubController = {
  name: "stub-first-run-controller",
  setup(b) {
    b.onResolve({ filter: /use-first-run-controller$/ }, () => ({
      path: join(here, "use-first-run-controller.stub.ts"),
    }));
  },
};
const stubAppState = {
  name: "stub-app-state",
  setup(b) {
    b.onResolve({ filter: /\.\.\/state$/ }, () => ({
      path: join(here, "app-state.stub.ts"),
    }));
  },
};

// FirstRunChat → boot-config-store re-exports `syncBrandEnvToEliza` /
// `syncElizaEnvToBrand` from `@elizaos/core`, whose Node entry pulls fs-extra and
// the rest of the server graph (dead in the browser). Production Vite resolves
// core's `browser` export condition; this raw-esbuild bundle does not, so satisfy
// every named import with a no-op Proxy (mirrors run-home-screen-e2e).
const stubElizaPackages = {
  name: "stub-eliza-packages",
  setup(b) {
    b.onResolve({ filter: /^@elizaos\/(core|shared)(\/.*)?$/ }, (args) => ({
      path: args.path,
      namespace: "eliza-pkg-stub",
    }));
    b.onLoad({ filter: /.*/, namespace: "eliza-pkg-stub" }, () => ({
      contents:
        "const noop=new Proxy(()=>noop,{get:()=>noop});module.exports=new Proxy({},{get:()=>noop});",
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
  entryPoints: [join(here, "onboarding-fixture.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  loader: { ".tsx": "tsx", ".ts": "ts" },
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [
    stubController,
    stubAppState,
    stubElizaPackages,
    stubNodeBuiltins,
  ],
  write: false,
});
const js = result.outputFiles[0].text;
const html = `<!doctype html><html><head><meta charset="utf-8"><title>first-run e2e</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>html,body{margin:0;height:100%}</style>
</head><body><div id="root"></div><script>${js}</script></body></html>`;
const htmlPath = join(outDir, "first-run.html");
await writeFile(htmlPath, html);
const url = `file://${htmlPath}`;

let shot = 0;
async function snap(p, name) {
  shot += 1;
  const file = `${String(shot).padStart(2, "0")}-${name}.png`;
  await p.screenshot({ path: join(outDir, file) });
  console.log(`  📸 ${file}`);
}

const sink = { errors: [] };
function attachConsole(p) {
  p.on("pageerror", (e) => sink.errors.push(String(e)));
}

// Visual states (param-driven page loads) for the contact sheet.
const STATES = [
  { q: "", name: "greet-runtime", desktop: true },
  { q: "?nolocal", name: "greet-no-local-runtime", desktop: true },
  { q: "?step=inference", name: "provider", desktop: true },
  { q: "?step=remote", name: "remote", desktop: true },
  { q: "?cloudlogin", name: "cloud-signin", desktop: true },
  { q: "?step=pick-agent", name: "pick-agent", desktop: true },
  { q: "?busy=Starting+your+agent%E2%80%A6", name: "busy", desktop: true },
];

const browser = await chromium.launch();
try {
  for (const view of [
    { w: 402, h: 874, tag: "mobile", scale: 2 },
    { w: 1180, h: 820, tag: "desktop", scale: 1 },
  ]) {
    for (const st of STATES) {
      if (view.tag === "desktop" && !st.desktop) continue;
      const p = await browser.newPage({
        viewport: { width: view.w, height: view.h },
        deviceScaleFactor: view.scale,
      });
      attachConsole(p);
      await p.goto(`${url}${st.q}`);
      await p.waitForSelector('[data-testid="first-run-chat"]', {
        timeout: 10_000,
      });
      await p.waitForTimeout(350);
      await snap(p, `${view.tag}-${st.name}`);
      await p.close();
    }
  }

  // ── Greeting + runtime choice render (agent greets first) ──────────────
  {
    const p = await browser.newPage({
      viewport: { width: 402, height: 874 },
      deviceScaleFactor: 2,
    });
    attachConsole(p);
    await p.goto(url);
    await p.waitForSelector('[data-testid="first-run-chat"]');
    await p.waitForTimeout(200);
    const greeting = await p.getByTestId("first-run-greeting").textContent();
    assert(
      (greeting ?? "").toLowerCase().includes("hey there"),
      "agent greeting is the first surface",
    );
    assert(
      await p.getByTestId("choice-cloud").isVisible(),
      "cloud login is an in-chat ChoiceWidget option",
    );
    assert(
      await p.getByTestId("choice-local").isVisible(),
      "local runtime is an in-chat ChoiceWidget option",
    );
    assert(
      await p.getByTestId("choice-remote").isVisible(),
      "remote runtime is an in-chat ChoiceWidget option",
    );
    await p.close();
  }

  // ── CLOUD PATH: greet → choose cloud → submit once → complete ──────────
  {
    const p = await browser.newPage({
      viewport: { width: 402, height: 874 },
      deviceScaleFactor: 2,
    });
    attachConsole(p);
    await p.goto(url);
    await p.waitForSelector('[data-testid="first-run-chat"]');
    await p.getByTestId("choice-cloud").click();
    await p.waitForTimeout(200);
    const submits = await p.evaluate(() => window.__firstRunSubmits ?? 0);
    const complete = await p.evaluate(() => window.__firstRunComplete === true);
    assert(submits === 1, `cloud path POSTs /api/first-run exactly once (got ${submits})`);
    assert(complete, "cloud path persists firstRunComplete");
    await p.close();
  }

  // ── LOCAL PATH: greet → choose local → on-device default → complete ────
  {
    const p = await browser.newPage({
      viewport: { width: 402, height: 874 },
      deviceScaleFactor: 2,
    });
    attachConsole(p);
    await p.goto(url);
    await p.waitForSelector('[data-testid="first-run-chat"]');
    await p.getByTestId("choice-local").click();
    await p.waitForTimeout(150);
    // The provider question appears; the on-device default is pre-offered.
    assert(
      await p.getByTestId("choice-on-device").isVisible(),
      "local path offers the on-device provider (default)",
    );
    assert(
      await p.getByTestId("choice-elizacloud").isVisible(),
      "local path offers Eliza Cloud inference too",
    );
    await p.getByTestId("choice-on-device").click();
    await p.waitForTimeout(200);
    const submits = await p.evaluate(() => window.__firstRunSubmits ?? 0);
    const complete = await p.evaluate(() => window.__firstRunComplete === true);
    assert(submits === 1, `local path POSTs /api/first-run exactly once (got ${submits})`);
    assert(complete, "local path persists firstRunComplete");
    await p.close();
  }

  // ── "OTHER" provider routes to Settings via the existing handoff ───────
  {
    const p = await browser.newPage({
      viewport: { width: 402, height: 874 },
      deviceScaleFactor: 2,
    });
    attachConsole(p);
    await p.goto(`${url}?step=inference`);
    await p.waitForSelector('[data-testid="first-run-chat"]');
    await p.getByTestId("choice-other").click();
    await p.waitForTimeout(250);
    const routedTab = await p.evaluate(() => window.__firstRunRoutedTab);
    assert(
      routedTab === "settings",
      `"other" provider routes to Settings (got ${routedTab})`,
    );
    await p.close();
  }
} finally {
  await browser.close();
}

assert(sink.errors.length === 0, `no uncaught page errors (${sink.errors.length})`);
if (sink.errors.length) for (const e of sink.errors) console.error(`  ⚠ ${e}`);

console.log(`\nScreenshots (${shot}) written to ${outDir}`);
if (failures > 0) {
  console.error(`\nFIRST-RUN E2E FAILED (${failures} assertion(s))`);
  process.exit(1);
}
console.log("\nFIRST-RUN E2E PASSED");
