import {
  addPublicReadHeaders,
  publicRateLimit,
  successResponse,
  withErrorHandling,
} from "@feed/api";
import type { NextRequest } from "next/server";
import { getPublicResolutionAudit } from "../../_resolution-audit";

export const GET = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> },
  ) => {
    const { error, rateLimitInfo } = await publicRateLimit(request);
    if (error) return error;

    const { id: marketId } = await context.params;
    const audit = await getPublicResolutionAudit(marketId);

    if (!audit) {
      return successResponse({ error: "Market not found" }, 404);
    }

    const response = successResponse({
      success: true,
      marketId,
      resolutionAudit: audit,
    });

    if (rateLimitInfo) addPublicReadHeaders(response, rateLimitInfo);
    return response;
  },
);
