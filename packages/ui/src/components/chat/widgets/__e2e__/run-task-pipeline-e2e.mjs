/**
 * Real-browser render pass for the inline task-activity pipeline (#13536).
 * Bundles the fixture with esbuild (single React copy), loads it in headless
 * chromium, and screenshots the grouped task → sub-agent → step tree at desktop
 * and mobile widths — asserting the nested sub-agents, in-place tool steps, live
 * plan checklist, workflow pipeline, and standalone checklist all render with a
 * clean console. This is the rendered-pixel half: the fixture mounts the real
 * pipeline components on the exact `SubagentActivity`/plan shapes the store
 * produces. The WS stream → those shapes seam is proven separately (real
 * `client.deliverWsMessageForTest` → `bindWs`) in `task-activity-store.test.ts`.
 *
 * Run: bun run --cwd packages/ui test:task-pipeline-e2e
 */
import { mkdir, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "output");
await mkdir(outDir, { recursive: true });

// The only RUNTIME symbol the fixture itself pulls from @elizaos/core is
// `toSwarmActivity` (via the store); it lives in the pure, dependency-free
// swarm-coordinator module. But the store also reaches @elizaos/shared, whose
// node-only modules import many OTHER core symbols (logger, ModelType,
// resolveStateDir, …) — all dead in the browser here. A narrow core→
// swarm-coordinator alias breaks those ("no matching export"); instead stub
// @elizaos/core to a module that serves the real swarm-coordinator exports and
// a no-op Proxy for everything else, so the whole graph resolves.
const repoRoot = resolve(here, "../../../../../../..");
const coreActivityEntry = join(
  repoRoot,
  "packages/core/src/types/swarm-coordinator.ts",
);
const stubElizaCore = {
  name: "stub-eliza-core",
  setup(b) {
    b.onResolve({ filter: /^@elizaos\/core$/ }, () => ({
      path: "eliza-core-stub",
      namespace: "eliza-core-stub",
    }));
    b.onLoad({ filter: /.*/, namespace: "eliza-core-stub" }, () => ({
      contents: `
        const real = require(${JSON.stringify(coreActivityEntry)});
        const noop = new Proxy(() => noop, { get: () => noop });
        module.exports = new Proxy(real, {
          get: (t, p) => (p in t ? t[p] : noop),
        });
      `,
      loader: "js",
      resolveDir: repoRoot,
    }));
  },
};

let failures = 0;
function assert(cond, msg) {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures += 1;
  return cond;
}

// Aliasing @elizaos/core is not enough: the store also reaches @elizaos/shared /
// @elizaos/logger, whose node-only modules (paths, cloud TTS, apps-loading
// routes, logger os probe) import Node builtins — all dead in the browser here.
// Stub every builtin to a no-op module so the browser bundle resolves, mirroring
// the sibling page runners; the page-error guard would catch any that ran.
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
  entryPoints: [join(here, "task-pipeline-fixture.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  conditions: ["browser", "import"],
  jsx: "automatic",
  loader: { ".tsx": "tsx", ".ts": "ts" },
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [stubElizaCore, stubNodeBuiltins],
  write: false,
});
const js = result.outputFiles[0].text;

