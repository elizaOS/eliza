/**
 * GET /api/v1/steward/tenants/credentials
 *
 * Returns Steward tenant credentials for the authenticated user's org.
 * Called by the desktop agent after cloud login to configure Steward locally.
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { dbWrite } from "@elizaos/cloud-shared/db/helpers";
import { organizations } from "@elizaos/cloud-shared/db/schemas/organizations";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { resolveServerStewardApiUrlFromEnv } from "@elizaos/cloud-shared/lib/steward-url";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { eq } from "drizzle-orm";
import { Hono } from "hono";

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
      return c.json(
        { error: "Steward not provisioned for this organization" },
        404,
      );
    }

    const stewardApiUrl = resolveServerStewardApiUrlFromEnv(
      c.env,
      new URL(c.req.url).origin,
    );

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
