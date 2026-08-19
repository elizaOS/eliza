/**
 * Lists attachment objects under a prefix.
 *
 * Routes:
 *   GET /api/v1/apis/storage/list?prefix=...&recursive=true|false
 *       → { items: [{ key, size, contentType, modifiedAt }] }
 *
 * Auth: requireUserOrApiKeyWithOrg.
 * Pricing: flat per-request charge against the `storage:list` row.
 *
 * Native R2 enumeration discovers and adopts legacy tenant-prefixed objects;
 * the catalog remains authoritative for immutable generations and tombstones.
 */

import { Hono } from "hono";
import { z } from "zod";
import { orgStorageMutationsRepository } from "@/db/repositories";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { creditsService } from "@/lib/services/credits";
import { getServiceMethodCost } from "@/lib/services/proxy/pricing";
import type { AppEnv } from "@/types/cloud-worker-env";

const STORAGE_SERVICE_ID = "storage";
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
    const scopedPrefix = trimmedPrefix
      ? `org/${organization_id}/${trimmedPrefix}`
      : `org/${organization_id}/`;
    const orgPrefix = `org/${organization_id}/`;

    let cursor: string | undefined;
    let providerTruncated = false;
    let adoptedCount = 0;
    do {
      const page = await bucket.list({
        prefix: scopedPrefix,
        cursor,
        delimiter: recursive ? undefined : "/",
        limit: Math.min(1000, MAX_LIST_RESULTS + 1 - adoptedCount),
        include: ["httpMetadata"],
      });
      for (const observed of page.objects) {
        if (!observed.key?.startsWith(orgPrefix)) continue;
        const logicalKey = observed.key.slice(orgPrefix.length);
        if (!observed.etag || observed.size <= 0) {
          throw new Error(
            "[storage list] R2 returned incomplete object metadata",
          );
        }
        const rawContentType = observed.httpMetadata?.contentType?.trim();
        const contentType =
          rawContentType &&
          rawContentType.length <= 255 &&
          !/[\0\r\n]/.test(rawContentType)
            ? rawContentType
            : "application/octet-stream";
        await orgStorageMutationsRepository.adoptLegacyObject({
          organizationId: organization_id,
          logicalKey,
          providerKey: observed.key,
          sizeBytes: BigInt(observed.size),
          contentType,
          etag: observed.etag,
          uploadedAt: observed.uploaded ?? new Date(0),
        });
        adoptedCount += 1;
        if (adoptedCount > MAX_LIST_RESULTS) break;
      }
      providerTruncated = page.truncated || adoptedCount > MAX_LIST_RESULTS;
      cursor = page.cursor;
    } while (providerTruncated && cursor && adoptedCount <= MAX_LIST_RESULTS);

    const catalog = await orgStorageMutationsRepository.listObjects(
      organization_id,
      trimmedPrefix,
      MAX_LIST_RESULTS + 1,
    );
    const visible = catalog.filter((object) => {
      if (recursive) return true;
      const suffix = object.logical_key
        .slice(trimmedPrefix.length)
        .replace(/^\//, "");
      return !suffix.includes("/");
    });
    const items = visible.slice(0, MAX_LIST_RESULTS).map((object) => {
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

    const cost = await getServiceMethodCost(STORAGE_SERVICE_ID, "list");
    if (cost > 0) {
      const deductResult = await creditsService.deductCredits({
        organizationId: organization_id,
        amount: cost,
        description: "API proxy: storage — list",
        metadata: {
          type: "proxy_storage",
          service: "storage",
          method: "list",
          prefix,
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

    return c.json({
      items,
      truncated:
        providerTruncated ||
        visible.length > MAX_LIST_RESULTS ||
        catalog.length > MAX_LIST_RESULTS,
    });
  } catch (error) {
    // error-policy:J1 route boundary — every catch in v1/apis/* translates a thrown error into a structured HTTP failure via failureResponse (never a fabricated 200/empty).
    return failureResponse(c, error);
  }
});

export default app;
