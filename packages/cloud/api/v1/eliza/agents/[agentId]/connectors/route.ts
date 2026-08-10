/**
 * Agent-scoped connector binding API. Route IDs may be sandbox IDs for product
 * compatibility, but persisted and returned bindings always use the canonical
 * character/runtime agent ID.
 */
import { Hono } from "hono";
import { z } from "zod";
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

const stringList = z.array(z.string().trim().min(1).max(200)).max(100);
const bindSchema = z.object({
  platformCredentialId: z.string().uuid(),
  provider: z.string().trim().min(1).max(80),
  role: z.enum(["OWNER", "AGENT", "TEAM"]),
  purposes: stringList.optional(),
  accessGate: z.string().trim().min(1).max(80).optional(),
  selectedProducts: stringList,
  isDefault: z.boolean().optional(),
  ownerBindingId: z.string().uuid().optional(),
  ownerIdentityId: z.string().trim().min(1).max(200).optional(),
});

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

function bindingFailure(
  c: Parameters<typeof failureResponse>[0],
  error: unknown,
) {
  if (error instanceof AgentConnectorBindingError) {
    return c.json({ error: error.message, code: error.code }, error.status);
  }
  return failureResponse(c, error);
}

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const routeAgentId = c.req.param("agentId");
    if (!routeAgentId) return c.json({ error: "Agent not found." }, 404);
    const agentId = await canonicalAgentId(routeAgentId, user.organization_id);
    if (!agentId) return c.json({ error: "Agent not found." }, 404);
    return c.json(
      await agentConnectorBindingsService.list(user.organization_id, agentId),
    );
  } catch (error) {
    return bindingFailure(c, error);
  }
});

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const body = await c.req.json().catch(() => null);
    const parsed = bindSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: "Invalid connector binding request.",
          details: parsed.error.issues,
        },
        400,
      );
    }
    const routeAgentId = c.req.param("agentId");
    if (!routeAgentId) return c.json({ error: "Agent not found." }, 404);
    const agentId = await canonicalAgentId(routeAgentId, user.organization_id);
    if (!agentId) return c.json({ error: "Agent not found." }, 404);
    const binding = await agentConnectorBindingsService.bind({
      organizationId: user.organization_id,
      agentId,
      platformCredentialId: parsed.data.platformCredentialId,
      provider: parsed.data.provider,
      role: parsed.data.role,
      purposes: parsed.data.purposes,
      accessGate: parsed.data.accessGate,
      selectedProducts: parsed.data.selectedProducts,
      isDefault: parsed.data.isDefault,
      authorizedByUserId: user.id,
      ownerBindingId: parsed.data.ownerBindingId,
      ownerIdentityId: parsed.data.ownerIdentityId,
    });
    await edgeRuntimeCache.bumpMcpVersion(user.organization_id);
    return c.json(binding, 201);
  } catch (error) {
    return bindingFailure(c, error);
  }
});

export default app;
