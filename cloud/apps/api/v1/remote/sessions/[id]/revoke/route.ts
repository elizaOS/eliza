import { Hono } from "hono";

import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * POST /api/v1/remote/sessions/:id/revoke
 *
 * T9a — Revokes an active or pending remote session. Only the owning
 * organization can revoke.
 */

import { remoteSessionsRepository } from "@/db/repositories/remote-sessions";
import { errorToResponse } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";

const CORS_METHODS = "POST, OPTIONS";

async function __hono_POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { id } = await params;

    const existing = await remoteSessionsRepository.findByIdAndOrg(id, user.organization_id);
    if (!existing) {
      return applyCorsHeaders(
        Response.json({ success: false, error: "Session not found" }, { status: 404 }),
        CORS_METHODS,
      );
    }

    if (existing.status === "revoked" || existing.status === "denied") {
      return applyCorsHeaders(
        Response.json({
          success: true,
          data: {
            id: existing.id,
            status: existing.status,
            alreadyEnded: true,
          },
        }),
        CORS_METHODS,
      );
    }

    const revoked = await remoteSessionsRepository.revoke(id, user.organization_id);
    if (!revoked) {
      return applyCorsHeaders(
        Response.json({ success: false, error: "Revoke failed" }, { status: 409 }),
        CORS_METHODS,
      );
    }

    return applyCorsHeaders(
      Response.json({
        success: true,
        data: {
          id: revoked.id,
          status: revoked.status,
          endedAt: revoked.ended_at,
        },
      }),
      CORS_METHODS,
    );
  } catch (error) {
    return applyCorsHeaders(errorToResponse(error), CORS_METHODS);
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.options("/", () => handleCorsOptions(CORS_METHODS));
__hono_app.post("/", async (c) =>
  __hono_POST(c.req.raw, { params: Promise.resolve({ id: c.req.param("id")! }) }),
);
export default __hono_app;
