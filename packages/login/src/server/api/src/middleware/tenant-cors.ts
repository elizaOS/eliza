/**
 * tenant-cors.ts — Per-tenant dynamic CORS middleware
 *
 * Replaces the global `cors({ origin: "*" })` setup with a middleware that:
 *  - Reads the tenant from the X-Steward-Tenant header
 *  - Looks up that tenant's allowed_origins from tenant_configs
 *  - Validates the request Origin against the list
 *  - Falls back to wildcard (*) for tenants with no configured origins (dev mode)
 *  - Fails closed when tenant origin configuration cannot be loaded
 *  - Caches origin lists in memory with a 60 s TTL to avoid per-request DB hits
 *
 * Usage in index.ts:
 *   import { tenantCors } from "./middleware/tenant-cors";
 *   app.use("*", tenantCors);
 */

import { logger } from "@elizaos/logger";
import { and, eq } from "drizzle-orm";
import type { Context, Next } from "hono";
import {
  getDb,
  tenantAppClients as tenantAppClientsTable,
  tenantConfigs as tenantConfigsTable,
} from "../../../db/src/index.ts";
import { redactedThrownDiagnostics } from "../../../shared/src/index.ts";

// ─── Cache ────────────────────────────────────────────────────────────────────

interface CacheEntry {
  origins: string[];
  expiresAt: number;
}

const CACHE_TTL_MS = 60_000; // 60 seconds
// Unknown/bogus tenant ids are negative-cached briefly so repeated requests
// carrying a random X-Steward-Tenant header don't each cost two DB queries.
const NEGATIVE_CACHE_TTL_MS = 10_000; // 10 seconds
const MAX_CORS_CACHE_ENTRIES = 1_000;
const TENANT_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const originsCache = new Map<string, CacheEntry>();

function cacheTenantOrigins(
  tenantId: string,
  origins: string[],
  ttlMs: number,
  now: number,
): void {
  if (originsCache.size >= MAX_CORS_CACHE_ENTRIES) {
    const oldest = originsCache.keys().next().value;
    if (oldest) originsCache.delete(oldest);
  }
  originsCache.set(tenantId, { origins, expiresAt: now + ttlMs });
}

async function getTenantOrigins(tenantId: string): Promise<string[]> {
  if (!TENANT_ID_RE.test(tenantId)) return [];

  const now = Date.now();
  const cached = originsCache.get(tenantId);
  if (cached && cached.expiresAt > now) return cached.origins;

  const db = getDb();
  const [row] = await db
    .select({ allowedOrigins: tenantConfigsTable.allowedOrigins })
    .from(tenantConfigsTable)
    .where(eq(tenantConfigsTable.tenantId, tenantId));

  const clientRows = await db
    .select({ allowedOrigins: tenantAppClientsTable.allowedOrigins })
    .from(tenantAppClientsTable)
    .where(
      and(
        eq(tenantAppClientsTable.tenantId, tenantId),
        eq(tenantAppClientsTable.enabled, true),
      ),
    );

  if (!row && clientRows.length === 0) {
    cacheTenantOrigins(tenantId, [], NEGATIVE_CACHE_TTL_MS, now);
    return [];
  }

  const origins = new Set<string>(row?.allowedOrigins ?? []);
  for (const client of clientRows) {
    for (const origin of client.allowedOrigins ?? []) origins.add(origin);
  }
  const originList = [...origins];
  cacheTenantOrigins(tenantId, originList, CACHE_TTL_MS, now);
  return originList;
}

/** Evict a tenant's origin list from cache (call after updating tenant config). */
export function invalidateTenantCorsCache(tenantId: string): void {
  originsCache.delete(tenantId);
  globalOriginsCache = null;
}

// ─── Global origin set (header-less requests) ────────────────────────────────
//
// Browsers NEVER send custom headers (X-Steward-Tenant) on CORS preflight
// OPTIONS requests, and several SDK flows (e.g. passkey login/options) carry
// the tenant in the BODY, not the header. Keying CORS exclusively off the
// header therefore breaks every real browser in production (no ACAO headers →
// "failed to fetch"). For requests without a tenant header we fall back to
// checking the Origin against the union of ALL tenants' allowed origins —
// the Origin is the actual security principal for CORS, the tenant header is
// only a routing hint.

interface GlobalOriginsCacheEntry {
  origins: Set<string>;
  expiresAt: number;
}

let globalOriginsCache: GlobalOriginsCacheEntry | null = null;

