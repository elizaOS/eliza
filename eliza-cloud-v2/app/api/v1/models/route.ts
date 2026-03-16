import { requireAuthOrApiKey } from "@/lib/auth";
import { logger } from "@/lib/utils/logger";
import {
  getAnonymousUser,
  getOrCreateAnonymousUser,
} from "@/lib/auth-anonymous";
import { getProvider } from "@/lib/providers";
import type { OpenAIModelsResponse } from "@/lib/providers/types";
import type { NextRequest } from "next/server";

// This route uses cookies for auth, so it must be dynamic
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/models
 * Lists all available AI models in OpenAI-compatible format.
 * Supports both authenticated and anonymous users.
 * Response is cached for 1 hour since model list rarely changes.
 *
 * @param request - The Next.js request object.
 * @returns OpenAI-compatible models list response.
 */
export async function GET(request: NextRequest) {
  try {
    // Support both authenticated and anonymous users
    try {
      await requireAuthOrApiKey(request);
    } catch (error) {
      // Fallback to anonymous user
      const anonData = await getAnonymousUser();
      if (!anonData) {
        // Create new anonymous session if none exists
        await getOrCreateAnonymousUser();
      }
    }

    const provider = getProvider();
    const response = await provider.listModels();
    const data: OpenAIModelsResponse = await response.json();

    // Return OpenAI-compatible format with cache headers
    return Response.json(data, {
      headers: {
        "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=7200",
      },
    });
  } catch (error) {
    logger.error("Error fetching models:", error);
    return Response.json(
      {
        error: {
          message: "Failed to fetch available models",
          type: "api_error",
        },
      },
      { status: 500 },
    );
  }
}
