/**
 * POST /api/v1/coding-containers
 *
 * Request a cloud coding container for an agent.
 *
 * HISTORY: this route used to HTTP-forward to a standalone
 * `container-control-plane` service (`${CONTAINER_CONTROL_PLANE_URL}/api/v1/containers`).
 * That origin was retired in the cloud migration (orphan service on :8791,
 * pointed at the decommissioned .246 node) and now returns 521. Node
 * autoscaling + warm pool already migrated to the `eliza-provisioning-worker`
 * daemon (jobs table + Redis); only this route never did.
 *
 * NOW: a coding container is just an `agent_sandboxes` row with a custom
 * `docker_image` + coding env vars, provisioned through the SAME healthy
 * daemon path used for normal agents. The daemon's `AGENT_PROVISION` job
 * (`elizaSandboxService.provision()`) already docker-runs an arbitrary image
 * via the provider (node-SSH + `docker run`) — see eliza-sandbox.ts where
 * `provision()` forwards `docker_image` into `provider.create()`. So we:
 *   1. allowlist-gate the requested image (SECURITY — see below),
 *   2. create the sandbox row (`createAgent({ dockerImage, environmentVars })`),
 *   3. enqueue the existing provision job + trigger the daemon immediately,
 *   4. poll the job for a synchronous result and return the session.
 *
 * SECURITY: coding-containers let an authenticated org run an OUTSIDE image
 * (e.g. ghcr.io/dexploarer/bnancy:latest). The image was previously taken raw
 * with ZERO validation. We now require it to match
 * `CODING_CONTAINER_IMAGE_ALLOWLIST` (default ghcr.io/{dexploarer,elizaos,
 * waifufun}/*) and reject others with 403.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { containersEnv } from "@/lib/config/containers-env";
import {
  buildCodingContainerCreatePayload,
  buildCodingContainerSessionResponse,
  type CodingContainerCreatePayload,
  isCodingContainerImageAllowed,
  type RequestCodingAgentContainerRequest,
  RequestCodingAgentContainerRequestSchema,
} from "@/lib/services/coding-containers";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { provisioningJobService } from "@/lib/services/provisioning-jobs";
import {
  checkProvisioningWorkerHealth,
  provisioningWorkerFailureBody,
} from "@/lib/services/provisioning-worker-health";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv, AuthedUser } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

// How long to wait for the daemon to provision the container before returning
// a 202 "still working" to the caller (the job keeps running; the caller can
// poll `/api/v1/jobs/{jobId}`). Container cold-start (image pull + boot) is
// slower than a normal agent, so we give it generous headroom.
const MAX_WAIT_MS = 110_000;
const POLL_INTERVAL_MS = 2_500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function validationError(c: AppContext, message: string): Response {
  return c.json({ success: false, error: message }, 400);
}

/**
 * Build the session response from a running sandbox row. Mirrors the upstream
 * shape the old control-plane returned, sourced from the daemon-provisioned
 * sandbox instead of the dead HTTP origin.
 */
function buildSessionFromSandbox(
  request: RequestCodingAgentContainerRequest,
  createPayload: CodingContainerCreatePayload,
  sandbox: {
    id: string;
    status: string;
    bridge_url: string | null;
    health_url: string | null;
    created_at?: Date | string | null;
  },
) {
  return buildCodingContainerSessionResponse({
    request,
    createPayload,
    upstreamData: {
      id: sandbox.id,
      status: sandbox.status,
      url: sandbox.bridge_url ?? sandbox.health_url ?? null,
      createdAt:
        sandbox.created_at instanceof Date
          ? sandbox.created_at.toISOString()
          : (sandbox.created_at ?? undefined),
    },
  });
}

