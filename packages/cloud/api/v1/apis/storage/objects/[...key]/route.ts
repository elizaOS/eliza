/**
 * Attachment object storage proxy.
 *
 * Routes:
 *   PUT    /api/v1/apis/storage/objects/_   integrity-declared byte stream → metadata
 *   GET    /api/v1/apis/storage/objects/_                raw bytes
 *   HEAD   /api/v1/apis/storage/objects/_                metadata headers, 404 if missing
 *   DELETE /api/v1/apis/storage/objects/_                204 No Content
 *
 * Native Worker R2 writes use immutable generation keys and a durable database
 * authority; catalog-backed reads and deletes follow the committed generation.
 * Legacy `org/${organization_id}/${userKey}` objects are adopted on first
 * access; new bytes live under tenant-scoped immutable generation keys.
 *
 * Auth: requireUserOrApiKeyWithOrg.
 * Quota: declared bytes are reserved atomically before R2 consumes the stream;
 * object size itself is governed by R2 and the ingress plan, not Worker heap.
 * Pricing: PUT, GET, and HEAD use durable server-priced receipts. Read retries
 * recover the exact immutable provider generation before any provider access.
 */

import { type Context, Hono } from "hono";
import {
  StoragePutConflictError,
  StorageQuotaExceededError,
} from "@/db/repositories";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { InsufficientCreditsError } from "@/lib/services/credits";
import { getServiceMethodCost } from "@/lib/services/proxy/pricing";
import {
  calculateStoragePutPrice,
  executeNativeStorageDelete,
  executeNativeStoragePut,
  NativeStoragePutError,
  resolveNativeStorageObject,
} from "@/lib/services/storage/native-storage-put";
import {
  executeNativeStorageGetOrHead,
  NativeStorageReadError,
} from "@/lib/services/storage/native-storage-read";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const STORAGE_SERVICE_ID = "storage";
const MAX_OBJECT_KEY_LENGTH = 1024;
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

function validatePrivateObjectKey(
  c: Context<AppEnv>,
): { key: string } | { error: string } {
  const routeMarker = c.req.param("*")?.replace(/^\/+|\/+$/g, "");
  if (routeMarker && routeMarker !== "_") {
    return {
      error:
        "Object keys are not accepted in read URLs; use /objects/_ and X-Storage-Object-Key",
    };
  }
  return validateUserKey(c.req.header("X-Storage-Object-Key"));
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

    const validated = validatePrivateObjectKey(c);
    if ("error" in validated) {
      return c.json({ error: validated.error }, 400);
    }

    const declaredLength = c.req.header("x-content-length");
    const bytes = declaredLength ? Number(declaredLength) : Number.NaN;
    if (!Number.isSafeInteger(bytes) || bytes <= 0) {
      return c.json(
        { error: "A positive X-Content-Length header is required" },
        411,
      );
    }
    const transportLength = c.req.header("content-length");
    if (transportLength !== undefined && Number(transportLength) !== bytes) {
      return c.json(
        { error: "Content-Length does not match X-Content-Length" },
        400,
      );
    }
    const contentSha256 = c.req.header("x-content-sha256")?.toLowerCase();
    if (!contentSha256 || !/^[0-9a-f]{64}$/.test(contentSha256)) {
      return c.json(
        { error: "A hexadecimal X-Content-SHA256 header is required" },
        400,
      );
    }
    const body = c.req.raw.body;
    if (!body) return c.json({ error: "Request body is required" }, 400);

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
      body,
      sizeBytes: bytes,
      contentSha256,
      contentType: c.req.header("content-type") ?? "application/octet-stream",
      priceUsd: totalCost,
    });
    return c.json(response, 201);
  } catch (error) {
    // error-policy:J1 transport boundary maps typed write failures to HTTP status.
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
              error.code === "CONTENT_TYPE_INVALID" ||
              error.code === "CONTENT_LENGTH_INVALID" ||
              error.code === "CONTENT_SHA256_INVALID"
            ? 400
            : 503;
      return c.json({ error: error.message, code: error.code }, status);
    }
    return failureResponse(c, error);
  }
});

