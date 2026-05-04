/**
 * GET /api/v1/steward/tenants/credentials
 *
 * Returns Steward tenant credentials for the authenticated user's org.
 * Called by the desktop agent after cloud login to configure Steward locally.
 */

import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { resolveServerStewardApiUrlFromEnv } from "@/lib/steward-url";
import { logger } from "@/lib/utils/logger";
import { dbWrite } from "@/packages/db/helpers";
import { organizations } from "@/packages/db/schemas/organizations";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    const [org] = await dbWrite
      .select({
        id: organizations.id,
        stewardTenantId: organizations.steward_tenant_id,
        stewardTenantApiKey: organizations.steward_tenant_api_key,
      })
      .from(organizations)
      .where(eq(organizations.id, user.organization_id))
      .limit(1);

    if (!org) {
      return c.json({ error: "Organization not found" }, 404);
    }

    if (!org.stewardTenantId) {
      return c.json({ error: "Steward not provisioned for this organization" }, 404);
    }

    const stewardApiUrl = resolveServerStewardApiUrlFromEnv(c.env, new URL(c.req.url).origin);

    return c.json({
      tenantId: org.stewardTenantId,
      apiKey: org.stewardTenantApiKey ?? "",
      stewardApiUrl,
    });
  } catch (error) {
    logger.error("[steward-credentials] Unexpected error", { error });
    return failureResponse(c, error);
  }
});

export default app;
