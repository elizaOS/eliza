/**
 * Seeded launcher gesture-loop web lane — the real-browser CDP runner for the
 * shared launcher-loop engine (packages/ui/src/testing/launcher-loop, #12373).
 *
 * The engine ships a jsdom self-check (launcher-loop.test.ts, a FakeDriver) and
 * the native Android/iOS lanes, but had no real-browser web runner, so its
 * `CdpTouchDriver` had never actually driven a live surface. This is that lane
 * (#12179 WI-6 / #12375): it esbuild-bundles the REAL composed home↔launcher
 * fixture (home-screen-fixture.tsx, the same one run-home-screen-e2e drives),
 * loads it in headless Chromium, and runs `runLauncherLoop(page, …)` in fresh
 * hasTouch/isMobile contexts, one per batch, with video + trace on. The engine
 * drives genuine CDP touch and checks every §D invariant (data-page / AX probe /
 * transform-at-rest, focus never inert, telemetry launch count == real taps,
 * zero console errors, CLS budget, no blue) after each command, throwing with
 * the seed + shrunk command path on the first violation. Only a FAILING batch
 * keeps its (video, trace, seed, shrunk path); the final passing batch's video
 * is the walkthrough.
 *
 * A brand-color scan (blue-hue + orange-accent sample) runs before and after the
 * whole loop and is written to brand-scan.json — the no-blue invariant already
 * guards every step, this is the human-auditable bookend.
 *
 * Seed: ELIZA_LOOP_SEED (default random, always printed). Tuning:
 * ELIZA_LOOP_ACTIONS (total, default 500), ELIZA_LOOP_BATCH (per-batch, default
 * 100). Replay: rerun with the printed ELIZA_LOOP_SEED to reproduce the whole
 * run; the failure json records the failing batch's exact seed + shrunk command
 * list; ELIZA_LOOP_ONLY_BATCH=<n> replays just that batch.
 *
 * Run: bun run --cwd packages/ui test:launcher-loop-e2e
 */

import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import {
  stubNodeBuiltins,
  writeFixturePage,
} from "../../../testing/e2e-runner/index.ts";
import { LAUNCHER_LOOP_INIT_SCRIPT } from "../../../testing/launcher-loop/cdp-gestures.ts";
import {
  DEFAULT_WEIGHTS,
  runLauncherLoop,
} from "../../../testing/launcher-loop/index.ts";

// Two gesture families are scoped out of this coarse-pointer (touch phone) lane
// because they diverge from the shared §D model on this surface — not because
// they are untested:
//   • railEdgeButton — the rail's `<`/`>` chevrons don't render on coarse
//     pointer (PagerEdgeButtons self-hides), yet the model treats an edge click
//     as always navigating. Covered by the desktop launcher-interaction spec.
//   • tileLongPress — the launcher tile is a plain onClick button with no
//     long-press affordance (Launcher.tsx IconTile), so a stationary touch
//     long-press is just a slow tap and launches on release, whereas the model
//     treats long-press as inert. Tap-vs-long-press semantics are covered on the
//     real app by gesture-matrix; modelling read-only-launcher long-press is out
//     of scope here.
const TOUCH_WEIGHTS = {
  ...DEFAULT_WEIGHTS,
  railEdgeButton: 0,
  tileLongPress: 0,
};

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "output-launcher-loop");
await mkdir(outDir, { recursive: true });
const RECORDED_VIDEO_FILE = "launcher-loop.webm";

const TOTAL_ACTIONS = Number(process.env.ELIZA_LOOP_ACTIONS ?? 500);
const BATCH_SIZE = Number(process.env.ELIZA_LOOP_BATCH ?? 100);
const ONLY_BATCH =
  process.env.ELIZA_LOOP_ONLY_BATCH !== undefined
    ? Number(process.env.ELIZA_LOOP_ONLY_BATCH)
    : null;
const SEED =
  process.env.ELIZA_LOOP_SEED && process.env.ELIZA_LOOP_SEED.trim() !== ""
    ? Number.parseInt(process.env.ELIZA_LOOP_SEED, 10) >>> 0
    : (Math.floor(Math.random() * 0xffffffff) >>> 0) || 1;

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
    if (
      /\.(webm|zip)$/.test(entry) ||
      /^page@.+/.test(entry) ||
      /^failure-batch-.+\.json$/.test(entry)
    ) {
      await rm(join(outDir, entry), { force: true }).catch(() => {});
    }
  }
}
await clearGeneratedArtifacts();

