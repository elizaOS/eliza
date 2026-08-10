/**
 * Agent-scoped connector revocation boundary. Removing a binding stops one
 * agent from using a shared credential without revoking that credential or
 * affecting bindings owned by other agents.
 */
import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { edgeRuntimeCache } from "@/lib/cache/edge-runtime-cache";
import { agentConnectorBindingsService } from "@/lib/services/agent-connector-bindings";
import { resolveCanonicalAgentId } from "@/lib/services/canonical-agent-id";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.delete("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const routeAgentId = c.req.param("agentId");
    const bindingId = c.req.param("bindingId");
    if (!routeAgentId || !bindingId) {
      return c.json({ error: "Connector binding not found." }, 404);
    }
    const agentId = await resolveCanonicalAgentId(
      routeAgentId,
      user.organization_id,
    );
    if (!agentId) return c.json({ error: "Agent not found." }, 404);
    await agentConnectorBindingsService.revoke({
      organizationId: user.organization_id,
      agentId,
      bindingId,
    });
    await edgeRuntimeCache.bumpMcpVersion(user.organization_id);
    return c.body(null, 204);
  } catch (error) {
    // error-policy:J1 service/repository failures are ApiError-shaped and
    // rendered into the canonical JSON envelope at this route boundary.
    return failureResponse(c, error);
  }
});

export default app;
