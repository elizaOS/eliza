/**
 * Mints a short-lived signed URL for a single attachment object.
 *
 * Routes:
 *   POST /api/v1/apis/storage/presign  { key, operation: "get", expiresIn? }
 *                                      → { url, expiresAt, receiptId }
 *
 * Auth: requireUserOrApiKeyWithOrg.
 * Pricing: flat per-request charge against the `storage:presign` row.
 *
 * The URL grants temporary GET/HEAD access through the Worker blob host. Paid
 * requests use a durable idempotency receipt so a retry after response loss can
 * recover the original capability without charging twice. Writes continue
 * through `PUT /objects/{key+}` so quota enforcement remains authoritative.
 */

import { Hono } from "hono";
import { z } from "zod";
import {
  mintStorageReadCapabilityUrl,
  normalizeStorageReadCapabilityHost,
  StorageReadCapabilityConfigurationError,
} from "@/api-app/storage-read-capability";
import { failureResponse, jsonError } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { getServiceMethodCost } from "@/lib/services/proxy/pricing";
import {
  StorageReadReceiptConflictError,
  StorageReadReceiptInsufficientCreditsError,
  StorageReadReceiptInvalidIdempotencyKeyError,
  type StorageReadReceiptTemporalClaims,
  StorageReadReceiptUnavailableError,
  storageReadReceiptService,
} from "@/lib/services/storage-read-receipts";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const STORAGE_SERVICE_ID = "storage";
const MAX_USER_OBJECT_KEY_CHARACTERS = 1024;
const MAX_SCOPED_OBJECT_KEY_BYTES = 1024;
const UTF8_ENCODER = new TextEncoder();

const presignRequestSchema = z.object({
  key: z.string().min(1).max(MAX_USER_OBJECT_KEY_CHARACTERS),
  operation: z.literal("get"),
  expiresIn: z.number().int().min(60).max(3600).optional(),
});

const app = new Hono<AppEnv>();

interface HeadCapableR2Bucket {
  head(key: string): Promise<unknown | null>;
}

function supportsHead(
  bucket: AppEnv["Bindings"]["BLOB"],
): bucket is AppEnv["Bindings"]["BLOB"] & HeadCapableR2Bucket {
  return typeof Reflect.get(bucket, "head") === "function";
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}

function temporalClaimsMatch(
  left: StorageReadReceiptTemporalClaims,
  right: StorageReadReceiptTemporalClaims,
): boolean {
  return (
    left.issuedAt === right.issuedAt &&
    left.expiresAt === right.expiresAt &&
    left.capabilityHost === right.capabilityHost
  );
}

async function mintCapability(
  env: AppEnv["Bindings"],
  scopedKey: string,
  claims: StorageReadReceiptTemporalClaims,
): Promise<string> {
  return await mintStorageReadCapabilityUrl({
    rawSecrets: env.STORAGE_READ_SIGNING_SECRETS,
    host: claims.capabilityHost,
    scopedKey,
    issuedAt: claims.issuedAt,
    expiresAt: claims.expiresAt,
  });
}

