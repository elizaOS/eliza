/** Handles owner-scoped remote-session revocation at the HTTP boundary. */

import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

/**
 * POST /api/v1/remote/sessions/:id/revoke
 *
 * T9a — Revokes an active or pending remote session. Only the current
 * authenticated agent owner can revoke it.
 */

import { isRemotePairingUuid } from "@elizaos/cloud-shared/db/crypto/remote-pairing-code";
import { remoteSessionsRepository } from "@elizaos/cloud-shared/db/repositories/remote-sessions";
import { errorToResponse } from "@elizaos/cloud-shared/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@elizaos/cloud-shared/lib/auth";
import {
  applyCorsHeaders,
  handleCorsOptions,
} from "@elizaos/cloud-shared/lib/services/proxy/cors";

const CORS_METHODS = "POST, OPTIONS";

async function __hono_POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { id } = await params;
    if (!isRemotePairingUuid(id)) {
      return applyCorsHeaders(
        Response.json(
          { success: false, error: "Session id must be a UUID" },
          { status: 400 },
        ),
        CORS_METHODS,
      );
    }

    const result = await remoteSessionsRepository.revoke(
      id,
      user.organization_id,
      user.id,
    );
    if (!result) {
      return applyCorsHeaders(
        Response.json(
          { success: false, error: "Session not found" },
          { status: 404 },
        ),
        CORS_METHODS,
      );
    }

    const { alreadyEnded, session } = result;
    if (alreadyEnded) {
      return applyCorsHeaders(
        Response.json({
          success: true,
          data: {
            id: session.id,
            status: session.status,
            alreadyEnded,
            endedAt: session.ended_at,
            cleanup: result.cleanup,
          },
        }),
        CORS_METHODS,
      );
    }

    return applyCorsHeaders(
      Response.json({
        success: true,
        data: {
          id: session.id,
          status: session.status,
          alreadyEnded,
          endedAt: session.ended_at,
          cleanup: result.cleanup,
        },
      }),
      CORS_METHODS,
    );
  } catch (error) {
    // error-policy:J1 the HTTP boundary translates typed/internal failures.
    return applyCorsHeaders(errorToResponse(error), CORS_METHODS);
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.options("/", () => handleCorsOptions(CORS_METHODS));
__hono_app.post("/", async (c) =>
  __hono_POST(c.req.raw, {
    params: Promise.resolve({ id: c.req.param("id")! }),
  }),
);
export default __hono_app;
