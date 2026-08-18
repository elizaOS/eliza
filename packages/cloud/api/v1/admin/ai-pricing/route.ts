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
import {
  PRICING_BILLING_SOURCES,
  PRICING_PRODUCT_FAMILIES,
} from "@/lib/services/ai-pricing-definitions";
import { decodeRequestJson } from "@/lib/utils/json-parsing";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

const OverrideSchema = z.object({
  billingSource: z.enum([
    "gateway",
    "bitrouter",
    "cerebras",
    "openai",
    "groq",
    "vast",
    "fal",
    "elevenlabs",
    "suno",
  ]),
  provider: z.string().min(1),
  model: z.string().min(1),
  productFamily: z.enum([
    "language",
    "embedding",
    "image",
    "video",
    "music",
    "tts",
    "stt",
    "voice_clone",
  ]),
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
      !PRICING_BILLING_SOURCES.includes(
        requestedSource as (typeof PRICING_BILLING_SOURCES)[number],
      )
    ) {
      return c.json(
        {
          error: "invalid_billing_source",
          message: `billingSource must be one of: ${PRICING_BILLING_SOURCES.join(", ")}.`,
        },
        400,
      );
    }
    const requestedFamily = c.req.query("productFamily");
    if (
      requestedFamily != null &&
      requestedFamily !== "" &&
      !PRICING_PRODUCT_FAMILIES.includes(
        requestedFamily as (typeof PRICING_PRODUCT_FAMILIES)[number],
      )
    ) {
      return c.json(
        {
          error: "invalid_product_family",
          message: `productFamily must be one of: ${PRICING_PRODUCT_FAMILIES.join(", ")}.`,
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

    const decodedRawBody = await decodeRequestJson(c.req);
    if (!decodedRawBody.ok) {
      // error-policy:J3 malformed JSON is invalid request input.
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const rawBody = decodedRawBody.value;
    const body = RefreshSchema.parse(rawBody);
    const refresh = await refreshPricingCatalog(body.sources);
    return c.json(refresh, refresh.success ? 200 : 207);
  } catch (error) {
    return failureResponse(c, error);
  }
});

app.put("/", async (c) => {
  try {
    const { user } = await requireAdmin(c);

    const decodedOverrideBody = await decodeRequestJson(c.req);
    if (!decodedOverrideBody.ok) {
      // error-policy:J3 malformed JSON is invalid request input.
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const overrideBody = decodedOverrideBody.value;
    const body = OverrideSchema.parse(overrideBody);
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
