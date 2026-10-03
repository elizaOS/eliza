/**
 * tenantAuthMiddleware — X-Steward-Tenant + X-Steward-Key authentication.
 *
 * Mount this ONLY on the API router it is meant to protect (e.g. /v1/*),
 * never globally over an app that serves content at `/`: exact GET `/` and
 * GET `/health` requests bypass authentication for liveness probes.
 */

import { createMiddleware } from "hono/factory";
import { getDb, type Tenant } from "../../db/src/index.ts";
import type { ApiResponse } from "../../shared/src/index.ts";

import { hashApiKey, validateApiKey } from "./api-keys";
import type { AuthVariables } from "./types";

const HEALTHCHECK_PATHS = new Set(["/", "/health"]);

function isHealthcheckRequest(method: string, path: string): boolean {
  return method.toUpperCase() === "GET" && HEALTHCHECK_PATHS.has(path);
}

async function findTenantById(tenantId: string): Promise<Tenant | undefined> {
  const db = getDb();
  return db.query.tenants.findFirst({
    where: (tenant, { eq }) => eq(tenant.id, tenantId),
  });
}

// Compared against the presented key when the tenant id is unknown, so the
// failure path has the same shape (hash + timingSafeEqual) whether or not the
// tenant exists — response timing must not reveal valid tenant ids.
const UNKNOWN_TENANT_DUMMY_HASH = hashApiKey(
  "steward-unknown-tenant-dummy-key",
);

export function tenantAuthMiddleware() {
  return createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
    if (isHealthcheckRequest(c.req.method, c.req.path)) {
      await next();
      return;
    }

    const tenantId = c.req.header("X-Steward-Tenant");
    const apiKey = c.req.header("X-Steward-Key");

    if (!tenantId || !apiKey) {
      return c.json<ApiResponse>(
        { ok: false, error: "Missing authentication headers" },
        401,
      );
    }

    const tenant = await findTenantById(tenantId);

    // Always run the hash comparison, even for unknown tenant ids.
    const keyValid = validateApiKey(
      apiKey,
      tenant?.apiKeyHash ?? UNKNOWN_TENANT_DUMMY_HASH,
    );
    if (!tenant || !keyValid) {
      return c.json<ApiResponse>({ ok: false, error: "Invalid API key" }, 403);
    }

    c.set("tenantId", tenantId);
    c.set("tenant", tenant);

    await next();
  });
}