// ── Bundle the fixture (identical stub set to run-home-screen-e2e). The launcher
// curation drives real developer/preview gating, so the @elizaos/core stub must
// export the genuine view-kind helpers as OWN enumerable keys (esbuild's __toESM
// interop only copies own keys onto the ESM namespace — a value reachable only
// through the Proxy `get` trap reads back undefined). ─────────────────────────
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

// The production launcher resolves packaged PNG and SVG assets relative to its
// icon modules with `new URL(..., import.meta.url)`. This fixture is
// intentionally an inline IIFE, where esbuild otherwise replaces import.meta
// with an empty object and every icon URL throws before React can mount. Bind
// their import.meta.url to their source file URLs, matching the sibling home
// fixture that exercises the same surface.
const fixtureIconModule = /(?:view-icons\.generated|launcher-ionicons)\.ts$/;
const fixtureViewIconUrls = {
  name: "launcher-loop-fixture-view-icon-urls",
  setup(b) {
    b.onLoad({ filter: fixtureIconModule }, async (args) => {
      const source = await readFile(args.path, "utf8");
      return {
        contents: source.replaceAll(
          "import.meta.url",
          JSON.stringify(pathToFileURL(args.path).href),
        ),
        loader: "ts",
      };
    });
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
        // The wake/provision path (client-cloud.ts) subclasses the real
        // ElizaError; esbuild's ESM interop copies only this object's own keys,
        // so a Proxy fallback would surface undefined here and break the
        // subclass at evaluation time. Export a real class with core's shape so
        // the fixture bundle exercises the same error type production does.
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
            ElizaError,
            isElizaError: (v) => v instanceof ElizaError,
            resolveViewKind,
            isViewKindEnabled,
            isViewVisible: (d, enabled) =>
              isViewKindEnabled(resolveViewKind(d), enabled),
            dedupeModalities: (m) => Array.from(new Set(Array.isArray(m) ? m : [])),
            stripUnclaimedInteractionMarkup: (text) => text,
            // The fixture defaults to attention mode, so the home notification
            // center (NotificationsHomeCenter) mounts and triages each seeded
            // notification by tier — it needs the REAL priority→tier mapping. A
            // noop reads back "undefined" through esbuild's own-key __toESM
            // interop and crashes the whole tree ("tierForPriority is not a
            // function"), so the launcher surface never renders. Mirror core's
            // notification.ts (matches run-home-screen-e2e.mjs's stub, #15320).
            tierForPriority: (priority) =>
              priority === "urgent" || priority === "high"
                ? "interrupt"
                : priority === "low"
                  ? "silent"
                  : "digest",
            roleRank: (role) => ({
              NONE: 0,
              GUEST: 1,
              USER: 2,
              MEMBER: 2,
              ADMIN: 3,
              OWNER: 4,
            })[String(role).trim().toUpperCase()] ?? 0,
          },
          { get: (t, p) => (p in t ? t[p] : noop) },
        );
      `,
      loader: "js",
    }));
  },
};

// Install the engine's console-error + layout-shift observers before the surface
// mounts, so a shift or error during the initial paint is counted too.
const headHtml = `<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover" />
<style>:root{--eliza-chat-clearance:5.25rem;--safe-area-bottom:0px;--eliza-mobile-nav-offset:0px}</style>
<script>${LAUNCHER_LOOP_INIT_SCRIPT}</script>`;
const url = await writeFixturePage({
  entry: join(here, "home-screen-fixture.tsx"),
  outDir,
  htmlName: "launcher-loop.html",
  title: "launcher loop e2e",
  plugins: [
    stubResolver,
    fixtureViewIconUrls,
    stubElizaCore,
    stubNodeBuiltins(),
  ],
  processShim: true,
  headHtml,
  background: "#0a0d16",
});

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

// The page-side brand-color scan (blue-hue offenders + orange-accent presence).
// Serializable, no module closure.
function scanBrandColors() {
  const isBlue = (color) => {
    const m = color.match(/rgba?\(([^)]+)\)/);
    if (!m) return false;
    const [r, g, bch, a] = m[1].split(",").map((n) => Number.parseFloat(n.trim()));
    if (a !== undefined && a === 0) return false;
    return bch > 90 && bch - r > 40 && bch - g > 40;
  };
  const isOrange = (color) => {
    const m = color.match(/rgba?\(([^)]+)\)/);
    if (!m) return false;
    const [r, g, bch, a] = m[1].split(",").map((n) => Number.parseFloat(n.trim()));
    if (a !== undefined && a === 0) return false;
    return r > 150 && r - bch > 60 && g > 60 && g < r && r - g > 20;
  };
  const surface = document.querySelector('[data-testid="home-launcher-surface"]');
  const blueOffenders = [];
  let orangeAccentCount = 0;
  let sampled = 0;
  if (surface) {
    const nodes = surface.querySelectorAll("*");
    const cap = Math.min(nodes.length, 600);
    for (let i = 0; i < cap; i += 1) {
      const cs = getComputedStyle(nodes[i]);
      sampled += 1;
      if (isBlue(cs.color) || isBlue(cs.backgroundColor) || isBlue(cs.borderColor)) {
        blueOffenders.push({
          tag: nodes[i].tagName.toLowerCase(),
          testid: nodes[i].getAttribute("data-testid") || null,
          color: cs.color,
          background: cs.backgroundColor,
        });
      }
      if (isOrange(cs.color) || isOrange(cs.backgroundColor) || isOrange(cs.borderColor)) {
        orangeAccentCount += 1;
      }
    }
  }
  return { sampled, blueOffenderCount: blueOffenders.length, blueOffenders, orangeAccentCount };
}

async function bootPage(page, sink) {
  page.on("pageerror", (e) => sink.errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") sink.errors.push(`console: ${m.text()}`);
  });
  await page.goto(`${url}?native`);
  await page.waitForSelector('[data-testid="home-launcher-surface"]');
  await page.waitForSelector('[data-testid="home-screen"]');
  await page.waitForTimeout(500);
}

async function newBatchContext(withVideo = true) {
  const context = await chromiumBrowser.newContext({
    viewport: { width: 402, height: 874 },
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
    ...(withVideo
      ? { recordVideo: { dir: outDir, size: { width: 402, height: 874 } } }
      : {}),
  });
  await context.addInitScript(COARSE_POINTER_INIT);
  return context;
}

const chromiumBrowser = await chromium.launch();

// ── Brand-color scan (BEFORE) — no video/trace, this context is throwaway. ────
const preScanContext = await newBatchContext(false);
const preScanPage = await preScanContext.newPage();
await bootPage(preScanPage, { errors: [] });
const brandBefore = await preScanPage.evaluate(scanBrandColors);
assert(
  brandBefore.blueOffenderCount === 0,
  `no blue on the surface before the loop (sampled ${brandBefore.sampled})`,
);
// Orange is accent-only, not a resting-state requirement — the home surface at
// rest is neutral dark glass, so the count is reported, never asserted.
console.log(`  · orange accent samples before: ${brandBefore.orangeAccentCount}`);
await preScanPage.close();
await preScanContext.close();

// ── Touch batches (the ≥500-action long loop) ────────────────────────────────
const batchCount = Math.ceil(TOTAL_ACTIONS / BATCH_SIZE);
let applied = 0;
let lastVideoPath = null;
let brandAfter = null;

// A dropped/coalesced CDP touch under CI compositor load can red a batch
// without a product defect (same policy as launcher-gesture-loop.spec.ts's
// bounded outer retry). One same-seed retry in a fresh context keeps the gate
// honest: a genuine invariant violation is deterministic and fails both
// attempts, while an environmental drop passes the replay.
const BATCH_ATTEMPTS = 2;

for (let batch = 0; batch < batchCount; batch += 1) {
  if (ONLY_BATCH !== null && batch !== ONLY_BATCH) continue;
  const remaining = TOTAL_ACTIONS - applied;
  const size = Math.min(BATCH_SIZE, remaining);
  if (size <= 0) break;
  // Each batch is its own seed offset so the whole run is one deterministic
  // stream, replayable end-to-end from ELIZA_LOOP_SEED.
  const batchSeed = (SEED + batch * 0x9e3779b1) >>> 0;

  let batchOk = false;
  let lastError = null;
  const isLastBatch = batch === batchCount - 1 || size >= remaining;
  for (let attempt = 1; attempt <= BATCH_ATTEMPTS && !batchOk; attempt += 1) {
    const context = await newBatchContext();
    await context.tracing.start({ screenshots: true, snapshots: true });
    const page = await context.newPage();
    const sink = { errors: [] };
    let attemptOk = true;
    try {
      await bootPage(page, sink);
      const result = await runLauncherLoop(page, {
        seed: batchSeed,
        actions: size,
        weights: TOUCH_WEIGHTS,
      });
      if (sink.errors.length > 0) {
        throw new Error(`page errors during batch: ${sink.errors.join(" | ")}`);
      }
      applied += result.actions;
      console.log(
        `  ✓ batch ${batch + 1}/${batchCount} — ${result.actions} actions (total ${applied}), seed ${batchSeed}${attempt > 1 ? ` (attempt ${attempt})` : ""}`,
      );
      if (isLastBatch) brandAfter = await page.evaluate(scanBrandColors);
      batchOk = true;
    } catch (error) {
      attemptOk = false;
      lastError = error;
      console.error(
        `\n✗ batch ${batch + 1} attempt ${attempt}/${BATCH_ATTEMPTS} failed (seed ${batchSeed}) — ${error?.message ?? error}\n`,
      );
    } finally {
      const video = page.video();
      if (attemptOk) {
        await context.tracing.stop().catch(() => {});
        await page.close();
        await context.close();
        if (video) {
          const p = await video.path().catch(() => null);
          if (p) {
            if (lastVideoPath) await rm(lastVideoPath, { force: true }).catch(() => {});
            lastVideoPath = p;
          }
        }
      } else if (attempt < BATCH_ATTEMPTS) {
        // Failed attempt with a retry remaining: discard its artifacts.
        await context.tracing.stop().catch(() => {});
        await page.close();
        await context.close();
        if (video) {
          const p = await video.path().catch(() => null);
          if (p) await rm(p, { force: true }).catch(() => {});
        }
      } else {
        await context.tracing
          .stop({ path: join(outDir, `failure-batch-${batch + 1}.trace.zip`) })
          .catch(() => {});
        await page.close();
        await context.close();
        if (video) {
          const p = await video.path().catch(() => null);
          if (p)
            await rename(p, join(outDir, `failure-batch-${batch + 1}.webm`)).catch(
              () => {},
            );
        }
      }
    }
  }
  if (!batchOk) {
    failures += 1;
    console.error(
      `\n✗ batch ${batch + 1} FAILED after ${BATCH_ATTEMPTS} attempts (seed ${batchSeed}) — ${lastError?.message ?? lastError}\n`,
    );
    await writeFile(
      join(outDir, `failure-batch-${batch + 1}.json`),
      `${JSON.stringify(
        {
          runSeed: SEED,
          batch: batch + 1,
          batchSeed,
          attempts: BATCH_ATTEMPTS,
          replay: `ELIZA_LOOP_SEED=${SEED} ELIZA_LOOP_ONLY_BATCH=${batch}`,
          message: String(lastError?.message ?? lastError),
          stack: String(lastError?.stack ?? ""),
        },
        null,
        2,
      )}\n`,
    );
    break;
  }
}

if (ONLY_BATCH === null) {
  assert(
    applied >= TOTAL_ACTIONS,
    `applied ≥ ${TOTAL_ACTIONS} touch actions (got ${applied})`,
  );
}
if (lastVideoPath) {
  await rename(lastVideoPath, join(outDir, RECORDED_VIDEO_FILE)).catch(() => {});
  console.log(`  🎥 ${join(outDir, RECORDED_VIDEO_FILE)}`);
}

// ── Brand-color scan (AFTER) + artifact ──────────────────────────────────────
if (brandAfter) {
  assert(
    brandAfter.blueOffenderCount === 0,
    `no blue on the surface after the loop (sampled ${brandAfter.sampled})`,
  );
  console.log(`  · orange accent samples after: ${brandAfter.orangeAccentCount}`);
}
await writeFile(
  join(outDir, "brand-scan.json"),
  `${JSON.stringify({ seed: SEED, before: brandBefore, after: brandAfter }, null, 2)}\n`,
);

await chromiumBrowser.close();

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
