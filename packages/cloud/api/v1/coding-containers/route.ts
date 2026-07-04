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
 *   2. check for existing running/pending sandbox (idempotency),
 *   3. create the sandbox row (`createAgent({ dockerImage, environmentVars })`),
 *   4. enqueue the existing provision job + trigger the daemon immediately,
 *   5. poll the job for a synchronous result and return the session.
 *
 * SECURITY: coding-containers let an authenticated org run an OUTSIDE image
 * (e.g. ghcr.io/dexploarer/bnancy:latest). The image was previously taken raw
 * with ZERO validation. We now require it to match
 * `CODING_CONTAINER_IMAGE_ALLOWLIST` (default ghcr.io/{dexploarer,elizaos,
 * waifufun}/*) and reject others with 403.
 *
 * DATABASE_URL: provision() injects a per-agent managed (Railway) DB URL, but it
 * no longer clobbers a caller-supplied DATABASE_URL. A self-contained image
 * that ships its OWN database keeps its `DATABASE_URL`; the managed URL is then
 * exposed under `ELIZA_MANAGED_DATABASE_URL` for opt-in. Only when the caller
 * supplies no DATABASE_URL does the managed one land as `DATABASE_URL` (the
 * normal managed-agent path). See eliza-sandbox.ts `provision()`.
 *
 * KNOWN GAPS vs the old control-plane path (tracked as follow-ups):
 *   1. `bootstrap_source` (source.files) is NOT hydrated — a VFS-promoted
 *      workspace would start empty. The `agent_sandboxes` schema has no
 *      bootstrap/volume columns, so honoring this needs daemon + schema work.
 *   2. The browser coding-IDE URL (if any) is a separate concern the daemon
 *      does not yet surface; the returned `url` is the per-agent public HTTPS
 *      URL (https://<id>.<agent-domain>).
 *
 * PUBLIC_BASE_URL: before provisioning we inject `https://<id>.<agent-domain>`
 * into the container's env (unless the caller pinned one) so a self-contained
 * agent like Nancy boots knowing its own public URL — needed for webhooks, deep
 * links, and signing pages. The sandbox id exists pre-provision and the
 * per-agent gateway serves that host, so there is no chicken-and-egg.
 */

import { Hono } from "hono";
import { ApiError, failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { containersEnv } from "@/lib/config/containers-env";
import { getMaxNonTerminalAgentsForOrg } from "@/lib/constants/agent-sandbox-quota";
import { getElizaAgentPublicWebUiUrl } from "@/lib/eliza-agent-web-ui";
import { checkAgentCreditGate } from "@/lib/services/agent-billing-gate";
import { insufficientCredits402 } from "@/lib/services/agent-billing-gate-402";
import {
  buildCodingContainerCreatePayload,
  buildCodingContainerSessionResponse,
  type CodingContainerCreatePayload,
  imageRequiresDigestPin,
  isCodingContainerImageAllowed,
  type RequestCodingAgentContainerRequest,
  RequestCodingAgentContainerRequestSchema,
} from "@/lib/services/coding-containers";
import {
  AgentQuotaExceededError,
  elizaSandboxService,
} from "@/lib/services/eliza-sandbox";
import { getOrgImageNamespaces } from "@/lib/services/org-image-namespaces";
import { provisioningJobService } from "@/lib/services/provisioning-jobs";
import {
  checkProvisioningWorkerHealth,
  provisioningWorkerFailureBody,
} from "@/lib/services/provisioning-worker-health";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv, AuthedUser } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

// error-policy:J1 every handler across the v1/coding-containers/* dir (this
// route plus [containerId]/sync and promotions) has one outermost try/catch
// that translates exceptions into a structured HTTP failure via
// failureResponse(c, error), with typed codes for allowlist/quota/enqueue/
// provision failures. No catch here fabricates a success: a missing sandbox
// after provisioning is a 500, an enqueue failure is a 503, a provision-job
// failure is a 402/502.

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
 * Per-agent public HTTPS URL (`https://<id>.<agent-domain>`), resolving the base
 * domain from the container control-plane config (`containersEnv`, which reads
 * the Worker's bindings) — NOT `process.env`. This route runs in the Cloudflare
 * Worker, where `process.env` is not populated, so calling
 * `getElizaAgentPublicWebUiUrl` without an explicit domain would silently fall
 * back to the default brand domain and yield an unreachable host. Returns null
 * when no base domain is configured.
 */
function resolveAgentPublicUrl(sandbox: {
  id: string;
  headscale_ip: string | null;
}): string | null {
  const baseDomain = containersEnv.publicBaseDomain();
  return getElizaAgentPublicWebUiUrl(sandbox, baseDomain ? { baseDomain } : {});
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
    headscale_ip: string | null;
    created_at?: Date | string | null;
  },
) {
  return buildCodingContainerSessionResponse({
    request,
    createPayload,
    upstreamData: {
      id: sandbox.id,
      status: sandbox.status,
      // Prefer the reachable per-agent HTTPS URL (https://<id>.<domain>) so the
      // session reports where the container is actually served; fall back to the
      // internal bridge/health URL.
      publicUrl: resolveAgentPublicUrl(sandbox) ?? undefined,
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
  // Platform-wide env allowlist first; on deny, the org's OWN operator-granted
  // namespace extension (organizations.settings.allowed_image_namespaces) —
  // additive and fail-closed, scoped to this org only.
  const allowlist = containersEnv.codingContainerImageAllowlist();
  const imageAllowed =
    isCodingContainerImageAllowed(payload.image, allowlist) ||
    isCodingContainerImageAllowed(
      payload.image,
      await getOrgImageNamespaces(user.organization_id),
    );
  if (!imageAllowed) {
    logger.warn("[CodingContainers API] image rejected by allowlist", {
      orgId: user.organization_id,
      image: payload.image,
    });
    // Humanized error: tell the caller which namespaces ARE permitted (from the
    // live, operator-configured allowlist) and how to widen it, instead of a
    // bare "not permitted". The machine-readable `code` is preserved so clients
    // can still branch on it.
    const permitted =
      allowlist.length > 0 ? allowlist.join(", ") : "(none configured)";
    return c.json(
      {
        success: false,
        code: "CODING_CONTAINER_IMAGE_NOT_ALLOWED",
        error:
          `Image '${payload.image}' is not in the coding-container allowlist. ` +
          `Permitted images: ${permitted}. ` +
          `To run another image, ask an operator to add its GHCR namespace to ` +
          `CODING_CONTAINER_IMAGE_ALLOWLIST, or to grant it to your organization ` +
          `(settings.allowed_image_namespaces).`,
        permittedImages: allowlist,
      },
      403,
    );
  }

  // ── SECURITY (opt-in): digest-pin gate ───────────────────────────────
  // When armed, an allowed image must also be pinned to a full sha256 digest
  // so the registry cannot swap the bytes behind a mutable tag after the
  // allowlist check passes. Default OFF (opt-in via env).
  if (
    imageRequiresDigestPin(
      payload.image,
      containersEnv.requireDigestPinnedImages(),
    )
  ) {
    logger.warn("[CodingContainers API] image rejected: digest pin required", {
      orgId: user.organization_id,
      image: payload.image,
    });
    return c.json(
      {
        success: false,
        code: "CODING_CONTAINER_IMAGE_NOT_DIGEST_PINNED",
        error:
          `Image '${payload.image}' must be pinned to a full sha256 digest ` +
          `(e.g. ghcr.io/org/repo@sha256:<64 hex>). Mutable tags like ':latest' ` +
          `are not accepted while CONTAINER_IMAGE_REQUIRE_DIGEST is enabled.`,
      },
      403,
    );
  }

  // ── Credit gate: require the minimum deposit before provisioning paid
  // compute (same as every sibling provision route). Without this, a $0/negative
  // org could launch a metered coding container and get free compute until the
  // hourly cron's warning + 48h grace expires. The route's downstream 402
  // "insufficient_credit" poll branch is dead — provision() has no credit gate —
  // so this is the only real gate. ──
  const creditCheck = await checkAgentCreditGate(user.organization_id);
  if (!creditCheck.allowed) {
    return c.json(
      insufficientCredits402(
        creditCheck,
        "[CodingContainers API] provision blocked: insufficient credits",
        { orgId: user.organization_id },
      ),
      402,
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

  // ── Idempotency: serialize by (organization, image) and return the active row.
  // The service takes a transaction-scoped advisory lock before checking for a
  // pending/provisioning/running sandbox, closing retry races without applying a
  // broad schema constraint that would collide with warm-pool rows.
  let createResult: Awaited<
    ReturnType<typeof elizaSandboxService.createCodingContainerAgent>
  >;
  try {
    createResult = await elizaSandboxService.createCodingContainerAgent({
      organizationId: user.organization_id,
      userId: user.id,
      agentName: payload.name || payload.project_name,
      environmentVars: payload.environment_vars,
      dockerImage: payload.image,
      executionTier: "custom",
      // Per-org ceiling (#11023): the per-image idempotency lock collapses only
      // same-image retries, so a distinct-image loop under an allowlisted
      // namespace would otherwise mint unbounded custom containers on the shared
      // fleet. Bound it by the org's balance tier — the same cap the sibling
      // POST /api/v1/eliza/agents forceCreate path enforces (#11042).
      maxNonTerminalAgents: getMaxNonTerminalAgentsForOrg(creditCheck.balance),
    });
  } catch (error) {
    if (error instanceof AgentQuotaExceededError) {
      logger.warn(
        "[CodingContainers API] provision blocked: per-org quota exceeded",
        {
          orgId: user.organization_id,
          count: error.count,
          max: error.max,
        },
      );
      throw new ApiError(429, "agent_quota_exceeded", error.message, {
        count: error.count,
        max: error.max,
      });
    }
    throw error;
  }
  if (createResult.idempotent) {
    const existing = createResult.agent;
    logger.info(
      "[CodingContainers API] returning existing active sandbox (idempotency)",
      {
        orgId: user.organization_id,
        sandboxId: existing.id,
        status: existing.status,
        image: payload.image,
      },
    );
    return c.json(
      {
        success: true,
        data: buildSessionFromSandbox(request, payload, existing),
        idempotent: true,
      },
      200,
    );
  }

  // ── Use the newly-created sandbox row carrying the custom image + coding env vars ──
  const sandbox = createResult.agent;

  // ── Inject the container's own public URL as PUBLIC_BASE_URL ──────────────
  // The sandbox id exists now (pre-provision) and the per-agent gateway serves
  // `https://<id>.<agent-domain>`, so we can set the agent's public URL before
  // the daemon docker-runs it — `provision()` forwards `environment_vars` into
  // the container (eliza-sandbox.ts). A self-contained image like Nancy needs
  // this for webhooks / deep links / signing pages. We never override a
  // PUBLIC_BASE_URL the caller pinned explicitly.
  let provisionRow = sandbox;
  const publicWebUrl = resolveAgentPublicUrl(sandbox);
  if (publicWebUrl && !payload.environment_vars.PUBLIC_BASE_URL) {
    payload.environment_vars.PUBLIC_BASE_URL = publicWebUrl;
    const updated = await elizaSandboxService.updateAgentEnvironment(
      sandbox.id,
      user.organization_id,
      payload.environment_vars,
    );
    if (updated) provisionRow = updated;
  }

  // ── Enqueue the (existing, image-capable) provision job + kick the daemon ──
  // Enqueue against `provisionRow` — updateAgentEnvironment bumps `updated_at`,
  // and enqueueAgentProvisionOnce gates on `expectedUpdatedAt`.
  let enqueue: Awaited<
    ReturnType<typeof provisioningJobService.enqueueAgentProvisionOnce>
  >;
  try {
    enqueue = await provisioningJobService.enqueueAgentProvisionOnce({
      agentId: provisionRow.id,
      organizationId: user.organization_id,
      userId: user.id,
      agentName: provisionRow.agent_name ?? provisionRow.id,
      expectedUpdatedAt: provisionRow.updated_at,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("[CodingContainers API] failed to enqueue provision job", {
      orgId: user.organization_id,
      sandboxId: sandbox.id,
      error: message,
    });
    // ── Orphan deletion on enqueue failure ───────────────────────────────
    // Delete the sandbox row we just created to prevent accumulating
    // pending/unknown rows on transient failures (e.g. DB contention,
    // job table unavailable). Best-effort — log but don't mask the original error.
    try {
      await elizaSandboxService.deleteAgent(sandbox.id, user.organization_id);
      // error-policy:J6 best-effort orphan teardown after an enqueue failure;
      // a failed cleanup is logged (warn) and does not mask the enqueue error
      // returned below as a 503.
    } catch (deleteError) {
      logger.warn(
        "[CodingContainers API] orphan cleanup failed after enqueue error",
        {
          sandboxId: sandbox.id,
          orgId: user.organization_id,
          error:
            deleteError instanceof Error
              ? deleteError.message
              : String(deleteError),
        },
      );
    }
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
  // error-policy:J5 fire-and-forget daemon kick; the rejection IS observed
  // inside triggerImmediate (it logs), and the provisioning cron is the safety
  // net, so a failed immediate trigger only delays (never drops) provisioning.
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
      // Humanized error: a provisioning failure caused by an empty/low credit
      // balance is actionable by the user, not a server fault. Surface it as a
      // 402 with the machine-readable `insufficient_credits` code and a concrete
      // next step, instead of an opaque 502.
      if (/insufficient[\s_]?credit/i.test(errMsg)) {
        return c.json(
          {
            success: false,
            code: "insufficient_credits",
            error: "Add $0.10 to launch this coding container.",
            jobId: job.id,
          },
          402,
        );
      }
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
        // Known pre-provision (id-derived); lets the caller wire up the URL now.
        url: publicWebUrl ?? undefined,
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
