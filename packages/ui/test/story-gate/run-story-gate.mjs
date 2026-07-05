#!/usr/bin/env node
/**
 * Story gate - render EVERY Storybook story in headless Chromium and assert it
 * is healthy. Converts the 1,400+ story catalog from "manual review only" into
 * a deterministic, CI-enforceable gate.
 *
 * For each story it:
 *   1. Injects the determinism shim (frozen clock / seeded RNG / en-US-UTC /
 *      animations off) so renders are byte-stable.
 *   2. Navigates to the static `iframe.html?id=<id>` and waits for render plus
 *      Storybook's autoplayed `play` interaction, when the story exports one.
 *   3. Captures console + pageerror + failed-network via the shared log helper.
 *   4. Detects Storybook's error display (a thrown story does NOT raise a
 *      pageerror; Storybook swallows it into `.sb-show-errordisplay`).
 *   5. Detects blank / one-color renders via sharp (downscaled distinct colors).
 *   6. Runs axe-core a11y scoped to the story root.
 *   7. Screenshots to `<out>/screenshots/<id>.png`.
 *
 * Failure model (the "throws in CI" contract):
 *   HARD FAIL (exit 1):
 *     - story threw (Storybook error display) or raised an uncaught pageerror
 *     - blank / one-color render
 *     - a NEW console error (not in the committed console baseline)
 *     - a NEW serious/critical a11y violation (not in the committed a11y baseline)
 *   The baselines (eslint-style) make the pre-existing backlog visible and
 *   burn-downable without blocking. Regenerate with `--update-baseline`.
 *
 * Usage:
 *   node test/story-gate/run-story-gate.mjs [--static-dir storybook-static]
 *     [--out test/story-gate/output] [--concurrency 6] [--shard i/n]
 *     [--section Primitives] [--grep <substr>] [--limit N]
 *     [--update-baseline] [--no-screenshots] [--no-a11y]
 *
 * Build the static catalog first: `bun run build-storybook --output-dir storybook-static`.
 */

import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { determinismShim, FROZEN_EPOCH_MS } from "./determinism-shim.mjs";
import { attachLogCapture } from "./log-capture.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "../..");
const rmRecursiveScript = resolve(pkgRoot, "../scripts/rm-path-recursive.mjs");

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const a = {
    staticDir: "storybook-static",
    out: "test/story-gate/output",
    concurrency: 6,
    shard: null,
    section: null,
    grep: null,
    limit: null,
    updateBaseline: false,
    screenshots: true,
    a11y: true,
    viewport: { width: 1280, height: 800 },
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--static-dir") a.staticDir = next();
    else if (arg === "--out") a.out = next();
    else if (arg === "--concurrency") a.concurrency = Number(next());
    else if (arg === "--shard") a.shard = next();
    else if (arg === "--section") a.section = next();
    else if (arg === "--grep") a.grep = next();
    else if (arg === "--limit") a.limit = Number(next());
    else if (arg === "--update-baseline") a.updateBaseline = true;
    else if (arg === "--no-screenshots") a.screenshots = false;
    else if (arg === "--no-a11y") a.a11y = false;
  }
  return a;
}
const args = parseArgs(process.argv.slice(2));
// Resolve --static-dir against the invocation cwd (repo root in CI via the
// ui-story-gate workflow, the package dir for the audit:stories scripts), the
// standard CLI convention. Resolving against pkgRoot doubled a repo-root-
// relative arg (packages/ui/packages/ui/storybook-static) and the gate hard-
// failed with "missing index.json" on every develop run.
const staticDir = resolve(process.cwd(), args.staticDir);
const outDir = resolve(pkgRoot, args.out);
const baselineDir = resolve(here, "baseline");

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function resolveAxeSource() {
  // axe-core is a transitive dep (via @storybook/addon-a11y), so it is not
  // resolvable from this file directly. Try, in order: this module, the ui
  // package, addon-a11y's own resolution, then the bun store as a last resort.
  const bases = [import.meta.url, join(pkgRoot, "package.json")];
  for (const base of bases) {
    try {
      return createRequire(base).resolve("axe-core/axe.min.js");
    } catch {
      /* next */
    }
  }
  try {
    const a11y = createRequire(join(pkgRoot, "package.json")).resolve(
      "@storybook/addon-a11y/package.json",
    );
    return createRequire(a11y).resolve("axe-core/axe.min.js");
  } catch {
    /* next */
  }
  try {
    const store = resolve(pkgRoot, "../../node_modules/.bun");
    const dirs = readdirSync(store)
      .filter((d) => d.startsWith("axe-core@"))
      .sort()
      .reverse();
    for (const d of dirs) {
      const p = join(store, d, "node_modules/axe-core/axe.min.js");
      if (existsSync(p)) return p;
    }
  } catch {
    /* give up — a11y will be skipped */
  }
  return null;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".png": "image/png",
  ".map": "application/json; charset=utf-8",
};

