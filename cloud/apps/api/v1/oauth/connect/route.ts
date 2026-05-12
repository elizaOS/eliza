/**
 * POST /api/v1/oauth/connect
 *
 * Initiate OAuth flow for a platform.
 * Returns an authorization URL for the user to visit.
 */

import { Hono } from "hono";
import { failureResponse, ApiError as WorkerApiError } from "@/lib/api/cloud-worker-errors";
import { ApiError } from "@/lib/api/errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  internalErrorResponse,
  OAuthError,
  oauthService,
  validationErrorResponse,
} from "@/lib/services/oauth";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

interface ConnectRequestBody {
  platform: string;
  redirectUrl?: string;
  scopes?: string[];
}

function isValidString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  let organizationId: string | undefined;
  let platform: string | undefined;

  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    organizationId = user.organization_id;

    let body: ConnectRequestBody;
    try {
      body = (await c.req.json()) as ConnectRequestBody;
    } catch {
      return c.json(validationErrorResponse("Invalid JSON body"), 400);
    }

    if (!isValidString(body.platform)) {
      return c.json(
        validationErrorResponse("platform is required and must be a non-empty string"),
        400,
      );
    }

    // Sanitize platform — lowercase and max 50 chars.
    body.platform = body.platform.toLowerCase().slice(0, 50);
    platform = body.platform;

    logger.info("[API] POST /api/v1/oauth/connect", {
      organizationId,
      platform,
      hasScopes: !!body.scopes,
    });

    const result = await oauthService.initiateAuth({
      organizationId,
      userId: user.id,
      platform,
      redirectUrl: body.redirectUrl,
      scopes: body.scopes,
    });

    return c.json(result);
  } catch (error) {
    logger.error("[API] POST /api/v1/oauth/connect error", {
      organizationId,
      platform,
      error: error instanceof Error ? error.message : String(error),
    });

    if (error instanceof WorkerApiError) {
      return failureResponse(c, error);
    }
    if (error instanceof ApiError) {
      return c.json(error.toJSON(), error.status as 400);
    }
    if (error instanceof OAuthError) {
      return c.json(error.toResponse(), error.httpStatus as 400);
    }

    return c.json(internalErrorResponse(), 500);
  }
});

export default app;
