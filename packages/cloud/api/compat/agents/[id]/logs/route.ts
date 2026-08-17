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
const DEFAULT_TAIL = 100;
const MAX_TAIL = 5000;
const CANONICAL_POSITIVE_INTEGER = /^[1-9]\d*$/;

/**
 * Canonical compat `tail` at the HTTP boundary. Same contract as v1
 * `GET /api/v1/agents/:agentId/logs`: omitted defaults to 100; any other
 * token must be a complete ASCII decimal integer in [1, 5000]. Prefix-legal
 * garbage must not coerce (`parseInt("1e4", 10)` is 1) into `docker logs --tail`.
 */
export function parseCompatLogsTail(
  rawTail: string | null,
): { ok: true; tail: number } | { ok: false } {
  if (rawTail === null) {
    return { ok: true, tail: DEFAULT_TAIL };
  }
  if (!CANONICAL_POSITIVE_INTEGER.test(rawTail)) {
    return { ok: false };
  }
  const tail = Number(rawTail);
  if (!Number.isSafeInteger(tail) || tail > MAX_TAIL) {
    return { ok: false };
  }
  return { ok: true, tail };
}

async function __hono_GET(
  request: Request,
  { params }: RouteContext<{ id: string }>,
  env: AppEnv["Bindings"],
) {
  try {
    const { user } = await requireCompatAuth(request);
    const { id: agentId } = await params;

    const url = new URL(request.url);
    const parsedTail = parseCompatLogsTail(url.searchParams.get("tail"));
    if (!parsedTail.ok) {
      // error-policy:J3 reject malformed request input instead of coercing
      // or clamping it into docker logs --tail.
      return withCompatCors(
        Response.json(
          errorEnvelope(`tail must be a whole number between 1 and ${MAX_TAIL}`),
          { status: 400 },
        ),
        CORS_METHODS,
      );
    }
    const { tail } = parsedTail;

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
