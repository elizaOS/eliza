import { Hono } from "hono";
import { errorToResponse } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { containersEnv } from "@/lib/config/containers-env";
import { AGENT_PRICING } from "@/lib/constants/agent-pricing";
import { agentSandboxesRepository } from "@/db/repositories/agent-sandboxes";
import { assertSafeOutboundUrl } from "@/lib/security/outbound-url";
import { checkAgentCreditGate } from "@/lib/services/agent-billing-gate";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { provisioningJobService } from "@/lib/services/provisioning-jobs";
import {
  checkProvisioningWorkerHealth,
  provisioningWorkerFailureBody,
} from "@/lib/services/provisioning-worker-health";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

// Reduced from 120s — async path returns 202 immediately.
// Sync fallback (?sync=true) still needs headroom for legacy callers.

const CORS_METHODS = "POST, OPTIONS";

function getProvisionFailureStatus(error?: string): 404 | 409 | 500 {
  if (error === "Agent not found") return 404;
  if (error === "Agent is already being provisioned") return 409;
  return 500;
}

function sanitizeProvisionFailureMessage(
  error: string | undefined,
  status: 404 | 409 | 500,
): string {
  if (status !== 500) {
    return error ?? "Provisioning failed";
  }

  return "Provisioning failed";
}

function sanitizeEnqueueFailureMessage(error: string, status: 404 | 409 | 500): string {
  if (status !== 500) {
    return error;
  }

  return "Failed to start provisioning";
}

