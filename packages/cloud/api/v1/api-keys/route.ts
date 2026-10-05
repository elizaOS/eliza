/**
 * GET /api/v1/api-keys — list user-managed keys for the authenticated organization,
 *   with the plan's API-key usage (`used`/`limit`/`remaining`).
 * POST /api/v1/api-keys — create a new key (returns plainKey once). Keys are free;
 *   their count is limited per plan (pay-as-you-go 5, Plus 10, Pro 25) and a
 *   create at the ceiling fails with 403 `api_key_limit_exceeded` (#22958).
 *
 * Mobile lifecycle credentials are deliberately absent. API key management
 * requires a session — API keys cannot manage other API keys.
 */

import { requireUserWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  RateLimitPresets,
  rateLimit,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import {
  ApiKeyLimitExceededError,
  apiKeysService,
} from "@elizaos/cloud-shared/lib/services/api-keys";
import { decodeRequestJson } from "@elizaos/cloud-shared/lib/utils/json-parsing";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { ElizaError } from "@elizaos/core";
import { Hono } from "hono";
import { z } from "zod";
import { createTransactionalAudit } from "@/api-app/services/audit-transactional";

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

async function readUsage(organizationId: string) {
  try {
    return {
      status: "available" as const,
      ...(await apiKeysService.getUsage(organizationId)),
    };
  } catch (error) {
    // error-policy:J4 an unavailable plan ceiling is reported as such; the
    // key list itself stays readable.
    if (
      error instanceof ElizaError &&
      (error.code === "RESOURCE_POLICY_UNAVAILABLE" ||
        error.code === "ORGANIZATION_POLICY_UNAVAILABLE")
    ) {
      return { status: "unavailable" as const, code: error.code };
    }
    throw error;
  }
}

app.get("/", async (c) => {
  try {
    const user = await requireUserWithOrg(c);
    const [keys, usage] = await Promise.all([
      apiKeysService.listByOrganization(user.organization_id),
      readUsage(user.organization_id),
    ]);
    return c.json({ keys: keys.map(toClientApiKey), usage });
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
    const decodedBody = await decodeRequestJson(c.req);
    if (!decodedBody.ok) {
      // error-policy:J3 malformed JSON is invalid request input.
      return c.json(
        {
          error: "Invalid JSON body",
          details: "Request body must be a valid JSON object",
        },
        400,
      );
    }
    const body = decodedBody.value;
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

    const audit = createTransactionalAudit();
    const { apiKey, plainKey, usage } = await apiKeysService.createUserManaged(
      {
        name,
        description,
        organization_id: user.organization_id,
        user_id: user.id,
        rate_limit,
        expires_at: expires_at ?? null,
        is_active: true,
      },
      async (tx, created) => {
        await audit.write(tx, {
          actor: { type: "user", id: user.id },
          action: "api_key.create",
          result: "success",
          resource: { type: "api_key", id: created.id },
          org_id: user.organization_id,
          request_id: c.get("requestId"),
          metadata: { key_id: created.id, name: created.name },
        });
      },
    );
    await audit.publish();

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
        usage,
      },
      201,
    );
  } catch (error) {
    if (error instanceof ApiKeyLimitExceededError) {
      return c.json(
        {
          success: false,
          error: `API key limit reached. Your plan allows ${error.limit} API keys; delete one or upgrade your plan to create another.`,
          code: "api_key_limit_exceeded" as const,
          details: { used: error.used, limit: error.limit, remaining: 0 },
        },
        403,
      );
    }
    logger.error("Error creating API key:", error);
    if (error instanceof z.ZodError) {
      return c.json({ error: "Validation error", details: error.issues }, 400);
    }
    return failureResponse(c, error);
  }
});

export default app;