async function createCodingContainer(
  c: AppContext,
  user: Pick<AuthedUser, "id"> & { organization_id: string },
  request: RequestCodingAgentContainerRequest,
  payload: CodingContainerCreatePayload,
): Promise<Response> {
  // ── SECURITY: image allowlist gate ───────────────────────────────────
  const allowlist = containersEnv.codingContainerImageAllowlist();
  if (!isCodingContainerImageAllowed(payload.image, allowlist)) {
    logger.warn("[CodingContainers API] image rejected by allowlist", {
      orgId: user.organization_id,
      image: payload.image,
    });
    return c.json(
      {
        success: false,
        code: "CODING_CONTAINER_IMAGE_NOT_ALLOWED",
        error: `Image '${payload.image}' is not permitted for coding containers`,
      },
      403,
    );
  }

  // ── Gate on the provisioning daemon being healthy (same as agent provision) ──
  const workerHealth = await checkProvisioningWorkerHealth();
  if (!workerHealth.ok) {
    logger.warn("[CodingContainers API] provisioning worker unavailable", {
      orgId: user.organization_id,
      code: workerHealth.code,
    });
    return c.json(
      provisioningWorkerFailureBody(workerHealth),
      workerHealth.status,
    );
  }

  // ── Create the sandbox row carrying the custom image + coding env vars ──
  const sandbox = await elizaSandboxService.createAgent({
    organizationId: user.organization_id,
    userId: user.id,
    agentName: payload.name || payload.project_name,
    environmentVars: payload.environment_vars,
    dockerImage: payload.image,
  });

  // ── Enqueue the (existing, image-capable) provision job + kick the daemon ──
  let enqueue: Awaited<
    ReturnType<typeof provisioningJobService.enqueueAgentProvisionOnce>
  >;
  try {
    enqueue = await provisioningJobService.enqueueAgentProvisionOnce({
      agentId: sandbox.id,
      organizationId: user.organization_id,
      userId: user.id,
      agentName: sandbox.agent_name ?? sandbox.id,
      expectedUpdatedAt: sandbox.updated_at,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("[CodingContainers API] failed to enqueue provision job", {
      orgId: user.organization_id,
      sandboxId: sandbox.id,
      error: message,
    });
    return c.json(
      {
        success: false,
        code: "CODING_CONTAINER_ENQUEUE_FAILED",
        error: "Failed to start coding container provisioning",
        retryable: true,
      },
      503,
    );
  }

  const { job } = enqueue;
  void provisioningJobService.triggerImmediate(c.env).catch(() => {
    // Logged inside the service; the cron is the safety net.
  });

  // ── Poll the job for a synchronous result (best-effort within timeout) ──
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const current = await provisioningJobService.getJobForOrg(
      job.id,
      user.organization_id,
    );
    if (!current) continue;

    if (current.status === "completed") {
      const running = await elizaSandboxService.getAgent(
        sandbox.id,
        user.organization_id,
      );
      if (!running) {
        return c.json(
          {
            success: false,
            code: "CODING_CONTAINER_MISSING_AFTER_PROVISION",
            error: "Coding container provisioned but sandbox row was not found",
            jobId: job.id,
          },
          500,
        );
      }
      return c.json(
        {
          success: true,
          data: buildSessionFromSandbox(request, payload, running),
          jobId: job.id,
        },
        201,
      );
    }

    if (current.status === "failed") {
      const result = (current.result ?? {}) as Record<string, unknown>;
      const errMsg =
        typeof result.error === "string"
          ? result.error
          : "coding container provisioning failed";
      logger.warn("[CodingContainers API] provision job failed", {
        sandboxId: sandbox.id,
        jobId: job.id,
        error: errMsg,
      });
      return c.json(
        {
          success: false,
          code: "CODING_CONTAINER_PROVISION_FAILED",
          error: errMsg,
          jobId: job.id,
        },
        502,
      );
    }
  }

  // ── Timed out waiting. The job keeps running; return 202 so the caller can
  // poll the job endpoint and then re-request / fetch the container by id. ──
  logger.info("[CodingContainers API] provision still running at timeout", {
    sandboxId: sandbox.id,
    jobId: job.id,
  });
  return c.json(
    {
      success: true,
      pending: true,
      message:
        "Coding container provisioning is in progress. Poll the job endpoint for status.",
      data: {
        containerId: sandbox.id,
        status: "pending",
        agent: request.agent,
      },
      jobId: job.id,
      polling: {
        endpoint: `/api/v1/jobs/${job.id}`,
        intervalMs: 5000,
        expectedDurationMs: 120000,
      },
    },
    202,
  );
}

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const body = (await c.req.json().catch(() => null)) as unknown;
    const parsed = RequestCodingAgentContainerRequestSchema.safeParse(body);
    if (!parsed.success) {
      return validationError(
        c,
        parsed.error.issues[0]?.message ?? "Invalid coding container request",
      );
    }

    const createPayload = buildCodingContainerCreatePayload(parsed.data);
    return await createCodingContainer(c, user, parsed.data, createPayload);
  } catch (error) {
    logger.error("[CodingContainers API] request error:", error);
    return failureResponse(c, error);
  }
});

export default app;
