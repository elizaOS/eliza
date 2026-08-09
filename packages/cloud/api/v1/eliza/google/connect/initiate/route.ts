/**
 * POST /api/v1/eliza/google/connect/initiate
 *
 * Returns the OAuth URL the client should redirect to in order to start a
 * managed Google connection (with optional capability scopes).
 */

import { Hono } from "hono";
import { z } from "zod";
import { userCharactersRepository } from "@/db/repositories/characters";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  AgentGoogleConnectorError,
  initiateManagedGoogleConnection,
} from "@/lib/services/agent-google-connector";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

const requestSchema = z.object({
  agentId: z.string().uuid().optional(),
  side: z.enum(["owner", "agent"]).optional(),
  redirectUrl: z.string().trim().min(1).optional(),
  capabilities: z
    .array(
      z.enum([
        "google.basic_identity",
        "google.calendar.read",
        "google.calendar.write",
        "google.gmail.triage",
        "google.gmail.send",
        "google.gmail.manage",
      ]),
    )
    .optional(),
});

async function resolveAgent(
  routeAgentId: string,
  organizationId: string,
): Promise<{ id: string; userId: string } | null> {
  const direct = await userCharactersRepository.findByIdInOrganization(
    routeAgentId,
    organizationId,
  );
  if (direct) return { id: direct.id, userId: direct.user_id };
  const sandbox = await elizaSandboxService.getAgent(
    routeAgentId,
    organizationId,
  );
  if (!sandbox?.character_id) return null;
  const character = await userCharactersRepository.findByIdInOrganization(
    sandbox.character_id,
    organizationId,
  );
  return character ? { id: character.id, userId: character.user_id } : null;
}

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const parsed = requestSchema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parsed.success) {
      return c.json(
        {
          error: "Invalid Google connector request.",
          details: parsed.error.issues,
        },
        400,
      );
    }
    const side = parsed.data.side ?? "owner";
    const agent = parsed.data.agentId
      ? await resolveAgent(parsed.data.agentId, user.organization_id)
      : null;
    if (parsed.data.agentId && !agent) {
      return c.json({ error: "Agent not found." }, 404);
    }
    if (side === "owner" && agent && agent.userId !== user.id) {
      return c.json(
        { error: "OWNER connection requires an agent owned by this user." },
        403,
      );
    }
    const result = await initiateManagedGoogleConnection({
      organizationId: user.organization_id,
      userId: user.id,
      side,
      agentId: agent?.id,
      redirectUrl: parsed.data.redirectUrl,
      capabilities: parsed.data.capabilities,
    });
    return c.json(result);
  } catch (error) {
    if (error instanceof AgentGoogleConnectorError) {
      return c.json({ error: error.message }, error.status as 400);
    }
    return failureResponse(c, error);
  }
});

export default app;
