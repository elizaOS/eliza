/**
 * POST /api/v1/api-keys/[id]/regenerate — invalidate the old key and emit a new one.
 */

import { Hono } from "hono";
import { requireApiKeyPermission } from "@/api-app/middleware/auth";
import { assertOrgMembership } from "@/api-app/middleware/org-membership";
import { getAuditDispatcher } from "@/api-app/services/audit-dispatcher-singleton";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { apiKeysService } from "@/lib/services/api-keys";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STRICT));
app.use("*", requireApiKeyPermission("keys:write"));

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id");
    if (!id) return c.json({ error: "Missing id" }, 400);

    const existingKey = await apiKeysService.getById(id);
    if (!existingKey) return c.json({ error: "API key not found" }, 404);
    await assertOrgMembership(user, existingKey.organization_id, {
      resourceType: "api_key",
      resourceId: id,
      c,
    });

    // D-1: plaintext is no longer stored in a `key` column. We mint a new
    // key, hash it, and persist the encrypted ciphertext + new hash/prefix.
    const {
      key: newKey,
      hash: newHash,
      prefix: newPrefix,
    } = apiKeysService.generateApiKey();

    const { encryptApiKey } = await import(
      "@elizaos/cloud-shared/db/crypto/api-keys"
    );
    const encrypted = await encryptApiKey(
      existingKey.organization_id,
      existingKey.id,
      newKey,
    );

    const updatedKey = await apiKeysService.update(id, {
      key_hash: newHash,
      key_prefix: newPrefix,
      key_ciphertext: encrypted.ciphertext,
      key_nonce: encrypted.nonce,
      key_auth_tag: encrypted.auth_tag,
      key_kms_key_id: encrypted.kms_key_id,
      key_kms_key_version: encrypted.kms_key_version,
      updated_at: new Date(),
    });
    if (!updatedKey)
      return c.json({ error: "Failed to regenerate API key" }, 500);

    await getAuditDispatcher()
      .emit({
        actor: { type: "user", id: user.id },
        action: "api_key.rotate",
        result: "success",
        resource: { type: "api_key", id },
        org_id: user.organization_id,
        request_id: c.get("requestId"),
        metadata: { key_id: id, reason: "user_regenerate" },
      })
      .catch((err: unknown) => {
        logger.warn("[API Keys] rotate audit emit failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });

    return c.json({
      apiKey: {
        id: updatedKey.id,
        name: updatedKey.name,
        description: updatedKey.description,
        key_prefix: updatedKey.key_prefix,
        created_at: updatedKey.created_at,
        permissions: updatedKey.permissions,
        rate_limit: updatedKey.rate_limit,
        expires_at: updatedKey.expires_at,
      },
      plainKey: newKey,
    });
  } catch (error) {
    logger.error("Error regenerating API key:", error);
    return failureResponse(c, error);
  }
});

export default app;
