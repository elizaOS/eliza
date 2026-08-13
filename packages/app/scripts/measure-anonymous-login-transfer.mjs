#!/usr/bin/env node

/**
 * Cold anonymous `/login` transfer measurement for #18056.
 *
 * Reproduces the issue recipe:
 * - fresh Chromium context
 * - service workers blocked
 * - navigate to /login only (no form submit)
 * - settle ~6s
 * - sum PerformanceResourceTiming.transferSize for all resources + scripts
 *
 * Usage:
 *   node scripts/measure-anonymous-login-transfer.mjs \
 *     --url http://127.0.0.1:4173/login \
 *     --out output-login-transfer/report.json
 *
 *   --url          full login URL (required unless --serve-dist)
 *   --serve-dist   serve packages/app/dist on an ephemeral port and measure /login
 *   --settle-ms    wait after load before sampling (default 6000; 0..2^31-1)
 *   --timeout      navigation timeout in ms (default 90000; 1..2^31-1)
 *   --out          write JSON report
 *   --headed       visible browser
 *   --label        label for this run (e.g. head-sha or develop)
 *
 * Desktop (1280x720) and mobile (390x844) viewports are measured by default.
 * Numeric overrides must be complete decimal integers; malformed values fail
 * closed before Chromium launches.
 */

import { execSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

// Playwright is loaded lazily in main() so CLI-boundary unit tests can import
// pure helpers without requiring a browser install in the script test lane.

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, "..");
let distDir = join(appDir, "dist");

/** Node clamps `setTimeout` delays above this to 1 ms; Playwright waits share that bound. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
};

const VIEWPORTS = [
  { id: "desktop", width: 1280, height: 720 },
  { id: "mobile", width: 390, height: 844 },
];

/**
 * Parse a non-negative decimal integer CLI override (allows 0).
 * Full-string match only: bare `Number("10junk")` is NaN and previously
 * launched Chromium under an unintended settle/timeout budget.
 *
 * @param {string | undefined} raw
 * @param {string} flag flag name for error messages (e.g. `--settle-ms`)
 * @param {{ max?: number, min?: number }} [opts]
 * @returns {number}
 */
export function parseDecimalInt(raw, flag, opts = {}) {
  const min = opts.min ?? 0;
  const max = opts.max ?? Number.MAX_SAFE_INTEGER;
  if (typeof raw !== "string" || raw.length === 0 || raw.startsWith("--")) {
    throw new Error(`${flag} requires a decimal integer from ${min} to ${max}`);
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `${flag} must be a decimal integer from ${min} to ${max}, got "${raw}"`,
    );
  }
  // Leading zeros like "08" are rejected so the canonical decimal form is
  // unambiguous (matches other CLI gates in packages/app scripts).
  if (raw.length > 1 && raw.startsWith("0")) {
    throw new Error(
      `${flag} must be a decimal integer from ${min} to ${max}, got "${raw}"`,
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(
      `${flag} must be a decimal integer from ${min} to ${max}, got "${raw}"`,
    );
  }
  return value;
}

/**
 * Parse CLI argv for the login-transfer harness. Exported for focused unit tests.
 * @param {string[]} argv process.argv-style array (index 0-1 ignored)
 */
