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
 *   --settle-ms    wait after load before sampling (default 6000)
 *   --out          write JSON report
 *   --headed       visible browser
 *   --label        label for this run (e.g. head-sha or develop)
 *
 * Desktop (1280x720) and mobile (390x844) viewports are measured by default.
 */

import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, "..");
const distDir = join(appDir, "dist");

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

function parseArgs(argv) {
  const args = {
    url: null,
    serveDist: false,
    settleMs: 6000,
    out: null,
    headed: false,
    label: null,
    timeout: 90_000,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--url") args.url = argv[++i];
    else if (a === "--serve-dist") args.serveDist = true;
    else if (a === "--settle-ms") args.settleMs = Number(argv[++i]);
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--timeout") args.timeout = Number(argv[++i]);
    else if (a === "--label") args.label = argv[++i];
    else if (a === "--headed") args.headed = true;
    else if (a === "--help" || a === "-h") {
      console.log(`Usage: node scripts/measure-anonymous-login-transfer.mjs [options]
  --url <url>       Login URL (default with --serve-dist: http://127.0.0.1:<port>/login)
  --serve-dist      Serve packages/app/dist and measure /login
  --settle-ms <n>   Settle time after navigation (default 6000)
  --out <path>      Write JSON report
  --label <name>    Label this measurement (e.g. git sha)
  --headed          Visible browser
  --timeout <ms>    Navigation timeout (default 90000)`);
      process.exit(0);
    }
  }
  return args;
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
function startDistServer() {
  if (!existsSync(join(distDir, "index.html"))) {
    throw new Error(
      `packages/app/dist/index.html missing — run: bun run --cwd packages/app build`,
    );
  }
  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      let rel = decodeURIComponent(url.pathname);
      if (rel === "/") rel = "/index.html";
      const filePath = join(distDir, rel.replace(/^\/+/, ""));
      const safeRoot = distDir + "\\";
      const resolved = resolve(filePath);
      if (!resolved.startsWith(resolve(distDir))) {
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
  const resources = performance.getEntriesByType(
    "resource",
  );
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

async function measureViewport(browser, { url, settleMs, timeout, viewport }) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    serviceWorkers: "block",
    // Empty storage / cache for cold measure
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  const started = Date.now();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout });
    await new Promise((r) => setTimeout(r, settleMs));
    const sample = await page.evaluate(sampleTransferInPage);
    return {
      viewport: viewport.id,
      width: viewport.width,
      height: viewport.height,
      wallMs: Date.now() - started,
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

async function main() {
  const args = parseArgs(process.argv);
  let server = null;
  let baseUrl = null;
  let loginUrl = args.url;

  if (args.serveDist) {
    const started = await startDistServer();
    server = started.server;
    baseUrl = started.baseUrl;
    loginUrl = `${baseUrl}/login`;
    console.log(`Serving dist at ${baseUrl}`);
  }

  if (!loginUrl) {
    console.error("Provide --url <login-url> or --serve-dist");
    process.exit(2);
  }

  const head = gitHead();
  console.log(
    `Measuring cold /login: url=${loginUrl} settleMs=${args.settleMs} sw=blocked cache=empty head=${head ?? "unknown"}`,
  );

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
      build: args.serveDist ? "packages/app/dist production assets" : "external-url",
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
  console.log("\n| Viewport | Resources | Total transferSize | Scripts | Script transferSize |");
  console.log("| --- | ---: | ---: | ---: | ---: |");
  for (const s of samples) {
    console.log(
      `| ${s.viewport} | ${s.resources} | ${s.transferBytes} B (${formatMb(s.transferBytes)}) | ${s.scripts} | ${s.scriptTransferBytes} B (${formatMb(s.scriptTransferBytes)}) |`,
    );
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
