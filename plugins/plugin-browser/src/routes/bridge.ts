/**
 * Agent Browser Bridge HTTP routes.
 *
 * Mounted under `/api/browser-bridge/*` by the plugin-collector. Pair +
 * settings + companion-sync + tabs + current-page + packaging endpoints
 * are fully generic. Session endpoints (confirm/progress/complete) still
 * operate on the LifeOps-owned `life_browser_sessions` table and therefore
 * call into the LifeOps route service because that app owns workflow-scoped
 * browser sessions.
 *
 * Companion/auto-pair/sync authentication uses the
 * `X-Browser-Bridge-Companion-Id` header paired with a bearer pairing
 * token. The old `X-LifeOps-Browser-Companion-Id` and legacy
 * `x-eliza-browser-companion-id` aliases were deliberately removed.
 */

import fs from "node:fs";
import type http from "node:http";
import type { ReadJsonBodyOptions } from "@elizaos/core";
import { type AgentRuntime, logger, type UUID } from "@elizaos/core";
import type {
  CompleteLifeOpsBrowserSessionRequest,
  ConfirmLifeOpsBrowserSessionRequest,
  CreateLifeOpsBrowserSessionRequest,
} from "../lifeops-session-contracts.js";
import {
  type BrowserBridgeCompanionAuthErrorCode,
  BROWSER_BRIDGE_PACKAGE_PATH_TARGETS,
  type CreateBrowserBridgeCompanionAutoPairRequest,
  type CreateBrowserBridgeCompanionPairingRequest,
  type SyncBrowserBridgeStateRequest,
  type UpdateBrowserBridgeSessionProgressRequest,
  type UpdateBrowserBridgeSettingsRequest,
} from "../contracts.js";
import {
  buildBrowserBridgeCompanionPackage,
  getBrowserBridgeCompanionDownloadFile,
  getBrowserBridgeCompanionPackageStatus,
  openBrowserBridgeCompanionManager,
  openBrowserBridgeCompanionPackagePath,
} from "../packaging.js";
import {
  BROWSER_BRIDGE_ROUTE_SERVICE_TYPE,
  type BrowserBridgeRouteService,
} from "../service.js";

export interface BrowserBridgeRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  url: URL;
  state: {
    runtime: AgentRuntime | null;
    adminEntityId: UUID | null;
  };
  json: (res: http.ServerResponse, data: unknown, status?: number) => void;
  error: (res: http.ServerResponse, message: string, status?: number) => void;
  readJsonBody: <T extends object>(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    options?: ReadJsonBodyOptions,
  ) => Promise<T | null>;
  decodePathComponent: (
    raw: string,
    res: http.ServerResponse,
    label: string,
  ) => string | null;
}

function getService(
  ctx: BrowserBridgeRouteContext,
): BrowserBridgeRouteService | null {
  if (!ctx.state.runtime) {
    ctx.error(ctx.res, "Agent runtime is not available", 503);
    return null;
  }
  const service = ctx.state.runtime.getService<BrowserBridgeRouteService>(
    BROWSER_BRIDGE_ROUTE_SERVICE_TYPE,
  );
  if (!service) {
    ctx.error(ctx.res, "Browser Bridge service is not available", 503);
    return null;
  }
  return service;
}

function getBrowserCompanionAuth(
  ctx: BrowserBridgeRouteContext,
): { companionId: string; pairingToken: string } | null {
  const companionHeader = ctx.req.headers["x-browser-bridge-companion-id"];
  const companionId =
    typeof companionHeader === "string" ? companionHeader.trim() : "";
  if (!companionId) {
    routeJsonError(
      ctx,
      "Missing X-Browser-Bridge-Companion-Id header",
      401,
      "browser_bridge_companion_auth_missing_id",
    );
    return null;
  }
  const authHeader =
    typeof ctx.req.headers.authorization === "string"
      ? ctx.req.headers.authorization.trim()
      : "";
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  const pairingToken = match?.[1]?.trim() ?? "";
  if (!pairingToken) {
    routeJsonError(
      ctx,
      "Missing browser companion bearer token",
      401,
      "browser_bridge_companion_auth_missing_token",
    );
    return null;
  }
  return {
    companionId,
    pairingToken,
  };
}

