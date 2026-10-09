// Handles v1 cloud API v1 apps id earnings history route traffic with route-local auth expectations.

import { requireAuthOrApiKeyWithOrg } from "@elizaos/cloud-shared/lib/auth";
import { isAppKeyOutOfScope } from "@elizaos/cloud-shared/lib/auth/app-key-scope";
import { appEarningsService } from "@elizaos/cloud-shared/lib/services/app-earnings";
import { appsService } from "@elizaos/cloud-shared/lib/services/apps";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { earningsHistoryQuerySchema as QuerySchema } from "./history-query";

/**
 * GET /api/v1/apps/[id]/earnings/history
 * Gets transaction history for app earnings.
 * Supports filtering by transaction type and pagination.
 * Requires ownership verification.
 *
 * Query Parameters:
 * - `limit`: Maximum number of transactions (default: 50, max: 100, 0 for none).
 * - `offset`: Offset for pagination (default: 0).
 * - `type`: Filter by transaction type - "inference_markup" | "purchase_share" | "withdrawal" | "adjustment".
 *
 * @param request - Request with optional filtering and pagination query parameters.
 * @param params - Route parameters containing the app ID.
 * @returns Transaction history with pagination information.
 */
async function __hono_GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { user, apiKey } = await requireAuthOrApiKeyWithOrg(request);
    const { id } = await params;

    // Parse query params (filter out nulls to use defaults)
    const searchParams = new URL(request.url).searchParams;
    const queryInput: Record<string, string> = {};
    const limitParam = searchParams.get("limit");
    const offsetParam = searchParams.get("offset");
    const typeParam = searchParams.get("type");
    if (limitParam) queryInput.limit = limitParam;
    if (offsetParam) queryInput.offset = offsetParam;
    if (typeParam) queryInput.type = typeParam;

    const queryResult = QuerySchema.safeParse(queryInput);

    if (!queryResult.success) {
      return Response.json(
        {
          success: false,
          error: "Invalid query parameters",
          details: queryResult.error.format(),
        },
        { status: 400 },
      );
    }

    const { limit, offset, type } = queryResult.data;

    // Verify the app exists and belongs to the user's organization
    const app = await appsService.getById(id);

    if (!app) {
      return Response.json(
        {
          success: false,
          error: "App not found",
        },
        { status: 404 },
      );
    }

    if (app.organization_id !== user.organization_id) {
      return Response.json(
        {
          success: false,
          error: "Access denied",
        },
        { status: 403 },
      );
    }
    if (await isAppKeyOutOfScope(apiKey?.id, id)) {
      return Response.json(
        {
          success: false,
          error: "Access denied",
        },
        { status: 403 },
      );
    }

    // Get transaction history
    const transactions = await appEarningsService.getTransactionHistory(id, {
      limit,
      offset,
      type,
    });

    return Response.json({
      success: true,
      transactions,
      pagination: {
        limit,
        offset,
        hasMore: transactions.length === limit,
      },
    });
  } catch (error) {
    logger.error("Failed to get app earnings history:", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to get earnings history",
      },
      { status: 500 },
    );
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.get("/", async (c) =>
  __hono_GET(c.req.raw, {
    params: Promise.resolve({ id: c.req.param("id")! }),
  }),
);
export default __hono_app;
