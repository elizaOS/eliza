/**
 * GET /api/v1/api-keys — list keys for the authenticated user's organization.
 * POST /api/v1/api-keys — create a new key (returns plainKey once).
 *
 * API key management requires a session — API keys cannot manage other API keys.
 */

import { Hono } from "hono";
import { z } from "zod";
import { getAuditDispatcher } from "@/api-app/services/audit-dispatcher-singleton";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { apiKeysService } from "@/lib/services/api-keys";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

import { createApiKeySchema } from "./schemas";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

function isAgentSandboxKeyName(name: string): boolean {
  return name.startsWith("agent-sandbox:");
}

function toClientApiKey(
  apiKey: Awaited<ReturnType<typeof apiKeysService.listByOrganization>>[number],
) {
  return {
    id: apiKey.id,
    name: apiKey.name,
    description: apiKey.description,
    key_prefix: apiKey.key_prefix,
    rate_limit: apiKey.rate_limit,
    is_active: apiKey.is_active,
    usage_count: apiKey.usage_count,
    last_used_at: apiKey.last_used_at,
    created_at: apiKey.created_at,
    expires_at: apiKey.expires_at,
  };
}

app.get("/", async (c) => {
  try {
    const user = await requireUserWithOrg(c);
    const keys = await apiKeysService.listByOrganization(user.organization_id);
    return c.json({ keys: keys.map(toClientApiKey) });
  } catch (error) {
    // error-policy:J1 route boundary — every catch in v1/api-keys/* translates a thrown error into a structured HTTP failure via failureResponse (never a fabricated 200/empty key list).
    logger.error("Error fetching API keys:", error);
    return failureResponse(c, error);
  }
});

app.post("/", async (c) => {
  try {
    const user = await requireUserWithOrg(c);
    // Guard a malformed/empty body to a 400 instead of a 500 — the ZodError
    // branch in the catch only handles bad FIELDS, not an unparseable body.
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return c.json(
        {
          error: "Invalid JSON body",
          details: "Request body must be a valid JSON object",
        },
        400,
      );
    }
    const { name, description, rate_limit, expires_at } =
      createApiKeySchema.parse(body);

    if (isAgentSandboxKeyName(name)) {
      return c.json(
        {
          error:
            "Name prefix 'agent-sandbox:' is reserved for provisioner-managed keys.",
        },
        400,
      );
    }

    const { apiKey, plainKey } = await apiKeysService.create({
      name,
      description,
      organization_id: user.organization_id,
      user_id: user.id,
      rate_limit,
      expires_at: expires_at ?? null,
      is_active: true,
    });

    await getAuditDispatcher()
      .emit({
        actor: { type: "user", id: user.id },
        action: "api_key.create",
        result: "success",
        resource: { type: "api_key", id: apiKey.id },
        org_id: user.organization_id,
        request_id: c.get("requestId"),
        metadata: {
          key_id: apiKey.id,
          name: apiKey.name,
        },
      })
      .catch((err: unknown) => {
        // error-policy:J7 audit-log emit is best-effort telemetry; a failed emit must not fail an already-created key. Observed via this warn.
        logger.warn("[API Keys] create audit emit failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });

    return c.json(
      {
        apiKey: {
          id: apiKey.id,
          name: apiKey.name,
          description: apiKey.description,
          key_prefix: apiKey.key_prefix,
          created_at: apiKey.created_at,
          rate_limit: apiKey.rate_limit,
          expires_at: apiKey.expires_at,
        },
        plainKey,
      },
      201,
    );
  } catch (error) {
    logger.error("Error creating API key:", error);
    if (error instanceof z.ZodError) {
      return c.json({ error: "Validation error", details: error.issues }, 400);
    }
    return failureResponse(c, error);
  }
});

export default app;