function browserAutoPairOriginAllowed(ctx: BrowserBridgeRouteContext): boolean {
  const originHeader =
    typeof ctx.req.headers.origin === "string"
      ? ctx.req.headers.origin.trim()
      : "";
  if (!originHeader) {
    return requestIsLoopback(ctx);
  }
  if (originHeader === ctx.url.origin) {
    return true;
  }
  return (
    originHeader.startsWith("chrome-extension://") ||
    originHeader.startsWith("safari-web-extension://")
  );
}

function requestIsLoopback(ctx: BrowserBridgeRouteContext): boolean {
  const remoteAddress = ctx.req.socket.remoteAddress?.trim().toLowerCase();
  return (
    remoteAddress === "127.0.0.1" ||
    remoteAddress === "::1" ||
    remoteAddress === "0:0:0:0:0:0:0:1" ||
    remoteAddress === "::ffff:127.0.0.1" ||
    remoteAddress === "::ffff:0:127.0.0.1"
  );
}

const BROWSER_BRIDGE_RATE_LIMITS = {
  default: { maxRequests: 60, windowMs: 60_000 },
} satisfies Record<string, RateLimitConfig>;

interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
}

interface RateLimitEntry {
  timestamps: number[];
}

const rateLimitBuckets = new Map<string, RateLimitEntry>();
const RATE_LIMIT_CLEANUP_INTERVAL_MS = 5 * 60 * 1_000;
let lastRateLimitCleanup = Date.now();

function cleanupRateLimitBuckets(windowMs: number): void {
  const now = Date.now();
  if (now - lastRateLimitCleanup < RATE_LIMIT_CLEANUP_INTERVAL_MS) return;
  lastRateLimitCleanup = now;
  const cutoff = now - windowMs;
  for (const [key, entry] of rateLimitBuckets) {
    entry.timestamps = entry.timestamps.filter((timestamp) => timestamp > cutoff);
    if (entry.timestamps.length === 0) rateLimitBuckets.delete(key);
  }
}

function checkBrowserBridgeRateLimit(
  key: string,
  config: RateLimitConfig,
): { allowed: boolean; retryAfterMs: number } {
  const now = Date.now();
  cleanupRateLimitBuckets(config.windowMs);
  let entry = rateLimitBuckets.get(key);
  if (!entry) {
    entry = { timestamps: [] };
    rateLimitBuckets.set(key, entry);
  }

  const cutoff = now - config.windowMs;
  entry.timestamps = entry.timestamps.filter((timestamp) => timestamp > cutoff);

  if (entry.timestamps.length >= config.maxRequests) {
    const oldestInWindow = entry.timestamps[0];
    const retryAfterMs =
      oldestInWindow === undefined ? 0 : oldestInWindow + config.windowMs - now;
    return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 0) };
  }

  entry.timestamps.push(now);
  return { allowed: true, retryAfterMs: 0 };
}

function rateLimitRequest(
  ctx: BrowserBridgeRouteContext,
  operation: string,
): boolean {
  const agentId = String(ctx.state.runtime?.agentId ?? "unknown");
  const companionHeader = ctx.req.headers["x-browser-bridge-companion-id"];
  const companionId =
    typeof companionHeader === "string" ? companionHeader.trim() : "anonymous";
  const remoteAddress = ctx.req.socket.remoteAddress?.trim() ?? "unknown";
  const limitKey = `${agentId}:${operation}:${remoteAddress}:${companionId}`;
  const config = BROWSER_BRIDGE_RATE_LIMITS.default;
  const { allowed, retryAfterMs } = checkBrowserBridgeRateLimit(
    limitKey,
    config,
  );
  if (!allowed) {
    ctx.res.writeHead(429, {
      "Content-Type": "application/json",
      "Retry-After": String(Math.ceil(retryAfterMs / 1_000)),
    });
    ctx.res.end(JSON.stringify({ error: "Rate limit exceeded", retryAfterMs }));
    return true;
  }
  return false;
}

