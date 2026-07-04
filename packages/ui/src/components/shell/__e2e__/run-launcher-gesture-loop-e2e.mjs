/**
 * Real-browser web lane for the shared #12373 launcher-loop engine
 * (packages/ui/src/testing/launcher-loop) — the piece #12373 shipped without.
 *
 * The engine ships a jsdom self-check against an in-memory FakeDriver plus the
 * Android/iOS native lanes, but had no runner that drives its CdpTouchDriver
 * through a real headless Chromium — so the driver's real-browser path
 * (touch-flick commit timing, notification-overlay handling, scrolled-off tiles)
 * had never actually executed. This lane bundles the REAL composed
 * home↔launcher surface (home-screen-fixture.tsx, reused verbatim) with esbuild,
 * then calls the engine's `runLauncherLoop(page, { seed, actions })` in batches
 * of 50 — a fresh hasTouch/isMobile context per batch, video + trace on. The
 * engine drives genuine CDP touch and checks every §D invariant after each
 * command, throwing with the seed + shrunk command path on the first violation.
 *
 * The seed comes from ELIZA_LOOP_SEED (default random, always printed);
 * ELIZA_LOOP_ACTIONS / ELIZA_LOOP_BATCH tune the run. #12179 requires ≥500
 * actions across 3 consecutive random seeds, green, in a real browser — invoke
 * this three times with three seeds (or use run-launcher-loop-3-seeds.mjs).
 * Only a FAILING batch keeps its (video, trace, seed, shrunk path); the final
 * passing batch's video is kept as the walkthrough (named by seed).
 *
 * Run: bun run --cwd packages/ui test:launcher-loop-e2e
 */

import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import {
  NOTIFICATION_OPEN_SELECTOR,
  runLauncherLoop,
} from "../../../testing/launcher-loop/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "output-launcher-loop");
await mkdir(outDir, { recursive: true });

const TOTAL_ACTIONS = Number(process.env.ELIZA_LOOP_ACTIONS ?? 500);
const BATCH_SIZE = Number(process.env.ELIZA_LOOP_BATCH ?? 50);
const SEED =
  process.env.ELIZA_LOOP_SEED && process.env.ELIZA_LOOP_SEED.trim() !== ""
    ? Number.parseInt(process.env.ELIZA_LOOP_SEED, 10) >>> 0
    : (Math.floor(Math.random() * 0xffffffff) >>> 0) || 1;
const VIDEO_FILE = `launcher-loop-seed${SEED}.webm`;

console.log(
  `\n[launcher-loop] seed=${SEED} actions=${TOTAL_ACTIONS} batch=${BATCH_SIZE}`,
);
console.log(`[launcher-loop] replay: ELIZA_LOOP_SEED=${SEED}\n`);

let failures = 0;
function assert(cond, msg) {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures += 1;
  return cond;
}

async function clearGeneratedArtifacts() {
  for (const entry of await readdir(outDir).catch(() => [])) {
    if (/\.(webm|zip)$/.test(entry) || /^page@.+/.test(entry)) {
      await rm(join(outDir, entry), { force: true }).catch(() => {});
    }
  }
}
await clearGeneratedArtifacts();

