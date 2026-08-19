/**
 * Mints a short-lived signed URL for a single attachment object.
 *
 * Routes:
 *   POST /api/v1/apis/storage/presign  { key, operation: "get", expiresIn? }
 *                                      → { url, expiresAt }
 *
 * Auth: requireUserOrApiKeyWithOrg.
 * Pricing: flat per-request charge against the `storage:presign` row.
 *
 * The URL grants direct, temporary GET access to the catalog's exact provider
 * generation through the R2 S3 endpoint. Writes continue through the object
 * route so organization quota and generation authority remain server-owned.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { creditsService } from "@/lib/services/credits";
import { getServiceMethodCost } from "@/lib/services/proxy/pricing";
import { resolveNativeStorageObject } from "@/lib/services/storage/native-storage-put";
import { getR2StorageAdapter } from "@/lib/services/storage/r2-storage-adapter";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const STORAGE_SERVICE_ID = "storage";
const MAX_OBJECT_KEY_LENGTH = 1024;

const presignRequestSchema = z.object({
  key: z.string().min(1).max(MAX_OBJECT_KEY_LENGTH),
  operation: z.literal("get"),
  expiresIn: z.number().int().min(60).max(3600).optional(),
});

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const { organization_id } = user;

    const rawBody = await c.req.json().catch(() => {
      // error-policy:J3 malformed JSON remains an explicit invalid request.
      return null;
    });
    const parsed = presignRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid presign request", details: parsed.error.issues },
        400,
      );
    }
    const { key: userKey, operation, expiresIn } = parsed.data;
    const trimmedKey = userKey.replace(/^\/+|\/+$/g, "");
    if (
      trimmedKey.length === 0 ||
      trimmedKey.split("/").some((s) => s === "..")
    ) {
      return c.json({ error: "Invalid object key" }, 400);
    }

    if (!c.env.BLOB) {
      return c.json(
        {
          error:
            "Attachment storage proxy not available — server misconfigured",
        },
        503,
      );
    }
    const object = await resolveNativeStorageObject(
      c.env.BLOB,
      organization_id,
      trimmedKey,
    );
    if (!object?.provider_key || object.deleted_at) {
      return c.json({ error: "Object not found" }, 404);
    }
    const adapter = getR2StorageAdapter(c.env);
    if (!adapter) {
      logger.error("[storage proxy] R2_* env vars not set; presign rejected");
      return c.json(
        {
          error:
            "Attachment storage proxy not available — server misconfigured",
        },
        503,
      );
    }

    const ttlSeconds = expiresIn ?? 3600;
    const url = await adapter.presignGet(object.provider_key, ttlSeconds);

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
            topUpUrl: "https://cloud.eliza.app/cloud/settings?tab=billing",
          },
          402,
        );
      }
    }

    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

    return c.json({ url, expiresAt });
  } catch (error) {
    // error-policy:J1 the route boundary translates authentication, pricing,
    // debit, configuration, and signing failures into the canonical response.
    return failureResponse(c, error);
  }
});

export default app;
