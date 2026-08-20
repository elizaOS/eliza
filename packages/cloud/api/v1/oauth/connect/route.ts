/**
 * POST /api/v1/oauth/connect
 *
 * Initiate OAuth flow for a platform.
 * Returns an authorization URL for the user to visit.
 */

import { Hono } from "hono";
import {
  failureResponse,
  ApiError as WorkerApiError,
} from "@/lib/api/cloud-worker-errors";
import { ApiError } from "@/lib/api/errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  internalErrorResponse,
  OAuthError,
  oauthService,
  validationErrorResponse,
} from "@/lib/services/oauth";
import { decodeRequestJson } from "@/lib/utils/json-parsing";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

interface ConnectRequestBody {
  platform: string;
  redirectUrl?: string;
  scopes?: string[];
  capabilities?: string[];
  capabilityRequest?: unknown;
  connectionId?: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === "string" && entry.trim().length > 0)
  );
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

    if (body.scopes !== undefined && !isNonEmptyStringArray(body.scopes)) {
      return c.json(
        validationErrorResponse("scopes must be a non-empty string array"),
        400,
      );
    }
    if (
      body.capabilities !== undefined &&
      !isNonEmptyStringArray(body.capabilities)
    ) {
      return c.json(
        validationErrorResponse(
          "capabilities must be a non-empty string array",
        ),
        400,
      );
    }
    if (body.scopes !== undefined && body.capabilities !== undefined) {
      return c.json(
        validationErrorResponse(
          "Request either named capabilities or raw scopes, not both",
        ),
        400,
      );
    }
    if (
      body.capabilityRequest !== undefined &&
      body.capabilities === undefined
    ) {
      return c.json(
        validationErrorResponse(
          "capabilityRequest requires named capabilities",
        ),
        400,
      );
    }
    if (
      body.connectionId !== undefined &&
      (!isValidString(body.connectionId) ||
        !UUID_PATTERN.test(body.connectionId) ||
        body.capabilities === undefined)
    ) {
      return c.json(
        validationErrorResponse(
          "connectionId is only valid with named capabilities",
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
      capabilityCount: body.capabilities?.length,
    });

    const result = await oauthService.initiateAuth({
      organizationId,
      userId: user.id,
      platform,
      redirectUrl: body.redirectUrl,
      scopes: body.scopes,
      capabilities: body.capabilities,
      capabilityRequest: body.capabilityRequest,
      connectionId: body.connectionId,
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
