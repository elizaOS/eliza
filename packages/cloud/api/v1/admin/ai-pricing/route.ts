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

const BILLING_SOURCES = [
  "gateway",
  "bitrouter",
  "cerebras",
  "openai",
  "groq",
  "vast",
  "fal",
  "elevenlabs",
  "suno",
] as const;
const PRODUCT_FAMILIES = [
  "language",
  "embedding",
  "image",
  "video",
  "music",
  "tts",
  "stt",
  "voice_clone",
] as const;

const OverrideSchema = z.object({
  billingSource: z.enum(BILLING_SOURCES),
  provider: z.string().min(1),
  model: z.string().min(1),
  productFamily: z.enum(PRODUCT_FAMILIES),
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
    .record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean(), z.null()]),
    )
    .optional(),
  reason: z.string().min(1),
});

const RefreshSchema = z.object({
  sources: z
    .array(
      z.enum([
        "gateway",
        "bitrouter",
        "cerebras",
        "fal",
        "elevenlabs",
        "suno",
        "vast",
      ]),
    )
    .optional(),
});

app.get("/", async (c) => {
  try {
    await requireAdmin(c);

    // Admin pricing-catalog identity, not leftover tax on admin metrics
    // timeRange or analytics export type. The prior `|| undefined` passed
    // GATEWAY / LANGUAGE / foo into listPersistedPricingEntries, so
    // operators asking for the gateway catalog received an empty page.
    // Missing / empty still means unfiltered. Garbage 400s before the
    // catalog sinks. provider / model / chargeType stay free-form.
    const requestedSource = c.req.query("billingSource");
    if (
      requestedSource != null &&
      requestedSource !== "" &&
      !BILLING_SOURCES.includes(
        requestedSource as (typeof BILLING_SOURCES)[number],
      )
    ) {
      return c.json(
        {
          error: "invalid_billing_source",
          message:
            'billingSource must be "gateway", "bitrouter", "cerebras", "openai", "groq", "vast", "fal", "elevenlabs", or "suno".',
        },
        400,
      );
    }
    const requestedFamily = c.req.query("productFamily");
    if (
      requestedFamily != null &&
      requestedFamily !== "" &&
      !PRODUCT_FAMILIES.includes(
        requestedFamily as (typeof PRODUCT_FAMILIES)[number],
      )
    ) {
      return c.json(
        {
          error: "invalid_product_family",
          message:
            'productFamily must be "language", "embedding", "image", "video", "music", "tts", "stt", or "voice_clone".',
        },
        400,
      );
    }

    const billingSource = requestedSource || undefined;
    const provider = c.req.query("provider") || undefined;
    const model = c.req.query("model") || undefined;
    const productFamily = requestedFamily || undefined;
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
