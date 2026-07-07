/**
 * Real accounts API server for the accounts-UI e2e (issue #10722 / #11032).
 *
 * Dispatches every `/api/accounts*` and `/api/providers*` request through the
 * REAL `handleAccountsRoutes` from `@elizaos/agent` — the exact handler the
 * dashboard API server mounts — backed by the REAL default `AccountPool`
 * (`@elizaos/app-core/account-pool`, pinned to source via
 * tsconfig.e2e-paths.json) over a REAL on-disk credential store under a
 * scratch `ELIZA_HOME`. Nothing between the browser's fetch and the disk is a
 * mock.
 *
 * Also serves the built fixture (index.html / fixture.js / fixture.css) from
 * the same origin so the real ElizaClient issues same-origin requests, plus a
 * small `/__e2e__/*` control surface the test runner uses to seed health
 * states through the pool's REAL mutation APIs (`markRateLimited`,
 * `markNeedsReauth` — the same calls the runtime makes when an upstream 429s)
 * and to read outcome state for assertions.
 *
 * Run (from packages/app):
 *   bun --tsconfig-override e2e/accounts-ui/tsconfig.e2e-paths.json \
 *       e2e/accounts-ui/accounts-api-server.ts
 *
 * Env: ELIZA_HOME (required, scratch dir) · ACCOUNTS_E2E_PORT (default 34110,
 * scans up within 34110-34139) · ACCOUNTS_E2E_FIXTURE_DIR (static assets).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { getDefaultAccountPool } from "@elizaos/app-core/account-pool";
import {
  type AccountsRouteContext,
  handleAccountsRoutes,
} from "../../../agent/src/api/accounts-routes.ts";
import type { ElizaConfig } from "../../../agent/src/config/types.eliza.ts";
import {
  defaultAgentHostBridge,
  setAgentHostBridge,
} from "../../../agent/src/runtime/host-bridge.ts";

// This process IS the host: the accounts routes read the pool through the
// agent host-bridge seam (`getPool()` → `getAgentHostBridge()`), which the
// real dashboard installs in its boot funnel. Without this injection the
// routes see the no-op bridge's `null` pool and every pool-touching request
// 500s — validation-only paths (e.g. the zod reject) still worked, which is
// how the gap stayed invisible until scenario 04 exercised a successful add.
setAgentHostBridge({
  ...defaultAgentHostBridge,
  getDefaultAccountPool,
});

const HOME = process.env.ELIZA_HOME?.trim();
if (!HOME) {
  console.error("[accounts-e2e-api] ELIZA_HOME must point at a scratch dir");
  process.exit(1);
}
const FIXTURE_DIR = process.env.ACCOUNTS_E2E_FIXTURE_DIR?.trim() || "";
const PORT_START = Number(process.env.ACCOUNTS_E2E_PORT || "34110");
const PORT_END = Math.min(PORT_START + 29, 34199);

// ── config state (what the real server passes as ctx.state.config) ─────────
const configPath = path.join(HOME, "accounts-e2e-config.json");
function loadConfig(): ElizaConfig {
  if (existsSync(configPath)) {
    return JSON.parse(readFileSync(configPath, "utf-8")) as ElizaConfig;
  }
  return {} as ElizaConfig;
}
const state = { config: loadConfig() };
function saveConfig(config: ElizaConfig): void {
  state.config = config;
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}

// ── route helper implementations (mirror the real API server contract) ─────
function json(res: http.ServerResponse, data: unknown, status = 200): void {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

function error(res: http.ServerResponse, message: string, status = 500): void {
  json(res, { error: message }, status);
}

async function readJsonBody<T extends object>(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<T | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw.trim()) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    error(res, "Invalid JSON body", 400);
    return null;
  }
}

// ── static fixture assets ───────────────────────────────────────────────────
const STATIC_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/fixture.js": {
    file: "fixture.js",
    type: "text/javascript; charset=utf-8",
  },
  "/fixture.css": { file: "fixture.css", type: "text/css; charset=utf-8" },
};

function serveStatic(pathname: string, res: http.ServerResponse): boolean {
  const entry = STATIC_FILES[pathname];
  if (!entry || !FIXTURE_DIR) return false;
  const file = path.join(FIXTURE_DIR, entry.file);
  if (!existsSync(file)) return false;
  res.statusCode = 200;
  res.setHeader("content-type", entry.type);
  res.end(readFileSync(file));
  return true;
}

// ── /__e2e__ control surface (drives REAL pool mutations, reads outcomes) ──
interface SeedHealthBody {
  providerId?: string;
  accountId?: string;
  mode?: "rate-limited" | "needs-reauth" | "healthy";
  untilMs?: number;
  detail?: string;
}

async function handleControl(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  url: URL,
): Promise<boolean> {
  if (!pathname.startsWith("/__e2e__/")) return false;
  const pool = getDefaultAccountPool();

  if (pathname === "/__e2e__/health" && req.method === "GET") {
    json(res, { ok: true });
    return true;
  }

  if (pathname === "/__e2e__/pool" && req.method === "GET") {
    const providerId = url.searchParams.get("providerId") ?? undefined;
    json(res, { accounts: pool.list(providerId as never) });
    return true;
  }

  if (pathname === "/__e2e__/config" && req.method === "GET") {
    json(res, { config: state.config });
    return true;
  }

  if (pathname === "/__e2e__/credential" && req.method === "GET") {
    const providerId = url.searchParams.get("providerId") ?? "";
    const accountId = url.searchParams.get("accountId") ?? "";
    if (!/^[\w-]+$/.test(providerId) || !/^[\w-]+$/.test(accountId)) {
      error(res, "bad providerId/accountId", 400);
      return true;
    }
    const file = path.join(
      HOME as string,
      "auth",
      providerId,
      `${accountId}.json`,
    );
    json(res, { exists: existsSync(file) });
    return true;
  }

  if (pathname === "/__e2e__/seed-health" && req.method === "POST") {
    const body = await readJsonBody<SeedHealthBody>(req, res);
    if (!body) return true;
    const { providerId, accountId, mode, untilMs, detail } = body;
    if (!providerId || !accountId || !mode) {
      error(res, "providerId, accountId, mode required", 400);
      return true;
    }
    // These are the pool's REAL runtime mutation APIs — the same calls
    // plugin-anthropic / the orchestrator router make on upstream 429/401.
    if (mode === "rate-limited") {
      await pool.markRateLimited(
        accountId,
        untilMs ?? Date.now() + 2 * 60 * 60 * 1000,
        detail ?? "429 (e2e seeded)",
        { providerId: providerId as never },
      );
    } else if (mode === "needs-reauth") {
      await pool.markNeedsReauth(accountId, detail ?? "invalid_grant (e2e)", {
        providerId: providerId as never,
      });
    } else {
      await pool.markHealthy(accountId, { providerId: providerId as never });
    }
    json(res, { ok: true, account: pool.get(accountId, providerId as never) });
    return true;
  }

  return false;
}

// ── server ──────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const pathname = url.pathname;
  const method = req.method ?? "GET";

  res.on("finish", () => {
    console.error(
      `[accounts-e2e-api] ${method} ${pathname} -> ${res.statusCode}`,
    );
  });

  void (async () => {
    if (await handleControl(req, res, pathname, url)) return;
    if (method === "GET" && serveStatic(pathname, res)) return;

    const ctx: AccountsRouteContext = {
      req,
      res,
      method,
      pathname,
      json,
      error,
      readJsonBody,
      state,
      saveConfig,
    };
    const handled = await handleAccountsRoutes(ctx);
    if (!handled && !res.headersSent) {
      error(res, `No route for ${method} ${pathname}`, 404);
    }
  })().catch((err) => {
    console.error(`[accounts-e2e-api] dispatch failed: ${String(err)}`);
    if (!res.headersSent) error(res, "internal error", 500);
  });
});

async function listenInRange(): Promise<number> {
  for (let port = PORT_START; port <= PORT_END; port++) {
    const ok = await new Promise<boolean>((resolve) => {
      const onError = () => resolve(false);
      server.once("error", onError);
      server.listen(port, "127.0.0.1", () => {
        server.removeListener("error", onError);
        resolve(true);
      });
    });
    if (ok) return port;
  }
  throw new Error(`no free port in ${PORT_START}-${PORT_END}`);
}

const port = await listenInRange();
// Machine-readable readiness line the runner parses.
console.log(JSON.stringify({ ready: true, port }));
