/**
 * Mints opaque, short-lived native R2 read capabilities after a durable
 * provider-success receipt and exact server-priced settlement.
 */
import { Hono } from "hono";
import { z } from "zod";
import {
  mintStorageReadCapabilityUrl,
  StorageReadCapabilityConfigurationError,
  validateStorageReadCapabilityConfiguration,
} from "@/api-app/storage-read-capability";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { getServiceMethodCost } from "@/lib/services/proxy/pricing";
import {
  executeNativeStoragePresign,
  NativeStorageReadError,
} from "@/lib/services/storage/native-storage-read";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const requestSchema = z.object({
  operation: z.literal("get"),
  expiresIn: z.number().int().min(60).max(3600).optional().default(3600),
});

const app = new Hono<AppEnv>();

function validLogicalKey(value: string): string | undefined {
  const key = value.replace(/^\/+|\/+$/g, "");
  if (
    !key ||
    new TextEncoder().encode(key).byteLength > 1024 ||
    /[\0\r\n]/.test(key) ||
    key
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return undefined;
  }
  return key;
}

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const raw = await c.req.json().catch(() => {
      // error-policy:J3 malformed request JSON remains an explicit invalid result.
      return null;
    });
    const parsed = requestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid presign request", details: parsed.error.issues },
        400,
      );
    }
    const logicalKey = validLogicalKey(
      c.req.header("X-Storage-Object-Key") ?? "",
    );
    if (!logicalKey) return c.json({ error: "Invalid object key" }, 400);
    if (!c.env.BLOB?.head) {
      return c.json({ error: "Attachment storage proxy not available" }, 503);
    }
    if (!c.env.R2_PUBLIC_HOST?.trim()) {
      logger.error("[storage proxy] Private capability host is not configured");
      return c.json({ error: "Attachment storage proxy not available" }, 503);
    }
    // Validate signer authority before provider access or durable settlement so
    // a missing secret cannot debit a request that cannot receive a capability.
    const capabilityHost = validateStorageReadCapabilityConfiguration(
      c.env.STORAGE_READ_SIGNING_SECRETS,
      c.env.R2_PUBLIC_HOST,
    );
    const result = await executeNativeStoragePresign({
      bucket: c.env.BLOB,
      organizationId: user.organization_id,
      userId: user.id,
      logicalKey,
      rawIdempotencyKey: c.req.header("Idempotency-Key") ?? "",
      priceUsd: await getServiceMethodCost("storage", "presign"),
      capabilityHost,
      ttlSeconds: parsed.data.expiresIn,
    });
    if (result.status === 404) return c.json(result.body, 404);
    const operation = result.operation;
    if (
      !operation.capability_id ||
      !operation.capability_issued_at ||
      !operation.capability_expires_at ||
      operation.capability_expires_at <= new Date()
    ) {
      return c.json(
        {
          error:
            "Storage capability expired; retry with the same Idempotency-Key",
          receiptId: operation.id,
        },
        409,
      );
    }
    const url = await mintStorageReadCapabilityUrl({
      rawSecrets: c.env.STORAGE_READ_SIGNING_SECRETS,
      host: capabilityHost,
      capabilityId: operation.capability_id,
      issuedAt: Math.floor(operation.capability_issued_at.getTime() / 1000),
      expiresAt: Math.floor(operation.capability_expires_at.getTime() / 1000),
    });
    return c.json({
      url,
      expiresAt: operation.capability_expires_at.toISOString(),
      receiptId: operation.id,
    });
  } catch (error) {
    // error-policy:J1 transport boundary maps receipt and signer failures to HTTP status.
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
    if (error instanceof StorageReadCapabilityConfigurationError) {
      logger.error("[storage proxy] Private capability signer is unavailable", {
        code: error.code,
      });
      return c.json({ error: "Attachment storage proxy not available" }, 503);
    }
    return failureResponse(c, error);
  }
});

export default app;
