/**
 * Attachment object storage proxy.
 *
 * Routes:
 *   PUT    /api/v1/apis/storage/objects/{key+}   raw bytes →  { key, size, contentType, etag }
 *   GET    /api/v1/apis/storage/objects/{key+}                raw bytes
 *   HEAD   /api/v1/apis/storage/objects/{key+}                metadata headers, 404 if missing
 *   DELETE /api/v1/apis/storage/objects/{key+}                204 No Content
 *
 * Native Worker R2 writes use immutable generation keys and a durable database
 * authority; catalog-backed reads and deletes follow the committed generation.
 * Legacy `org/${organization_id}/${userKey}` objects are adopted on first
 * access; new bytes live under tenant-scoped immutable generation keys.
 *
 * Auth: requireUserOrApiKeyWithOrg.
 * Quota: hard-rejects writes with 413 when the org's bytes_limit is exceeded.
 * Pricing: per-request charge (and per-byte for PUT) deducted via creditsService.
 */

import { type Context, Hono } from "hono";
import {
  StoragePutConflictError,
  StorageQuotaExceededError,
} from "@/db/repositories";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  creditsService,
  InsufficientCreditsError,
} from "@/lib/services/credits";
import { getServiceMethodCost } from "@/lib/services/proxy/pricing";
import {
  calculateStoragePutPrice,
  executeNativeStorageDelete,
  executeNativeStoragePut,
  NativeStoragePutError,
  resolveNativeStorageObject,
} from "@/lib/services/storage/native-storage-put";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const STORAGE_SERVICE_ID = "storage";
const MAX_OBJECT_KEY_LENGTH = 1024;
const MAX_PUT_BYTES = 50 * 1024 * 1024;
const R2_NOT_CONFIGURED_BODY = {
  error:
    "Attachment storage proxy not available — server misconfigured (R2_* env vars unset)",
};

const app = new Hono<AppEnv>();

/**
 * Validates a client-supplied storage key. Returns the key on success or a
 * descriptive error message. Rejects empty, oversized, NUL-containing, and
 * `..`-traversal keys.
 */
function validateUserKey(
  rawKey: string | undefined,
): { key: string } | { error: string } {
  if (!rawKey) {
    return { error: "Object key is required" };
  }
  const key = rawKey.replace(/^\/+|\/+$/g, "");
  if (key.length === 0) {
    return { error: "Object key is required" };
  }
  if (key.length > MAX_OBJECT_KEY_LENGTH) {
    return {
      error: `Object key exceeds ${MAX_OBJECT_KEY_LENGTH} character limit`,
    };
  }
  if (key.includes("\0")) {
    return { error: "Object key may not contain NUL bytes" };
  }
  if (key.split("/").some((segment) => segment === "..")) {
    return { error: "Object key may not contain '..' path segments" };
  }
  return { key };
}

async function deductFlatCost(
  organizationId: string,
  method: "put" | "get" | "head" | "delete" | "list" | "presign",
  metadata: Record<string, string | number>,
): Promise<{ ok: true } | { ok: false }> {
  const cost = await getServiceMethodCost(STORAGE_SERVICE_ID, method);
  if (cost === 0) {
    return { ok: true };
  }
  const result = await creditsService.deductCredits({
    organizationId,
    amount: cost,
    description: `API proxy: storage — ${method}`,
    metadata: {
      type: "proxy_storage",
      service: "storage",
      method,
      ...metadata,
    },
  });
  if (!result.success) {
    return { ok: false };
  }
  return { ok: true };
}

app.put("/*", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const { organization_id } = user;

    if (!c.env.BLOB) {
      logger.error(
        "[storage proxy] native BLOB binding is missing; PUT rejected",
      );
      return c.json(R2_NOT_CONFIGURED_BODY, 503);
    }

    const validated = validateUserKey(c.req.param("*"));
    if ("error" in validated) {
      return c.json({ error: validated.error }, 400);
    }

    const arrayBuffer = await c.req.arrayBuffer();
    const bytes = arrayBuffer.byteLength;
    if (bytes === 0) {
      return c.json({ error: "Request body is required" }, 400);
    }
    if (bytes > MAX_PUT_BYTES) {
      return c.json(
        { error: `Object exceeds ${MAX_PUT_BYTES} byte limit (${bytes})` },
        413,
      );
    }

    const flatCost = await getServiceMethodCost(STORAGE_SERVICE_ID, "put");
    const perByteCost = await getServiceMethodCost(
      STORAGE_SERVICE_ID,
      "put_per_byte",
    );
    const totalCost = calculateStoragePutPrice(flatCost, perByteCost, bytes);
    const response = await executeNativeStoragePut({
      bucket: c.env.BLOB,
      organizationId: organization_id,
      logicalKey: validated.key,
      idempotencyKey: c.req.header("idempotency-key") ?? "",
      body: arrayBuffer,
      contentType: c.req.header("content-type") ?? "application/octet-stream",
      priceUsd: totalCost,
    });
    return c.json(response, 201);
  } catch (error) {
    if (error instanceof InsufficientCreditsError) {
      return c.json(
        {
          error: "Insufficient credits",
          topUpUrl: "https://cloud.eliza.app/cloud/settings?tab=billing",
        },
        402,
      );
    }
    if (error instanceof StorageQuotaExceededError) {
      return c.json({ error: error.message }, 413);
    }
    if (error instanceof StoragePutConflictError) {
      return c.json({ error: error.message, reason: error.reason }, 409);
    }
    if (error instanceof NativeStoragePutError) {
      const status =
        error.code === "OPERATION_IN_PROGRESS"
          ? 409
          : error.code === "IDEMPOTENCY_REQUIRED" ||
              error.code === "IDEMPOTENCY_INVALID" ||
              error.code === "CONTENT_TYPE_INVALID"
            ? 400
            : 503;
      return c.json({ error: error.message, code: error.code }, status);
    }
    return failureResponse(c, error);
  }
});

