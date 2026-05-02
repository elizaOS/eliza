import { getDb, type Tenant } from "@stwd/db";
import type { ApiResponse } from "@stwd/shared";
import { createMiddleware } from "hono/factory";

import { validateApiKey } from "./api-keys";
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

export function tenantAuthMiddleware() {
  return createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
    if (isHealthcheckRequest(c.req.method, c.req.path)) {
      await next();
      return;
    }

    const tenantId = c.req.header("X-Steward-Tenant");
    const apiKey = c.req.header("X-Steward-Key");

    if (!tenantId || !apiKey) {
      return c.json<ApiResponse>({ ok: false, error: "Missing authentication headers" }, 401);
    }

    const tenant = await findTenantById(tenantId);

    if (!tenant || !validateApiKey(apiKey, tenant.apiKeyHash)) {
      return c.json<ApiResponse>({ ok: false, error: "Invalid API key" }, 403);
    }

    c.set("tenantId", tenantId);
    c.set("tenant", tenant);

    await next();
  });
}

export function dashboardAuthMiddleware() {
  return createMiddleware(async (c) => {
    return c.json<ApiResponse>({ ok: false, error: "Dashboard auth not implemented" }, 501);
  });
}
