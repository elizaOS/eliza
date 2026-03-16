// app/api/v1/models/[...model]/route.ts
import { requireAuthOrApiKey } from "@/lib/auth";
import { logger } from "@/lib/utils/logger";
import { getProvider } from "@/lib/providers";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/models/[...model]
 * Gets details for a specific model by its identifier.
 * Supports both slash-separated and URL-encoded model names (e.g., "openai/gpt-4o-mini").
 *
 * @param request - The Next.js request object.
 * @param context - Route context containing model segments as an array.
 * @returns Model details from the provider gateway.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ model: string[] }> },
) {
  try {
    await requireAuthOrApiKey(request);

    const resolvedParams = await context.params;
    const modelSegments = resolvedParams.model;

    // Validate that we have model segments
    if (!modelSegments || modelSegments.length === 0) {
      return Response.json(
        {
          error: {
            message: "Model parameter is required",
            type: "invalid_request_error",
            code: "missing_parameter",
          },
        },
        { status: 400 },
      );
    }

    // Join segments to support both "openai/gpt-4o-mini" and "openai%2Fgpt-4o-mini"
    const model = modelSegments.join("/");

    const provider = getProvider();
    const response = await provider.getModel(model);

    if (!response.ok) {
      if (response.status === 404) {
        return Response.json(
          {
            error: {
              message: `Model '${model}' not found`,
              type: "invalid_request_error",
              code: "model_not_found",
            },
          },
          { status: 404 },
        );
      }
      throw new Error(`Gateway error: ${response.status}`);
    }

    const data = await response.json();
    return Response.json(data);
  } catch (error) {
    logger.error("Error fetching model:", error);
    return Response.json(
      {
        error: {
          message: "Failed to fetch model details",
          type: "api_error",
        },
      },
      { status: 500 },
    );
  }
}
