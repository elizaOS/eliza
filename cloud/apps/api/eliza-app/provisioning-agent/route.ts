/**
 * /api/eliza-app/provisioning-agent
 *
 * GET  — returns sandbox status for the session user's org.
 * POST — idempotent provision trigger: creates + enqueues a sandbox if none
 *        exists, otherwise returns the current sandbox status. Safe to call
 *        multiple times; second call is a no-op when a sandbox already exists.
 *
 * Auth: eliza-app session Bearer token (same as /api/eliza-app/user/me).
 */

import { Hono } from "hono";
import { z } from "zod";
import { agentSandboxesRepository } from "@/db/repositories/agent-sandboxes";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { provisioningJobService } from "@/lib/services/provisioning-jobs";
import { elizaAppSessionService } from "@/lib/services/eliza-app";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

const DEFAULT_AGENT_NAME = "Eliza";
const DEFAULT_DOCKER_IMAGE = "elizaos/eliza:latest";

async function resolveSession(c: Parameters<typeof app.get>[1]) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader) return null;
  return elizaAppSessionService.validateAuthHeader(authHeader);
}

function sandboxPayload(sandbox: { id: string; status: string; bridge_url: string | null }) {
  const bridgeUrl = sandbox.status === "running" ? (sandbox.bridge_url ?? null) : null;
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
    return c.json({ error: "Authorization required", code: "UNAUTHORIZED" }, 401);
  }

  try {
    const sandboxes = await agentSandboxesRepository.listByOrganization(session.organizationId);
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
    return c.json({ error: "Authorization required", code: "UNAUTHORIZED" }, 401);
  }

  try {
    const sandboxes = await agentSandboxesRepository.listByOrganization(session.organizationId);
    const existing = sandboxes[0];

    if (existing) {
      return c.json({ success: true, data: sandboxPayload(existing) });
    }

    // No sandbox yet — create one and enqueue provisioning.
    const sandbox = await elizaSandboxService.createAgent({
      organizationId: session.organizationId,
      userId: session.userId,
      agentName: DEFAULT_AGENT_NAME,
      dockerImage: DEFAULT_DOCKER_IMAGE,
    });

    await provisioningJobService.enqueueAgentProvision({
      agentId: sandbox.id,
      organizationId: session.organizationId,
      userId: session.userId,
      agentName: DEFAULT_AGENT_NAME,
    });

    logger.info("[eliza-app provisioning-agent] Provisioning kicked off", {
      agentId: sandbox.id,
      orgId: session.organizationId,
    });

    return c.json({
      success: true,
      data: { status: sandbox.status, agentId: sandbox.id },
    });
  } catch (err) {
    logger.error("[eliza-app provisioning-agent] POST provision error", { error: err });
    return c.json({ success: false, error: "Failed to provision" }, 500);
  }
});

export default app;
