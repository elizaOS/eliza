/**
 * Admin AI pricing API.
 *
 * GET  — list persisted pricing entries + recent refresh runs
 * POST — refresh pricing catalog from selected sources
 * PUT  — manual override an entry (deactivates the prior override row)
 *
 * Requires admin role.
 */

import { Hono } from "hono";
import { z } from "zod";
import { aiPricingRepository } from "@/db/repositories/ai-pricing";
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
  billingSource: z.enum(["gateway", "openrouter", "openai", "groq", "vast", "fal", "elevenlabs"]),
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
    const created = await aiPricingRepository.createManualOverride({
      billingSource: body.billingSource,
      provider: body.provider,
      model: body.model,
      productFamily: body.productFamily,
      chargeType: body.chargeType,
      unit: body.unit,
      unitPrice: body.unitPrice,
      dimensionKey,
      dimensions,
      reason: body.reason,
      updatedBy: user.id,
    });

    return c.json({ success: true, pricing: created });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
