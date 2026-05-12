/**
 * Attachment object storage proxy.
 *
 * Routes:
 *   PUT    /api/v1/apis/storage/objects/{key+}   raw bytes →  { key, size, contentType, etag }
 *   GET    /api/v1/apis/storage/objects/{key+}                raw bytes
 *   HEAD   /api/v1/apis/storage/objects/{key+}                metadata headers, 404 if missing
 *   DELETE /api/v1/apis/storage/objects/{key+}                204 No Content
 *
 * Storage backend: R2 over the S3 API via @brighter/storage-adapter-s3
 * (transparent to clients). Object keys are scoped per organization:
 * `org/${organization_id}/${userKey}` is the actual storage key. Clients
 * never see the prefix; the route prepends/strips it.
 *
 * Auth: requireUserOrApiKeyWithOrg.
 * Quota: hard-rejects writes with 413 when the org's bytes_limit is exceeded.
 * Pricing: per-request charge (and per-byte for PUT) deducted via creditsService.
 */

import { Hono } from "hono";
import { orgStorageQuotaRepository } from "@/db/repositories";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { creditsService } from "@/lib/services/credits";
import { getServiceMethodCost } from "@/lib/services/proxy/pricing";
import { getR2StorageAdapter } from "@/lib/services/storage/r2-storage-adapter";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const STORAGE_SERVICE_ID = "storage";
const MAX_OBJECT_KEY_LENGTH = 1024;
const MAX_PUT_BYTES = 50 * 1024 * 1024;
const R2_NOT_CONFIGURED_BODY = {
  error: "Attachment storage proxy not available — server misconfigured (R2_* env vars unset)",
};

const app = new Hono<AppEnv>();

function scopedKey(organizationId: string, userKey: string): string {
  return `org/${organizationId}/${userKey}`;
}

/**
 * Validates a client-supplied storage key. Returns the key on success or a
 * descriptive error message. Rejects empty, oversized, NUL-containing, and
 * `..`-traversal keys.
 */
function validateUserKey(rawKey: string | undefined): { key: string } | { error: string } {
  if (!rawKey) {
    return { error: "Object key is required" };
  }
  const key = rawKey.replace(/^\/+|\/+$/g, "");
  if (key.length === 0) {
    return { error: "Object key is required" };
  }
  if (key.length > MAX_OBJECT_KEY_LENGTH) {
    return { error: `Object key exceeds ${MAX_OBJECT_KEY_LENGTH} character limit` };
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

    const adapter = getR2StorageAdapter(c.env);
    if (!adapter) {
      logger.error("[storage proxy] R2_* env vars not set; PUT rejected");
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
      return c.json({ error: `Object exceeds ${MAX_PUT_BYTES} byte limit (${bytes})` }, 413);
    }

    const reserved = await orgStorageQuotaRepository.tryReserveBytes(
      organization_id,
      BigInt(bytes),
    );
    if (reserved === null) {
      return c.json({ error: "Storage quota exceeded for this organization" }, 413);
    }

    const flatCost = await getServiceMethodCost(STORAGE_SERVICE_ID, "put");
    const perByteCost = await getServiceMethodCost(STORAGE_SERVICE_ID, "put_per_byte");
    const totalCost = flatCost + perByteCost * bytes;
    const deductResult = await creditsService.deductCredits({
      organizationId: organization_id,
      amount: totalCost,
      description: `API proxy: storage — put (${bytes}B)`,
      metadata: {
        type: "proxy_storage",
        service: "storage",
        method: "put",
        bytes,
      },
    });
    if (!deductResult.success) {
      await orgStorageQuotaRepository.releaseBytes(organization_id, BigInt(bytes));
      return c.json(
        {
          error: "Insufficient credits",
          topUpUrl: "https://www.elizacloud.ai/dashboard/billing",
        },
        402,
      );
    }

    const key = scopedKey(organization_id, validated.key);
    try {
      await adapter.write(key, Buffer.from(arrayBuffer));
    } catch (error) {
      await orgStorageQuotaRepository.releaseBytes(organization_id, BigInt(bytes));
      throw error;
    }

    const stat = await adapter.stat(key);
    return c.json(
      {
        key: validated.key,
        size: stat.size,
        contentType: stat.contentType,
        etag: stat.etag,
      },
      201,
    );
  } catch (error) {
    return failureResponse(c, error);
  }
});

app.get("/*", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const { organization_id } = user;

    const adapter = getR2StorageAdapter(c.env);
    if (!adapter) {
      return c.json(R2_NOT_CONFIGURED_BODY, 503);
    }

    const validated = validateUserKey(c.req.param("*"));
    if ("error" in validated) {
      return c.json({ error: validated.error }, 400);
    }

    const deduct = await deductFlatCost(organization_id, "get", { key: validated.key });
    if (!deduct.ok) {
      return c.json(
        { error: "Insufficient credits", topUpUrl: "https://www.elizacloud.ai/dashboard/billing" },
        402,
      );
    }

    const key = scopedKey(organization_id, validated.key);
    if (!(await adapter.exists(key))) {
      return c.json({ error: "Object not found" }, 404);
    }
    const [bytes, stat] = await Promise.all([adapter.read(key), adapter.stat(key)]);
    const body = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(body).set(bytes);
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": stat.contentType,
        "Content-Length": String(stat.size),
        ETag: stat.etag,
        "Last-Modified": stat.modified.toUTCString(),
      },
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

app.on(["HEAD"], "/*", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const { organization_id } = user;

    const adapter = getR2StorageAdapter(c.env);
    if (!adapter) {
      return c.json(R2_NOT_CONFIGURED_BODY, 503);
    }

    const validated = validateUserKey(c.req.param("*"));
    if ("error" in validated) {
      return c.json({ error: validated.error }, 400);
    }

    const deduct = await deductFlatCost(organization_id, "head", { key: validated.key });
    if (!deduct.ok) {
      return c.json(
        { error: "Insufficient credits", topUpUrl: "https://www.elizacloud.ai/dashboard/billing" },
        402,
      );
    }

    const key = scopedKey(organization_id, validated.key);
    if (!(await adapter.exists(key))) {
      return new Response(null, { status: 404 });
    }
    const stat = await adapter.stat(key);
    return new Response(null, {
      status: 200,
      headers: {
        "Content-Type": stat.contentType,
        "Content-Length": String(stat.size),
        ETag: stat.etag,
        "Last-Modified": stat.modified.toUTCString(),
      },
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

app.delete("/*", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const { organization_id } = user;

    const adapter = getR2StorageAdapter(c.env);
    if (!adapter) {
      return c.json(R2_NOT_CONFIGURED_BODY, 503);
    }

    const validated = validateUserKey(c.req.param("*"));
    if ("error" in validated) {
      return c.json({ error: validated.error }, 400);
    }

    const key = scopedKey(organization_id, validated.key);
    if (!(await adapter.exists(key))) {
      return new Response(null, { status: 204 });
    }
    const stat = await adapter.stat(key);
    await adapter.remove(key);
    await orgStorageQuotaRepository.releaseBytes(organization_id, BigInt(stat.size));
    return new Response(null, { status: 204 });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;

/**
 * Test-only export. Direct unit tests for the key validator avoid the
 * URL parser collapsing `%2E%2E` segments before the handler runs.
 */
export const validateUserKeyForTest = validateUserKey;
