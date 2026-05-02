import { Hono } from "hono";

import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * GET/DELETE /api/compat/agents/[id]
 */

import { userCharactersRepository } from "@/db/repositories/characters";
import {
  envelope,
  errorEnvelope,
  toCompatAgent,
  toCompatOpResult,
} from "@/lib/api/compat-envelope";
import { reusesExistingElizaCharacter } from "@/lib/services/eliza-agent-config";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { getStewardAgent } from "@/lib/services/steward-client";
import { logger } from "@/lib/utils/logger";
import { requireCompatAuth } from "../../_lib/auth";
import { handleCompatCorsOptions, withCompatCors } from "../../_lib/cors";
import { handleCompatError } from "../../_lib/error-handler";

const CORS_METHODS = "GET, DELETE, OPTIONS";

type RouteParams = { params: Promise<{ id: string }> };

async function __hono_GET(request: Request, { params }: RouteParams) {
  try {
    const { user } = await requireCompatAuth(request);
    const { id: agentId } = await params;

    const agent = await elizaSandboxService.getAgent(agentId, user.organization_id);
    if (!agent) {
      return withCompatCors(
        Response.json(errorEnvelope("Agent not found"), {
          status: 404,
        }),
        CORS_METHODS,
      );
    }

    // Resolve wallet info for Docker-backed agents
    let walletInfo: { address: string | null; provider: "steward" | null } | undefined;
    if (agent.node_id) {
      try {
        const stewardAgent = await getStewardAgent(agentId, {
          organizationId: user.organization_id,
        });
        if (stewardAgent?.walletAddress) {
          walletInfo = {
            address: stewardAgent.walletAddress,
            provider: "steward",
          };
        }
      } catch {
        // Steward unreachable — wallet fields will be null
      }
    }

    return withCompatCors(Response.json(envelope(toCompatAgent(agent, walletInfo))), CORS_METHODS);
  } catch (err) {
    return handleCompatError(err, CORS_METHODS);
  }
}

async function __hono_DELETE(request: Request, { params }: RouteParams) {
  try {
    const { user } = await requireCompatAuth(request);
    const { id: agentId } = await params;

    const deleted = await elizaSandboxService.deleteAgent(agentId, user.organization_id);
    if (!deleted.success) {
      const status =
        deleted.error === "Agent not found"
          ? 404
          : deleted.error === "Agent provisioning is in progress"
            ? 409
            : 500;
      return withCompatCors(Response.json(errorEnvelope(deleted.error), { status }), CORS_METHODS);
    }

    const characterId = deleted.deletedSandbox.character_id;
    const sandboxConfig = deleted.deletedSandbox.agent_config as Record<string, unknown> | null;
    const reusesExistingCharacter = reusesExistingElizaCharacter(sandboxConfig);

    // Clean up the linked character row so the token_address unique constraint
    // is released. Best-effort: log but don't fail the delete if cleanup fails.
    if (characterId && !reusesExistingCharacter) {
      try {
        await userCharactersRepository.delete(characterId);
        logger.info("[compat] Cleaned up linked character after agent delete", {
          agentId,
          characterId,
        });
      } catch (charErr) {
        logger.warn("[compat] Failed to clean up linked character after agent delete", {
          agentId,
          characterId,
          error: charErr instanceof Error ? charErr.message : String(charErr),
        });
      }
    }

    logger.info("[compat] Agent deleted", {
      agentId,
      orgId: user.organization_id,
    });
    return withCompatCors(
      Response.json(envelope(toCompatOpResult(agentId, "delete", true))),
      CORS_METHODS,
    );
  } catch (err) {
    return handleCompatError(err, CORS_METHODS);
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.options("/", () => handleCompatCorsOptions(CORS_METHODS));
__hono_app.get("/", async (c) =>
  __hono_GET(c.req.raw, { params: Promise.resolve({ id: c.req.param("id")! }) }),
);
__hono_app.delete("/", async (c) =>
  __hono_DELETE(c.req.raw, { params: Promise.resolve({ id: c.req.param("id")! }) }),
);
export default __hono_app;
