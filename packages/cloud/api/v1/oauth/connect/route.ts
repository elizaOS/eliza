/**
 * POST /api/v1/oauth/connect
 *
 * Initiate OAuth flow for a platform.
 * Returns an authorization URL for the user to visit.
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import {
  failureResponse,
  ApiError as WorkerApiError,
} from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { ApiError } from "@elizaos/cloud-shared/lib/api/errors";
import {
  internalErrorResponse,
  OAuthError,
  oauthService,
  validationErrorResponse,
} from "@elizaos/cloud-shared/lib/services/oauth";
import { decodeRequestJson } from "@elizaos/cloud-shared/lib/utils/json-parsing";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

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

    const decodedBody = await decodeRequestJson(c.req);
    if (!decodedBody.ok) {
      // error-policy:J3 malformed JSON is invalid request input.
      return c.json(validationErrorResponse("Invalid JSON body"), 400);
    }
    const body = decodedBody.value as ConnectRequestBody;

    if (!isValidString(body.platform)) {
      return c.json(
        validationErrorResponse(
          "platform is required and must be a non-empty string",
        ),
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