// Map the brand tokens the widgets use (text-ok/bg-card/border-border/…) so the
// render is faithful; the Tailwind CDN supplies the layout/animation utilities.
const css = `
:root{color-scheme:dark}
body{background:#0b0b0c;color:#e8e8e8;font:13px/1.45 system-ui,sans-serif;margin:0}
.text-txt{color:#ededed}.text-txt\\/80{color:#edededcc}.text-txt\\/70{color:#ededed;opacity:.7}
.text-muted{color:#9aa0a6}
.text-muted\\/40{color:#9aa0a666}.text-muted\\/50{color:#9aa0a680}.text-muted\\/60{color:#9aa0a699}
.text-ok{color:#34d399}.text-danger{color:#f87171}.text-warn{color:#fbbf24}
.text-accent{color:#ff7a1a}.text-accent-hover{color:#e56a10}
.bg-card{background:#161619}.bg-bg-hover{background:#1f1f24}
.border,.border-t,.border-l{border-style:solid;border-width:0}
.border{border-width:1px}.border-t{border-top-width:1px}.border-l{border-left-width:1px}
.border-border{border-color:#33333a}
.rounded-sm{border-radius:6px}.rounded-none{border-radius:0}
.tabular-nums{font-variant-numeric:tabular-nums}
.line-through{text-decoration:line-through}
`;
const html = `<!doctype html><html><head><meta charset="utf-8"><title>task pipeline e2e</title>
<script src="https://cdn.tailwindcss.com"></script>
<!-- Shim node-ish globals the dead-in-browser @elizaos/shared graph touches at module init. -->
<script>window.process=window.process||{env:{NODE_ENV:"production"},platform:"browser",cwd:function(){return "/"}};</script>
<style>${css}</style></head><body><div id="root"></div><script>${js}</script></body></html>`;
const htmlPath = join(outDir, "task-pipeline.html");
await writeFile(htmlPath, html);
const url = `file://${htmlPath}`;

const sink = { errors: [] };
const browser = await chromium.launch();
try {
  const p = await browser.newPage({
    viewport: { width: 900, height: 1000 },
    deviceScaleFactor: 2,
  });
  p.on("pageerror", (e) => sink.errors.push(String(e)));
  p.on("console", (m) => {
    if (m.type() === "error") sink.errors.push(`[console.error] ${m.text()}`);
  });
  await p.goto(url);
  await p.waitForSelector('[data-testid="task-pipeline-fixture"]', {
    timeout: 15_000,
  });
  await p.waitForSelector('[data-testid="subagent-block"]', { timeout: 10_000 });
  await p.waitForTimeout(300);
  await p.screenshot({
    path: join(outDir, "task-pipeline-desktop.png"),
    fullPage: true,
  });
  console.log("  📸 task-pipeline-desktop.png");

  assert(
    (await p.getByText("Ship the planner loop").count()) > 0,
    "task card header renders the task title",
  );
  assert(
    (await p.locator('[data-testid="subagent-block"]').count()) === 2,
    "both sub-agents render (builder + nested reviewer)",
  );
  assert(
    (await p.locator('[data-session-id="reviewer-2c8b"]').count()) > 0,
    "the nested reviewer child session renders",
  );
  assert(
    (await p.locator('[data-testid="plan-checklist"]').count()) > 0,
    "the live plan checklist renders inside the card",
  );
  assert(
    (await p.getByText("turn-controller.ts").count()) > 0,
    "tool-call steps render with their input preview",
  );
  assert(
    (await p.locator('[data-testid="workflow-steps"]').count()) > 0,
    "the [WORKFLOW] step pipeline renders",
  );
  assert(
    (await p.getByText("Migration").count()) > 0,
    "the standalone [CHECKLIST] renders",
  );

  // Mobile viewport — the pipeline must stay readable narrow.
  await p.setViewportSize({ width: 390, height: 900 });
  await p.waitForTimeout(300);
  await p.screenshot({
    path: join(outDir, "task-pipeline-mobile.png"),
    fullPage: true,
  });
  console.log("  📸 task-pipeline-mobile.png");
  assert(
    (await p.locator('[data-testid="subagent-block"]').count()) === 2,
    "sub-agents still render at mobile width",
  );

  await p.close();
} finally {
  await browser.close();
}

assert(sink.errors.length === 0, `clean console (${sink.errors.length} errors)`);
for (const e of sink.errors) console.error(`  ⚠ ${e}`);

console.log(`\nScreenshots written to ${outDir}`);
if (failures > 0) {
  console.error(`\nTASK PIPELINE E2E FAILED (${failures} assertion(s))`);
  process.exit(1);
}
console.log("\nTASK PIPELINE E2E PASSED");
