/**
 * app.ts — Runtime-agnostic Hono app construction.
 *
 * This module exports the fully-configured `Hono` instance with all routes,
 * middleware, and per-route auth wired up. It deliberately contains NO server
 * boot code (no `Bun.serve`, no `setInterval` GC, no signal handlers, no
 * blocking `runMigrations()` call) so that it can be reused by:
 *
 *   - `index.ts`   — Bun entry point (long-lived process; runs migrations,
 *                    sets up GC timers, wires SIGINT/SIGTERM, calls
 *                    `Bun.serve`).
 *   - `worker.ts`  — Cloudflare Workers entry point (per-request fetch,
 *                    no setInterval/Bun, migrations run out-of-band).
 *   - `embedded.ts`— Electrobun/desktop entry point.
 *
 * Anything that must NOT run on Workers (timers, blocking I/O at module init,
 * Node-only APIs) belongs in `index.ts`, not here.
 */

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { logger } from "hono/logger";
import { correlationId } from "./middleware/correlation";
import { tenantCors } from "./middleware/tenant-cors";
import { agentRoutes } from "./routes/agents";
import { approvalRoutes } from "./routes/approvals";
import { auditRoutes } from "./routes/audit";
import { authRoutes } from "./routes/auth";
import { dashboardRoutes } from "./routes/dashboard";
import { discoveryRoutes, erc8004Routes } from "./routes/erc8004";
import { platformRoutes } from "./routes/platform";
import { policiesStandaloneRoutes } from "./routes/policies-standalone";
import { secretsRoutes } from "./routes/secrets";
import { tenantConfigRoutes } from "./routes/tenant-config";
import { tenantRoutes } from "./routes/tenants";
import { userRoutes } from "./routes/user";
import { vaultRoutes } from "./routes/vault";
import { webhookRoutes } from "./routes/webhooks";
import {
  API_VERSION,
  type ApiResponse,
  type AppVariables,
  dashboardAuthMiddleware,
  tenantAuth,
} from "./services/context";

const startTime = Date.now();

const app = new Hono<{ Variables: AppVariables }>();

// ─── Global error handler ─────────────────────────────────────────────────────

app.onError((err, c) => {
  const requestId = c.get("requestId") || "unknown";

  if (err instanceof SyntaxError || err.message?.includes("JSON")) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid JSON in request body" }, 400);
  }

  console.error(`[${requestId}] Unhandled API error:`, err);
  return c.json<ApiResponse>({ ok: false, error: "Internal server error" }, 500);
});

// ─── 404 fallback ─────────────────────────────────────────────────────────────

app.notFound((c) =>
  c.json<ApiResponse>({ ok: false, error: `Not found: ${c.req.method} ${c.req.path}` }, 404),
);

// ─── Global middleware ────────────────────────────────────────────────────────

app.use("*", tenantCors);
app.use("*", logger());
app.use("*", correlationId);

app.use(
  "*",
  bodyLimit({
    maxSize: 1024 * 1024,
    onError: (c) =>
      c.json<ApiResponse>({ ok: false, error: "Request body too large (max 1MB)" }, 413),
  }),
);

// ─── Auth middleware per route group ──────────────────────────────────────────

app.use("/agents", (c, next) => tenantAuth(c, next));
app.use("/agents/*", (c, next) => tenantAuth(c, next));
app.use("/vault/*", (c, next) => tenantAuth(c, next));
app.use("/secrets", (c, next) => tenantAuth(c, next));
app.use("/secrets/*", (c, next) => tenantAuth(c, next));
app.use("/tenants/:id", (c, next) =>
  tenantAuth(c, next, { requireTenantMatch: c.req.param("id") }),
);
app.use("/tenants/:id/webhook", (c, next) =>
  tenantAuth(c, next, { requireTenantMatch: c.req.param("id") }),
);
app.use("/tenants/:id/config", (c, next) =>
  tenantAuth(c, next, { requireTenantMatch: c.req.param("id") }),
);
app.use("/tenants/:id/config/*", (c, next) =>
  tenantAuth(c, next, { requireTenantMatch: c.req.param("id") }),
);
app.use("/dashboard/*", (c, next) => dashboardAuthMiddleware(c, next));
app.use("/webhooks", (c, next) => tenantAuth(c, next));
app.use("/webhooks/*", (c, next) => tenantAuth(c, next));
app.use("/approvals", (c, next) => tenantAuth(c, next));
app.use("/approvals/*", (c, next) => tenantAuth(c, next));
app.use("/audit", (c, next) => tenantAuth(c, next));
app.use("/audit/*", (c, next) => tenantAuth(c, next));
app.use("/policies", (c, next) => tenantAuth(c, next));
app.use("/policies/*", (c, next) => tenantAuth(c, next));

// ─── Health & root ────────────────────────────────────────────────────────────

app.get("/", (c) => c.json({ name: "steward", version: API_VERSION, status: "running" }));
app.get("/health", (c) =>
  c.json({
    status: "ok",
    version: API_VERSION,
    uptime: Math.floor((Date.now() - startTime) / 1000),
  }),
);

// ─── Route modules ────────────────────────────────────────────────────────────

app.route("/auth", authRoutes);
app.route("/platform", platformRoutes);
app.route("/user", userRoutes);
app.route("/agents", agentRoutes);
app.route("/vault", vaultRoutes);
app.route("/secrets", secretsRoutes);
app.route("/tenants", tenantRoutes);
app.route("/tenants", tenantConfigRoutes);
app.route("/dashboard", dashboardRoutes);
app.route("/webhooks", webhookRoutes);
app.route("/approvals", approvalRoutes);
app.route("/audit", auditRoutes);
app.route("/policies", policiesStandaloneRoutes);
app.route("/agents", erc8004Routes);
app.route("/discovery", discoveryRoutes);

export { app, startTime };
export default app;
