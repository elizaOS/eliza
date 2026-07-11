/**
 * Frontend KPI.
 *
 * Loads the production SPA in headless Chromium and records Core Web Vitals +
 * transfer/request stats: FCP, LCP, CLS, TTFB/DCL/load, JS bytes transferred,
 * total request count, and long-task time.
 *
 * By default it serves packages/app/dist as a static SPA on an ephemeral port
 * (history fallback to index.html), then navigates Chromium there. Override the
 * target with LOADPERF_FE_URL or --url=<url> to measure a running deployment.
 *
 *   node packages/benchmarks/loadperf/frontend-kpi.mjs
 *   node packages/benchmarks/loadperf/frontend-kpi.mjs --url=http://127.0.0.1:2138
 *
 * Requires the optional `playwright` dependency. If it (or a browser binary) is
 * unavailable, records { skipped: true, error } and exits 2.
 *
 * Exit: 0 pass, 1 budget fail, 2 skipped/unavailable.
 */

import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants as zlibConstants } from "node:zlib";
import {
  APP_DIST,
  existsSync,
  join,
  kb,
  loadBudgets,
  ms,
  readFileSync,
  recordResult,
} from "./lib.mjs";

const NOW = new Date().toISOString();
const JSON_ONLY = process.argv.includes("--json");
const urlArg = process.argv.find((a) => a.startsWith("--url="));
const TARGET_URL = urlArg
  ? urlArg.slice("--url=".length)
  : (process.env.LOADPERF_FE_URL ?? null);
const SETTLE_MS = Number(process.env.LOADPERF_FE_SETTLE_MS ?? 8000);
const BROTLI_OPTIONS = {
  params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 },
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

function contentTypeFor(path) {
  const dot = path.lastIndexOf(".");
  const ext = dot === -1 ? "" : path.slice(dot).toLowerCase();
  return MIME[ext] ?? "application/octet-stream";
}

function shouldCompress(contentType) {
  return /^(text\/|application\/(javascript|json|wasm)|image\/svg\+xml)/.test(
    contentType,
  );
}