function createFailureId(): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `provision-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * POST /api/v1/eliza/agents/[agentId]/provision
 *
 * Provision (or re-provision) the sandbox for an Agent cloud agent.
 *
 * **Warm pool fast path:** When `WARM_POOL_ENABLED=true`, attempts to claim
 * a pre-warmed container atomically and returns 200 with running info.
 *
 * **Default (async):** Creates a provisioning job and returns 202 with a
 * jobId. Poll GET /api/v1/jobs/{jobId} for status. The endpoint also
 * fires a fire-and-forget kick at the worker so we don't wait up to 60s
 * for the next cron tick.
 *
 * **Sync fallback:** Pass `?sync=true` to get the old blocking behaviour
 * (useful during migration). Will be removed in a future release.
 *
 * Idempotent: if the sandbox is already running, returns 200 with
 * existing connection info (no job created).
 */
async function __hono_POST(
  request: Request,
  { params }: { params: Promise<{ agentId: string }> },
  ctx?: AppContext,
) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { agentId } = await params;
    const syncRequested = new URL(request.url).searchParams.get("sync") === "true";
    const sync =
      syncRequested &&
      (process.env.NODE_ENV !== "production" ||
        process.env.ALLOW_AGENT_SYNC_PROVISIONING === "true");

    logger.info("[agent-api] Provision requested", {
      agentId,
      orgId: user.organization_id,
      async: !sync,
    });

    // Fast path: check if already running (no job needed)
    const existing = await elizaSandboxService.getAgentForWrite(agentId, user.organization_id!);
    if (!existing) {
      return applyCorsHeaders(
        Response.json({ success: false, error: "Agent not found" }, { status: 404 }),
        CORS_METHODS,
      );
    }

    if (existing.status === "running" && existing.bridge_url && existing.health_url) {
      return applyCorsHeaders(
        Response.json({
          success: true,
          data: {
            id: existing.id,
            agentName: existing.agent_name,
            status: existing.status,
            bridgeUrl: existing.bridge_url,
            healthUrl: existing.health_url,
          },
        }),
        CORS_METHODS,
      );
    }

    // ── Credit gate: require minimum deposit before provisioning ──────
    const creditCheck = await checkAgentCreditGate(user.organization_id);
    if (!creditCheck.allowed) {
      logger.warn("[agent-api] Provision blocked: insufficient credits", {
        agentId,
        orgId: user.organization_id,
        balance: creditCheck.balance,
        required: AGENT_PRICING.MINIMUM_DEPOSIT,
      });
      return applyCorsHeaders(
        Response.json(
          {
            success: false,
            error: creditCheck.error,
            requiredBalance: AGENT_PRICING.MINIMUM_DEPOSIT,
            currentBalance: creditCheck.balance,
          },
          { status: 402 },
        ),
        CORS_METHODS,
      );
    }

    // ── Warm pool fast path ───────────────────────────────────────────
    // Attempt to atomically claim a pre-warmed container. Falls through
    // (returns null) when the pool is empty, disabled, or the user's row
    // already has a database (re-provision).
    if (containersEnv.warmPoolEnabled() && !sync) {
      try {
        const claimed = await agentSandboxesRepository.claimWarmContainer({
          userAgentId: agentId,
          organizationId: user.organization_id!,
          image: containersEnv.defaultAgentImage(),
          agentName: existing.agent_name ?? agentId,
          agentConfig: (existing.agent_config as Record<string, unknown> | undefined) ?? undefined,
          characterId: existing.character_id,
          expectedUpdatedAt: existing.updated_at,
        });
        if (claimed) {
          logger.info("[agent-api] Warm pool claim succeeded", {
            agentId,
            orgId: user.organization_id,
            poolNodeId: claimed.node_id,
          });
          return applyCorsHeaders(
            Response.json({
              success: true,
              data: {
                id: claimed.id,
                agentName: claimed.agent_name,
                status: claimed.status,
                bridgeUrl: claimed.bridge_url,
                healthUrl: claimed.health_url,
              },
              source: "warm_pool",
            }),
            CORS_METHODS,
          );
        }
      } catch (err) {
        // Don't block on claim errors — fall through to the normal path.
        logger.warn("[agent-api] Warm pool claim threw; falling back", {
          agentId,
          orgId: user.organization_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // ── Sync fallback (legacy) ────────────────────────────────────────
    if (sync) {
      const result = await elizaSandboxService.provision(agentId, user.organization_id!);

      if (!result.success) {
        const status = getProvisionFailureStatus(result.error);
        const clientError = sanitizeProvisionFailureMessage(result.error, status);

        if (status === 500) {
          logger.error("[agent-api] Sync provision failed", {
            agentId,
            orgId: user.organization_id,
            error: result.error,
          });
        }

        return applyCorsHeaders(
          Response.json({ success: false, error: clientError }, { status }),
          CORS_METHODS,
        );
      }

      return applyCorsHeaders(
        Response.json({
          success: true,
          data: {
            id: result.sandboxRecord.id,
            agentName: result.sandboxRecord.agent_name,
            status: result.sandboxRecord.status,
            bridgeUrl: result.bridgeUrl,
            healthUrl: result.healthUrl,
          },
        }),
        CORS_METHODS,
      );
    }

    const workerHealth = await checkProvisioningWorkerHealth();
    if (!workerHealth.ok) {
      logger.warn("[agent-api] Provision blocked: provisioning worker unavailable", {
        agentId,
        orgId: user.organization_id,
        code: workerHealth.code,
      });
      return applyCorsHeaders(
        Response.json(provisioningWorkerFailureBody(workerHealth), {
          status: workerHealth.status,
        }),
        CORS_METHODS,
      );
    }

    // ── Async path (default) ──────────────────────────────────────────
    const webhookUrl = request.headers.get("x-webhook-url") ?? undefined;
    if (webhookUrl) {
      try {
        await assertSafeOutboundUrl(webhookUrl);
      } catch (error) {
        return applyCorsHeaders(
          Response.json(
            {
              success: false,
              error: error instanceof Error ? error.message : "Invalid webhook URL",
            },
            { status: 400 },
          ),
          CORS_METHODS,
        );
      }
    }

    let enqueueResult;
    try {
      enqueueResult = await provisioningJobService.enqueueAgentProvisionOnce({
        agentId,
        organizationId: user.organization_id!,
        userId: user.id,
        agentName: existing.agent_name ?? agentId,
        webhookUrl,
        expectedUpdatedAt: existing.updated_at,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status =
        message === "Agent not found"
          ? 404
          : message === "Agent state changed while starting"
            ? 409
            : 500;
      const failureId = status === 500 ? createFailureId() : undefined;

      if (status === 500) {
        logger.error("[agent-api] Failed to enqueue provisioning job", {
          failureId,
          agentId,
          orgId: user.organization_id,
          error: message,
        });
      }

      return applyCorsHeaders(
        Response.json(
          {
            success: false,
            code: status === 500 ? "provision_enqueue_failed" : "provision_enqueue_rejected",
            error: sanitizeEnqueueFailureMessage(message, status),
            ...(failureId ? { failureId } : {}),
            retryable: status === 500 || status === 409,
          },
          { status },
        ),
        CORS_METHODS,
      );
    }

    const { job, created } = enqueueResult;

    // Inline trigger: kick the worker now instead of waiting up to a minute
    // for the next cron tick. Fire-and-forget; the cron is the safety net.
    if (created) {
      const triggerEnv = ctx?.env;
      const triggerPromise = provisioningJobService.triggerImmediate(triggerEnv);
      if (ctx?.executionCtx) {
        ctx.executionCtx.waitUntil(triggerPromise);
      } else {
        triggerPromise.catch(() => undefined);
      }
    }

    return applyCorsHeaders(
      Response.json(
        {
          success: true,
          created,
          alreadyInProgress: !created,
          message: created
            ? "Provisioning job created. Poll the job endpoint for status."
            : "Provisioning is already in progress. Poll the existing job for status.",
          data: {
            jobId: job.id,
            agentId,
            status: job.status,
            estimatedCompletionAt: job.estimated_completion_at,
          },
          polling: {
            endpoint: `/api/v1/jobs/${job.id}`,
            intervalMs: 5000,
            expectedDurationMs: 90000,
          },
        },
        { status: created ? 202 : 409 },
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
  __hono_POST(
    c.req.raw,
    { params: Promise.resolve({ agentId: c.req.param("agentId")! }) },
    c,
  ),
);
export default __hono_app;