// ── esbuild the fixture (identical stub set to run-home-screen-e2e) ──────────
const stubResolver = {
  name: "home-stub-resolver",
  setup(b) {
    b.onResolve({ filter: /(\/api|\/api\/client)$/ }, () => ({
      path: join(here, "home-screen-fixture.api-stub.ts"),
    }));
    b.onResolve({ filter: /useActivityEvents$/ }, () => ({
      path: join(here, "home-screen-fixture.activity-stub.ts"),
    }));
    b.onResolve({ filter: /useDocumentVisibility$/ }, () => ({
      path: join(here, "home-screen-fixture.docvis-stub.ts"),
    }));
    b.onResolve({ filter: /useAvailableViews$/ }, () => ({
      path: join(here, "home-screen-fixture.views-stub.ts"),
    }));
    b.onResolve({ filter: /useViewCatalog$/ }, () => ({
      path: join(here, "home-screen-fixture.catalog-stub.ts"),
    }));
    b.onResolve({ filter: /useViewKinds$/ }, () => ({
      path: join(here, "home-screen-fixture.view-kinds-stub.ts"),
    }));
    b.onResolve({ filter: /platform-guards$/ }, () => ({
      path: join(here, "home-screen-fixture.platform-stub.ts"),
    }));
    b.onResolve({ filter: /\/hooks\/useAuthStatus$/ }, () => ({
      path: join(here, "home-screen-fixture.auth-stub.ts"),
    }));
    b.onResolve({ filter: /\/hooks$/ }, () => ({
      path: join(here, "home-screen-fixture.docvis-stub.ts"),
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
        const resolveViewKind = (d) =>
          (d && d.viewKind) || (d && d.developerOnly ? "developer" : "release");
        const isViewKindEnabled = (kind, enabled) =>
          kind === "system" || kind === "release"
            ? true
            : kind === "developer"
              ? !!(enabled && enabled.developer)
              : kind === "preview"
                ? !!(enabled && enabled.preview)
                : false;
        module.exports = new Proxy(
          {
            resolveViewKind,
            isViewKindEnabled,
            isViewVisible: (d, enabled) =>
              isViewKindEnabled(resolveViewKind(d), enabled),
            dedupeModalities: (m) => Array.from(new Set(Array.isArray(m) ? m : [])),
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
  entryPoints: [join(here, "home-screen-fixture.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  loader: { ".tsx": "tsx", ".ts": "ts" },
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [stubResolver, stubElizaCore, stubNodeBuiltins],
  write: false,
});
const js = result.outputFiles[0].text;
const html = `<!doctype html><html><head><meta charset="utf-8"><title>launcher loop</title>
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover" />
<script src="https://cdn.tailwindcss.com"></script>
<style>html,body{margin:0;height:100%;background:#0a0d16}
:root{--eliza-continuous-chat-clearance:5.25rem;--safe-area-bottom:0px;--eliza-mobile-nav-offset:0px}</style>
<script>window.process=window.process||{env:{NODE_ENV:"production"},platform:"browser",cwd:function(){return "/"}};</script>
</head><body><div id="root"></div><script>${js}</script></body></html>`;
const htmlPath = join(outDir, "launcher-loop.html");
await writeFile(htmlPath, html);
const url = `file://${htmlPath}?native`;

const browser = await chromium.launch();

// Coarse-pointer (touch phone) matchMedia shim — the edge buttons must stay
// hidden on the touch batches, exactly like run-home-screen-e2e.
const COARSE_POINTER_INIT = () => {
  const real = window.matchMedia.bind(window);
  const coarse = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() {
      return false;
    },
  });
  window.matchMedia = (query) =>
    /hover:\s*hover|pointer:\s*fine/.test(query) ? coarse(query) : real(query);
};

async function bootPage(page, sink) {
  page.on("pageerror", (e) => sink.errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") sink.errors.push(`console: ${m.text()}`);
  });
  await page.goto(url);
  await page.waitForSelector('[data-testid="home-launcher-surface"]');
  await page.waitForSelector('[data-testid="home-screen"]');
  await page.waitForTimeout(500);
}

// ── Touch batches (the ≥500-action long loop) ────────────────────────────────
const batchCount = Math.ceil(TOTAL_ACTIONS / BATCH_SIZE);
let applied = 0;
let lastVideoPath = null;

for (let batch = 0; batch < batchCount; batch += 1) {
  const remaining = TOTAL_ACTIONS - applied;
  const size = Math.min(BATCH_SIZE, remaining);
  if (size <= 0) break;
  // Each batch is its own seed offset so the whole run is one deterministic
  // stream, replayable end-to-end from ELIZA_LOOP_SEED.
  const batchSeed = (SEED + batch * 0x9e3779b1) >>> 0;

  const context = await browser.newContext({
    viewport: { width: 402, height: 874 },
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
    recordVideo: { dir: outDir, size: { width: 402, height: 874 } },
  });
  await context.addInitScript(COARSE_POINTER_INIT);
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  const sink = { errors: [] };
  let batchOk = true;
  try {
    await bootPage(page, sink);
    if (batch === 0 && process.env.ELIZA_LOOP_PROBE) {
      const notifOpen = () =>
        page.evaluate(
          (sel) => Boolean(document.querySelector(sel)),
          NOTIFICATION_OPEN_SELECTOR,
        );
      console.log(`[probe] notification-open selector: ${NOTIFICATION_OPEN_SELECTOR}`);
      console.log(`[probe] initially open? ${await notifOpen()}`);
    }
    // The engine drives its own CDP-touch driver + fast-check command stream and
    // checks every invariant after each command; it throws (with seed + shrunk
    // path) on the first violation.
    const runResult = await runLauncherLoop(page, {
      seed: batchSeed,
      actions: size,
    });
    if (sink.errors.length > 0) {
      throw new Error(`page errors during batch: ${sink.errors.join(" | ")}`);
    }
    applied += runResult.actions;
    console.log(
      `  ✓ batch ${batch + 1}/${batchCount} — ${runResult.actions} actions (total ${applied})`,
    );
  } catch (error) {
    batchOk = false;
    failures += 1;
    console.error(
      `\n✗ batch ${batch + 1} FAILED — ${error?.message ?? error}\n`,
    );
    await writeFile(
      join(outDir, `failure-batch-${batch + 1}-seed${batchSeed}.json`),
      `${JSON.stringify(
        {
          seed: batchSeed,
          batch: batch + 1,
          message: String(error?.message ?? error),
          stack: String(error?.stack ?? ""),
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    const video = page.video();
    if (batchOk) {
      await context.tracing.stop().catch(() => {});
      await page.close();
      await context.close();
      if (video) {
        const p = await video.path().catch(() => null);
        if (p) {
          if (lastVideoPath)
            await rm(lastVideoPath, { force: true }).catch(() => {});
          lastVideoPath = p;
        }
      }
    } else {
      // Failing batch: keep the (video, trace, seed, command list) triple.
      await context.tracing
        .stop({
          path: join(outDir, `failure-batch-${batch + 1}-seed${batchSeed}.trace.zip`),
        })
        .catch(() => {});
      await page.close();
      await context.close();
      if (video) {
        const p = await video.path().catch(() => null);
        if (p)
          await rename(
            p,
            join(outDir, `failure-batch-${batch + 1}-seed${batchSeed}.webm`),
          ).catch(() => {});
      }
      break;
    }
  }
}
assert(
  applied >= TOTAL_ACTIONS,
  `applied ≥ ${TOTAL_ACTIONS} touch actions (got ${applied})`,
);
if (lastVideoPath) {
  await rename(lastVideoPath, join(outDir, VIDEO_FILE)).catch(() => {});
  console.log(`  🎥 ${join(outDir, VIDEO_FILE)}`);
}

await browser.close();

console.log(`\nArtifacts → ${outDir}`);
if (failures > 0) {
  console.error(
    `\nLAUNCHER-LOOP E2E FAILED (${failures}) — replay: ELIZA_LOOP_SEED=${SEED}`,
  );
  process.exit(1);
}
console.log(
  `\nLAUNCHER-LOOP E2E PASSED — ${applied} touch actions, seed ${SEED}`,
);