function routeOperation(ctx: BrowserBridgeRouteContext): string {
  return `${ctx.method.toUpperCase()} ${ctx.pathname}`;
}

interface BrowserBridgeTelemetrySpan {
  success: (args?: { statusCode?: number }) => void;
  failure: (args?: {
    statusCode?: number;
    error?: unknown;
    errorKind?: string;
  }) => void;
}

function sanitizeTelemetryToken(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const token = value.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  const normalized = token.replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  return normalized ? normalized.slice(0, 64) : undefined;
}

function inferTelemetryErrorKind(error: unknown): string | undefined {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (
      error.name === "AbortError" ||
      error.name === "TimeoutError" ||
      message.includes("timeout") ||
      message.includes("timed out")
    ) {
      return "timeout";
    }
    return sanitizeTelemetryToken(error.name);
  }
  return typeof error === "string" ? sanitizeTelemetryToken(error) : undefined;
}

function createBrowserBridgeTelemetrySpan(meta: {
  boundary: "browser-bridge";
  operation: string;
  timeoutMs?: number;
}): BrowserBridgeTelemetrySpan {
  const startedAt = Date.now();
  let settled = false;

  const finalize = (
    outcome: "success" | "failure",
    args?: { statusCode?: number; error?: unknown; errorKind?: string },
  ): void => {
    if (settled) return;
    settled = true;
    const event: Record<string, unknown> = {
      schema: "integration_boundary_v1",
      boundary: meta.boundary,
      operation: meta.operation,
      outcome,
      durationMs: Math.max(0, Date.now() - startedAt),
    };
    if (typeof meta.timeoutMs === "number") event.timeoutMs = meta.timeoutMs;
    if (typeof args?.statusCode === "number") event.statusCode = args.statusCode;
    if (outcome === "failure") {
      event.errorKind =
        sanitizeTelemetryToken(args?.errorKind) ??
        inferTelemetryErrorKind(args?.error);
    }
    const line = `[integration] ${JSON.stringify(event)}`;
    if (outcome === "success") {
      logger.info(line);
    } else {
      logger.warn(line);
    }
  };

  return {
    success: (args) => finalize("success", args),
    failure: (args) => finalize("failure", args),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function routeJsonError(
  ctx: BrowserBridgeRouteContext,
  message: string,
  status: number,
  code?: BrowserBridgeCompanionAuthErrorCode | string | null,
): void {
  ctx.json(
    ctx.res,
    {
      error: message,
      ...(code ? { code } : {}),
    },
    status,
  );
}

function isStatusError(
  error: unknown,
): error is Error & { readonly status: number } {
  return (
    error instanceof Error &&
    "status" in error &&
    typeof error.status === "number"
  );
}

function statusErrorCode(error: unknown): string | null {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return (error as { code: string }).code;
  }
  return null;
}

function decodeMatchedPathComponent(
  ctx: BrowserBridgeRouteContext,
  match: RegExpMatchArray | null,
  index: number,
  res: http.ServerResponse,
  label: string,
): string | null {
  const raw = match?.[index];
  return raw ? ctx.decodePathComponent(raw, res, label) : null;
}

async function runRoute(
  ctx: BrowserBridgeRouteContext,
  fn: (service: BrowserBridgeRouteService) => Promise<void>,
): Promise<boolean> {
  const operation = routeOperation(ctx);
  const span = createBrowserBridgeTelemetrySpan({
    boundary: "browser-bridge",
    operation,
  });
  const service = getService(ctx);
  if (!service) {
    logger.info(
      {
        boundary: "browser-bridge",
        operation,
        statusCode: 503,
      },
      "[browser-bridge] Route rejected because agent runtime is unavailable",
    );
    span.failure({
      statusCode: 503,
      errorKind: "runtime_unavailable",
    });
    return true;
  }
  try {
    await fn(service);
    span.success({
      statusCode: ctx.res.statusCode >= 400 ? ctx.res.statusCode : 200,
    });
    return true;
  } catch (error) {
    if (isStatusError(error)) {
      const logFn =
        error.status === 401
          ? logger.debug.bind(logger)
          : logger.warn.bind(logger);
      logFn(
        {
          boundary: "browser-bridge",
          operation,
          statusCode: error.status,
        },
        `[browser-bridge] Route failed: ${error.message}`,
      );
      span.failure({
        statusCode: error.status,
        error,
        errorKind:
          error.status === 401
            ? "browser_bridge_auth_invalid"
            : "browser_bridge_service_error",
      });
      routeJsonError(ctx, error.message, error.status, statusErrorCode(error));
      return true;
    }
    logger.error(
      {
        boundary: "browser-bridge",
        operation,
      },
      `[browser-bridge] Route crashed: ${errorMessage(error)}`,
    );
    span.failure({
      error,
      errorKind: "unhandled_error",
    });
    throw error;
  }
}

async function runStatelessRoute(
  ctx: BrowserBridgeRouteContext,
  fn: () => Promise<void>,
): Promise<boolean> {
  const operation = routeOperation(ctx);
  const span = createBrowserBridgeTelemetrySpan({
    boundary: "browser-bridge",
    operation,
  });
  try {
    await fn();
    span.success({
      statusCode: ctx.res.statusCode >= 400 ? ctx.res.statusCode : 200,
    });
    return true;
  } catch (error) {
    if (isStatusError(error)) {
      logger.warn(
        {
          boundary: "browser-bridge",
          operation,
          statusCode: error.status,
        },
        `[browser-bridge] Route failed: ${error.message}`,
      );
      span.failure({
        statusCode: error.status,
        error,
        errorKind: "browser_bridge_service_error",
      });
      ctx.error(ctx.res, error.message, error.status);
      return true;
    }
    logger.error(
      {
        boundary: "browser-bridge",
        operation,
      },
      `[browser-bridge] Route crashed: ${errorMessage(error)}`,
    );
    span.failure({
      error,
      errorKind: "unhandled_error",
    });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export async function handleBrowserBridgeRoutes(
  ctx: BrowserBridgeRouteContext,
): Promise<boolean> {
  const { req, res, method, pathname, json, readJsonBody } = ctx;

  if (method === "GET" && pathname === "/api/browser-bridge/sessions") {
    return runRoute(ctx, async (service) => {
      json(res, {
        sessions: await service.listBrowserSessions(ctx.state.adminEntityId),
      });
    });
  }

  if (method === "GET" && pathname === "/api/browser-bridge/settings") {
    return runRoute(ctx, async (service) => {
      json(res, {
        settings: await service.getBrowserSettings(ctx.state.adminEntityId),
      });
    });
  }

  if (method === "POST" && pathname === "/api/browser-bridge/settings") {
    const body = await readJsonBody<UpdateBrowserBridgeSettingsRequest>(
      req,
      res,
    );
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, {
        settings: await service.updateBrowserSettings(
          body,
          ctx.state.adminEntityId,
        ),
      });
    });
  }

  if (method === "POST" && pathname === "/api/browser-bridge/companions/pair") {
    const body = await readJsonBody<CreateBrowserBridgeCompanionPairingRequest>(
      req,
      res,
    );
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(
        res,
        await service.createBrowserCompanionPairing(
          body,
          ctx.state.adminEntityId,
        ),
        201,
      );
    });
  }

  if (
    method === "POST" &&
    pathname === "/api/browser-bridge/companions/auto-pair"
  ) {
    if (rateLimitRequest(ctx, "companions:auto-pair")) {
      return true;
    }
    if (!browserAutoPairOriginAllowed(ctx)) {
      ctx.error(
        res,
        "browser auto-pair must come from the agent app or a browser extension",
        403,
      );
      return true;
    }
    const body =
      await readJsonBody<CreateBrowserBridgeCompanionAutoPairRequest>(req, res);
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(
        res,
        await service.autoPairBrowserCompanion(
          body,
          ctx.url.origin,
          ctx.state.adminEntityId,
        ),
        201,
      );
    });
  }

  if (method === "GET" && pathname === "/api/browser-bridge/companions") {
    return runRoute(ctx, async (service) => {
      json(res, {
        companions: await service.listBrowserCompanions(
          ctx.state.adminEntityId,
        ),
      });
    });
  }

  if (
    method === "POST" &&
    pathname === "/api/browser-bridge/companions/revoke"
  ) {
    if (rateLimitRequest(ctx, "companions:revoke")) {
      return true;
    }
    return runRoute(ctx, async (service) => {
      const auth = getBrowserCompanionAuth(ctx);
      if (!auth) {
        return;
      }
      json(
        res,
        await service.revokeBrowserCompanionFromCompanion(
          auth.companionId,
          auth.pairingToken,
          ctx.state.adminEntityId,
        ),
      );
    });
  }

  const browserCompanionRevokeMatch = pathname.match(
    /^\/api\/browser-bridge\/companions\/([^/]+)\/revoke$/,
  );
  if (method === "POST" && browserCompanionRevokeMatch) {
    const companionId = decodeMatchedPathComponent(
      ctx,
      browserCompanionRevokeMatch,
      1,
      res,
      "browser companion id",
    );
    if (!companionId) return true;
    return runRoute(ctx, async (service) => {
      json(
        res,
        await service.revokeBrowserCompanion(
          companionId,
          ctx.state.adminEntityId,
        ),
      );
    });
  }

  if (method === "GET" && pathname === "/api/browser-bridge/packages") {
    return runStatelessRoute(ctx, async () => {
      json(res, { status: getBrowserBridgeCompanionPackageStatus() });
    });
  }

  if (
    method === "POST" &&
    pathname === "/api/browser-bridge/packages/open-path"
  ) {
    if (!requestIsLoopback(ctx)) {
      ctx.error(
        res,
        "Local extension install helpers can only run on the same machine as the agent",
        403,
      );
      return true;
    }
    const body = await readJsonBody<{
      target?: string;
      revealOnly?: boolean;
    }>(req, res);
    if (!body) return true;
    if (
      typeof body.target !== "string" ||
      !BROWSER_BRIDGE_PACKAGE_PATH_TARGETS.includes(
        body.target as (typeof BROWSER_BRIDGE_PACKAGE_PATH_TARGETS)[number],
      )
    ) {
      ctx.error(
        res,
        `target must be one of: ${BROWSER_BRIDGE_PACKAGE_PATH_TARGETS.join(", ")}`,
        400,
      );
      return true;
    }
    const validatedTarget =
      body.target as (typeof BROWSER_BRIDGE_PACKAGE_PATH_TARGETS)[number];
    return runStatelessRoute(ctx, async () => {
      json(
        res,
        await openBrowserBridgeCompanionPackagePath(validatedTarget, {
          revealOnly: body.revealOnly === true,
        }),
      );
    });
  }

  if (method === "POST" && pathname === "/api/browser-bridge/companions/sync") {
    if (rateLimitRequest(ctx, "companions:sync")) {
      return true;
    }
    const body = await readJsonBody<SyncBrowserBridgeStateRequest>(req, res);
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      const auth = getBrowserCompanionAuth(ctx);
      if (!auth) {
        return;
      }
      json(
        res,
        await service.syncBrowserCompanion(
          auth.companionId,
          auth.pairingToken,
          body,
          ctx.state.adminEntityId,
        ),
      );
    });
  }

  if (method === "GET" && pathname === "/api/browser-bridge/tabs") {
    return runRoute(ctx, async (service) => {
      json(res, {
        tabs: await service.listBrowserTabs(ctx.state.adminEntityId),
      });
    });
  }

  const browserPackageBuildMatch = pathname.match(
    /^\/api\/browser-bridge\/packages\/([^/]+)\/build$/,
  );
  if (method === "POST" && browserPackageBuildMatch) {
    const browser = decodeMatchedPathComponent(
      ctx,
      browserPackageBuildMatch,
      1,
      res,
      "browser package target",
    );
    if (!browser) return true;
    if (browser !== "chrome" && browser !== "safari") {
      ctx.error(res, "browser must be chrome or safari", 400);
      return true;
    }
    return runStatelessRoute(ctx, async () => {
      json(res, {
        status: await buildBrowserBridgeCompanionPackage(browser),
      });
    });
  }

  const browserPackageOpenManagerMatch = pathname.match(
    /^\/api\/browser-bridge\/packages\/([^/]+)\/open-manager$/,
  );
  if (method === "POST" && browserPackageOpenManagerMatch) {
    if (!requestIsLoopback(ctx)) {
      ctx.error(
        res,
        "Local extension install helpers can only run on the same machine as the agent",
        403,
      );
      return true;
    }
    const browser = decodeMatchedPathComponent(
      ctx,
      browserPackageOpenManagerMatch,
      1,
      res,
      "browser package target",
    );
    if (!browser) return true;
    if (browser !== "chrome" && browser !== "safari") {
      ctx.error(res, "browser must be chrome or safari", 400);
      return true;
    }
    return runStatelessRoute(ctx, async () => {
      json(res, await openBrowserBridgeCompanionManager(browser));
    });
  }

  const browserPackageDownloadMatch = pathname.match(
    /^\/api\/browser-bridge\/packages\/([^/]+)\/download$/,
  );
  if (method === "GET" && browserPackageDownloadMatch) {
    const browser = decodeMatchedPathComponent(
      ctx,
      browserPackageDownloadMatch,
      1,
      res,
      "browser package target",
    );
    if (!browser) return true;
    if (browser !== "chrome" && browser !== "safari") {
      ctx.error(res, "browser must be chrome or safari", 400);
      return true;
    }
    return runStatelessRoute(ctx, async () => {
      const artifact = getBrowserBridgeCompanionDownloadFile(browser);
      res.statusCode = 200;
      res.setHeader("Content-Type", artifact.contentType);
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${artifact.filename}"`,
      );
      await new Promise<void>((resolve, reject) => {
        const stream = fs.createReadStream(artifact.path);
        stream.on("error", reject);
        res.on("error", reject);
        stream.on("end", resolve);
        stream.pipe(res);
      });
    });
  }

  if (method === "GET" && pathname === "/api/browser-bridge/current-page") {
    return runRoute(ctx, async (service) => {
      json(res, {
        page: await service.getCurrentBrowserPage(ctx.state.adminEntityId),
      });
    });
  }

  if (method === "POST" && pathname === "/api/browser-bridge/sync") {
    const body = await readJsonBody<SyncBrowserBridgeStateRequest>(req, res);
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, await service.syncBrowserState(body, ctx.state.adminEntityId));
    });
  }

  if (method === "POST" && pathname === "/api/browser-bridge/sessions") {
    const body = await readJsonBody<CreateLifeOpsBrowserSessionRequest>(
      req,
      res,
    );
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(
        res,
        {
          session: await service.createBrowserSession(
            body,
            ctx.state.adminEntityId,
          ),
        },
        201,
      );
    });
  }

  const browserSessionMatch = pathname.match(
    /^\/api\/browser-bridge\/sessions\/([^/]+)$/,
  );
  if (browserSessionMatch) {
    const sessionId = decodeMatchedPathComponent(
      ctx,
      browserSessionMatch,
      1,
      res,
      "browser session id",
    );
    if (!sessionId) return true;
    if (method === "GET") {
      return runRoute(ctx, async (service) => {
        json(res, {
          session: await service.getBrowserSession(
            sessionId,
            ctx.state.adminEntityId,
          ),
        });
      });
    }
  }

  const browserConfirmMatch = pathname.match(
    /^\/api\/browser-bridge\/sessions\/([^/]+)\/confirm$/,
  );
  if (method === "POST" && browserConfirmMatch) {
    const sessionId = decodeMatchedPathComponent(
      ctx,
      browserConfirmMatch,
      1,
      res,
      "browser session id",
    );
    if (!sessionId) return true;
    const body = await readJsonBody<ConfirmLifeOpsBrowserSessionRequest>(
      req,
      res,
    );
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, {
        session: await service.confirmBrowserSession(
          sessionId,
          body,
          ctx.state.adminEntityId,
        ),
      });
    });
  }

  const browserProgressMatch = pathname.match(
    /^\/api\/browser-bridge\/sessions\/([^/]+)\/progress$/,
  );
  if (method === "POST" && browserProgressMatch) {
    const sessionId = decodeMatchedPathComponent(
      ctx,
      browserProgressMatch,
      1,
      res,
      "browser session id",
    );
    if (!sessionId) return true;
    const body = await readJsonBody<UpdateBrowserBridgeSessionProgressRequest>(
      req,
      res,
    );
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, {
        session: await service.updateBrowserSessionProgress(
          sessionId,
          body,
          ctx.state.adminEntityId,
        ),
      });
    });
  }

  const browserCompleteMatch = pathname.match(
    /^\/api\/browser-bridge\/sessions\/([^/]+)\/complete$/,
  );
  if (method === "POST" && browserCompleteMatch) {
    const sessionId = decodeMatchedPathComponent(
      ctx,
      browserCompleteMatch,
      1,
      res,
      "browser session id",
    );
    if (!sessionId) return true;
    const body = await readJsonBody<CompleteLifeOpsBrowserSessionRequest>(
      req,
      res,
    );
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, {
        session: await service.completeBrowserSession(
          sessionId,
          body,
          ctx.state.adminEntityId,
        ),
      });
    });
  }

  const browserCompanionProgressMatch = pathname.match(
    /^\/api\/browser-bridge\/companions\/sessions\/([^/]+)\/progress$/,
  );
  if (method === "POST" && browserCompanionProgressMatch) {
    if (rateLimitRequest(ctx, "companions:session-progress")) {
      return true;
    }
    const sessionId = decodeMatchedPathComponent(
      ctx,
      browserCompanionProgressMatch,
      1,
      res,
      "browser session id",
    );
    if (!sessionId) return true;
    const body = await readJsonBody<UpdateBrowserBridgeSessionProgressRequest>(
      req,
      res,
    );
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      const auth = getBrowserCompanionAuth(ctx);
      if (!auth) {
        return;
      }
      json(res, {
        session: await service.updateBrowserSessionProgressFromCompanion(
          auth.companionId,
          auth.pairingToken,
          sessionId,
          body,
          ctx.state.adminEntityId,
        ),
      });
    });
  }

  const browserCompanionCompleteMatch = pathname.match(
    /^\/api\/browser-bridge\/companions\/sessions\/([^/]+)\/complete$/,
  );
  if (method === "POST" && browserCompanionCompleteMatch) {
    if (rateLimitRequest(ctx, "companions:session-complete")) {
      return true;
    }
    const sessionId = decodeMatchedPathComponent(
      ctx,
      browserCompanionCompleteMatch,
      1,
      res,
      "browser session id",
    );
    if (!sessionId) return true;
    const body = await readJsonBody<CompleteLifeOpsBrowserSessionRequest>(
      req,
      res,
    );
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      const auth = getBrowserCompanionAuth(ctx);
      if (!auth) {
        return;
      }
      json(res, {
        session: await service.completeBrowserSessionFromCompanion(
          auth.companionId,
          auth.pairingToken,
          sessionId,
          body,
          ctx.state.adminEntityId,
        ),
      });
    });
  }

  return false;
}

export { rateLimitRequest };
