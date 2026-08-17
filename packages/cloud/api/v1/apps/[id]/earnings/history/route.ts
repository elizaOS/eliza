// Handles v1 cloud API v1 apps id earnings history route traffic with route-local auth expectations.
import { Hono } from "hono";
import { z } from "zod";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { isAppKeyOutOfScope } from "@/lib/auth/app-key-scope";
import { appEarningsService } from "@/lib/services/app-earnings";
import { appsService } from "@/lib/services/apps";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const DEFAULT_EARNINGS_HISTORY_LIMIT = 50;
const MAX_EARNINGS_HISTORY_LIMIT = 100;

class EarningsHistoryLimitError extends Error {
  constructor(message = "Invalid limit") {
    super(message);
    this.name = "EarningsHistoryLimitError";
  }
}

/**
 * GET /api/v1/apps/[id]/earnings/history `limit` is ledger-page size
 * identity, leftover tax after earnings `days` (#20672). Stock develop
 * used z.coerce.number(), which treated `1e2` / `007` / `0x10` as a
 * page size instead of a 400. offset / type stay untouched. Missing /
 * empty still means 50. Exact integers clamp at 100.
 */
function parseEarningsHistoryLimitQuery(
  searchParams: URLSearchParams,
): number {
  const requested = searchParams.getAll("limit");
  if (requested.length > 1) {
    throw new EarningsHistoryLimitError();
  }
  const raw = requested[0];
  if (raw == null || raw === "") {
    return DEFAULT_EARNINGS_HISTORY_LIMIT;
  }
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new EarningsHistoryLimitError();
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new EarningsHistoryLimitError();
  }
  return Math.min(parsed, MAX_EARNINGS_HISTORY_LIMIT);
}

const QuerySchema = z.object({
  offset: z.coerce.number().int().min(0).optional().default(0),
  type: z
    .enum(["inference_markup", "purchase_share", "withdrawal", "adjustment"])
    .optional(),
});

/**
 * GET /api/v1/apps/[id]/earnings/history
 * Gets transaction history for app earnings.
 * Supports filtering by transaction type and pagination.
 * Requires ownership verification.
 *
 * Query Parameters:
 * - `limit`: Maximum number of transactions (default: 50, max: 100).
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
    let limit: number;
    try {
      limit = parseEarningsHistoryLimitQuery(searchParams);
    } catch (limitError) {
      if (limitError instanceof EarningsHistoryLimitError) {
        return Response.json(
          { success: false, error: limitError.message },
          { status: 400 },
        );
      }
      throw limitError;
    }
    const queryInput: Record<string, string> = {};
    const offsetParam = searchParams.get("offset");
    const typeParam = searchParams.get("type");
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

    const { offset, type } = queryResult.data;

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