function startStaticServer(root) {
  return new Promise((res) => {
    const server = createServer((req, resp) => {
      try {
        const url = decodeURIComponent((req.url || "/").split("?")[0]);
        let filePath = join(root, url);
        if (url.endsWith("/")) filePath = join(filePath, "index.html");
        const stream = createReadStream(filePath);
        stream.on("error", () => {
          resp.statusCode = 404;
          resp.end("not found");
        });
        stream.once("open", () => {
          resp.setHeader(
            "content-type",
            MIME[extname(filePath)] || "application/octet-stream",
          );
          stream.pipe(resp);
        });
      } catch {
        resp.statusCode = 500;
        resp.end("error");
      }
    });
    server.listen(0, "127.0.0.1", () => res(server));
  });
}

async function loadStories() {
  const indexPath = join(staticDir, "index.json");
  let raw;
  try {
    raw = JSON.parse(await readFile(indexPath, "utf8"));
  } catch {
    throw new Error(
      `story-gate: missing ${indexPath}. Build first: bun run build-storybook --output-dir ${args.staticDir}`,
    );
  }
  let stories = Object.values(raw.entries || raw.stories || {}).filter(
    (e) => e.type === "story",
  );
  if (args.section) {
    const s = args.section.toLowerCase();
    stories = stories.filter((e) =>
      (e.title || "").toLowerCase().startsWith(s),
    );
  }
  if (args.grep) {
    const g = args.grep.toLowerCase();
    stories = stories.filter(
      (e) =>
        `${e.title}/${e.name}`.toLowerCase().includes(g) || e.id.includes(g),
    );
  }
  stories.sort((x, y) => x.id.localeCompare(y.id));
  if (args.shard) {
    const [i, n] = args.shard.split("/").map(Number);
    stories = stories.filter((_, idx) => idx % n === i - 1);
  }
  if (args.limit) stories = stories.slice(0, args.limit);
  return stories;
}

async function loadBaseline(name) {
  try {
    return JSON.parse(await readFile(join(baselineDir, name), "utf8"));
  } catch {
    return {};
  }
}

function rmRecursive(targetPath) {
  const result = spawnSync(process.execPath, [rmRecursiveScript, targetPath], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(
      `failed to remove generated story-gate output ${targetPath} (exit ${result.status})`,
    );
  }
}

function normalizeConsole(text) {
  // Collapse volatile substrings (urls, numbers, hex ids) so baseline keys are
  // stable across runs.
  const normalized = text
    .replace(/https?:\/\/[^\s)]+/g, "<url>")
    .replace(/0x[0-9a-f]+/gi, "<hex>")
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      "<uuid>",
    )
    .replace(/\n\s+at\s+[A-Za-z_$][\w$]*(?=[\s(])/g, "\n    at <fn>")
    .replace(/\d+/g, "<n>")
    .trim()
    .slice(0, 300);
  if (
    normalized ===
    "Failed to load resource: the server responded with a status of <n> (Not Found)"
  ) {
    return "";
  }
  // useAppSelector throws in the headless Story Gate for any story that renders
  // an app-state consumer without mounting the real AppProvider — a harness
  // artifact (the app always mounts AppProvider), caught by the story error
  // boundary so the story still renders `good`. It surfaces FLAKILY: a given
  // consumer story is classified `needs-runtime` one run and renders-with-throw
  // the next, which makes per-story baselining a perpetual moving target across
  // the ~127 app-selector consumers. Drop it (and Storybook's paired "Error
  // rendering story" wrapper) globally instead. A genuinely broken story is
  // still caught by the broken verdict (the DOM error display), and a real
  // (non-useAppSelector) render throw keeps its own specific message — only this
  // generic wrapper is dropped.
  if (
    normalized.startsWith(
      "Error: useAppSelector used before AppProvider rendered",
    ) ||
    /^Error rendering story '[^']*':/.test(normalized)
  ) {
    return "";
  }
  return normalized;
}

