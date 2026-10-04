/**
 * Brokered token refresh endpoint for first-party plugins.
 *
 * POST /api/v1/connections/:id/refresh revalidates or refreshes the credential
 * behind an opaque connection ID and returns token metadata only (expiry,
 * scopes, whether a refresh happened). Raw token material is never exposed.
 * This recovery endpoint intentionally stays outside paid standing admission:
 * restoring or revoking credential validity must remain available to an
 * authenticated account even when new external work is fenced.
 */

import { ApiError } from "@elizaos/cloud-shared/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@elizaos/cloud-shared/lib/auth";
import {
  credentialBroker,
  internalErrorResponse,
  OAuthError,
} from "@elizaos/cloud-shared/lib/services/oauth";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

async function __hono_POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: connectionId } = await params;
  let organizationId: string | undefined;

  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    organizationId = user.organization_id;

    const result = await credentialBroker.refreshToken({
      organizationId,
      userId: user.id,
      connectionId,
    });

    return Response.json(result);
  } catch (error) {
    if (error instanceof ApiError) {
      return Response.json(error.toJSON(), { status: error.status });
    }
    if (error instanceof OAuthError) {
      return Response.json(error.toResponse(), { status: error.httpStatus });
    }
    logger.error("[API] POST /api/v1/connections/:id/refresh error", {
      organizationId,
      connectionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      internalErrorResponse("Connection token refresh failed"),
      {
        status: 500,
      },
    );
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.post("/", async (c) =>
  __hono_POST(c.req.raw, {
    params: Promise.resolve({ id: c.req.param("id")! }),
  }),
);
export default __hono_app;
