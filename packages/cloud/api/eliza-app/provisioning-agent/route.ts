/**
 * /api/eliza-app/provisioning-agent
 *
 * GET  — returns sandbox status for the session user's org.
 * POST — idempotent provision trigger: creates + enqueues a sandbox if none
 *        exists, otherwise returns the current sandbox status. Safe to call
 *        multiple times; second call returns the existing sandbox status.
 *
 * Auth: eliza-app session Bearer token (same as /api/eliza-app/user/me).
 */

import type { Context } from "hono";
import { Hono } from "hono";
import { agentSandboxesRepository } from "@/db/repositories/agent-sandboxes";
import { containersEnv } from "@/lib/config/containers-env";
import { checkAgentCreditGate } from "@/lib/services/agent-billing-gate";
import { insufficientCredits402 } from "@/lib/services/agent-billing-gate-402";
import { elizaAppSessionService } from "@/lib/services/eliza-app";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { provisioningJobService } from "@/lib/services/provisioning-jobs";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

const DEFAULT_AGENT_NAME = "Eliza";
// Use the canonical managed-agent image so the daemon pulls from ghcr.io
// (the source of truth), not Docker Hub where the image does not exist.
// A bare name like "elizaos/eliza:latest" causes Docker to resolve against
// docker.io, producing an "unauthorized" / "pull access denied" error.
const DEFAULT_DOCKER_IMAGE = containersEnv.defaultAgentImage();

async function resolveSession(c: Context<AppEnv>) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader) return null;
  return elizaAppSessionService.validateAuthHeader(authHeader);
}

function sandboxPayload(sandbox: {
  id: string;
  status: string;
  bridge_url: string | null;
}) {
  const bridgeUrl =
    sandbox.status === "running" ? (sandbox.bridge_url ?? null) : null;
  return {
    status: sandbox.status,
    agentId: sandbox.id,
    ...(bridgeUrl ? { bridgeUrl } : {}),
  };
}

/** GET — status only, no side effects. */
app.get("/", async (c) => {
  const session = await resolveSession(c);
  if (!session) {
    return c.json(
      { error: "Authorization required", code: "UNAUTHORIZED" },
      401,
    );
  }

  try {
    const sandboxes = await agentSandboxesRepository.listByOrganization(
      session.organizationId,
    );
    const sandbox = sandboxes[0];
    if (!sandbox) {
      return c.json({ success: true, data: { status: "none" } });
    }
    return c.json({ success: true, data: sandboxPayload(sandbox) });
  } catch (err) {
    logger.error("[eliza-app provisioning-agent] GET error", { error: err });
    return c.json({ success: false, error: "Failed to fetch status" }, 500);
  }
});

/** POST — idempotent provision trigger. */
app.post("/", async (c) => {
  const session = await resolveSession(c);
  if (!session) {
    return c.json(
      { error: "Authorization required", code: "UNAUTHORIZED" },
      401,
    );
  }

  try {
    const sandboxes = await agentSandboxesRepository.listByOrganization(
      session.organizationId,
    );
    const existing = sandboxes[0];

    if (existing) {
      return c.json({ success: true, data: sandboxPayload(existing) });
    }

    // Credit gate before provisioning a NEW dedicated agent (#11224): this
    // creates a custom-image (DEFAULT_DOCKER_IMAGE → dedicated) sandbox and
    // eagerly enqueues its container, the same paid compute the main
    // create/resume/wake paths gate. Without it a credit-suspended / zero-balance
    // org gets a free dedicated container. New orgs clear this via the signup
    // grant; only genuinely suspended orgs are blocked. (Existing sandboxes
    // returned above are unaffected — this only fences the first provision.)
    const creditCheck = await checkAgentCreditGate(session.organizationId);
    if (!creditCheck.allowed) {
      return c.json(
        insufficientCredits402(
          creditCheck,
          "[eliza-app provisioning-agent] provision blocked: insufficient credits",
          { orgId: session.organizationId },
        ),
        402,
      );
    }

    // No sandbox yet — create one and enqueue provisioning.
    const { agent: sandbox, idempotent } =
      await elizaSandboxService.createAgent({
        organizationId: session.organizationId,
        userId: session.userId,
        agentName: DEFAULT_AGENT_NAME,
        dockerImage: DEFAULT_DOCKER_IMAGE,
        reuseExistingNonTerminal: true,
      });

    // The org-scoped guard reused an in-flight sandbox; its provision job is
    // already queued, so don't enqueue a second one.
    if (!idempotent) {
      // createAgent committed a `pending` row, but the daemon only claims rows
      // that already have an `agent_provision` job. A throw here would strand
      // the row, and the reuse guard would then hand that job-less row back on
      // every later call (idempotent:true → skip enqueue), making it permanent.
      // Delete the just-created row on failure so a retry mints a fresh agent.
      try {
        await provisioningJobService.enqueueAgentProvision({
          agentId: sandbox.id,
          organizationId: session.organizationId,
          userId: session.userId,
          agentName: DEFAULT_AGENT_NAME,
        });
      } catch (err) {
        await agentSandboxesRepository.delete(
          sandbox.id,
          session.organizationId,
        );
        throw err;
      }
    }

    logger.info(
      idempotent
        ? "[eliza-app provisioning-agent] Reusing in-flight sandbox"
        : "[eliza-app provisioning-agent] Provisioning kicked off",
      {
        agentId: sandbox.id,
        orgId: session.organizationId,
      },
    );

    return c.json({
      success: true,
      data: { status: sandbox.status, agentId: sandbox.id },
    });
  } catch (err) {
    logger.error("[eliza-app provisioning-agent] POST provision error", {
      error: err,
    });
    return c.json({ success: false, error: "Failed to provision" }, 500);
  }
});

export default app;