export function parseArgs(argv) {
  const args = {
    url: null,
    serveDist: false,
    distDir: null,
    settleMs: 6000,
    out: null,
    headed: false,
    label: null,
    timeout: 90_000,
    help: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--url") {
      const next = argv[++i];
      if (
        typeof next !== "string" ||
        next.length === 0 ||
        next.startsWith("--")
      ) {
        throw new Error("--url requires a login URL value");
      }
      args.url = next;
    } else if (a === "--serve-dist") args.serveDist = true;
    else if (a === "--dist-dir") {
      const next = argv[++i];
      if (
        typeof next !== "string" ||
        next.length === 0 ||
        next.startsWith("--")
      ) {
        throw new Error("--dist-dir requires a path value");
      }
      args.distDir = next;
    } else if (a === "--settle-ms") {
      args.settleMs = parseDecimalInt(argv[++i], "--settle-ms", {
        min: 0,
        max: MAX_TIMER_DELAY_MS,
      });
    } else if (a === "--out") {
      const next = argv[++i];
      if (
        typeof next !== "string" ||
        next.length === 0 ||
        next.startsWith("--")
      ) {
        throw new Error("--out requires a file path value");
      }
      args.out = next;
    } else if (a === "--timeout") {
      args.timeout = parseDecimalInt(argv[++i], "--timeout", {
        min: 1,
        max: MAX_TIMER_DELAY_MS,
      });
    } else if (a === "--label") {
      const next = argv[++i];
      if (
        typeof next !== "string" ||
        next.length === 0 ||
        next.startsWith("--")
      ) {
        throw new Error("--label requires a name value");
      }
      args.label = next;
    } else if (a === "--headed") args.headed = true;
    else if (a === "--help" || a === "-h") {
      args.help = true;
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/measure-anonymous-login-transfer.mjs [options]
  --url <url>       Login URL (default with --serve-dist: http://127.0.0.1:<port>/login)
  --serve-dist      Serve packages/app/dist and measure /login
  --dist-dir <path> Override dist directory (default: packages/app/dist)
  --settle-ms <n>   Settle time after navigation (default 6000; 0..${MAX_TIMER_DELAY_MS})
  --out <path>      Write JSON report
  --label <name>    Label this measurement (e.g. git sha)
  --headed          Visible browser
  --timeout <ms>    Navigation timeout (default 90000; 1..${MAX_TIMER_DELAY_MS})`);
}

function gitHead() {
  try {
    return execSync("git rev-parse HEAD", {
      cwd: appDir,
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

/** Minimal static SPA server for dist/ (history-fallback to index.html). */
function startDistServer(root) {
  if (!existsSync(join(root, "index.html"))) {
    throw new Error(
      `${root}/index.html missing — run a production vite build first`,
    );
  }
  distDir = root;
  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      let rel = decodeURIComponent(url.pathname);
      if (rel === "/") rel = "/index.html";
      const filePath = join(distDir, rel.replace(/^\/+/, ""));
      const rootResolved = resolve(distDir);
      // Trailing separator so `distDir + "evil"` cannot pass a prefix check
      // (shipwright #18441 path-traversal note).
      const rootPrefix =
        rootResolved.endsWith("\\") || rootResolved.endsWith("/")
          ? rootResolved
          : rootResolved + (process.platform === "win32" ? "\\" : "/");
      const resolved = resolve(filePath);
      if (resolved !== rootResolved && !resolved.startsWith(rootPrefix)) {
        res.writeHead(403);
        res.end("forbidden");
        return;
      }
      let finalPath = resolved;
      if (!existsSync(finalPath) || statSync(finalPath).isDirectory()) {
        finalPath = join(distDir, "index.html");
      }
      const raw = readFileSync(finalPath);
      const type =
        MIME[extname(finalPath).toLowerCase()] || "application/octet-stream";
      // Gzip text assets so transferSize matches hosted/CDN compression
      // (issue #18056 measures browser transferSize, not on-disk size).
      const accept = String(req.headers["accept-encoding"] || "");
      const compressible =
        /\.(html?|js|mjs|css|json|svg|webmanifest|map)$/i.test(finalPath) ||
        type.startsWith("text/") ||
        type.includes("javascript") ||
        type.includes("json") ||
        type.includes("svg");
      if (compressible && accept.includes("gzip") && raw.length > 256) {
        const gz = gzipSync(raw, { level: 9 });
        res.writeHead(200, {
          "content-type": type,
          "content-encoding": "gzip",
          "cache-control": "no-store",
          vary: "accept-encoding",
        });
        res.end(gz);
        return;
      }
      res.writeHead(200, {
        "content-type": type,
        "cache-control": "no-store",
      });
      res.end(raw);
    } catch (err) {
      res.writeHead(500);
      res.end(String(err?.message || err));
    }
  });
  return new Promise((resolveListen) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolveListen({ server, port, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

/**
 * Sample PRT inside the page — same shape as issue #18056.
 */
function sampleTransferInPage() {
  const resources = performance.getEntriesByType("resource");
  const scripts = resources.filter((e) => e.initiatorType === "script");
  const sum = (list, key) =>
    list.reduce((n, e) => n + (Number(e[key]) || 0), 0);

  const scriptRows = scripts
    .map((e) => ({
      name: e.name,
      transferSize: e.transferSize || 0,
      encodedBodySize: e.encodedBodySize || 0,
      decodedBodySize: e.decodedBodySize || 0,
    }))
    .sort((a, b) => b.transferSize - a.transferSize);

  return {
    resources: resources.length,
    transferBytes: sum(resources, "transferSize"),
    scripts: scripts.length,
    scriptTransferBytes: sum(scripts, "transferSize"),
    scriptEncodedBytes: sum(scripts, "encodedBodySize"),
    topScripts: scriptRows.slice(0, 25),
  };
}

/**
 * Reject a sample whose renderer crashed or logged an error. A smaller broken
 * page is not a valid performance improvement.
 *
 * @param {string[]} runtimeErrors
 * @param {string} viewportId
 */
export function assertNoRuntimeErrors(runtimeErrors, viewportId) {
  if (runtimeErrors.length === 0) return;
  const details = runtimeErrors.slice(0, 5).join(" | ");
  throw new Error(
    `${viewportId} /login emitted ${runtimeErrors.length} runtime error(s): ${details}`,
  );
}

/**
 * @typedef {{
 *   ok: boolean,
 *   failure: string,
 *   rootChildren: number,
 *   emailVisible: boolean,
 *   headingVisible: boolean,
 *   formVisible: boolean,
 *   appMarker: string,
 *   bodySample: string,
 * }} LoginSurfaceProbe
 */

/**
 * Inspect the settled `/login` DOM for a stable visible auth surface.
 * Prefer a visible email field plus login heading/form; also accept the
 * app-owned login marker together with a visible email field so a future
 * marker-only pin remains possible without treating an empty shell as healthy.
 *
 * Runs inside the page (Playwright `evaluate`) and under unit fixtures.
 *
 * @returns {LoginSurfaceProbe}
 */
export function collectLoginSurfaceProbe() {
  const isVisible = (element) => {
    if (!element) return false;
    const style =
      typeof globalThis.getComputedStyle === "function"
        ? globalThis.getComputedStyle(element)
        : element.style || {};
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.opacity === "0"
    ) {
      return false;
    }
    const rect =
      typeof element.getBoundingClientRect === "function"
        ? element.getBoundingClientRect()
        : null;
    if (!rect) return true;
    return rect.width > 0 && rect.height > 0;
  };

  const root = document.getElementById("root");
  const rootChildren = root ? root.children.length : 0;
  const email =
    document.getElementById("steward-login-email") ||
    document.querySelector('input[type="email"]') ||
    document.querySelector('input[name="email"]');
  const emailVisible = isVisible(email);

  const headings = Array.from(document.querySelectorAll("h1"));
  const headingVisible = headings.some((heading) => {
    if (!isVisible(heading)) return false;
    const text = String(heading.textContent || "")
      .trim()
      .toLowerCase();
    return (
      text.includes("sign in") || text.includes("log in") || text.length > 0
    );
  });

  const formVisible = Array.from(document.querySelectorAll("form")).some(
    (form) => isVisible(form),
  );
  const mainVisible = Array.from(document.querySelectorAll("main")).some(
    (main) => isVisible(main),
  );

  const markerEl =
    document.querySelector('[data-testid="login-safe-area-fill"]') ||
    document.querySelector('[data-login-surface="ready"]');
  const appMarker = markerEl
    ? markerEl.getAttribute("data-testid") ||
      markerEl.getAttribute("data-login-surface") ||
      "present"
    : "";
  const markerVisible = isVisible(markerEl);

  const bodySample = String(document.body?.textContent || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);

  // Primary contract: visible email + (heading or form). This matches the
  // shipped Steward login card and rejects empty/black #root shells.
  if (emailVisible && (headingVisible || formVisible)) {
    return {
      ok: true,
      failure: "",
      rootChildren,
      emailVisible,
      headingVisible,
      formVisible,
      appMarker,
      bodySample,
    };
  }

  // Secondary contract: app-owned marker + visible email + main landmark.
  // Keeps an explicit product marker usable without accepting blank shells.
  if (markerVisible && emailVisible && mainVisible) {
    return {
      ok: true,
      failure: "",
      rootChildren,
      emailVisible,
      headingVisible,
      formVisible,
      appMarker,
      bodySample,
    };
  }

  let failure = "missing-login-surface";
  if (!root) failure = "missing-root";
  else if (rootChildren === 0) failure = "empty-root";
  else if (!emailVisible && !headingVisible && !formVisible) {
    failure = "blank-or-invalid-login-dom";
  } else if (!emailVisible) failure = "missing-email";
  else failure = "missing-login-chrome";

  return {
    ok: false,
    failure,
    rootChildren,
    emailVisible,
    headingVisible,
    formVisible,
    appMarker,
    bodySample,
  };
}

/**
 * Fail closed when the settled page is not a usable login surface — even if
 * zero console/page errors were emitted.
 *
 * @param {LoginSurfaceProbe} probe
 * @param {string} viewportId
 */
export function assertLoginSurfaceReady(probe, viewportId) {
  if (probe?.ok) return;
  const diagnostic = [
    `failure=${probe?.failure || "unknown"}`,
    `rootChildren=${probe?.rootChildren ?? "?"}`,
    `emailVisible=${Boolean(probe?.emailVisible)}`,
    `headingVisible=${Boolean(probe?.headingVisible)}`,
    `formVisible=${Boolean(probe?.formVisible)}`,
    `appMarker=${probe?.appMarker || "none"}`,
    `bodySample=${JSON.stringify(String(probe?.bodySample || "").slice(0, 80))}`,
  ].join(" ");
  const message = `${viewportId} /login failed visible login contract after settle: ${diagnostic}`;
  throw new Error(message.slice(0, 480));
}

async function measureViewport(browser, { url, settleMs, timeout, viewport }) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    serviceWorkers: "block",
    // Empty storage / cache for cold measure
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  const runtimeErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      runtimeErrors.push(`console: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    runtimeErrors.push(`page: ${error.message}`);
  });
  const started = Date.now();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout });
    await new Promise((r) => setTimeout(r, settleMs));
    const sample = await page.evaluate(sampleTransferInPage);
    assertNoRuntimeErrors(runtimeErrors, viewport.id);
    const loginProbe = await page.evaluate(collectLoginSurfaceProbe);
    assertLoginSurfaceReady(loginProbe, viewport.id);
    return {
      viewport: viewport.id,
      width: viewport.width,
      height: viewport.height,
      wallMs: Date.now() - started,
      loginSurface: {
        emailVisible: loginProbe.emailVisible,
        headingVisible: loginProbe.headingVisible,
        formVisible: loginProbe.formVisible,
        appMarker: loginProbe.appMarker,
      },
      ...sample,
    };
  } finally {
    await context.close();
  }
}

