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

import type { Context } from "hono";
import { Hono } from "hono";
import { elizaAppSessionService } from "@/lib/services/eliza-app";
import {
  ensureElizaAppProvisioning,
  getElizaAppProvisioningStatus,
  publicElizaAppProvisioningPayload,
} from "@/lib/services/eliza-app/provisioning";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

async function resolveSession(c: Context<AppEnv>) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader) return null;
  return elizaAppSessionService.validateAuthHeader(authHeader);
}

/** GET — status only, no side effects. */
app.get("/", async (c) => {
  const session = await resolveSession(c);
  if (!session) {
    return c.json({ error: "Authorization required", code: "UNAUTHORIZED" }, 401);
  }

  try {
    const status = await getElizaAppProvisioningStatus(session.organizationId);
    return c.json({ success: true, data: publicElizaAppProvisioningPayload(status) });
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
    const status = await ensureElizaAppProvisioning({
      organizationId: session.organizationId,
      userId: session.userId,
    });

    logger.info("[eliza-app provisioning-agent] Provisioning status resolved", {
      agentId: status.agentId,
      orgId: session.organizationId,
    });

    return c.json({
      success: true,
      data: publicElizaAppProvisioningPayload(status),
    });
  } catch (err) {
    logger.error("[eliza-app provisioning-agent] POST provision error", { error: err });
    return c.json({ success: false, error: "Failed to provision" }, 500);
  }
});

export default app;
