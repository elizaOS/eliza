/**
 * Exposes the authenticated Eliza App Dedicated lifecycle observation endpoint.
 * GET and the legacy POST alias are read-only and never create or enqueue compute.
 */
import type { Context } from "hono";
import { Hono } from "hono";
import { agentSandboxesRepository } from "@/db/repositories/agent-sandboxes";
import { elizaAppSessionService } from "@/lib/services/eliza-app";
import { selectElizaAppProvisioningTarget } from "@/lib/services/eliza-app/provisioning";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

export interface ProvisioningAgentObservationDependencies {
  sandboxes: Pick<typeof agentSandboxesRepository, "listByOrganization">;
  sessions: Pick<typeof elizaAppSessionService, "validateAuthHeader">;
  log: Pick<typeof logger, "error">;
}

const DEFAULT_DEPENDENCIES: ProvisioningAgentObservationDependencies = {
  sandboxes: agentSandboxesRepository,
  sessions: elizaAppSessionService,
  log: logger,
};

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

/** Construct the read-only route with explicit observation-only dependencies. */
export function createProvisioningAgentObservationApp(
  dependencies: ProvisioningAgentObservationDependencies = DEFAULT_DEPENDENCIES,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  async function resolveSession(c: Context<AppEnv>) {
    const authHeader = c.req.header("Authorization");
    if (!authHeader) return null;
    return dependencies.sessions.validateAuthHeader(authHeader);
  }

  async function observeProvisioningStatus(c: Context<AppEnv>) {
    const session = await resolveSession(c);
    if (!session) {
      return c.json(
        { error: "Authorization required", code: "UNAUTHORIZED" },
        401,
      );
    }

    try {
      const sandboxes = await dependencies.sandboxes.listByOrganization(
        session.organizationId,
      );
      const sandbox = selectElizaAppProvisioningTarget(
        sandboxes,
        session.userId,
      );
      if (!sandbox) {
        return c.json({ success: true, data: { status: "none" } });
      }
      return c.json({ success: true, data: sandboxPayload(sandbox) });
    } catch (err) {
      // error-policy:J1 the HTTP boundary turns a failed status read into an explicit 500.
      dependencies.log.error(
        "[eliza-app provisioning-agent] Status read error",
        {
          method: c.req.method,
          error: err,
        },
      );
      return c.json({ success: false, error: "Failed to fetch status" }, 500);
    }
  }

  app.get("/", observeProvisioningStatus);
  app.post("/", observeProvisioningStatus);

  return app;
}

export default createProvisioningAgentObservationApp();
