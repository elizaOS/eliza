// Handles v1 cloud API v1 eliza agents agentid backups predeletion route traffic with route-local auth expectations.
import { Hono } from "hono";
import { errorToResponse } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import type { AppEnv } from "@/types/cloud-worker-env";

const CORS_METHODS = "GET, OPTIONS";

/**
 * GET /api/v1/eliza/agents/[agentId]/backups/predeletion
 *
 * Recovery/export surface for the cascade-immune pre-deletion capture
 * (#18517): the newest retention row for this agent under the caller's
 * organization, with `state_data` decrypted and fetched from the object store
 * when offloaded. Unlike the sibling backups listing, this deliberately does
 * NOT require a live sandbox row — retention rows are the artifact that
 * outlives the delete, and this route is how an owner retrieves that final
 * state afterward. Waiver rows (`captureUnsupported: true`) return null state:
 * the image had no snapshot endpoint by construction.
 */
async function __hono_GET(
  request: Request,
  { params }: { params: Promise<{ agentId: string }> },
) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { agentId } = await params;

    const recovery = await elizaSandboxService.getPredeletionRecovery(
      agentId,
      user.organization_id,
    );
    if (!recovery) {
      return applyCorsHeaders(
        Response.json(
          {
            success: false,
            error: "No pre-deletion backup is retained for this agent",
          },
          { status: 404 },
        ),
        CORS_METHODS,
      );
    }

    return applyCorsHeaders(
      Response.json({
        success: true,
        data: {
          id: recovery.id,
          agentId: recovery.agent_id,
          deletionAttemptId: recovery.deletion_attempt_id,
          sandboxId: recovery.sandbox_id,
          captureUnsupported: recovery.capture_unsupported,
          sizeBytes: recovery.size_bytes,
          createdAt: recovery.created_at,
          expiresAt: recovery.expires_at,
          stateData: recovery.capture_unsupported ? null : recovery.state_data,
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
__hono_app.get("/", async (c) =>
  __hono_GET(c.req.raw, {
    params: Promise.resolve({ agentId: c.req.param("agentId")! }),
  }),
);
export default __hono_app;
