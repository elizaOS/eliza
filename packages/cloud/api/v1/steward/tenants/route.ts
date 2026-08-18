/**
 * POST /api/v1/steward/tenants
 *
 * Provisions a new Steward tenant for the authenticated user's organization.
 * Idempotent: if the org already has a Steward tenant, returns the existing ID.
 *
 * This endpoint is called automatically during organization setup when
 * Steward-backed auth is enabled for the organization. The actual
 * provisioning logic lives in `ensureStewardTenant` so it can also be invoked
 * from server-context flows (e.g. docker-sandbox creation) without going
 * through the HTTP boundary.
 *
 * Body: { organizationId: string; tenantName?: string }
 * Returns: { tenantId: string; isNew: boolean }
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { isStewardPlatformConfigured } from "@/lib/services/steward-platform-users";
import { ensureStewardTenant } from "@/lib/services/steward-tenant-config";
import { decodeRequestJson } from "@/lib/utils/json-parsing";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    const decodedRawBody = await decodeRequestJson(c.req);
    if (!decodedRawBody.ok) {
      // error-policy:J3 malformed JSON is invalid request input.
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const rawBody = decodedRawBody.value;
    if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
      return c.json({ error: "Invalid request body" }, 400);
    }
    const body = rawBody as {
      organizationId?: string;
      tenantName?: string;
    };
    if (!body.organizationId) {
      return c.json({ error: "organizationId is required" }, 400);
    }
    if (body.organizationId !== user.organization_id) {
      return c.json({ error: "Forbidden" }, 403);
    }

    if (!isStewardPlatformConfigured()) {
      logger.error("[steward-tenants] STEWARD_PLATFORM_KEYS not configured");
      return c.json({ error: "Steward not configured" }, 503);
    }

    const result = await ensureStewardTenant(body.organizationId, {
      tenantName: body.tenantName,
    });

    return c.json(
      { tenantId: result.tenantId, isNew: result.isNew },
      result.isNew ? 201 : 200,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      /^Organization .+ not found$/.test(error.message)
    ) {
      return c.json({ error: "Organization not found" }, 404);
    }
    if (
      error instanceof Error &&
      error.message.startsWith("Failed to provision Steward tenant")
    ) {
      logger.error("[steward-tenants] Failed to create Steward tenant", {
        error: error.message,
      });
      return c.json({ error: "Failed to provision Steward tenant" }, 502);
    }
    return failureResponse(c, error);
  }
});

export default app;