app.get("/*", async (c) => {
  // Hono dispatches HEAD through the matching GET route while preserving the
  // original request method. Branch here so HEAD never enters the body-read
  // path or uses GET pricing.
  if (c.req.method === "HEAD") {
    return handleStorageHead(c);
  }

  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const { organization_id } = user;

    const validated = validateUserKey(c.req.param("*"));
    if ("error" in validated) {
      return c.json({ error: validated.error }, 400);
    }

    if (!c.env.BLOB) return c.json(R2_NOT_CONFIGURED_BODY, 503);
    const nativeObject = await resolveNativeStorageObject(
      c.env.BLOB,
      organization_id,
      validated.key,
    );
    if (nativeObject?.deleted_at)
      return c.json({ error: "Object not found" }, 404);
    if (nativeObject?.provider_key) {
      const object = await c.env.BLOB.get(nativeObject.provider_key);
      if (!object) {
        return c.json(
          { error: "Storage generation is temporarily unavailable" },
          503,
        );
      }
      const body = object.body ?? (await object.arrayBuffer?.());
      if (!body) {
        return c.json({ error: "Storage generation body is unavailable" }, 503);
      }
      const deduct = await deductFlatCost(organization_id, "get", {
        key: validated.key,
      });
      if (!deduct.ok) {
        return c.json(
          {
            error: "Insufficient credits",
            topUpUrl: "https://cloud.eliza.app/cloud/settings?tab=billing",
          },
          402,
        );
      }
      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": nativeObject.content_type!,
          "Content-Length": String(nativeObject.size_bytes),
          ETag: nativeObject.etag!,
          "Last-Modified": nativeObject.uploaded_at!.toUTCString(),
        },
      });
    }

    return c.json({ error: "Object not found" }, 404);
  } catch (error) {
    return failureResponse(c, error);
  }
});

async function handleStorageHead(c: Context<AppEnv>) {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const { organization_id } = user;

    const validated = validateUserKey(c.req.param("*"));
    if ("error" in validated) {
      return c.json({ error: validated.error }, 400);
    }

    if (!c.env.BLOB?.head) return c.json(R2_NOT_CONFIGURED_BODY, 503);
    const nativeObject = await resolveNativeStorageObject(
      c.env.BLOB,
      organization_id,
      validated.key,
    );
    if (nativeObject?.deleted_at) return new Response(null, { status: 404 });
    if (nativeObject?.provider_key) {
      const observed = await c.env.BLOB.head(nativeObject.provider_key);
      if (
        !observed ||
        observed.size !== Number(nativeObject.size_bytes) ||
        observed.etag !== nativeObject.etag
      ) {
        return c.json(
          { error: "Storage generation is temporarily unavailable" },
          503,
        );
      }
      const deduct = await deductFlatCost(organization_id, "head", {
        key: validated.key,
      });
      if (!deduct.ok) {
        return c.json(
          {
            error: "Insufficient credits",
            topUpUrl: "https://cloud.eliza.app/cloud/settings?tab=billing",
          },
          402,
        );
      }
      return new Response(null, {
        status: 200,
        headers: {
          "Content-Type": nativeObject.content_type!,
          "Content-Length": String(nativeObject.size_bytes),
          ETag: nativeObject.etag!,
          "Last-Modified": nativeObject.uploaded_at!.toUTCString(),
        },
      });
    }

    return new Response(null, { status: 404 });
  } catch (error) {
    return failureResponse(c, error);
  }
}

app.delete("/*", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const { organization_id } = user;

    const validated = validateUserKey(c.req.param("*"));
    if ("error" in validated) {
      return c.json({ error: validated.error }, 400);
    }

    if (!c.env.BLOB) return c.json(R2_NOT_CONFIGURED_BODY, 503);
    const nativeObject = await resolveNativeStorageObject(
      c.env.BLOB,
      organization_id,
      validated.key,
    );
    if (nativeObject?.deleted_at) return new Response(null, { status: 204 });
    if (nativeObject?.provider_key) {
      const deleteCost = await getServiceMethodCost(
        STORAGE_SERVICE_ID,
        "delete",
      );
      await executeNativeStorageDelete({
        bucket: c.env.BLOB,
        organizationId: organization_id,
        logicalKey: validated.key,
        idempotencyKey: c.req.header("idempotency-key") ?? "",
        priceUsd: deleteCost,
      });
      return new Response(null, { status: 204 });
    }

    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof StoragePutConflictError) {
      return c.json({ error: error.message, reason: error.reason }, 409);
    }
    if (error instanceof NativeStoragePutError) {
      const status =
        error.code === "OPERATION_IN_PROGRESS"
          ? 409
          : error.code === "IDEMPOTENCY_REQUIRED" ||
              error.code === "IDEMPOTENCY_INVALID" ||
              error.code === "CONTENT_TYPE_INVALID"
            ? 400
            : 503;
      return c.json({ error: error.message, code: error.code }, status);
    }
    return failureResponse(c, error);
  }
});

export default app;
