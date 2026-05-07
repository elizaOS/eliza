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
import type { AppContext } from "@/types/cloud-worker-env";
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

const CONTROL_PLANE_URL_KEYS = [
  "CONTAINER_CONTROL_PLANE_URL",
  "CONTAINER_SIDECAR_URL",
  "HETZNER_CONTAINER_CONTROL_PLANE_URL",
] as const;

function readControlPlaneEnv(c: AppContext, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = c.env[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

async function deleteDockerBackedAgentViaControlPlane(
  c: AppContext,
  user: { id: string; organization_id: string },
  agentId: string,
): Promise<Response | null> {
  const baseUrl = readControlPlaneEnv(c, CONTROL_PLANE_URL_KEYS);
  if (!baseUrl) return null;

  const target = new URL(baseUrl);
  target.pathname = `/api/compat/agents/${encodeURIComponent(agentId)}`;

  const headers = new Headers(c.req.raw.headers);
  headers.delete("host");
  const internalToken = readControlPlaneEnv(c, ["CONTAINER_CONTROL_PLANE_TOKEN"]);
  if (internalToken) headers.set("x-container-control-plane-token", internalToken);
  headers.set("x-eliza-user-id", user.id);
  headers.set("x-eliza-organization-id", user.organization_id);

  const upstream = await fetch(target, {
    headers,
    method: "DELETE",
    redirect: "manual",
  });
  const body = await upstream.json().catch(() => errorEnvelope("Agent delete failed"));
  return withCompatCors(
    Response.json(body, {
      status: upstream.status,
      statusText: upstream.statusText,
    }),
    CORS_METHODS,
  );
}

async function __hono_DELETE(c: AppContext, { params }: RouteParams) {
  try {
    const { user } = await requireCompatAuth(c.req.raw);
    const { id: agentId } = await params;

    const existing = await elizaSandboxService.getAgent(agentId, user.organization_id);
    if (!existing) {
      return withCompatCors(
        Response.json(errorEnvelope("Agent not found"), { status: 404 }),
        CORS_METHODS,
      );
    }

    if (existing.node_id && existing.sandbox_id) {
      const forwarded = await deleteDockerBackedAgentViaControlPlane(c, user, agentId);
      if (forwarded) return forwarded;
    }

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
  __hono_DELETE(c, { params: Promise.resolve({ id: c.req.param("id")! }) }),
);
export default __hono_app;
