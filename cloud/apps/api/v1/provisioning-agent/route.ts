/**
 * GET /api/v1/provisioning-agent
 *
 * Returns the provisioning status of the caller's most recent agent sandbox.
 * Used by the onboarding UI to determine whether to show the provisioning
 * placeholder agent or hand off to the running container.
 */

import { Hono } from "hono";
import { agentSandboxesRepository } from "@/db/repositories/agent-sandboxes";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    const sandboxes = await agentSandboxesRepository.listByOrganization(user.organization_id);
    const sandbox = sandboxes[0];

    if (!sandbox) {
      return c.json({ success: true, data: { status: "none" } });
    }

    const bridgeUrl =
      sandbox.status === "running" ? (sandbox.bridge_url ?? null) : null;

    return c.json({
      success: true,
      data: {
        status: sandbox.status,
        ...(bridgeUrl ? { bridgeUrl } : {}),
        agentId: sandbox.id,
      },
    });
  } catch (error) {
    logger.error("[provisioning-agent] GET status error", { error });
    return failureResponse(c, error);
  }
});

export default app;
