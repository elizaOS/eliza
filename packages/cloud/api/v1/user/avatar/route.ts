/**
 * POST /api/v1/user/avatar
 *
 * Uploads a user profile image to R2 and updates `users.avatar`.
 */

import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { readRequestWithinMultipartBudget } from "@/api/_lib/multipart-body-budget";
import { dbWrite } from "@/db/helpers";
import { orgStorageQuotaRepository } from "@/db/repositories/org-storage-quota";
import { users } from "@/db/schemas/users";
import { failureResponse, NotFoundError } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { putPublicObject } from "@/lib/storage/r2-public-object";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const MAX_BYTES = 5 * 1024 * 1024;
// The multipart envelope — boundaries, part headers, any additional fields —
// riding on top of the file this route accepts. Derived from MAX_BYTES so the
// two cannot drift, and generous by design: this budget exists to bound the
// isolate, not to police framing overhead.
const MULTIPART_ENVELOPE_HEADROOM_BYTES = 1024 * 1024;
const MAX_MULTIPART_BODY_BYTES = MAX_BYTES + MULTIPART_ENVELOPE_HEADROOM_BYTES;
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

    // Charge the byte budget before the body is parsed. `formData()` parses
    // AND materializes every part, so the `entry.size > MAX_BYTES` check below
    // used to run only once the bytes it exists to refuse were already
    // resident — and this handler's catch cannot give a completed allocation
    // back on a Cloudflare isolate (see @/api/_lib/multipart-body-budget).
    const budgeted = await readRequestWithinMultipartBudget(
      c.req.raw,
      MAX_MULTIPART_BODY_BYTES,
      (reason, cancelError) => {
        // error-policy:J6 best-effort teardown for an upload already rejected.
        logger.warn("[User Avatar] Failed to cancel upload body", {
          errorType:
            cancelError instanceof Error ? cancelError.name : "unknown",
          reason,
        });
      },
    );
    if (!budgeted.ok) {
      if (budgeted.outcome === "incomplete") {
        // error-policy:J4 a body that was aborted or never completed is a
        // visibly distinct client-side failure, not an internal error.
        logger.warn("[User Avatar] Multipart body read did not complete", {
          reason: budgeted.reason,
          errorType:
            budgeted.error instanceof Error ? budgeted.error.name : "unknown",
        });
        return c.json(
          { success: false, error: "Upload body could not be read" },
          408,
        );
      }
      return c.json(
        {
          success: false,
          error: `Upload exceeds the ${MAX_MULTIPART_BODY_BYTES} byte request limit (${budgeted.bytes})`,
        },
        413,
      );
    }

    const form = await budgeted.request.formData();
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

    const key = `avatars/users/${authed.organization_id}/${authed.id}/${crypto.randomUUID()}.${ext}`;
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
        logger.warn("[User Avatar] Failed to delete ambiguous R2 upload", {
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
          "[User Avatar] Failed to release quota after R2 upload cleanup",
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

    const cleanupDefinitivePersistenceMiss = async (): Promise<void> => {
      try {
        await c.env.BLOB.delete(key);
      } catch {
        // error-policy:J6 retain the reservation when object deletion fails;
        // the caller preserves the canonical not-found persistence result.
        logger.warn(
          "[User Avatar] Failed to delete R2 object after definitive persistence miss",
          {
            organizationId: logger.redact.orgId(authed.organization_id),
            userId: logger.redact.userId(authed.id),
            reservedBytes: sizeBytes.toString(),
            stage: "avatar_persistence_compensation",
            reason: "object_delete_failed",
          },
        );
        return;
      }

      try {
        await orgStorageQuotaRepository.releaseBytes(
          authed.organization_id,
          sizeBytes,
        );
      } catch {
        // error-policy:J6 the object is gone, but a failed quota release is
        // logged without replacing the canonical not-found persistence result.
        logger.warn(
          "[User Avatar] Failed to release quota after definitive persistence miss",
          {
            organizationId: logger.redact.orgId(authed.organization_id),
            userId: logger.redact.userId(authed.id),
            reservedBytes: sizeBytes.toString(),
            stage: "avatar_persistence_compensation",
            reason: "quota_release_failed",
          },
        );
      }
    };

    let updateRowCount: number | undefined;
    try {
      const updated = await dbWrite
        .update(users)
        .set({ avatar: url })
        .where(
          and(
            eq(users.id, authed.id),
            eq(users.organization_id, authed.organization_id),
          ),
        )
        .returning({ id: users.id });
      updateRowCount = updated.length;
    } catch (updateError) {
      // error-policy:J1 an UPDATE rejection has an ambiguous acknowledgement;
      // primary readback decides whether the HTTP boundary can report success.
      let persistedUser: { avatar: string | null } | undefined;
      try {
        persistedUser = await dbWrite.query.users.findFirst({
          columns: { avatar: true },
          where: and(
            eq(users.id, authed.id),
            eq(users.organization_id, authed.organization_id),
          ),
        });
      } catch {
        // error-policy:J1 an unavailable primary readback cannot disprove a
        // late commit, so retain storage accounting and rethrow the UPDATE error.
        logger.warn(
          "[User Avatar] Avatar update acknowledgement readback failed",
          {
            organizationId: logger.redact.orgId(authed.organization_id),
            userId: logger.redact.userId(authed.id),
            reservedBytes: sizeBytes.toString(),
            stage: "avatar_persistence_ack_readback",
            reason: "readback_failed",
          },
        );
        throw updateError;
      }

      if (persistedUser?.avatar !== url) {
        logger.warn(
          "[User Avatar] Avatar update was not confirmed by readback",
          {
            organizationId: logger.redact.orgId(authed.organization_id),
            userId: logger.redact.userId(authed.id),
            reservedBytes: sizeBytes.toString(),
            stage: "avatar_persistence_ack_readback",
            reason: "avatar_not_confirmed",
          },
        );
        throw updateError;
      }
    }

    if (updateRowCount !== undefined && updateRowCount !== 1) {
      await cleanupDefinitivePersistenceMiss();
      throw NotFoundError("User not found");
    }

    return c.json({
      success: true,
      avatarUrl: url,
      message: "Avatar uploaded successfully",
    });
  } catch (error) {
    // error-policy:J1 the route boundary translates authentication, quota,
    // object-storage, and persistence failures through the canonical response.
    return failureResponse(c, error);
  }
});

app.all("*", (c) =>
  c.json({ success: false, error: "Method not allowed" }, 405),
);

export default app;
