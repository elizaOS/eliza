/**
 * Mints a short-lived signed URL for a single attachment object.
 *
 * Routes:
 *   POST /api/v1/apis/storage/presign  { key, operation, expiresIn? }
 *                                      → { url, expiresAt }
 *
 * Auth: requireUserOrApiKeyWithOrg.
 * Pricing: flat per-request charge against the `storage:presign` row.
 *
 * The URL is a direct R2 S3 signed URL — clients hit R2 directly with it,
 * NOT this proxy. Presign for `put` is supported but the signed URL bypasses
 * the proxy's quota enforcement; clients SHOULD prefer `PUT /objects/{key+}`
 * for writes that should count against the org quota.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { creditsService } from "@/lib/services/credits";
import { getServiceMethodCost } from "@/lib/services/proxy/pricing";
import { getR2StorageAdapter } from "@/lib/services/storage/r2-storage-adapter";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const STORAGE_SERVICE_ID = "storage";
const MAX_OBJECT_KEY_LENGTH = 1024;

const presignRequestSchema = z.object({
  key: z.string().min(1).max(MAX_OBJECT_KEY_LENGTH),
  operation: z.enum(["get", "put"]),
  expiresIn: z.number().int().min(60).max(3600).optional(),
});

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const { organization_id } = user;

    const adapter = getR2StorageAdapter(c.env);
    if (!adapter) {
      logger.error("[storage proxy] R2_* env vars not set; presign rejected");
      return c.json(
        { error: "Attachment storage proxy not available — server misconfigured" },
        503,
      );
    }

    const rawBody = await c.req.json().catch(() => null);
    const parsed = presignRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json({ error: "Invalid presign request", details: parsed.error.issues }, 400);
    }
    const { key: userKey, operation, expiresIn } = parsed.data;
    const trimmedKey = userKey.replace(/^\/+|\/+$/g, "");
    if (trimmedKey.length === 0 || trimmedKey.split("/").some((s) => s === "..")) {
      return c.json({ error: "Invalid object key" }, 400);
    }

    const cost = await getServiceMethodCost(STORAGE_SERVICE_ID, "presign");
    if (cost > 0) {
      const deductResult = await creditsService.deductCredits({
        organizationId: organization_id,
        amount: cost,
        description: `API proxy: storage — presign (${operation})`,
        metadata: {
          type: "proxy_storage",
          service: "storage",
          method: "presign",
          operation,
        },
      });
      if (!deductResult.success) {
        return c.json(
          {
            error: "Insufficient credits",
            topUpUrl: "https://www.elizacloud.ai/dashboard/billing",
          },
          402,
        );
      }
    }

    const ttlSeconds = expiresIn ?? 3600;
    const scopedKey = `org/${organization_id}/${trimmedKey}`;
    const url = await adapter.presign(scopedKey, ttlSeconds);
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

    return c.json({ url, expiresAt });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