/**
 * Classify per-story render results against the console / a11y / broken
 * allowlist baselines and produce the failure list + regenerated baselines.
 *
 * Doctrine (matches the `broken-baseline` ratchet): each baseline is a pure
 * ALLOWLIST of pre-existing violations, never an on/off switch. A violation
 * whose key is NOT in the allowlist reds the run. An empty or absent baseline
 * therefore means fail-on-ANY violation (zero tolerance). This is the corrected
 * behaviour after the inverted `Object.keys(baseline).length > 0` gate (which
 * silently disabled the check whenever a baseline was emptied/reset).
 *
 * Pure + deterministic so it is unit-testable without a browser (see
 * story-gate-classify.test.mjs). `main()` calls it with the live run results.
 *
 * @param {object} params
 * @param {Array<object>} params.results per-story render results
 * @param {Record<string, string[]>} params.consoleBaseline allowlisted console keys per story id
 * @param {Record<string, string[]>} params.a11yBaseline allowlisted a11y rule ids per story id
 * @param {Record<string, unknown>} params.brokenBaseline allowlisted known-broken story ids
 * @param {boolean} [params.updateBaseline] when true, skip console/a11y failures (regeneration mode)
 */
/**
 * Pure derivation of the network-failure signal from a log-capture snapshot.
 * Failed / erroring network RESPONSES + request failures during a story render
 * are a real fault the reduced inline console/pageerror capture used to drop.
 * Gate them only for stories that actually rendered or threw — a `needs-runtime`
 * story's network errors are just the symptom of a missing live app context.
 *
 * Extracted from renderStory so it is unit-testable headlessly (no Playwright).
 * #13624
 *
 * @param {{ failedResponses?: Array<{status:number,url:string}>,
 *           requestFailures?: Array<{failure:string,url:string}> }} cap
 *   the attachLogCapture instance (or its snapshot) to read.
 * @param {string} verdict the story's current verdict.
 * @returns {{ escalate: boolean, issues: string[] }}
 */
export function deriveNetworkFailureIssues(cap, verdict) {
  if (verdict === "needs-runtime") return { escalate: false, issues: [] };
  const failedResponses = cap?.failedResponses ?? [];
  const requestFailures = cap?.requestFailures ?? [];
  const raw = [
    ...failedResponses.map((r) => `net-response ${r.status}: ${r.url}`),
    ...requestFailures.map((r) => `net-request ${r.failure}: ${r.url}`),
  ];
  return {
    escalate: raw.length > 0,
    issues: raw.map((n) => `network-failure: ${n.slice(0, 300)}`),
  };
}

export function classifyStoryGateFailures({
  results,
  consoleBaseline,
  a11yBaseline,
  brokenBaseline,
  updateBaseline = false,
}) {
  const newConsoleBaseline = {};
  const newA11yBaseline = {};
  const newBrokenBaseline = {};
  const failures = [];

  for (const r of results) {
    if (r.verdict === "broken") {
      newBrokenBaseline[r.id] = (r.issues ?? []).join(" | ").slice(0, 200);
    }
    // console errors -> baseline keys
    const consoleKeys = (r.consoleErrors ?? [])
      .map(normalizeConsole)
      .filter(Boolean);
    if (consoleKeys.length)
      newConsoleBaseline[r.id] = [...new Set(consoleKeys)];
    const allowedConsole = new Set(consoleBaseline[r.id] || []);
    const newConsole = consoleKeys.filter((k) => !allowedConsole.has(k));

    // a11y -> baseline keys (rule id)
    const a11yKeys = [...new Set((r.a11y ?? []).map((v) => v.id))];
    if (a11yKeys.length) newA11yBaseline[r.id] = a11yKeys;
    const allowedA11y = new Set(a11yBaseline[r.id] || []);
    const newA11y = a11yKeys.filter((k) => !allowedA11y.has(k));

    if (r.verdict === "broken" && !(r.id in brokenBaseline)) {
      failures.push({
        id: r.id,
        kind: "broken",
        detail: (r.issues ?? []).join(" | "),
      });
    }
    // Console + a11y gating is ALWAYS on (baseline is a pure allowlist); a key
    // absent from the allowlist reds regardless of how many rows it holds.
    if (!updateBaseline && newConsole.length) {
      failures.push({
        id: r.id,
        kind: "new-console-error",
        detail: newConsole.join(" | "),
      });
    }
    if (!updateBaseline && newA11y.length) {
      failures.push({
        id: r.id,
        kind: "new-a11y-violation",
        detail: newA11y.join(", "),
      });
    }
  }

  return { failures, newConsoleBaseline, newA11yBaseline, newBrokenBaseline };
}

