import { Hono } from "hono";
import { errorToResponse } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { provisioningJobService } from "@/lib/services/provisioning-jobs";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import type { AppEnv } from "@/types/cloud-worker-env";

const CORS_METHODS = "POST, OPTIONS";

/**
 * POST /api/v1/eliza/agents/[agentId]/snapshot
 *
 * Enqueue an `agent_snapshot` job. The orchestrator daemon pulls
 * runtime state from the bridge URL and persists a row in
 * `agent_sandbox_backups`. Same op as before, but executed from the
 * daemon so it uses a consistent network identity for outbound traffic
 * to cores (Worker bridge-HTTP previously hit SSRF guards / firewalls).
 *
 * Returns 202 + jobId; clients poll `/api/v1/jobs/<id>` for the
 * backup metadata.
 */
async function __hono_POST(
  request: Request,
  env: AppEnv["Bindings"],
  { params }: { params: Promise<{ agentId: string }> },
) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { agentId } = await params;

    const agent = await elizaSandboxService.getAgentForWrite(
      agentId,
      user.organization_id,
    );
    if (!agent) {
      return applyCorsHeaders(
        Response.json(
          { success: false, error: "Agent not found" },
          { status: 404 },
        ),
        CORS_METHODS,
      );
    }

    if (agent.status !== "running") {
      return applyCorsHeaders(
        Response.json(
          { success: false, error: "Sandbox is not running" },
          { status: 409 },
        ),
        CORS_METHODS,
      );
    }

    const enqueueResult = await provisioningJobService.enqueueAgentSnapshotOnce(
      {
        agentId,
        organizationId: user.organization_id,
        userId: user.id,
        snapshotType: "manual",
      },
    );

    void provisioningJobService.triggerImmediate(env).catch(() => {
      // Logged inside the service.
    });

    return applyCorsHeaders(
      Response.json(
        {
          success: true,
          created: enqueueResult.created,
          alreadyInProgress: !enqueueResult.created,
          data: {
            agentId,
            action: "snapshot",
            jobId: enqueueResult.job.id,
            status: enqueueResult.job.status,
          },
          polling: {
            endpoint: `/api/v1/jobs/${enqueueResult.job.id}`,
            intervalMs: 5_000,
            expectedDurationMs: 45_000,
          },
        },
        { status: 202 },
      ),
      CORS_METHODS,
    );
  } catch (error) {
    return applyCorsHeaders(errorToResponse(error), CORS_METHODS);
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.options("/", () => handleCorsOptions(CORS_METHODS));
__hono_app.post("/", async (c) =>
  __hono_POST(c.req.raw, c.env, {
    params: Promise.resolve({ agentId: c.req.param("agentId")! }),
  }),
);
export default __hono_app;
