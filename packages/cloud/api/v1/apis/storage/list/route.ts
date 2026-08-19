/**
 * Lists attachment objects under a prefix.
 *
 * Routes:
 *   GET /api/v1/apis/storage/list?prefix=...&recursive=true|false
 *       → { items: [{ key, size, contentType, modifiedAt }] }
 *
 * Auth: requireUserOrApiKeyWithOrg.
 * Pricing: explicitly unbilled until durable paid-list receipts are available.
 *
 * Native R2 enumeration discovers and adopts legacy tenant-prefixed objects;
 * the catalog remains authoritative for immutable generations and tombstones.
 */

import { Hono } from "hono";
import { z } from "zod";
import { orgStorageMutationsRepository } from "@/db/repositories";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { ensureNativeStorageQuotaReconciled } from "@/lib/services/storage/native-storage-put";
import type { AppEnv } from "@/types/cloud-worker-env";

const MAX_LIST_RESULTS = 1000;

const listQuerySchema = z.object({
  prefix: z.string().max(1024).optional().default(""),
  recursive: z
    .enum(["true", "false"])
    .optional()
    .default("true")
    .transform((v) => v === "true"),
});

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const { organization_id } = user;

    const bucket = c.env.BLOB;
    if (!bucket?.list) {
      return c.json(
        {
          error:
            "Attachment storage proxy not available — server misconfigured",
        },
        503,
      );
    }

    const parsed = listQuerySchema.safeParse({
      prefix: c.req.query("prefix") ?? "",
      recursive: c.req.query("recursive") ?? "true",
    });
    if (!parsed.success) {
      return c.json(
        { error: "Invalid list query", details: parsed.error.issues },
        400,
      );
    }
    const { prefix, recursive } = parsed.data;

    const trimmedPrefix = prefix.replace(/^\/+|\/+$/g, "");
    await ensureNativeStorageQuotaReconciled(bucket, organization_id);

    const catalog = await orgStorageMutationsRepository.listObjects(
      organization_id,
      trimmedPrefix,
      MAX_LIST_RESULTS + 1,
      recursive,
    );
    const items = catalog.slice(0, MAX_LIST_RESULTS).map((object) => {
      if (!object.content_type || !object.uploaded_at) {
        throw new Error("[storage list] catalog object metadata is incomplete");
      }
      return {
        key: object.logical_key,
        size: Number(object.size_bytes),
        contentType: object.content_type,
        modifiedAt: object.uploaded_at.toISOString(),
      };
    });

    return c.json({
      items,
      truncated: catalog.length > MAX_LIST_RESULTS,
    });
  } catch (error) {
    // error-policy:J1 route boundary — every catch in v1/apis/* translates a thrown error into a structured HTTP failure via failureResponse (never a fabricated 200/empty).
    return failureResponse(c, error);
  }
});

export default app;