/** Serve a production build as an SPA. Returns { url, close }. */
export function serveDist(
  distRoot = APP_DIST,
  { readFile = readFileSync } = {},
) {
  const indexPath = join(distRoot, "index.html");
  if (!existsSync(indexPath)) {
    throw new Error(
      `no build at ${APP_DIST} — run \`bun run --cwd packages/app build\` first.`,
    );
  }
  const server = createServer((req, res) => {
    try {
      const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
      const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
      const safe = rel
        .split("/")
        .filter((segment) => segment && segment !== "..")
        .join("/");
      const candidate = join(distRoot, safe);
      const file =
        existsSync(candidate) && !candidate.endsWith("/")
          ? candidate
          : indexPath;
      const buf = readFile(file);
      const contentType = contentTypeFor(file);
      const acceptsBrotli = /(?:^|,)\s*br(?:\s*;|\s*,|\s*$)/i.test(
        req.headers["accept-encoding"] ?? "",
      );
      // The transfer budget models the deployed CDN path, where text assets
      // are encoded; serving raw dist bytes would measure bundle weight twice.
      const body =
        acceptsBrotli && shouldCompress(contentType)
          ? brotliCompressSync(buf, BROTLI_OPTIONS)
          : buf;
      res.writeHead(200, {
        "content-type": contentType,
        "content-length": body.length,
        ...(body !== buf ? { "content-encoding": "br" } : {}),
        vary: "accept-encoding",
      });
      res.end(body);
    } catch (error) {
      if (error instanceof URIError) {
        // error-policy:J3 malformed URL escapes are invalid input, not missing assets.
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("invalid URL encoding");
        return;
      }
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        // error-policy:J1 an asset can disappear between existence check and read.
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      // error-policy:J1 the HTTP boundary reports unexpected filesystem failures.
      process.stderr.write(
        `[frontend-kpi] static asset read failed: ${error instanceof Error ? error.stack : String(error)}\n`,
      );
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("static asset read failed");
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/** Observers injected before navigation to capture LCP/CLS/long-tasks. */
const OBSERVER_INIT = `
  window.__perf = { lcp: 0, cls: 0, longTasks: 0 };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__perf.lcp = e.startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch {}
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (!e.hadRecentInput) window.__perf.cls += e.value;
    }).observe({ type: 'layout-shift', buffered: true });
  } catch {}
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__perf.longTasks += e.duration;
    }).observe({ type: 'longtask', buffered: true });
  } catch {}
`;

const COLLECT = `(() => {
  const perf = window.__perf || { lcp: 0, cls: 0, longTasks: 0 };
  const nav = performance.getEntriesByType('navigation')[0] || {};
  const paints = performance.getEntriesByType('paint');
  const fcpEntry = paints.find((p) => p.name === 'first-contentful-paint');
  const resources = performance.getEntriesByType('resource');
  let jsTransferred = 0;
  for (const r of resources) {
    if (r.initiatorType === 'script') jsTransferred += (r.encodedBodySize || 0);
  }
  return {
    fcpMs: fcpEntry ? fcpEntry.startTime : null,
    lcpMs: perf.lcp || null,
    cls: perf.cls || 0,
    longTasksMs: perf.longTasks || 0,
    ttfbMs: nav.responseStart ?? null,
    domContentLoadedMs: nav.domContentLoadedEventEnd ?? null,
    loadMs: nav.loadEventEnd ?? null,
    jsTransferredBytes: jsTransferred,
    requestCount: resources.length,
  };
})()`;

export function checkBudgets(metrics) {
  const b = loadBudgets().frontend;
  const checks = [
    { name: "fcpMs", value: metrics.fcpMs, budget: b.fcpMs, unit: "ms" },
    { name: "lcpMs", value: metrics.lcpMs, budget: b.lcpMs, unit: "ms" },
    {
      name: "jsTransferredBytes",
      value: metrics.jsTransferredBytes,
      budget: b.jsTransferredBytes,
      unit: "bytes",
    },
    {
      name: "requestCount",
      value: metrics.requestCount,
      budget: b.requestCount,
      unit: "count",
    },
    {
      name: "longTasksMs",
      value: metrics.longTasksMs,
      budget: b.longTasksMs,
      unit: "ms",
    },
  ];
  return checks.map((c) => ({
    ...c,
    pass: c.value != null && c.value <= c.budget,
  }));
}

export async function runFrontendKpi({
  playwright: suppliedPlaywright,
  targetUrl = TARGET_URL,
  settleMs = SETTLE_MS,
  jsonOnly = JSON_ONLY,
  serve = serveDist,
  record = recordResult,
} = {}) {
  let playwright = suppliedPlaywright;
  try {
    playwright ??= await import("playwright");
  } catch (err) {
    // error-policy:J1 CLI boundary translation — the optional browser is a
    // documented prerequisite, so its absence produces a skipped artifact.
    const payload = {
      skipped: true,
      error: `playwright unavailable: ${err?.message ?? String(err)}`,
    };
    const { file } = record("frontend", payload, NOW);
    if (jsonOnly) console.log(JSON.stringify({ ...payload, file }, null, 2));
    else
      console.error(
        `[frontend-kpi] skipped: ${payload.error}\nrecorded -> ${file}`,
      );
    return 2;
  }

  let served = null;
  let target = targetUrl;
  if (!target) {
    try {
      served = await serve();
      target = served.url;
    } catch (err) {
      // error-policy:J1 CLI boundary translation — an unavailable build
      // produces a skipped artifact rather than a fabricated KPI result.
      const payload = { skipped: true, error: err?.message ?? String(err) };
      const { file } = record("frontend", payload, NOW);
      if (jsonOnly) console.log(JSON.stringify({ ...payload, file }, null, 2));
      else
        console.error(
          `[frontend-kpi] skipped: ${payload.error}\nrecorded -> ${file}`,
        );
      return 2;
    }
  }

  let browser = null;
  try {
    browser = await playwright.chromium.launch({ args: ["--no-sandbox"] });
    const context = await browser.newContext();
    await context.addInitScript(OBSERVER_INIT);
    const page = await context.newPage();
    await page.goto(target, { waitUntil: "load", timeout: 60_000 });
    await page.waitForTimeout(settleMs);
    const metrics = await page.evaluate(COLLECT);

    const checks = checkBudgets(metrics);
    const result = {
      summary: {
        url: target,
        served: served ? "static-dist" : "remote",
        ...metrics,
      },
      checks,
      pass: checks.every((c) => c.pass),
    };
    const { file } = record("frontend", result, NOW);

    if (jsonOnly) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log("\n=== Frontend KPI ===");
      console.log(`url:           ${target}`);
      console.log(`FCP:           ${ms(metrics.fcpMs)}`);
      console.log(`LCP:           ${ms(metrics.lcpMs)}`);
      console.log(`CLS:           ${metrics.cls.toFixed(3)}`);
      console.log(`TTFB:          ${ms(metrics.ttfbMs)}`);
      console.log(`DOMContentLoaded: ${ms(metrics.domContentLoadedMs)}`);
      console.log(`load:          ${ms(metrics.loadMs)}`);
      console.log(`JS transferred: ${kb(metrics.jsTransferredBytes)}`);
      console.log(`requests:      ${metrics.requestCount}`);
      console.log(`long tasks:    ${ms(metrics.longTasksMs)}`);
      console.log("\n-- budget checks --");
      for (const c of checks) {
        const fmt = (v) =>
          v == null
            ? "—"
            : c.unit === "ms"
              ? ms(v)
              : c.unit === "bytes"
                ? kb(v)
                : String(v);
        console.log(
          `  ${c.pass ? "PASS" : "FAIL"}  ${c.name}: ${fmt(c.value)} / budget ${fmt(c.budget)}`,
        );
      }
      console.log(
        `\nresult: ${result.pass ? "PASS" : "FAIL"}   recorded -> ${file}\n`,
      );
    }
    return result.pass ? 0 : 1;
  } catch (err) {
    // error-policy:J1 CLI boundary translation — browser and navigation
    // failures become a recorded skipped result for the benchmark caller.
    const payload = {
      skipped: true,
      url: target,
      error: err?.message ?? String(err),
    };
    const { file } = record("frontend", payload, NOW);
    if (jsonOnly) console.log(JSON.stringify({ ...payload, file }, null, 2));
    else
      console.error(
        `[frontend-kpi] skipped: ${payload.error}\nrecorded -> ${file}`,
      );
    return 2;
  } finally {
    for (const [label, close] of [
      ["browser", browser ? () => browser.close() : null],
      ["static server", served ? () => served.close() : null],
    ]) {
      if (!close) continue;
      try {
        await close();
      } catch (error) {
        // error-policy:J6 best-effort teardown — the primary benchmark result
        // is already recorded, while teardown failures remain visible.
        console.error(
          `[frontend-kpi] ${label} teardown failed: ${error?.message ?? String(error)}`,
        );
      }
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await runFrontendKpi();
}
