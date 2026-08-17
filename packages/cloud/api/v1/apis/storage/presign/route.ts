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
 * The URL grants temporary GET/HEAD access through the Worker blob host. The
 * capability is minted locally and returned only after the flat charge commits;
 * writes continue through `PUT /objects/{key+}` so quota enforcement remains
 * authoritative.
 */

import { Hono } from "hono";
import { z } from "zod";
import {
  mintStorageReadCapabilityUrl,
  normalizeStorageReadCapabilityHost,
  StorageReadCapabilityConfigurationError,
} from "@/api-app/storage-read-capability";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { creditsService } from "@/lib/services/credits";
import { getServiceMethodCost } from "@/lib/services/proxy/pricing";
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
    const issuedAt = Math.floor(Date.now() / 1000);
    const ttlSeconds = expiresIn ?? 3600;
    const expiresAtSeconds = issuedAt + ttlSeconds;

    let url: string;
    try {
      url = await mintStorageReadCapabilityUrl({
        rawSecrets: c.env.STORAGE_READ_SIGNING_SECRETS,
        host: blobHost,
        scopedKey,
        issuedAt,
        expiresAt: expiresAtSeconds,
      });
    } catch (error) {
      if (error instanceof StorageReadCapabilityConfigurationError) {
        // error-policy:J2 deployment configuration is unavailable. Fail before
        // the debit and never serialize secret material into logs or responses.
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

    const expiresAt = new Date(expiresAtSeconds * 1000).toISOString();

    return c.json({ url, expiresAt });
  } catch (error) {
    // error-policy:J1 the route boundary translates authentication, pricing,
    // debit, configuration, and signing failures into the canonical response.
    return failureResponse(c, error);
  }
});

export default app;
