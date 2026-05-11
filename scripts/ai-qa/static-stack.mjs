#!/usr/bin/env node
// Boots a minimal "static stack" for the AI QA capture spec:
// - Spawns playwright-ui-smoke-api-stub.mjs on a free API port
// - Serves packages/app/dist/ on a free UI port via a tiny static+proxy server
// - Writes the ports to scripts/ai-qa/.static-stack.json
// - Stays alive until SIGINT/SIGTERM; on exit cleans up the stub child
//
// Why this exists: packages/app-core/scripts/playwright-ui-live-stack.ts runs
// ensureUiDistReady() at boot, which triggers `bun run build:web`. When the
// workspace is mid-refactor (e.g. the secrets rename), that build fails and
// the live stack never reaches the stub branch. This script is the
// "I have a working dist, just serve it and the stub" path.
//
// Usage:
//   node scripts/ai-qa/static-stack.mjs                    # auto-pick ports
//   node scripts/ai-qa/static-stack.mjs --api 33337 --ui 3138
//
// Pair with: ELIZA_UI_SMOKE_REUSE_SERVER=1 ELIZA_UI_SMOKE_API_PORT=$API
//   ELIZA_UI_SMOKE_PORT=$UI bun run --cwd packages/app test:e2e -- ai-qa-capture.spec.ts

import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const APP_DIST = join(REPO_ROOT, "packages", "app", "dist");
const STUB_SCRIPT = join(
  REPO_ROOT,
  "packages",
  "app-core",
  "scripts",
  "playwright-ui-smoke-api-stub.mjs",
);
const PORTS_FILE = join(HERE, ".static-stack.json");

function parseArgs(argv) {
  const out = { api: null, ui: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--api") {
      out.api = Number(argv[i + 1]);
      i += 1;
    } else if (argv[i] === "--ui") {
      out.ui = Number(argv[i + 1]);
      i += 1;
    }
  }
  return out;
}

async function getFreePort() {
  return new Promise((resolveP, rejectP) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", rejectP);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolveP(port));
    });
  });
}

function contentTypeFor(filePath) {
  switch (extname(filePath).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".svg":
      return "image/svg+xml";
    case ".ico":
      return "image/x-icon";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".webmanifest":
      return "application/manifest+json";
    default:
      return "application/octet-stream";
  }
}

function resolveDistAsset(pathname) {
  // Strip leading slash + try the path verbatim, then index.html fallback for SPA.
  const segments = pathname.replace(/^\/+/, "").split("/").filter(Boolean);
  if (segments.length > 0) {
    const candidate = resolve(APP_DIST, segments.join("/"));
    if (
      candidate.startsWith(APP_DIST) &&
      existsSync(candidate) &&
      statSync(candidate).isFile()
    ) {
      return candidate;
    }
  }
  return join(APP_DIST, "index.html");
}

async function proxyToApi({ apiBase, request, response }) {
  const url = new URL(request.url, "http://127.0.0.1");
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks);

  const headers = {};
  for (const [key, value] of Object.entries(request.headers)) {
    if (typeof value === "string") headers[key] = value;
  }
  delete headers.host;

  const upstream = await fetch(`${apiBase}${url.pathname}${url.search}`, {
    method: request.method ?? "GET",
    headers,
    body: body.byteLength > 0 ? body : undefined,
  }).catch((error) => ({
    error,
  }));

  if ("error" in upstream) {
    response.writeHead(502, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: String(upstream.error) }));
    return;
  }

  const headersOut = {};
  upstream.headers.forEach((v, k) => {
    if (k.toLowerCase() === "content-length") return;
    headersOut[k] = v;
  });
  response.writeHead(upstream.status, headersOut);
  const buf = Buffer.from(await upstream.arrayBuffer());
  response.end(buf);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiPort = args.api ?? (await getFreePort());
  const uiPort = args.ui ?? (await getFreePort());
  const apiBase = `http://127.0.0.1:${apiPort}`;

  if (!existsSync(APP_DIST) || !existsSync(join(APP_DIST, "index.html"))) {
    console.error(
      `[ai-qa static-stack] packages/app/dist/index.html missing. Build with: bun run --cwd packages/app build`,
    );
    process.exit(2);
  }

  console.error(
    `[ai-qa static-stack] starting stub api on :${apiPort}, ui on :${uiPort}`,
  );

  const stubChild = spawn("node", [STUB_SCRIPT], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ELIZA_UI_SMOKE_API_PORT: String(apiPort),
      FORCE_COLOR: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  stubChild.stdout.on("data", (chunk) =>
    process.stderr.write(`[stub] ${chunk}`),
  );
  stubChild.stderr.on("data", (chunk) =>
    process.stderr.write(`[stub-err] ${chunk}`),
  );

  // wait for stub to be ready
  const deadline = Date.now() + 30_000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${apiBase}/api/status`);
      if (r.ok) {
        const j = await r.json();
        if (j.state === "running") {
          ready = true;
          break;
        }
      }
    } catch {
      /* wait */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!ready) {
    console.error("[ai-qa static-stack] stub never became ready");
    stubChild.kill("SIGTERM");
    process.exit(3);
  }

  const uiServer = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname.startsWith("/api/")) {
        await proxyToApi({ apiBase, request, response });
        return;
      }
      const filePath = resolveDistAsset(url.pathname);
      const body = readFileSync(filePath);
      response.writeHead(200, {
        "content-type": contentTypeFor(filePath),
        "cache-control": "no-store",
      });
      response.end(body);
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: String(error) }));
    }
  });

  await new Promise((resolveP, rejectP) => {
    uiServer.once("error", rejectP);
    uiServer.listen(uiPort, "127.0.0.1", () => resolveP());
  });

  writeFileSync(
    PORTS_FILE,
    JSON.stringify(
      {
        api: apiPort,
        ui: uiPort,
        apiBase,
        uiBase: `http://127.0.0.1:${uiPort}`,
        pid: process.pid,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  console.error(
    `[ai-qa static-stack] ready at http://127.0.0.1:${uiPort} (api: ${apiBase})`,
  );

  const shutdown = (signal) => {
    console.error(`[ai-qa static-stack] received ${signal}, shutting down`);
    try {
      stubChild.kill("SIGTERM");
    } catch {}
    uiServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000);
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  // keep alive
  await new Promise(() => {});
}

main().catch((error) => {
  console.error("[ai-qa static-stack] fatal:", error);
  process.exit(1);
});
