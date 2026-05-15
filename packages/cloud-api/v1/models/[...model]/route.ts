// app/api/v1/models/[...model]/route.ts

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { nextStyleParams } from "@/lib/api/hono-next-style-params";
import { requireAuthOrApiKey } from "@/lib/auth";
import { getGroqCatalogModel, isGroqNativeModel } from "@/lib/models";
import { getProviderForModel, hasGroqProviderConfigured } from "@/lib/providers";
import { getCachedGatewayModelById } from "@/lib/services/model-catalog";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * GET /api/v1/models/[...model]
 * Gets details for a specific model by its identifier.
 * Supports both slash-separated and URL-encoded model names (e.g., "openai/gpt-5-mini").
 *
 * @param request - The Next.js request object.
 * @param context - Route context containing model segments as an array.
 * @returns Model details from the provider gateway.
 */
async function __next_GET(request: Request, context: { params: Promise<{ model: string[] }> }) {
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

    // Join segments to support both "openai/gpt-5-mini" and "openai%2Fgpt-5-mini"
    const model = modelSegments.join("/");

    if (isGroqNativeModel(model)) {
      if (!hasGroqProviderConfigured()) {
        return Response.json(
          {
            error: {
              message: `Model '${model}' is not configured on this deployment`,
              type: "invalid_request_error",
              code: "model_not_configured",
            },
          },
          { status: 503 },
        );
      }

      const groqModel = getGroqCatalogModel(model);
      if (groqModel) {
        return Response.json(groqModel);
      }
    }

    try {
      const cachedModel = await getCachedGatewayModelById(model);
      if (cachedModel) {
        return Response.json(cachedModel);
      }
    } catch (error) {
      logger.warn("Error reading cached model catalog, falling back to provider", {
        model,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const provider = getProviderForModel(model);
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

const ROUTE_PARAM_SPEC = [{ name: "model", splat: true }] as const;
const honoRouter = new Hono<AppEnv>();
honoRouter.get("/", async (c) => {
  try {
    return await __next_GET(c.req.raw, nextStyleParams(c, ROUTE_PARAM_SPEC));
  } catch (error) {
    return failureResponse(c, error);
  }
});
export default honoRouter;
