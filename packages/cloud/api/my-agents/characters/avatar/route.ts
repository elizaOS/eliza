/**
 * POST /api/my-agents/characters/avatar
 *
 * Uploads a character avatar image to R2. Returns a public URL for the client to store on the character.
 */

import { Hono } from "hono";
import { orgStorageQuotaRepository } from "@/db/repositories/org-storage-quota";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { putPublicObject } from "@/lib/storage/r2-public-object";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

function isFile(value: FormDataEntryValue | null): value is File {
  return (
    typeof value === "object" &&
    value !== null &&
    "arrayBuffer" in value &&
    "name" in value &&
    typeof (value as File).type === "string"
  );
}

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.post("/", async (c) => {
  try {
    const authed = await requireUserOrApiKeyWithOrg(c);
    const ct = c.req.header("content-type") ?? "";
    if (!ct.includes("multipart/form-data")) {
      return c.json(
        {
          success: false,
          error: "Expected multipart form data with file field",
        },
        400,
      );
    }

    const form = await c.req.formData();
    const entry = form.get("file");
    if (!isFile(entry)) {
      return c.json({ success: false, error: "Missing file" }, 400);
    }

    if (entry.size > MAX_BYTES) {
      return c.json({ success: false, error: "File too large (max 5MB)" }, 400);
    }

    const mime = entry.type || "application/octet-stream";
    if (!ALLOWED.has(mime)) {
      return c.json({ success: false, error: "Unsupported image type" }, 400);
    }

    const ext =
      mime === "image/jpeg"
        ? "jpg"
        : mime === "image/png"
          ? "png"
          : mime === "image/webp"
            ? "webp"
            : "gif";

    const key = `avatars/characters/${authed.organization_id}/${authed.id}/${crypto.randomUUID()}.${ext}`;
    const buf = await entry.arrayBuffer();
    const sizeBytes = BigInt(buf.byteLength);

    const reserved = await orgStorageQuotaRepository.tryReserveBytes(
      authed.organization_id,
      sizeBytes,
    );
    if (reserved === null) {
      return c.json(
        {
          success: false,
          error: "Storage quota exceeded for this organization",
        },
        413,
      );
    }

    let url: string;
    try {
      ({ url } = await putPublicObject(c.env, {
        key,
        body: buf,
        contentType: mime,
        customMetadata: {
          userId: authed.id,
          organizationId: authed.organization_id,
        },
      }));
    } catch (error) {
      // error-policy:J6 a rejected provider write is ambiguous, so confirm
      // object teardown before releasing quota and rethrowing the original error.
      try {
        await c.env.BLOB.delete(key);
      } catch {
        // error-policy:J6 retain the reservation when deletion cannot confirm
        // whether the rejected write committed, and preserve the put failure.
        logger.warn("[Character Avatar] Failed to delete ambiguous R2 upload", {
          organizationId: logger.redact.orgId(authed.organization_id),
          userId: logger.redact.userId(authed.id),
          reservedBytes: sizeBytes.toString(),
          stage: "r2_put_compensation",
          reason: "object_delete_failed",
        });
        throw error;
      }

      try {
        await orgStorageQuotaRepository.releaseBytes(
          authed.organization_id,
          sizeBytes,
        );
      } catch {
        // error-policy:J6 object deletion is confirmed, but a failed quota
        // release is logged without replacing the original put failure.
        logger.warn(
          "[Character Avatar] Failed to release quota after R2 upload cleanup",
          {
            organizationId: logger.redact.orgId(authed.organization_id),
            userId: logger.redact.userId(authed.id),
            reservedBytes: sizeBytes.toString(),
            stage: "r2_put_compensation",
            reason: "quota_release_failed",
          },
        );
      }
      throw error;
    }

    return c.json({ success: true, url });
  } catch (error) {
    // error-policy:J1 the route boundary translates authentication, quota,
    // and object-storage failures through the canonical API error response.
    return failureResponse(c, error);
  }
});

app.all("*", (c) =>
  c.json({ success: false, error: "Method not allowed" }, 405),
);

export default app;
