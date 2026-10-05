/**
 * DELETE /api/v1/api-keys/[id] — delete a key (org-scoped).
 * PATCH  /api/v1/api-keys/[id] — partial update.
 * Mobile lifecycle credentials are not addressable through either operation.
 */

import { requireUserWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  RateLimitPresets,
  rateLimit,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import { apiKeysService } from "@elizaos/cloud-shared/lib/services/api-keys";
import { decodeRequestJson } from "@elizaos/cloud-shared/lib/utils/json-parsing";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { z } from "zod";
import { assertOrgMembership } from "@/api-app/middleware/org-membership";
import { createTransactionalAudit } from "@/api-app/services/audit-transactional";

import { updateApiKeySchema } from "../schemas";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

function isAgentSandboxKeyName(name: string): boolean {
  return name.startsWith("agent-sandbox:");
}

app.delete("/", async (c) => {
  try {
    const user = await requireUserWithOrg(c);
    const id = c.req.param("id");
    if (!id) return c.json({ error: "Missing id" }, 400);

    const existingKey = await apiKeysService.getManageableById(id);
    if (!existingKey) return c.json({ error: "API key not found" }, 404);
    await assertOrgMembership(user, existingKey.organization_id, {
      resourceType: "api_key",
      resourceId: id,
      c,
    });

    const audit = createTransactionalAudit();
    await apiKeysService.delete(id, async (tx) => {
      await audit.write(tx, {
        actor: { type: "user", id: user.id },
        action: "api_key.revoke",
        result: "success",
        resource: { type: "api_key", id },
        org_id: user.organization_id,
        request_id: c.get("requestId"),
        metadata: { key_id: id, reason: "user_delete" },
      });
    });
    await audit.publish();
    return c.json({ success: true });
  } catch (error) {
    logger.error("[API Keys] Error deleting API key", { error });
    return failureResponse(c, error);
  }
});

app.patch("/", async (c) => {
  try {
    const user = await requireUserWithOrg(c);
    const id = c.req.param("id");
    if (!id) return c.json({ error: "Missing id" }, 400);

    const existingKey = await apiKeysService.getManageableById(id);
    if (!existingKey) return c.json({ error: "API key not found" }, 404);
    await assertOrgMembership(user, existingKey.organization_id, {
      resourceType: "api_key",
      resourceId: id,
      c,
    });

    const decodedBody = await decodeRequestJson(c.req);
    if (!decodedBody.ok) {
      // error-policy:J3 malformed JSON is invalid request input.
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const body = decodedBody.value;
    const { name, description, rate_limit, is_active, expires_at } =
      updateApiKeySchema.parse(body);

    if (isAgentSandboxKeyName(existingKey.name)) {
      return c.json(
        {
          error:
            "Provisioner-managed API keys cannot be updated through user routes.",
        },
        403,
      );
    }

    if (name !== undefined && isAgentSandboxKeyName(name)) {
      return c.json(
        {
          error:
            "Name prefix 'agent-sandbox:' is reserved for provisioner-managed keys.",
        },
        400,
      );
    }

    const updatedKey = await apiKeysService.update(id, {
      ...(name !== undefined && { name }),
      ...(description !== undefined && { description }),
      ...(rate_limit !== undefined && { rate_limit }),
      ...(is_active !== undefined && { is_active }),
      ...(expires_at !== undefined && { expires_at }),
    });

    if (!updatedKey) return c.json({ error: "Failed to update API key" }, 500);

    return c.json({
      apiKey: {
        id: updatedKey.id,
        name: updatedKey.name,
        description: updatedKey.description,
        key_prefix: updatedKey.key_prefix,
        created_at: updatedKey.created_at,
        rate_limit: updatedKey.rate_limit,
        is_active: updatedKey.is_active,
        expires_at: updatedKey.expires_at,
      },
    });
  } catch (error) {
    logger.error("[API Keys] Error updating API key", { error });
    if (error instanceof z.ZodError) {
      return c.json({ error: "Validation error", details: error.issues }, 400);
    }
    return failureResponse(c, error);
  }
});

export default app;
