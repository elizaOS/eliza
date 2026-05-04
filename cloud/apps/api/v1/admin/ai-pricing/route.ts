/**
 * Admin AI pricing API.
 *
 * GET  — list persisted pricing entries + recent refresh runs
 * POST — refresh pricing catalog from selected sources
 * PUT  — manual override an entry (deactivates the prior override row)
 *
 * Requires admin role.
 */

import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { dbWrite } from "@/db/helpers";
import { aiPricingEntries } from "@/db/schemas/ai-pricing";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireAdmin } from "@/lib/auth/workers-hono-auth";
import {
  buildDimensionKey,
  listPersistedPricingEntries,
  listRecentPricingRefreshRuns,
  normalizePricingDimensions,
  refreshPricingCatalog,
} from "@/lib/services/ai-pricing";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

const OverrideSchema = z.object({
  billingSource: z.enum(["gateway", "openrouter", "openai", "groq", "fal", "elevenlabs"]),
  provider: z.string().min(1),
  model: z.string().min(1),
  productFamily: z.enum(["language", "embedding", "image", "video", "tts", "stt", "voice_clone"]),
  chargeType: z.string().min(1),
  unit: z.enum([
    "token",
    "image",
    "request",
    "second",
    "minute",
    "hour",
    "character",
    "1k_requests",
  ]),
  unitPrice: z.number().positive(),
  dimensions: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .optional(),
  reason: z.string().min(1),
});

const RefreshSchema = z.object({
  sources: z.array(z.enum(["gateway", "openrouter", "fal", "elevenlabs"])).optional(),
});

app.get("/", async (c) => {
  try {
    await requireAdmin(c);

    const billingSource = c.req.query("billingSource") || undefined;
    const provider = c.req.query("provider") || undefined;
    const model = c.req.query("model") || undefined;
    const productFamily = c.req.query("productFamily") || undefined;
    const chargeType = c.req.query("chargeType") || undefined;

    const [entries, refreshRuns] = await Promise.all([
      listPersistedPricingEntries({
        billingSource,
        provider,
        model,
        productFamily,
        chargeType,
      }),
      listRecentPricingRefreshRuns(10),
    ]);

    return c.json({ pricing: entries, refreshRuns });
  } catch (error) {
    return failureResponse(c, error);
  }
});

app.post("/", async (c) => {
  try {
    await requireAdmin(c);

    const body = RefreshSchema.parse(await c.req.json());
    const refresh = await refreshPricingCatalog(body.sources);
    return c.json(refresh, refresh.success ? 200 : 207);
  } catch (error) {
    return failureResponse(c, error);
  }
});

app.put("/", async (c) => {
  try {
    const { user } = await requireAdmin(c);

    const body = OverrideSchema.parse(await c.req.json());
    const dimensions = normalizePricingDimensions(body.dimensions);
    const dimensionKey = buildDimensionKey(dimensions);
    const now = new Date();

    const [created] = await dbWrite.transaction(async (tx) => {
      await tx
        .update(aiPricingEntries)
        .set({
          is_active: false,
          effective_until: now,
          updated_at: now,
        })
        .where(
          and(
            eq(aiPricingEntries.is_active, true),
            eq(aiPricingEntries.source_kind, "manual_override"),
            eq(aiPricingEntries.billing_source, body.billingSource),
            eq(aiPricingEntries.provider, body.provider),
            eq(aiPricingEntries.model, body.model),
            eq(aiPricingEntries.product_family, body.productFamily),
            eq(aiPricingEntries.charge_type, body.chargeType),
            eq(aiPricingEntries.dimension_key, dimensionKey),
          ),
        );

      const inserted = await tx
        .insert(aiPricingEntries)
        .values({
          billing_source: body.billingSource,
          provider: body.provider,
          model: body.model,
          product_family: body.productFamily,
          charge_type: body.chargeType,
          unit: body.unit,
          unit_price: body.unitPrice.toString(),
          currency: "USD",
          dimension_key: dimensionKey,
          dimensions,
          source_kind: "manual_override",
          source_url: "admin://manual-override",
          source_hash: null,
          fetched_at: now,
          stale_after: null,
          effective_from: now,
          priority: 1000,
          is_active: true,
          is_override: true,
          updated_by: user.id,
          metadata: { reason: body.reason },
          updated_at: now,
        })
        .returning();

      return inserted;
    });

    return c.json({ success: true, pricing: created });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
