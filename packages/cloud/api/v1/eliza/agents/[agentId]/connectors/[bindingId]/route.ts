/**
 * Agent-scoped connector revocation boundary. Removing a binding stops one
 * agent from using a shared credential without revoking that credential or
 * affecting bindings owned by other agents.
 */
import { Hono } from "hono";
import { userCharactersRepository } from "@/db/repositories/characters";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { edgeRuntimeCache } from "@/lib/cache/edge-runtime-cache";
import {
  AgentConnectorBindingError,
  agentConnectorBindingsService,
} from "@/lib/services/agent-connector-bindings";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

async function canonicalAgentId(
  routeAgentId: string,
  organizationId: string,
): Promise<string | null> {
  const direct = await userCharactersRepository.findByIdInOrganization(
    routeAgentId,
    organizationId,
  );
  if (direct) return direct.id;
  const sandbox = await elizaSandboxService.getAgent(
    routeAgentId,
    organizationId,
  );
  if (!sandbox?.character_id) return null;
  const character = await userCharactersRepository.findByIdInOrganization(
    sandbox.character_id,
    organizationId,
  );
  return character?.id ?? null;
}

app.delete("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const routeAgentId = c.req.param("agentId");
    const bindingId = c.req.param("bindingId");
    if (!routeAgentId || !bindingId) {
      return c.json({ error: "Connector binding not found." }, 404);
    }
    const agentId = await canonicalAgentId(routeAgentId, user.organization_id);
    if (!agentId) return c.json({ error: "Agent not found." }, 404);
    await agentConnectorBindingsService.revoke({
      organizationId: user.organization_id,
      agentId,
      bindingId,
    });
    await edgeRuntimeCache.bumpMcpVersion(user.organization_id);
    return c.body(null, 204);
  } catch (error) {
    if (error instanceof AgentConnectorBindingError) {
      return c.json({ error: error.message, code: error.code }, error.status);
    }
    return failureResponse(c, error);
  }
});

export default app;
