/**
 * POST /api/v1/agents/[agentId]/restart
 *
 * Service-to-service: enqueue an `agent_restart` job. The orchestrator
 * daemon SSH-stops the existing container and runs a full `provision()`
 * to recreate it (URLs restored from the fresh sandbox handle). Atomic
 * on the daemon side so concurrent restarts can't interleave.
 *
 * Replaces the Worker-side `shutdown()` + `provision()` sequence which
 * silently skipped the stop from CF Workers (no SSH) and could leave
 * the old container running alongside the new one.
 *
 * Optional JSON body `{ "stateLossAcknowledged": true }` (#18228) is the
 * sanctioned operator override for an agent whose pre-stop snapshot capture
 * or transfer persistently fails: the daemon proceeds to stop without a
 * capture, explicitly discarding state since the last durable backup. The
 * waiver is refused (409) rather than silently dropped when a non-waived
 * restart job is already in flight.
 */

import { Hono } from "hono";
import { failureResponse, NotFoundError } from "@/lib/api/cloud-worker-errors";
import { requireServiceKey } from "@/lib/auth/service-key-hono-worker";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { checkAgentCreditGate } from "@/lib/services/agent-billing-gate";
import { insufficientCredits402 } from "@/lib/services/agent-billing-gate-402";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { provisioningJobService } from "@/lib/services/provisioning-jobs";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.post("/", async (c) => {
  try {
    await requireServiceKey(c);
    const agentId = c.req.param("agentId") ?? "";
    const agent = await elizaSandboxService.getAgentById(agentId);
    if (!agent) throw NotFoundError("Agent not found");

    const creditCheck = await checkAgentCreditGate(agent.organization_id);
    if (!creditCheck.allowed) {
      return c.json(
        insufficientCredits402(
          creditCheck,
          "[service-api] Restart blocked: insufficient credits",
          { agentId, orgId: agent.organization_id },
        ),
        402,
      );
    }

    // Optional operator waiver (#18228): `{ "stateLossAcknowledged": true }`
    // lets the restart proceed when the pre-stop capture persistently fails,
    // explicitly discarding state since the last durable backup. Anything
    // other than the literal `true` is treated as absent — the waiver must be
    // deliberate, never inferred from a malformed body.
    let stateLossAcknowledged = false;
    try {
      const body = (await c.req.json()) as { stateLossAcknowledged?: unknown };
      stateLossAcknowledged = body?.stateLossAcknowledged === true;
    } catch {
      // error-policy:J3 an absent or non-JSON body is the ordinary no-waiver
      // request, not an error.
      stateLossAcknowledged = false;
    }

    if (stateLossAcknowledged) {
      logger.warn(
        "[service-api] Restart requested WITH state-loss acknowledgment: pre-stop capture failure will be waived",
        { agentId },
      );
    } else {
      logger.info("[service-api] Restart requested", { agentId });
    }

    const writableAgent = await elizaSandboxService.getAgentForWrite(
      agentId,
      agent.organization_id,
    );
    if (!writableAgent) {
      throw NotFoundError("Agent not found");
    }

    if (writableAgent.status === "provisioning") {
      return c.json(
        { success: false, error: "Agent provisioning is in progress" },
        409,
      );
    }

    const enqueue = await provisioningJobService.enqueueAgentRestartOnce({
      agentId,
      organizationId: agent.organization_id,
      userId: agent.user_id,
      stateLossAcknowledged,
    });

    const existingJobCarriesWaiver =
      (enqueue.job.data as { stateLossAcknowledged?: unknown } | null)
        ?.stateLossAcknowledged === true;
    if (
      stateLossAcknowledged &&
      !enqueue.created &&
      !existingJobCarriesWaiver
    ) {
      // The waiver must never be silently dropped: an already-queued restart
      // job carries its own (non-waived) data, so tell the operator to retry
      // once that job settles instead of pretending the forced restart is
      // queued.
      return c.json(
        {
          success: false,
          error:
            "A restart job is already in flight without the state-loss waiver; wait for it to settle and retry.",
          jobId: enqueue.job.id,
        },
        409,
      );
    }

    return c.json({ success: true });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