async function getAllAllowedOrigins(): Promise<Set<string>> {
  const now = Date.now();
  if (globalOriginsCache && globalOriginsCache.expiresAt > now) {
    return globalOriginsCache.origins;
  }

  const db = getDb();
  const tenantRows = await db
    .select({ allowedOrigins: tenantConfigsTable.allowedOrigins })
    .from(tenantConfigsTable);
  const clientRows = await db
    .select({ allowedOrigins: tenantAppClientsTable.allowedOrigins })
    .from(tenantAppClientsTable)
    .where(eq(tenantAppClientsTable.enabled, true));

  const origins = new Set<string>();
  for (const row of tenantRows) {
    for (const origin of row.allowedOrigins ?? []) origins.add(origin);
  }
  for (const row of clientRows) {
    for (const origin of row.allowedOrigins ?? []) origins.add(origin);
  }

  globalOriginsCache = { origins, expiresAt: now + CACHE_TTL_MS };
  return origins;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const ALLOW_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
const ALLOW_HEADERS =
  "Content-Type, X-Steward-Tenant, X-Steward-Key, X-Steward-Platform-Key, X-Steward-Signature, X-Steward-Signer-Id, X-Steward-Signer-Secret, X-Steward-Key-Quorum-Id, X-Steward-Key-Quorum-Credentials, X-Steward-Timestamp, X-Steward-Expires, X-Steward-Request-Timestamp, X-Steward-Request-Expires-At, Idempotency-Key, Authorization";
const EXPOSE_HEADERS = "Content-Length, X-Request-Id";
const MAX_AGE = "86400";

// ─── Middleware ───────────────────────────────────────────────────────────────

/**
 * The wildcard CORS fallback is a development-only convenience and requires an
 * explicit "development" or "test" environment. Unset, unknown, and production
 * environments all fail closed.
 */
function devWildcardAllowed(): boolean {
  const env = process.env.NODE_ENV;
  return env === "development" || env === "test";
}

export async function tenantCors(
  c: Context,
  next: Next,
): Promise<Response | undefined> {
  const origin = c.req.header("origin") ?? "";
  const tenantId = c.req.header("X-Steward-Tenant");
  const allowDevelopmentWildcard = devWildcardAllowed();

  // Set this before any lookup or early deny. A shared cache must never reuse
  // a 403/error produced for one origin or tenant hint for another request.
  // This is harmless for the explicit development wildcard and keeps every
  // exit path (including DB failures) on the same cache contract.
  c.header("Vary", "Origin, X-Steward-Tenant");

  let allowOrigin = allowDevelopmentWildcard ? "*" : "";

  if (!allowDevelopmentWildcard && !tenantId && origin) {
    // No tenant header (true for ALL browser preflights and any SDK call that
    // carries the tenant in the body). Allow the request iff the Origin is in
    // any tenant's allowlist.
    try {
      const allOrigins = await getAllAllowedOrigins();
      if (allOrigins.has(origin)) {
        allowOrigin = origin;
      } else {
        if (c.req.method === "OPTIONS") {
          return c.newResponse(null, 403);
        }
        await next();
        return;
      }
    } catch (err) {
      logger.warn(
        {
          details: [
            "[tenant-cors] Failed to load global origins, denying CORS",
            redactedThrownDiagnostics(err),
          ],
        },
        "[Login:tenant-cors] warn",
      );
      if (c.req.method === "OPTIONS") {
        return c.newResponse(null, 403);
      }
      await next();
      return;
    }
  } else if (!allowDevelopmentWildcard && tenantId && origin) {
    try {
      const origins = await getTenantOrigins(tenantId);
      if (origins.length > 0) {
        if (origins.includes(origin)) {
          // Exact match — echo back the request origin
          allowOrigin = origin;
        } else {
          // Origin not in the allowlist — block preflight, let main requests through
          // without CORS headers so the browser enforces the deny.
          if (c.req.method === "OPTIONS") {
            return c.newResponse(null, 403);
          }
          await next();
          return;
        }
      } else {
        if (c.req.method === "OPTIONS") {
          return c.newResponse(null, 403);
        }
        await next();
        return;
      }
    } catch (err) {
      logger.warn(
        {
          details: [
            "[tenant-cors] Failed to load origins for tenant, denying CORS",
            redactedThrownDiagnostics(err),
          ],
        },
        "[Login:tenant-cors] warn",
      );
      if (c.req.method === "OPTIONS") {
        return c.newResponse(null, 403);
      }
      await next();
      return;
    }
  }

  // Set CORS headers on the response context
  if (allowOrigin) {
    c.header("Access-Control-Allow-Origin", allowOrigin);
    c.header("Access-Control-Allow-Methods", ALLOW_METHODS);
    c.header("Access-Control-Allow-Headers", ALLOW_HEADERS);
    c.header("Access-Control-Expose-Headers", EXPOSE_HEADERS);
    c.header("Access-Control-Max-Age", MAX_AGE);
  }

  if (c.req.method === "OPTIONS") {
    return c.newResponse(null, 204);
  }

  await next();
}
