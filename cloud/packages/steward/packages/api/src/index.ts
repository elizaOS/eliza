/**
 * Steward API — Bun entry point.
 *
 * The Hono application itself lives in `./app.ts` so the same routes can be
 * served by other runtimes (Cloudflare Workers, Electrobun embedded). This
 * file only contains code that needs a long-lived Node/Bun process:
 *
 *   - The in-memory IP rate-limit log (only safe in single-process mode)
 *   - `setInterval` GC for expired entries
 *   - The blocking `runMigrations()` call at boot
 *   - The /ready readiness probe (depends on migration state + DB ping)
 *   - `Bun.serve` plus SIGINT/SIGTERM graceful shutdown
 */

import { closeDb, getDb, runMigrations, shouldUsePGLite } from "@stwd/db";
import { sql } from "drizzle-orm";
import { app } from "./app";
import { initRedis, shutdownRedis } from "./middleware/redis";
import { initAuthStores } from "./routes/auth";
import {
  API_VERSION,
  type ApiResponse,
  nonceCleanupTimer,
  RATE_LIMIT_MAX_REQUESTS,
  RATE_LIMIT_WINDOW_MS,
} from "./services/context";

// ─── Constants ────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "3200", 10);
const startTime = Date.now();
let migrationsRan = false;

if (!Number.isInteger(PORT) || PORT <= 0) {
  throw new Error("PORT must be a positive integer");
}

// ─── In-memory rate-limit log + shutdown guard ───────────────────────────────
//
// NOT used by the Workers entry — Workers should rely on the Redis-backed
// sliding-window rate limiter (or a Workers-native KV-backed alternative).

const requestLog = new Map<string, { count: number; resetAt: number }>();
let isShuttingDown = false;

app.use("*", async (c, next) => {
  if (c.req.path === "/health" || c.req.path === "/ready") return next();

  if (isShuttingDown) {
    return c.json<ApiResponse>({ ok: false, error: "Server is shutting down" }, 503);
  }

  const forwardedFor = c.req.header("x-forwarded-for");
  const ip = forwardedFor?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "unknown";
  const now = Date.now();
  const current = requestLog.get(ip);

  if (!current || current.resetAt <= now) {
    requestLog.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return next();
  }

  if (current.count >= RATE_LIMIT_MAX_REQUESTS) {
    c.header("Retry-After", Math.ceil((current.resetAt - now) / 1000).toString());
    return c.json<ApiResponse>({ ok: false, error: "Rate limit exceeded" }, 429);
  }

  current.count += 1;
  requestLog.set(ip, current);
  return next();
});

const requestLogCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of requestLog.entries()) {
    if (entry.resetAt <= now) requestLog.delete(ip);
  }
}, RATE_LIMIT_WINDOW_MS);

// ─── /ready — deep readiness probe ───────────────────────────────────────────
//
// Only mounted on the Bun entry. Workers expose `/health` (in app.ts) and rely
// on the Cloudflare control plane for instance health.

app.get("/ready", async (c) => {
  const checks: Record<string, { ok: boolean; error?: string }> = {};

  checks.migrations = { ok: migrationsRan };

  try {
    const db = getDb();
    await db.execute(sql`SELECT 1`);
    checks.database = { ok: true };
  } catch (err: unknown) {
    checks.database = { ok: false, error: err instanceof Error ? err.message : "unknown" };
  }

  if (!process.env.STEWARD_MASTER_PASSWORD) {
    checks.vault = { ok: false, error: "STEWARD_MASTER_PASSWORD not set" };
  } else {
    checks.vault = { ok: true };
  }

  const allOk = Object.values(checks).every((c) => c.ok);
  return c.json(
    {
      status: allOk ? "ready" : "not_ready",
      version: API_VERSION,
      uptime: Math.floor((Date.now() - startTime) / 1000),
      checks,
    },
    allOk ? 200 : 503,
  );
});

// ─── Database migrations (blocking — must complete before serving traffic) ───

if (shouldUsePGLite()) {
  migrationsRan = true;
  console.log("[steward] PGLite mode detected — skipping Postgres migrator.");
} else if (process.env.SKIP_MIGRATIONS === "true" || process.env.SKIP_MIGRATIONS === "1") {
  migrationsRan = true;
  console.log("[steward] SKIP_MIGRATIONS set — skipping auto-migration. Run migrations manually.");
} else {
  try {
    console.log("[steward] Running database migrations...");
    await runMigrations();
    migrationsRan = true;
    console.log("[steward] Migrations complete.");
  } catch (err) {
    console.error("[steward] Migration failed — cannot start:", err);
    process.exit(1);
  }
}

// ─── Redis + auth store initialization (non-blocking) ───────────────────────

initRedis()
  .then((redisOk) => {
    // usePostgres=true when migrations have run, so auth_kv_store table exists.
    const usePostgres = migrationsRan && !redisOk;
    return initAuthStores(usePostgres);
  })
  .catch((err) => {
    console.warn("[steward] Redis/auth store initialization failed, using in-memory stores:", err);
    initAuthStores(false).catch(() => {});
  });

// ─── Server ───────────────────────────────────────────────────────────────────

const BIND_HOST = process.env.STEWARD_BIND_HOST || "127.0.0.1";

const serverOptions = {
  hostname: BIND_HOST,
  port: PORT,
  fetch: (request: Request) => app.fetch(request),
  idleTimeout: 30,
} as Parameters<typeof Bun.serve>[0] & { hostname?: string };

const server = Bun.serve(serverOptions);

const shutdown = async (signal: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`Received ${signal}, shutting down Steward API`);

  server.stop(true);
  clearInterval(requestLogCleanupTimer);
  clearInterval(nonceCleanupTimer);
  requestLog.clear();

  try {
    await Promise.all([closeDb(), shutdownRedis()]);
  } catch (error) {
    console.error("Failed to close connections cleanly", error);
  }

  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

console.log(`Steward API running on ${BIND_HOST}:${server.port}`);
