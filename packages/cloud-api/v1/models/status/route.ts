/**
 * POST /api/v1/models/status
 * Check availability of specific AI models against the gateway catalog and
 * provider config flags. Public — auth probe is best-effort.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { getCurrentUser } from "@/lib/auth/workers-hono-auth";
import { isGroqNativeModel } from "@/lib/models";
import { hasGroqProviderConfigured } from "@/lib/providers";
import {
  getAiProviderConfigurationError,
  hasAnyAiProviderConfigured,
  hasGatewayProviderConfigured,
} from "@/lib/providers/language-model";
import { getCachedMergedModelCatalog } from "@/lib/services/model-catalog";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

interface ModelAvailability {
  modelId: string;
  available: boolean;
  reason?: string;
}

const UNAVAILABLE_PROVIDERS = new Set([
  "bfl", // BFL/Flux not currently available
]);

function isProviderUnavailable(modelId: string): { unavailable: boolean; reason?: string } {
  const provider = modelId.split("/")[0];
  if (UNAVAILABLE_PROVIDERS.has(provider)) {
    return { unavailable: true, reason: `${provider} provider is currently unavailable` };
  }
  return { unavailable: false };
}

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    await getCurrentUser(c).catch(() => null);

    const body = (await c.req.json()) as { modelIds?: unknown };
    const modelIds = body.modelIds;

    if (!Array.isArray(modelIds) || modelIds.length === 0) {
      return c.json({ error: "modelIds array is required" }, 400);
    }

    if (modelIds.length > 50) {
      return c.json({ error: "Maximum 50 models can be checked at once" }, 400);
    }

    if (!modelIds.every((id) => typeof id === "string" && id.length > 0)) {
      return c.json({ error: "Each modelId must be a non-empty string" }, 400);
    }

    const gatewayConfigured = hasGatewayProviderConfigured();
    const groqConfigured = hasGroqProviderConfigured();

    if (!hasAnyAiProviderConfigured()) {
      return c.json({ error: getAiProviderConfigurationError() }, 503);
    }

    const gatewayModelIds = new Set((await getCachedMergedModelCatalog()).map((model) => model.id));

    const results: ModelAvailability[] = (modelIds as string[]).map((modelId) => {
      const providerCheck = isProviderUnavailable(modelId);
      if (providerCheck.unavailable) {
        return { modelId, available: false, reason: providerCheck.reason };
      }

      if (isGroqNativeModel(modelId)) {
        return {
          modelId,
          available: groqConfigured,
          reason: groqConfigured ? undefined : "Groq models are not configured on this deployment",
        };
      }

      if (!gatewayConfigured) {
        return {
          modelId,
          available: false,
          reason: "Gateway provider is not configured on this deployment",
        };
      }

      const inGateway = gatewayModelIds.has(modelId);
      if (!inGateway) {
        return { modelId, available: false, reason: "Model not found in gateway" };
      }

      return { modelId, available: true };
    });

    c.header("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
    return c.json({ models: results, timestamp: Date.now() });
  } catch (error) {
    logger.error("Error fetching model status:", error);
    return failureResponse(c, error);
  }
});

export default app;
