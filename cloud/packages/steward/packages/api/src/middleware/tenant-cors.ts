/**
 * tenant-cors.ts — Per-tenant dynamic CORS middleware
 *
 * Replaces the global `cors({ origin: "*" })` setup with a middleware that:
 *  - Reads the tenant from the X-Steward-Tenant header
 *  - Looks up that tenant's allowed_origins from tenant_configs
 *  - Validates the request Origin against the list
 *  - Falls back to wildcard (*) for tenants with no configured origins (dev mode)
 *  - Caches origin lists in memory with a 60 s TTL to avoid per-request DB hits
 *
 * Usage in index.ts:
 *   import { tenantCors } from "./middleware/tenant-cors";
 *   app.use("*", tenantCors);
 */

import { getDb, tenantConfigs as tenantConfigsTable } from "@stwd/db";
import { eq } from "drizzle-orm";
import type { Context, Next } from "hono";

// ─── Cache ────────────────────────────────────────────────────────────────────

interface CacheEntry {
  origins: string[];
  expiresAt: number;
}

const CACHE_TTL_MS = 60_000; // 60 seconds
const originsCache = new Map<string, CacheEntry>();

async function getTenantOrigins(tenantId: string): Promise<string[]> {
  const now = Date.now();
  const cached = originsCache.get(tenantId);
  if (cached && cached.expiresAt > now) return cached.origins;

  const db = getDb();
  const [row] = await db
    .select({ allowedOrigins: tenantConfigsTable.allowedOrigins })
    .from(tenantConfigsTable)
    .where(eq(tenantConfigsTable.tenantId, tenantId));

  const origins: string[] = row?.allowedOrigins ?? [];
  originsCache.set(tenantId, { origins, expiresAt: now + CACHE_TTL_MS });
  return origins;
}

/** Evict a tenant's origin list from cache (call after updating tenant config). */
export function invalidateTenantCorsCache(tenantId: string): void {
  originsCache.delete(tenantId);
}

// ─── Constants ────────────────────────────────────────────────────────────────

const ALLOW_METHODS = "GET, POST, PUT, DELETE, OPTIONS";
const ALLOW_HEADERS =
  "Content-Type, X-Steward-Tenant, X-Steward-Key, X-Steward-Platform-Key, Authorization";
const EXPOSE_HEADERS = "Content-Length, X-Request-Id";
const MAX_AGE = "86400";

// ─── Middleware ───────────────────────────────────────────────────────────────

export async function tenantCors(c: Context, next: Next): Promise<Response | undefined> {
  const origin = c.req.header("origin") ?? "";
  const tenantId = c.req.header("X-Steward-Tenant");

  let allowOrigin = "*";

  if (tenantId && origin) {
    try {
      const origins = await getTenantOrigins(tenantId);
      if (origins.length > 0) {
        if (origins.includes("*") || origins.includes(origin)) {
          // Exact match or explicit wildcard — echo back the request origin
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
      }
      // origins.length === 0 → no config yet → fall through to wildcard
    } catch (err) {
      console.warn("[tenant-cors] Failed to load origins for tenant, falling back to *:", err);
    }
  }

  // Set CORS headers on the response context
  c.header("Access-Control-Allow-Origin", allowOrigin);
  c.header("Access-Control-Allow-Methods", ALLOW_METHODS);
  c.header("Access-Control-Allow-Headers", ALLOW_HEADERS);
  c.header("Access-Control-Expose-Headers", EXPOSE_HEADERS);
  c.header("Access-Control-Max-Age", MAX_AGE);

  if (allowOrigin !== "*") {
    // Let caches vary on Origin when we're doing selective allow
    c.header("Vary", "Origin");
  }

  if (c.req.method === "OPTIONS") {
    return c.newResponse(null, 204);
  }

  await next();
}
