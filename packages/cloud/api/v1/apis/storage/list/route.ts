/**
 * Lists attachment objects under a prefix.
 *
 * Routes:
 *   GET /api/v1/apis/storage/list with X-Storage-Prefix and
 *       X-Storage-Recursive headers
 *       → { items: [{ key, size, contentType, modifiedAt }] }
 *
 * Auth: requireUserOrApiKeyWithOrg.
 * Pricing: one durable server-priced receipt per idempotent list request.
 *
 * Native R2 enumeration discovers and adopts legacy tenant-prefixed objects;
 * the catalog remains authoritative for immutable generations and tombstones.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { getServiceMethodCost } from "@/lib/services/proxy/pricing";
import {
  executeNativeStorageList,
  NativeStorageReadError,
} from "@/lib/services/storage/native-storage-read";
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

    if (c.req.query("prefix") !== undefined) {
      return c.json(
        {
          error: "List prefixes are not accepted in URLs; use X-Storage-Prefix",
        },
        400,
      );
    }
    const parsed = listQuerySchema.safeParse({
      prefix: c.req.header("X-Storage-Prefix") ?? "",
      recursive: c.req.header("X-Storage-Recursive") ?? "true",
    });
    if (!parsed.success) {
      return c.json(
        { error: "Invalid list query", details: parsed.error.issues },
        400,
      );
    }
    const { prefix, recursive } = parsed.data;

    const trimmedPrefix = prefix.replace(/^\/+|\/+$/g, "");
    const result = await executeNativeStorageList({
      bucket,
      organizationId: organization_id,
      userId: user.id,
      rawIdempotencyKey: c.req.header("Idempotency-Key") ?? "",
      priceUsd: await getServiceMethodCost("storage", "list"),
      prefix: trimmedPrefix,
      recursive,
      limit: MAX_LIST_RESULTS,
    });
    c.header("X-Storage-Receipt-Id", result.operation.id);
    return c.json(result.body);
  } catch (error) {
    if (error instanceof NativeStorageReadError) {
      if (error.code === "INSUFFICIENT_CREDITS") {
        return c.json(
          {
            error: "Insufficient credits",
            topUpUrl: "https://cloud.eliza.app/cloud/settings?tab=billing",
          },
          402,
        );
      }
      const status =
        error.code === "IDEMPOTENCY_REQUIRED" ||
        error.code === "IDEMPOTENCY_INVALID"
          ? 400
          : error.code === "IDEMPOTENCY_MISMATCH"
            ? 409
            : 503;
      return c.json({ error: error.message, code: error.code }, status);
    }
    // error-policy:J1 route boundary — every catch in v1/apis/* translates a thrown error into a structured HTTP failure via failureResponse (never a fabricated 200/empty).
    return failureResponse(c, error);
  }
});

export default app;
