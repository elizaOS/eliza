/**
 * Real-browser flow + screenshot pass for CompactOnboarding. Bundles
 * onboarding-fixture.tsx with esbuild, stubs the first-run controller, loads it
 * in headless Chromium, drives the cloud/local/advanced paths, and asserts
 * `POST /api/first-run` fires exactly once per terminal path.
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

// Stub the first-run controller with a browser-pure stand-in driven by URL params.
const stubController = {
  name: "stub-first-run-controller",
  setup(b) {
    b.onResolve({ filter: /use-first-run-controller$/ }, () => ({
      path: join(here, "use-first-run-controller.stub.ts"),
    }));
  },
};
// CompactOnboarding -> boot-config-store re-exports `syncBrandEnvToEliza` /
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
  plugins: [stubController, stubElizaPackages, stubNodeBuiltins],
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
  { q: "", name: "choose", desktop: true },
  { q: "?nolocal", name: "choose-no-local-runtime", desktop: true },
  { q: "?step=inference", name: "inference", desktop: true },
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
      await p.waitForSelector('[data-testid="onboarding-toast"]', {
        timeout: 10_000,
      });
      await p.waitForTimeout(350);
      await snap(p, `${view.tag}-${st.name}`);
      await p.close();
    }
  }

  // Default runtime choices: cloud + local visible, advanced collapsed.
  {
    const p = await browser.newPage({
      viewport: { width: 402, height: 874 },
      deviceScaleFactor: 2,
    });
    attachConsole(p);
    await p.goto(url);
    await p.waitForSelector('[data-testid="onboarding-toast"]');
    await p.waitForTimeout(200);
    assert(
      await p.getByTestId("onboarding-option-cloud").isVisible(),
      "cloud sign-in option card is visible",
    );
    assert(
      await p.getByTestId("onboarding-option-local").isVisible(),
      "local runtime option card is visible",
    );
    assert(
      await p.getByTestId("onboarding-advanced-toggle").isVisible(),
      "advanced disclosure toggle is visible",
    );
    assert(
      (await p.getByTestId("onboarding-option-remote").count()) === 0,
      "remote self-hosted option is hidden until Advanced opens",
    );
    await p.getByTestId("onboarding-advanced-toggle").click();
    assert(
      await p.getByTestId("onboarding-option-remote").isVisible(),
      "remote self-hosted option appears after Advanced opens",
    );
    await p.close();
  }

  // CLOUD PATH: choose cloud -> submit once -> complete.
  {
    const p = await browser.newPage({
      viewport: { width: 402, height: 874 },
      deviceScaleFactor: 2,
    });
    attachConsole(p);
    await p.goto(url);
    await p.waitForSelector('[data-testid="onboarding-toast"]');
    await p.getByTestId("onboarding-option-cloud").click();
    await p.waitForTimeout(200);
    const submits = await p.evaluate(() => window.__firstRunSubmits ?? 0);
    const complete = await p.evaluate(() => window.__firstRunComplete === true);
    assert(submits === 1, `cloud path POSTs /api/first-run exactly once (got ${submits})`);
    assert(complete, "cloud path persists firstRunComplete");
    await p.close();
  }

  // LOCAL PATH: choose local -> choose on-device inference -> complete.
  {
    const p = await browser.newPage({
      viewport: { width: 402, height: 874 },
      deviceScaleFactor: 2,
    });
    attachConsole(p);
    await p.goto(url);
    await p.waitForSelector('[data-testid="onboarding-toast"]');
    await p.getByTestId("onboarding-option-local").click();
    await p.waitForTimeout(150);
    assert(
      await p.getByTestId("onboarding-inference-local").isVisible(),
      "local path offers on-device inference",
    );
    assert(
      await p.getByTestId("onboarding-inference-cloud").isVisible(),
      "local path offers Eliza Cloud inference",
    );
    await p.getByTestId("onboarding-inference-local").click();
    await p.waitForTimeout(200);
    const submits = await p.evaluate(() => window.__firstRunSubmits ?? 0);
    const complete = await p.evaluate(() => window.__firstRunComplete === true);
    assert(submits === 1, `local path POSTs /api/first-run exactly once (got ${submits})`);
    assert(complete, "local path persists firstRunComplete");
    await p.close();
  }

  // REMOTE PATH: Advanced -> connect my own agent -> remote form.
  {
    const p = await browser.newPage({
      viewport: { width: 402, height: 874 },
      deviceScaleFactor: 2,
    });
    attachConsole(p);
    await p.goto(url);
    await p.waitForSelector('[data-testid="onboarding-toast"]');
    await p.getByTestId("onboarding-advanced-toggle").click();
    await p.getByTestId("onboarding-option-remote").click();
    await p.waitForTimeout(150);
    assert(
      await p.getByTestId("onboarding-remote-connect").isVisible(),
      "advanced remote path opens the connect form",
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