function expiresAtIso(claims: StorageReadReceiptTemporalClaims): string {
  return new Date(claims.expiresAt * 1000).toISOString();
}

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
    const { key: userKey, expiresIn } = parsed.data;
    const trimmedKey = userKey.replace(/^\/+|\/+$/g, "");
    const keySegments = trimmedKey.split("/");
    const scopedKey = `org/${organization_id}/${trimmedKey}`;
    if (
      trimmedKey.length === 0 ||
      UTF8_ENCODER.encode(scopedKey).byteLength > MAX_SCOPED_OBJECT_KEY_BYTES ||
      hasControlCharacter(trimmedKey) ||
      keySegments.some(
        (segment) =>
          segment.length === 0 || segment === "." || segment === "..",
      )
    ) {
      return c.json({ error: "Invalid object key" }, 400);
    }

    const rawBlobHost = c.env.R2_PUBLIC_HOST;
    let blobHost: string;
    try {
      if (typeof rawBlobHost !== "string" || rawBlobHost.trim().length === 0) {
        throw new StorageReadCapabilityConfigurationError(
          "invalid_host",
          "Storage read capability host is not configured",
        );
      }
      blobHost = normalizeStorageReadCapabilityHost(rawBlobHost);
    } catch (error) {
      if (error instanceof StorageReadCapabilityConfigurationError) {
        // error-policy:J2 private capability routing must use one explicit,
        // canonical host shared by minting and serving. Fail before R2 or billing.
        logger.error(
          "[storage proxy] Signed read capability configuration unavailable",
        );
        return c.json(
          {
            error:
              "Attachment storage proxy not available — server misconfigured",
          },
          503,
        );
      }
      throw error;
    }

    const ttlSeconds = expiresIn ?? 3600;
    const prepared = await storageReadReceiptService.prepare({
      rawIdempotencyKey: c.req.header("Idempotency-Key"),
      organizationId: organization_id,
      scopedKey,
      ttlSeconds,
      capabilityHost: blobHost,
    });

    if (prepared.status === "replay") {
      const url = await mintCapability(c.env, scopedKey, prepared.claims);
      return c.json({
        url,
        expiresAt: expiresAtIso(prepared.claims),
        receiptId: prepared.transactionId,
      });
    }

    if (!supportsHead(c.env.BLOB)) {
      logger.error(
        "[storage proxy] Native R2 HEAD capability unavailable; signed read rejected",
      );
      return c.json(
        {
          error:
            "Attachment storage proxy not available — server misconfigured",
        },
        503,
      );
    }

    const object = await c.env.BLOB.head(scopedKey);
    if (!object) {
      return c.json({ error: "Object not found" }, 404);
    }

    const cost = await getServiceMethodCost(STORAGE_SERVICE_ID, "presign");
    if (!Number.isFinite(cost) || cost < 0) {
      logger.error("[storage proxy] Storage presign pricing unavailable");
      return jsonError(
        c,
        503,
        "Attachment storage pricing is temporarily unavailable",
        "service_unavailable",
      );
    }

    const candidateUrl = await mintCapability(
      c.env,
      scopedKey,
      prepared.candidateClaims,
    );

    if (cost === 0) {
      return c.json({
        url: candidateUrl,
        expiresAt: expiresAtIso(prepared.candidateClaims),
        receiptId: null,
      });
    }

    const receipt = await storageReadReceiptService.chargeOrReplay(prepared, {
      chargeAmountUsd: cost,
    });
    const url = temporalClaimsMatch(prepared.candidateClaims, receipt.claims)
      ? candidateUrl
      : await mintCapability(c.env, scopedKey, receipt.claims);

    return c.json({
      url,
      expiresAt: expiresAtIso(receipt.claims),
      receiptId: receipt.transactionId,
    });
  } catch (error) {
    if (error instanceof StorageReadReceiptInvalidIdempotencyKeyError) {
      return jsonError(
        c,
        400,
        "A valid Idempotency-Key header is required",
        "validation_error",
      );
    }
    if (error instanceof StorageReadReceiptConflictError) {
      if (error.reason === "receipt_expired") {
        return jsonError(
          c,
          409,
          "Storage read receipt expired; retry with a new idempotency key",
          "billing_state_conflict",
          error.transactionId ? { receiptId: error.transactionId } : undefined,
        );
      }
      return jsonError(
        c,
        409,
        "Idempotency key was already used for a different storage read request",
        "billing_state_conflict",
      );
    }
    if (error instanceof StorageReadReceiptInsufficientCreditsError) {
      return c.json(
        {
          error: "Insufficient credits",
          topUpUrl: "https://cloud.eliza.app/cloud/settings?tab=billing",
        },
        402,
      );
    }
    if (error instanceof StorageReadReceiptUnavailableError) {
      // error-policy:J2 a missing or corrupt durable receipt cannot safely
      // authorize disclosure. Keep receipt and object details private.
      logger.error("[storage proxy] Storage read receipt unavailable");
      return jsonError(
        c,
        503,
        "Storage billing receipt service is temporarily unavailable",
        "service_unavailable",
      );
    }
    if (error instanceof StorageReadCapabilityConfigurationError) {
      // error-policy:J2 deployment configuration or signing is unavailable.
      // Fail closed without serializing capability or secret details.
      logger.error(
        "[storage proxy] Signed read capability configuration unavailable",
      );
      return c.json(
        {
          error:
            "Attachment storage proxy not available — server misconfigured",
        },
        503,
      );
    }
    // error-policy:J1 the route boundary translates authentication, pricing,
    // debit, configuration, and signing failures into the canonical response.
    return failureResponse(c, error);
  }
});

export default app;
