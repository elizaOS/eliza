// Handles compatibility cloud API compat agents id logs route traffic through route-local auth checks.
import { Hono } from "hono";
/**
 * GET /api/compat/agents/[id]/logs
 *
 * Compat path for thin clients. Enqueues an `agent_logs` job for the
 * orchestrator daemon to SSH `docker logs --tail N` on the assigned
 * core. Returns 202 + jobId; the client polls
 * `/api/v1/jobs/<id>` for the logs envelope.
 *
 * Previously this route called `fetch(bridge_url + "/logs")` directly
 * from the CF Worker. That path returned empty for any non-running
 * container (no bridge HTTP when the agent is stopped or crashed) and
 * was also subject to SSRF guards / firewall on the Worker→core hop.
 * The daemon path works uniformly.
 */
import { envelope, errorEnvelope } from "@/lib/api/compat-envelope";
import type { RouteContext } from "@/lib/api/hono-next-style-params";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { provisioningJobService } from "@/lib/services/provisioning-jobs";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import { requireCompatAuth } from "../../../_lib/auth";
import { handleCompatCorsOptions, withCompatCors } from "../../../_lib/cors";
import { handleCompatError } from "../../../_lib/error-handler";

const CORS_METHODS = "GET, OPTIONS";

async function __hono_GET(
  request: Request,
  { params }: RouteContext<{ id: string }>,
  env: AppEnv["Bindings"],
) {
  try {
    const { user } = await requireCompatAuth(request);
    const { id: agentId } = await params;

    const agent = await elizaSandboxService.getAgent(
      agentId,
      user.organization_id,
    );
    if (!agent) {
      return withCompatCors(
        Response.json(errorEnvelope("Agent not found"), { status: 404 }),
        CORS_METHODS,
      );
    }

    const url = new URL(request.url);
    const rawTail = parseInt(url.searchParams.get("tail") ?? "100", 10);
    const tail = Math.max(
      1,
      Math.min(Number.isFinite(rawTail) ? rawTail : 100, 5000),
    );

    const enqueueResult = await provisioningJobService.enqueueAgentLogsOnce({
      agentId,
      organizationId: user.organization_id,
      userId: user.id,
      tail,
    });

    void provisioningJobService.triggerImmediate(env).catch(() => {
      // Logged inside the service.
    });

    logger.info("[compat] Logs job enqueued", {
      agentId,
      tail,
      jobId: enqueueResult.job.id,
      created: enqueueResult.created,
    });

    return withCompatCors(
      Response.json(
        envelope({
          jobId: enqueueResult.job.id,
          status: enqueueResult.job.status,
          tail,
          agentStatus: agent.status,
          alreadyInProgress: !enqueueResult.created,
          polling: {
            endpoint: `/api/v1/jobs/${enqueueResult.job.id}`,
            intervalMs: 2_000,
            expectedDurationMs: 15_000,
          },
        }),
        { status: 202 },
      ),
      CORS_METHODS,
    );
  } catch (err) {
    return handleCompatError(err, CORS_METHODS);
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.options("/", () => handleCompatCorsOptions(CORS_METHODS));
__hono_app.get("/", async (c) =>
  __hono_GET(
    c.req.raw,
    {
      params: Promise.resolve({ id: c.req.param("id")! }),
    },
    c.env,
  ),
);
export default __hono_app;
