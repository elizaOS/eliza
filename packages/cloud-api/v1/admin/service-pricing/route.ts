/**
 * Admin Service Pricing Management API
 *
 * GET /api/v1/admin/service-pricing?service_id=...   — list pricing entries for a service
 * PUT /api/v1/admin/service-pricing                  — upsert a pricing entry
 *
 * Requires admin role. Cache is invalidated pre + post DB update.
 */

import { Hono } from "hono";
import { z } from "zod";
import { servicePricingRepository } from "@/db/repositories/service-pricing";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireAdmin } from "@/lib/auth/workers-hono-auth";
import { invalidateServicePricingCache } from "@/lib/services/proxy/pricing";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    await requireAdmin(c);

    const serviceId = c.req.query("service_id");
    if (!serviceId) {
      return c.json({ error: "service_id query parameter is required" }, 400);
    }

    const pricing = await servicePricingRepository.listByService(serviceId, false);
    return c.json({
      service_id: serviceId,
      pricing: pricing.map((p) => ({
        id: p.id,
        method: p.method,
        cost: p.cost,
        description: p.description,
        metadata: p.metadata,
        is_active: p.is_active,
        updated_by: p.updated_by,
        updated_at: p.updated_at,
      })),
    });
  } catch (error) {
    logger.error("[Admin] Service pricing GET error", { error });
    return failureResponse(c, error);
  }
});

const UpsertSchema = z.object({
  service_id: z.string(),
  method: z.string(),
  cost: z.number().positive(),
  reason: z.string(),
  description: z.string().optional(),
  metadata: z
    .record(z.string().max(100), z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]))
    .refine((val) => Object.keys(val).length <= 20, {
      message: "Metadata cannot have more than 20 keys",
    })
    .optional(),
});

app.put("/", async (c) => {
  try {
    const { user } = await requireAdmin(c);

    const rawBody = await c.req.json().catch(() => null);
    if (!rawBody) {
      return c.json({ error: "Invalid JSON in request body" }, 400);
    }

    const parsed = UpsertSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json({ error: "Invalid request", details: parsed.error.flatten() }, 400);
    }

    const { service_id, method, cost, reason, description, metadata } = parsed.data;
    let cacheInvalidated = false;

    await invalidateServicePricingCache(service_id);

    const result = await servicePricingRepository.upsert(
      service_id,
      method,
      cost,
      user.id,
      reason,
      description,
      metadata,
    );

    try {
      await invalidateServicePricingCache(service_id);
      cacheInvalidated = true;
    } catch (retryError) {
      logger.error("[Admin] CRITICAL: Post-update cache invalidation failed", {
        service_id,
        method,
        retryError: retryError instanceof Error ? retryError.message : "Unknown",
      });
    }

    logger.info("[Admin] Service pricing updated", {
      service_id,
      method,
      cost,
      updated_by: user.id,
      reason,
      cache_invalidated: cacheInvalidated,
    });

    return c.json({
      success: true,
      pricing: {
        id: result.id,
        service_id: result.service_id,
        method: result.method,
        cost: result.cost,
        description: result.description,
        metadata: result.metadata,
        is_active: result.is_active,
        updated_at: result.updated_at,
      },
      cache_invalidated: cacheInvalidated,
    });
  } catch (error) {
    logger.error("[Admin] Service pricing PUT error", { error });
    return failureResponse(c, error);
  }
});

export default app;