function formatMb(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(3)} MB`;
}

function printSample(sample) {
  console.log(
    `\n[${sample.viewport}] resources=${sample.resources} transfer=${formatMb(sample.transferBytes)} scripts=${sample.scripts} scriptTransfer=${formatMb(sample.scriptTransferBytes)}`,
  );
  console.log("  top scripts by transferSize:");
  for (const row of sample.topScripts.slice(0, 12)) {
    const short = row.name.split("/").slice(-1)[0] || row.name;
    console.log(
      `    ${formatMb(row.transferSize).padStart(12)}  ${short.slice(0, 80)}`,
    );
  }
}

async function main(argv = process.argv) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  let server = null;
  let baseUrl = null;
  let loginUrl = args.url;

  if (args.serveDist) {
    const root = args.distDir ? resolve(args.distDir) : distDir;
    const started = await startDistServer(root);
    server = started.server;
    baseUrl = started.baseUrl;
    loginUrl = `${baseUrl}/login`;
    console.log(`Serving dist at ${baseUrl} (root=${root})`);
  }

  if (!loginUrl) {
    console.error("Provide --url <login-url> or --serve-dist");
    process.exit(2);
  }

  const head = gitHead();
  console.log(
    `Measuring cold /login: url=${loginUrl} settleMs=${args.settleMs} sw=blocked cache=empty head=${head ?? "unknown"}`,
  );

  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({ headless: !args.headed });
  const samples = [];
  try {
    for (const viewport of VIEWPORTS) {
      const sample = await measureViewport(browser, {
        url: loginUrl,
        settleMs: args.settleMs,
        timeout: args.timeout,
        viewport,
      });
      samples.push(sample);
      printSample(sample);
    }
  } finally {
    await browser.close();
    if (server) {
      await new Promise((r) => server.close(r));
    }
  }

  const report = {
    issue: "18056",
    label: args.label ?? head,
    headSha: head,
    loginUrl,
    baseUrl,
    serveDist: args.serveDist,
    settleMs: args.settleMs,
    conditions: {
      serviceWorkers: "block",
      cache: "empty-context",
      interaction: "none (no form submit)",
      build: args.serveDist
        ? "packages/app/dist production assets"
        : "external-url",
    },
    capturedAtIso: new Date().toISOString(),
    samples,
    summary: {
      desktop: samples.find((s) => s.viewport === "desktop") ?? null,
      mobile: samples.find((s) => s.viewport === "mobile") ?? null,
    },
  };

  if (args.out) {
    writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\nWrote ${args.out}`);
  }

  // Always print markdown table for PR evidence paste.
  console.log(
    "\n| Viewport | Resources | Total transferSize | Scripts | Script transferSize |",
  );
  console.log("| --- | ---: | ---: | ---: | ---: |");
  for (const s of samples) {
    console.log(
      `| ${s.viewport} | ${s.resources} | ${s.transferBytes} B (${formatMb(s.transferBytes)}) | ${s.scripts} | ${s.scriptTransferBytes} B (${formatMb(s.scriptTransferBytes)}) |`,
    );
  }

  process.exit(0);
}

function isDirectRun(entryPath) {
  if (!entryPath) return false;
  try {
    return (
      realpathSync(resolve(entryPath)) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    // error-policy:J3 an unresolved argv entry is not this module's CLI path
    return false;
  }
}

if (isDirectRun(process.argv[1])) {
  // error-policy:J1 CLI boundary — invalid flags and measure failures exit
  // non-zero with a legible message instead of an unhandled rejection.
  main().catch((err) => {
    console.error(
      `[login-transfer] ${err instanceof Error ? err.message : err}`,
    );
    process.exit(1);
  });
}