async function handleStorageGet(c: Context<AppEnv>) {
  // Hono dispatches HEAD through the matching GET route while preserving the
  // original request method. Branch here so HEAD never enters the body-read
  // path or uses GET pricing.
  if (c.req.method === "HEAD") {
    return handleStorageHead(c);
  }

  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const { organization_id } = user;

    const validated = validatePrivateObjectKey(c);
    if ("error" in validated) {
      return c.json({ error: validated.error }, 400);
    }

    if (!c.env.BLOB) return c.json(R2_NOT_CONFIGURED_BODY, 503);
    const priceUsd = await getServiceMethodCost(STORAGE_SERVICE_ID, "get");
    const result = await executeNativeStorageGetOrHead({
      bucket: c.env.BLOB,
      organizationId: organization_id,
      userId: user.id,
      logicalKey: validated.key,
      rawIdempotencyKey: c.req.header("Idempotency-Key") ?? "",
      priceUsd,
      method: "get",
    });
    if (result.status === 404)
      return c.json({ error: "Object not found" }, 404);
    if (!result.object || !result.headers) {
      return c.json({ error: "Storage generation body is unavailable" }, 503);
    }
    const body = result.object.body ?? (await result.object.arrayBuffer?.());
    if (!body)
      return c.json({ error: "Storage generation body is unavailable" }, 503);
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": result.headers.contentType,
        "Content-Length": String(result.headers.size),
        ETag: result.headers.etag,
        "Last-Modified": result.headers.lastModified,
        "X-Storage-Receipt-Id": result.operation.id,
      },
    });
  } catch (error) {
    // error-policy:J1 transport boundary maps typed read failures to HTTP status.
    const readFailure = storageReadFailure(c, error);
    if (readFailure) return readFailure;
    return failureResponse(c, error);
  }
}

app.get("/", handleStorageGet);
app.get("/*", handleStorageGet);

async function handleStorageHead(c: Context<AppEnv>) {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const { organization_id } = user;

    const validated = validatePrivateObjectKey(c);
    if ("error" in validated) {
      return c.json({ error: validated.error }, 400);
    }

    if (!c.env.BLOB?.head) return c.json(R2_NOT_CONFIGURED_BODY, 503);
    const priceUsd = await getServiceMethodCost(STORAGE_SERVICE_ID, "head");
    const result = await executeNativeStorageGetOrHead({
      bucket: c.env.BLOB,
      organizationId: organization_id,
      userId: user.id,
      logicalKey: validated.key,
      rawIdempotencyKey: c.req.header("Idempotency-Key") ?? "",
      priceUsd,
      method: "head",
    });
    if (result.status === 404) return new Response(null, { status: 404 });
    if (!result.headers)
      return c.json({ error: "Storage generation is unavailable" }, 503);
    return new Response(null, {
      status: 200,
      headers: {
        "Content-Type": result.headers.contentType,
        "Content-Length": String(result.headers.size),
        ETag: result.headers.etag,
        "Last-Modified": result.headers.lastModified,
        "X-Storage-Receipt-Id": result.operation.id,
      },
    });
  } catch (error) {
    // error-policy:J1 transport boundary maps typed read failures to HTTP status.
    const readFailure = storageReadFailure(c, error);
    if (readFailure) return readFailure;
    return failureResponse(c, error);
  }
}

function storageReadFailure(
  c: Context<AppEnv>,
  error: unknown,
): Response | undefined {
  if (!(error instanceof NativeStorageReadError)) return undefined;
  if (error.code === "INSUFFICIENT_CREDITS") {
    return c.json(
      {
        error: "Insufficient credits",
        topUpUrl: "https://cloud.eliza.app/cloud/settings?tab=billing",
      },
      402,
    );
  }
  if (
    error.code === "IDEMPOTENCY_REQUIRED" ||
    error.code === "IDEMPOTENCY_INVALID"
  ) {
    return c.json({ error: error.message, code: error.code }, 400);
  }
  if (error.code === "IDEMPOTENCY_MISMATCH") {
    return c.json({ error: error.message, code: error.code }, 409);
  }
  return c.json(
    { error: "Storage read is temporarily unavailable", code: error.code },
    503,
  );
}

app.delete("/*", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const { organization_id } = user;

    const validated = validatePrivateObjectKey(c);
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
    // error-policy:J1 transport boundary maps typed delete failures to HTTP status.
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