// ---------------------------------------------------------------------------
// per-story render + assert
// ---------------------------------------------------------------------------
async function renderStory(context, baseUrl, story, axeSource, opts) {
  const page = await context.newPage();
  // Shared, richer log capture: console + uncaught page errors **and** failed /
  // erroring network responses + request failures, with a durable JSON
  // snapshot (see log-capture.mjs). Previously the gate wired a reduced inline
  // console/pageerror capture and left the shared helper orphaned — so a story
  // that rendered but fired a failing network request (a real fault) went
  // completely unsignalled and the doc-claimed helper was dead code. #13624
  const cap = attachLogCapture(page, { label: story.id });
  // Preserve the exact prior console-error signal (every console message of
  // type "error") for the console-baseline ratchet — the helper's own
  // consoleErrors() additionally allow-lists dev noise, which we apply only to
  // the durable snapshot, not to the baseline-gating list, to avoid silently
  // shifting the committed console baseline.
  const rawConsoleError = (m) => m.type === "error";

  await page.addInitScript(determinismShim, FROZEN_EPOCH_MS);

  const result = {
    id: story.id,
    title: story.title,
    name: story.name,
    verdict: "good",
    issues: [],
    consoleErrors: [],
    logCapture: null,
    a11y: [],
    play: {
      expected: Boolean(story.tags?.includes("play-fn")),
      prepared: false,
      phase: null,
    },
  };

  try {
    const url = `${baseUrl}/iframe.html?id=${encodeURIComponent(story.id)}&viewMode=story`;
    await page.goto(url, { waitUntil: "load", timeout: 20000 });

    // Wait for Storybook to settle into rendered or error state. A story that
    // never settles is almost always one that needs a live runtime/backend to
    // mount (full app-shell/page stories the all-views audit covers live) — NOT
    // a code fault. We classify it `needs-runtime` (soft, never fails the gate)
    // and move on after a short wait, rather than burning the long tail on it.
    const settled = await page
      .waitForFunction(
        () => {
          // Storybook 10 applies the `sb-show-*` layout classes to
          // `document.body` (the preview runtime calls
          // `document.body.classList.add(classes.MAIN)`); older majors used
          // `document.documentElement`. Check BOTH so the settle detector
          // works regardless of Storybook version — reading only
          // `documentElement` silently misclassified every story
          // `needs-runtime` under SB10, neutering the entire gate.
          const has = (cls) =>
            !!document.body?.classList.contains(cls) ||
            document.documentElement.classList.contains(cls);
          return (
            has("sb-show-main") ||
            has("sb-show-errordisplay") ||
            has("sb-show-nopreview")
          );
        },
        { timeout: Number(process.env.STORY_GATE_SETTLE_MS) || 10000 },
      )
      .then(() => true)
      .catch(() => false);
    if (!settled) {
      result.verdict = "needs-runtime";
      result.issues.push("did-not-settle: no sb-show-* state in time");
    }

    // Storybook autoplays `play` functions in the iframe. The old gate only
    // waited for `sb-show-main` and then slept for 80ms, which could move on
    // while an async interaction was still running. Wait for the preview
    // render phase to finish so interaction assertions can actually fail here.
    const finished = await page
      .waitForFunction(
        () => {
          const phase = window.__STORYBOOK_PREVIEW__?.currentRender?.phase;
          return phase === "finished" || phase === "errored";
        },
        { timeout: Number(process.env.STORY_GATE_FINISH_MS) || 10000 },
      )
      .then(() => true)
      .catch(() => false);
    const playState = await page
      .evaluate(async (storyId) => {
        const preview = window.__STORYBOOK_PREVIEW__;
        const phase = preview?.currentRender?.phase ?? null;
        let prepared = false;
        try {
          const preparedStory = await preview?.storyStoreValue?.loadStory?.({
            storyId,
          });
          prepared = typeof preparedStory?.playFunction === "function";
        } catch {
          prepared = false;
        }
        return { phase, prepared };
      }, story.id)
      .catch(() => ({ phase: null, prepared: false }));
    result.play.phase = playState.phase;
    result.play.prepared = playState.prepared;
    if (!finished && result.verdict === "good") {
      result.verdict = "broken";
      result.issues.push(
        `story-not-finished: Storybook render phase stayed at ${playState.phase ?? "unknown"}`,
      );
    }
    if (result.play.expected && !result.play.prepared) {
      result.verdict = "broken";
      result.issues.push(
        "play-missing: story index is tagged play-fn but runtime playFunction was not prepared",
      );
    }

    // Give layout/fonts a deterministic beat to settle.
    await page.waitForTimeout(80);
    await page.evaluate(() => document.fonts?.ready).catch(() => {});

    // Storybook swallows a thrown story into its error display. SB10 puts the
    // `sb-show-*` classes on `document.body`; check both for version safety.
    const sbError = await page.evaluate(() => {
      const has = (cls) =>
        !!document.body?.classList.contains(cls) ||
        document.documentElement.classList.contains(cls);
      if (has("sb-show-errordisplay")) {
        const msg = document.querySelector("#error-message")?.textContent || "";
        const stack = document.querySelector("#error-stack")?.textContent || "";
        return `${msg}\n${stack}`.trim().slice(0, 600);
      }
      if (has("sb-show-nopreview")) {
        return "NO_PREVIEW: story produced no renderable output";
      }
      return null;
    });
    if (sbError) {
      // A story that throws specifically because it needs the live app context
      // (the static catalog has no <AppProvider>/runtime) is a SOFT
      // `needs-runtime`, not a code fault — those surfaces are covered live by
      // `audit:app` (see packages/ui CLAUDE.md). The previous (broken) settle
      // detector masked these as needs-runtime for the WRONG reason (it never
      // saw the error state at all); now that the gate correctly sees the
      // Storybook error display, classify by the error signature so genuine
      // throws stay `broken` while missing-provider/context throws stay soft.
      const NEEDS_CONTEXT_RE =
        /used before .*Provider rendered|must be used within|requires? .*Provider|No \w+ ?(?:context|Provider) (?:found|available)|outside (?:of )?(?:an? )?\w*Provider/i;
      const needsRuntime = NEEDS_CONTEXT_RE.test(sbError);
      result.verdict = needsRuntime ? "needs-runtime" : "broken";
      result.issues.push(
        `${needsRuntime ? "needs-runtime (story-threw)" : "story-threw"}: ${sbError}`,
      );
    }

    if (cap.pageErrors.length) {
      result.verdict = "broken";
      result.issues.push(
        ...cap.pageErrors.map(
          (e) => `pageerror: ${(e.message ?? String(e)).slice(0, 300)}`,
        ),
      );
    }

    // Screenshot + blank detection (only meaningful if it actually rendered).
    if (result.verdict === "good" && opts.screenshots) {
      const shotPath = join(outDir, "screenshots", `${story.id}.png`);
      await mkdir(dirname(shotPath), { recursive: true });
      const buf = await page.screenshot({
        path: shotPath,
        animations: "disabled",
      });
      const blank = await detectBlank(buf, opts.sharp);
      if (blank) {
        result.verdict = "broken";
        result.issues.push(`blank-render: ${blank}`);
      }
    }

    // a11y (axe) scoped to the story root.
    if (result.verdict === "good" && opts.a11y && axeSource) {
      try {
        await page.addScriptTag({ content: axeSource });
        const violations = await page.evaluate(async () => {
          // @ts-expect-error - axe injected above
          const res = await window.axe.run("#storybook-root", {
            resultTypes: ["violations"],
            rules: { "color-contrast": { enabled: true } },
          });
          return res.violations.map((v) => ({
            id: v.id,
            impact: v.impact,
            nodes: v.nodes.length,
          }));
        });
        result.a11y = violations.filter(
          (v) => v.impact === "serious" || v.impact === "critical",
        );
      } catch {
        /* axe failed to run on this story - non-fatal */
      }
    }

    // Failed / erroring network responses + request failures during render are
    // a real fault signal the reduced inline capture missed. #13624
    const netFailure = deriveNetworkFailureIssues(cap, result.verdict);
    if (netFailure.escalate) {
      result.verdict = "broken";
      result.issues.push(...netFailure.issues);
    }

    // Console errors are only an independent signal for stories that actually
    // rendered (good) or that threw (broken). A `needs-runtime` story's console
    // errors are just the symptom of missing app context — don't gate on them.
    result.consoleErrors =
      result.verdict === "needs-runtime"
        ? []
        : cap.consoleMessages
            .filter(rawConsoleError)
            .map((m) => m.text.slice(0, 300));
  } catch (err) {
    result.verdict = "broken";
    result.issues.push(
      `runner-error: ${(err?.message ?? String(err)).slice(0, 300)}`,
    );
  } finally {
    // Durable, richer per-story snapshot (console/network/errors) for the
    // output/ artifact; needs-runtime stories carry their raw capture too so
    // triage can see why they never mounted.
    result.logCapture = cap.snapshot();
    cap.detach();
    await page.close();
  }
  return result;
}

