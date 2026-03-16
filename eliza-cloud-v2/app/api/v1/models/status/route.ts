/**
 * Model Availability Status API
 *
 * Checks whether specific AI models are currently available.
 * For image models, verifies the provider is configured and reachable.
 */

import { requireAuthOrApiKey } from "@/lib/auth";
import {
  getAnonymousUser,
  getOrCreateAnonymousUser,
} from "@/lib/auth-anonymous";
import { getProvider } from "@/lib/providers";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

interface ModelAvailability {
  modelId: string;
  available: boolean;
  reason?: string;
}

interface ModelStatusResponse {
  models: ModelAvailability[];
  timestamp: number;
}

/**
 * Known unavailable providers/models
 * Update this based on actual provider status
 */
const UNAVAILABLE_PROVIDERS = new Set([
  "bfl", // BFL/Flux not currently available
]);

/**
 * Check if a model's provider is known to be unavailable
 */
function isProviderUnavailable(modelId: string): {
  unavailable: boolean;
  reason?: string;
} {
  const provider = modelId.split("/")[0];

  if (UNAVAILABLE_PROVIDERS.has(provider)) {
    return {
      unavailable: true,
      reason: `${provider} provider is currently unavailable`,
    };
  }

  return { unavailable: false };
}

/**
 * POST /api/v1/models/status
 *
 * Check availability of specific models.
 * Accepts an array of model IDs and returns their availability status.
 */
export async function POST(request: NextRequest) {
  // Support both authenticated and anonymous users
  try {
    await requireAuthOrApiKey(request);
  } catch {
    const anonData = await getAnonymousUser();
    if (!anonData) {
      await getOrCreateAnonymousUser();
    }
  }

  const body = await request.json();
  const { modelIds } = body as { modelIds: string[] };

  if (!Array.isArray(modelIds) || modelIds.length === 0) {
    return Response.json(
      { error: "modelIds array is required" },
      { status: 400 },
    );
  }

  if (modelIds.length > 50) {
    return Response.json(
      { error: "Maximum 50 models can be checked at once" },
      { status: 400 },
    );
  }

  // Validate each modelId is a non-empty string
  if (!modelIds.every((id) => typeof id === "string" && id.length > 0)) {
    return Response.json(
      { error: "Each modelId must be a non-empty string" },
      { status: 400 },
    );
  }

  const provider = getProvider();

  // Get all models from gateway catalog
  const listResponse = await provider.listModels();
  const listData = (await listResponse.json()) as { data?: { id: string }[] };
  const gatewayModelIds = new Set(listData.data?.map((m) => m.id) || []);

  // Check availability for each requested model
  const results: ModelAvailability[] = modelIds.map((modelId) => {
    // First check if provider is known to be unavailable
    const providerCheck = isProviderUnavailable(modelId);
    if (providerCheck.unavailable) {
      return {
        modelId,
        available: false,
        reason: providerCheck.reason,
      };
    }

    // Then check if model exists in gateway
    const inGateway = gatewayModelIds.has(modelId);
    if (!inGateway) {
      return {
        modelId,
        available: false,
        reason: "Model not found in gateway",
      };
    }

    return {
      modelId,
      available: true,
    };
  });

  const response: ModelStatusResponse = {
    models: results,
    timestamp: Date.now(),
  };

  return Response.json(response, {
    headers: {
      "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
    },
  });
}
