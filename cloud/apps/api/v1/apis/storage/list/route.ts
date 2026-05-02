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
 * Listing is automatically scoped to `org/${organization_id}/`. The returned
 * `key` field is the user-relative key (the org prefix is stripped).
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { creditsService } from "@/lib/services/credits";
import { getServiceMethodCost } from "@/lib/services/proxy/pricing";
import { getR2StorageAdapter } from "@/lib/services/storage/r2-storage-adapter";
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

    const adapter = getR2StorageAdapter(c.env);
    if (!adapter) {
      return c.json(
        { error: "Attachment storage proxy not available — server misconfigured" },
        503,
      );
    }

    const parsed = listQuerySchema.safeParse({
      prefix: c.req.query("prefix") ?? "",
      recursive: c.req.query("recursive") ?? "true",
    });
    if (!parsed.success) {
      return c.json({ error: "Invalid list query", details: parsed.error.issues }, 400);
    }
    const { prefix, recursive } = parsed.data;

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
            topUpUrl: "https://www.elizacloud.ai/dashboard/billing",
          },
          402,
        );
      }
    }

    const trimmedPrefix = prefix.replace(/^\/+|\/+$/g, "");
    const scopedPrefix = trimmedPrefix
      ? `org/${organization_id}/${trimmedPrefix}`
      : `org/${organization_id}/`;
    const orgPrefix = `org/${organization_id}/`;

    const fullKeys = await adapter.list(scopedPrefix, { recursive });
    const truncated = fullKeys.slice(0, MAX_LIST_RESULTS);

    const items = await Promise.all(
      truncated.map(async (fullKey) => {
        const stat = await adapter.stat(fullKey);
        const userKey = fullKey.startsWith(orgPrefix) ? fullKey.slice(orgPrefix.length) : fullKey;
        return {
          key: userKey,
          size: stat.size,
          contentType: stat.contentType,
          modifiedAt: stat.modified.toISOString(),
        };
      }),
    );

    return c.json({
      items,
      truncated: fullKeys.length > MAX_LIST_RESULTS,
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