async function detectBlank(pngBuffer, sharp) {
  if (!sharp) return null;
  try {
    const { data, info } = await sharp(pngBuffer)
      .resize(32, 32, { fit: "fill" })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const channels = info.channels;
    const seen = new Set();
    for (let i = 0; i < data.length; i += channels) {
      seen.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
      if (seen.size > 2) return null; // clearly not blank
    }
    return seen.size <= 1 ? "single-color" : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const stories = await loadStories();
  if (!stories.length) {
    console.error("story-gate: no stories matched the filters");
    process.exit(2);
  }
  console.log(
    `story-gate: ${stories.length} stories | concurrency=${args.concurrency}` +
      `${args.shard ? ` | shard ${args.shard}` : ""}` +
      `${args.section ? ` | section ${args.section}` : ""}`,
  );

  const axeSource = args.a11y ? await readAxe(resolveAxeSource()) : null;
  if (args.a11y && !axeSource)
    console.warn("story-gate: axe-core not found - skipping a11y");
  const sharp = await loadSharp();
  if (!sharp)
    console.warn("story-gate: sharp not found - skipping blank detection");

  const consoleBaseline = await loadBaseline("console-baseline.json");
  const a11yBaseline = await loadBaseline("a11y-baseline.json");
  // The broken-baseline is an allowlist of story IDs that are KNOWN broken
  // (genuine render throws / blank renders) — burn-down debt, not green-washing.
  // A broken story in this list is reported but does not fail the run; a broken
  // story NOT in it fails immediately. This is the same eslint-style ratchet as
  // console/a11y, but for the hard-fail `broken` verdict — so the gate enforces
  // "no NEW broken stories" from day one while the existing set is fixed. Shape:
  // { "<story-id>": "<reason>" }. Regenerate via `--update-baseline`.
  const brokenBaseline = await loadBaseline("broken-baseline.json");
  // Console + a11y gating is ALWAYS on, exactly like the broken-baseline ratchet
  // above: each baseline is a pure ALLOWLIST of pre-existing violations, never a
  // switch. An empty or absent baseline therefore means fail-on-ANY violation
  // (zero tolerance) — the same shape as `broken-baseline.json = {}`.
  //
  // The old `Object.keys(baseline).length > 0` gate INVERTED this: emptying or
  // resetting a baseline silently DISABLED the check (the opposite of a burn-down
  // ratchet), so green-washing was one `echo '{}' > a11y-baseline.json` away.
  // Enforcement now lives in classifyStoryGateFailures() and is unconditional.

  rmRecursive(outDir);
  await mkdir(outDir, { recursive: true });

  const server = await startStaticServer(staticDir);
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();

  const results = [];
  let cursor = 0;
  const opts = { screenshots: args.screenshots, a11y: args.a11y, sharp };

  async function worker() {
    const context = await browser.newContext({
      viewport: args.viewport,
      deviceScaleFactor: 1,
      reducedMotion: "reduce",
      colorScheme: "dark",
    });
    while (cursor < stories.length) {
      const story = stories[cursor++];
      const r = await renderStory(context, baseUrl, story, axeSource, opts);
      results.push(r);
      const n = results.length;
      if (n % 50 === 0 || n === stories.length) {
        process.stdout.write(`  ...${n}/${stories.length}\n`);
      }
    }
    await context.close();
  }

  const workers = Array.from(
    { length: Math.min(args.concurrency, stories.length) },
    () => worker(),
  );
  await Promise.all(workers);
  await browser.close();
  server.close();

  // -------------------------------------------------------------------------
  // classify against baselines
  // -------------------------------------------------------------------------
  const { failures, newConsoleBaseline, newA11yBaseline, newBrokenBaseline } =
    classifyStoryGateFailures({
      results,
      consoleBaseline,
      a11yBaseline,
      brokenBaseline,
      updateBaseline: args.updateBaseline,
    });

  // -------------------------------------------------------------------------
  // write artifacts
  // -------------------------------------------------------------------------
  const broken = results.filter((r) => r.verdict === "broken");
  const report = {
    schema: "eliza_story_gate_v1",
    generatedAt: new Date().toISOString(),
    frozenEpochMs: FROZEN_EPOCH_MS,
    totals: {
      stories: results.length,
      good: results.filter((r) => r.verdict === "good").length,
      broken: broken.length,
      needsRuntime: results.filter((r) => r.verdict === "needs-runtime").length,
      withConsoleErrors: results.filter((r) => r.consoleErrors.length).length,
      withA11yViolations: results.filter((r) => r.a11y.length).length,
      playExpected: results.filter((r) => r.play.expected).length,
      playPrepared: results.filter((r) => r.play.prepared).length,
      failures: failures.length,
    },
    failures,
    results,
  };
  await writeFile(join(outDir, "report.json"), JSON.stringify(report, null, 2));
  await writeContactSheet(outDir, results);
  await writeFrontendLogs(outDir, results);
  await writeManualReview(outDir, results, failures);

  if (args.updateBaseline) {
    await mkdir(baselineDir, { recursive: true });
    await writeFile(
      join(baselineDir, "console-baseline.json"),
      JSON.stringify(sortKeys(newConsoleBaseline), null, 2),
    );
    await writeFile(
      join(baselineDir, "a11y-baseline.json"),
      JSON.stringify(sortKeys(newA11yBaseline), null, 2),
    );
    await writeFile(
      join(baselineDir, "broken-baseline.json"),
      JSON.stringify(sortKeys(newBrokenBaseline), null, 2),
    );
    console.log(
      `\nstory-gate: baselines updated (${Object.keys(newConsoleBaseline).length} console, ${Object.keys(newA11yBaseline).length} a11y, ${Object.keys(newBrokenBaseline).length} broken story-keys)`,
    );
  }

  // -------------------------------------------------------------------------
  // self-check: a healthy catalog always has SOME renderable (`good`) stories.
  // If EVERY story came back `needs-runtime` (and none `good`/`broken`), the
  // settle detector itself is broken (e.g. the `sb-show-*` class moved to a
  // different element across a Storybook major) — the gate would otherwise
  // pass silently while testing nothing. Hard-fail with a distinct exit code so
  // this can never regress unnoticed again. Guarded on a non-trivial,
  // unfiltered run so a legitimately all-runtime filtered slice doesn't trip it.
  const unfiltered = !args.section && !args.grep && !args.limit && !args.shard;
  if (
    unfiltered &&
    results.length > 5 &&
    report.totals.good === 0 &&
    report.totals.broken === 0 &&
    report.totals.needsRuntime === results.length
  ) {
    console.error(
      `\nX story-gate SELF-CHECK FAILED — all ${results.length} stories classified ` +
        `'needs-runtime' and zero rendered 'good'. The settle detector is not ` +
        `matching Storybook's rendered state (sb-show-* class target moved?). ` +
        `The gate is testing nothing. See renderStory() settle logic.`,
    );
    process.exit(3);
  }

  // -------------------------------------------------------------------------
  // verdict
  // -------------------------------------------------------------------------
  console.log(
    `\nstory-gate: ${results.length} stories | good=${report.totals.good} | ` +
      `broken=${broken.length} | needs-runtime=${report.totals.needsRuntime} | ` +
      `console-err=${report.totals.withConsoleErrors} | a11y=${report.totals.withA11yViolations} | ` +
      `play=${report.totals.playPrepared}/${report.totals.playExpected}`,
  );
  if (failures.length && !args.updateBaseline) {
    console.error(`\nX story-gate FAILED - ${failures.length} regression(s):`);
    for (const f of failures.slice(0, 40)) {
      console.error(`  [${f.kind}] ${f.id}\n      ${f.detail}`);
    }
    if (failures.length > 40)
      console.error(`  ...and ${failures.length - 40} more (see report.json)`);
    console.error(`\nReport: ${join(outDir, "report.json")}`);
    process.exit(1);
  }
  console.log(
    `\nOK story-gate PASSED - report: ${join(outDir, "report.json")}`,
  );
}

function sortKeys(obj) {
  return Object.fromEntries(
    Object.entries(obj).sort((a, b) => a[0].localeCompare(b[0])),
  );
}

async function readAxe(axePath) {
  if (!axePath) return null;
  try {
    return await readFile(axePath, "utf8");
  } catch {
    return null;
  }
}

async function loadSharp() {
  try {
    const require = createRequire(join(pkgRoot, "package.json"));
    return require("sharp");
  } catch {
    try {
      const mod = await import("sharp");
      return mod.default ?? mod;
    } catch {
      return null;
    }
  }
}

async function writeContactSheet(dir, results) {
  const cells = results
    .map((r) => {
      const color =
        r.verdict === "broken"
          ? "#c0392b"
          : r.consoleErrors.length || r.a11y.length
            ? "#e67e22"
            : "#2d3436";
      const note = [
        r.verdict === "broken" ? "BROKEN" : "",
        r.consoleErrors.length ? `${r.consoleErrors.length} console` : "",
        r.a11y.length ? `${r.a11y.length} a11y` : "",
      ]
        .filter(Boolean)
        .join(" | ");
      return `<figure style="margin:0;border:1px solid ${color};border-radius:6px;overflow:hidden;background:#111">
  <img loading="lazy" src="screenshots/${r.id}.png" style="width:100%;display:block;background:#000" onerror="this.style.opacity=.2"/>
  <figcaption style="padding:4px 6px;font:11px monospace;color:#ddd">${r.title}/${r.name}<br><span style="color:${color}">${note || "good"}</span></figcaption>
</figure>`;
    })
    .join("\n");
  const html = `<!doctype html><meta charset="utf-8"><title>Story Gate Contact Sheet</title>
<body style="background:#0a0a0a;color:#eee;font-family:system-ui;margin:0;padding:16px">
<h1 style="font:600 16px system-ui">Story Gate - ${results.length} stories</h1>
<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px">${cells}</div>`;
  await writeFile(join(dir, "contact-sheet.html"), html);
}

/**
 * Durable frontend-logs artifact (PR_EVIDENCE convention): every console error,
 * page error, **and failed/erroring network response + request failure**
 * captured across the catalog via the shared attachLogCapture helper, keyed by
 * story. The network legs are what the reduced inline capture used to drop; now
 * they land in output/ so the doc-claimed log-capture.mjs is actually wired.
 */
async function writeFrontendLogs(dir, results) {
  const netCount = (r) =>
    (r.logCapture?.summary?.failedResponses ?? 0) +
    (r.logCapture?.summary?.requestFailures ?? 0);
  const withLogs = results
    .filter((r) => r.consoleErrors.length || r.issues.length || netCount(r))
    .map((r) => ({
      id: r.id,
      title: `${r.title}/${r.name}`,
      verdict: r.verdict,
      consoleErrors: r.consoleErrors,
      issues: r.issues,
      // Richer, structured capture (console + network + errors) from the
      // shared helper — the durable JSON the README/AGENTS.md promise.
      capture: r.logCapture,
    }));
  const artifact = {
    schema: "eliza_story_gate_frontend_logs_v2",
    capturedAt: new Date().toISOString(),
    summary: {
      stories: results.length,
      withConsoleErrors: results.filter((r) => r.consoleErrors.length).length,
      withNetworkFailures: results.filter((r) => netCount(r) > 0).length,
      broken: results.filter((r) => r.verdict === "broken").length,
    },
    stories: withLogs,
  };
  await writeFile(
    join(dir, "frontend-logs.json"),
    JSON.stringify(artifact, null, 2),
  );
}

/**
 * Human-facing review rollup mirroring the repo's aesthetic-audit convention
 * (verdict per surface). One file for the whole catalog — per-story would be
 * 1,400 stubs — listing every broken / console / a11y story to triage.
 */
async function writeManualReview(dir, results, failures) {
  const broken = results.filter((r) => r.verdict === "broken");
  const consoleStories = results.filter((r) => r.consoleErrors.length);
  const a11yStories = results.filter((r) => r.a11y.length);
  const line = (r, extra) =>
    `- \`${r.id}\` — ${r.title}/${r.name}${extra ? ` — ${extra}` : ""}`;
  const md = [
    "# Story Gate — manual review",
    "",
    `Generated ${new Date().toISOString()} · ${results.length} stories.`,
    "",
    `**Verdict:** ${failures.length ? `❌ ${failures.length} regression(s)` : "✅ no regressions vs baseline"}`,
    "",
    `## Broken (${broken.length})`,
    broken.length
      ? broken.map((r) => line(r, r.issues.join("; "))).join("\n")
      : "_none_",
    "",
    `## Console errors (${consoleStories.length})`,
    consoleStories.length
      ? consoleStories
          .map((r) => line(r, `${r.consoleErrors.length} error(s)`))
          .join("\n")
      : "_none_",
    "",
    `## Serious/critical a11y (${a11yStories.length})`,
    a11yStories.length
      ? a11yStories
          .map((r) => line(r, [...new Set(r.a11y.map((v) => v.id))].join(", ")))
          .join("\n")
      : "_none_",
    "",
  ].join("\n");
  await writeFile(join(dir, "manual-review.md"), md);
}

// Only auto-run as a CLI; importing this module (e.g. from the classifier unit
// test) must NOT launch a browser run.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("story-gate: fatal", err);
    process.exit(1);
  });
}
