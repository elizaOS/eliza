/**
 * POST /api/v1/agent-tokens
 * Mints a short-lived, RS256 Steward agent JWT for a cloud-provisioned agent.
 *
 * Auth: service-account bearer/header token (any agentId), a platform admin
 * (any agentId), or an organization admin whose organization owns the agent.
 * The human mint is bound to the caller's authority so one tenant cannot
 * impersonate another tenant's agent at Steward.
 * Body: { agentId: string; ttl?: number }
 * Response: { token, expiresAt }
 */

import { getCurrentUser, requireAdmin } from "@elizaos/cloud-shared/auth";
import { agentSandboxesRepository } from "@elizaos/cloud-shared/db/repositories/agent-sandboxes";
import { ApiError } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { mintAgentToken } from "@elizaos/cloud-shared/lib/auth/agent-token";
import { timingSafeEqualSecret } from "@elizaos/cloud-shared/lib/auth/cron";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type {
  AppContext,
  AppEnv,
} from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

function bearerToken(c: {
  req: { header: (name: string) => string | undefined };
}): string | null {
  const auth = c.req.header("authorization");
  return auth?.startsWith("Bearer ") ? auth.slice(7) : null;
}

function serviceToken(c: AppEnv["Bindings"]): string | null {
  const candidates = [c.ELIZA_CLOUD_SERVICE_TOKEN, c.AGENT_TOKEN_SERVICE_TOKEN];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim())
      return candidate.trim();
  }
  return null;
}

function hasServiceAccountAuth(c: AppContext): boolean {
  const expected = serviceToken(c.env);
  if (!expected) return false;
  const supplied =
    bearerToken(c) ??
    c.req.header("x-eliza-service-token") ??
    c.req.header("x-service-token");
  if (typeof supplied !== "string") return false;
  return timingSafeEqualSecret(supplied, expected);
}

type HumanMintAuth =
  | {
      ok: true;
      actor: string;
      actorUserId: string;
      actorOrganizationId: string | null;
    }
  | { ok: false; status: 401 | 403; error: string };

/**
 * Human callers hold no service secret, so the mint must be tied to their
 * platform or org authority: platform admins mint for any agentId, while an
 * org "admin" (a per-organization role on the users row, not a platform role)
 * mints only for an agent owned by their own organization.
 */
async function authorizeHumanMint(
  c: AppContext,
  agentId: string,
): Promise<HumanMintAuth> {
  try {
    const { user } = await requireAdmin(c);
    return {
      ok: true,
      actor: "platform-admin",
      actorUserId: user.id,
      actorOrganizationId: user.organization_id,
    };
  } catch (error) {
    // error-policy:J1 route boundary — a 401/403 platform-admin denial is not final here; the org-scoped check below produces the structured denial. Infrastructure failures (e.g. 503 storage outage) propagate to the global onError translator instead of being masked as auth failures.
    if (
      error instanceof ApiError &&
      error.status !== 401 &&
      error.status !== 403
    ) {
      throw error;
    }
  }

  const user = await getCurrentUser(c);
  if (!user) {
    return {
      ok: false,
      status: 401,
      error: "admin or container service-account auth required",
    };
  }
  // Deactivation must revoke this fallback too: getCurrentUser performs no
  // is_active screening (that lives in requireUser/requireUserWithOrg, which
  // the swallowed platform-admin denial above may have failed on), so reject
  // deactivated users/orgs explicitly before the org-admin leg.
  if (
    user.is_active !== true ||
    !user.organization ||
    user.organization.is_active !== true ||
    user.organization.id !== user.organization_id
  ) {
    return {
      ok: false,
      status: 403,
      error:
        "platform admin or owning-organization admin required for this agentId",
    };
  }
  if (agentId && user.role === "admin" && user.organization_id) {
    const sandbox = await agentSandboxesRepository.findByIdAndOrg(
      agentId,
      user.organization_id,
    );
    if (sandbox) {
      return {
        ok: true,
        actor: "org-admin",
        actorUserId: user.id,
        actorOrganizationId: user.organization_id,
      };
    }
  }
  return {
    ok: false,
    status: 403,
    error:
      "platform admin or owning-organization admin required for this agentId",
  };
}

app.post("/", async (c) => {
  const serviceAccount = hasServiceAccountAuth(c);

  const body = (await c.req.json().catch(() => ({}))) as {
    agentId?: unknown;
    ttl?: unknown;
  };
  const agentId = typeof body.agentId === "string" ? body.agentId.trim() : "";

  let actor = "service-account";
  let actorUserId: string | null = null;
  let actorOrganizationId: string | null = null;
  if (!serviceAccount) {
    const authz = await authorizeHumanMint(c, agentId);
    if (!authz.ok) {
      return c.json({ success: false, error: authz.error }, authz.status);
    }
    actor = authz.actor;
    actorUserId = authz.actorUserId;
    actorOrganizationId = authz.actorOrganizationId;
  }

  if (!agentId) {
    return c.json({ success: false, error: "agentId is required" }, 400);
  }

  try {
    const minted = await mintAgentToken(agentId, body.ttl);
    logger.info("[agent-token] minted Steward JWT", {
      agentId,
      expiresAt: minted.expiresAt,
      actor,
      actorUserId: actorUserId ?? undefined,
      actorOrganizationId: actorOrganizationId ?? undefined,
    });
    return c.json(minted);
  } catch (error) {
    // error-policy:J1 route boundary — this catch translates mint failures into structured HTTP failures (400 invalid id / 503 unconfigured key / 500 otherwise), never a fabricated success token.
    const message = error instanceof Error ? error.message : String(error);
    if (message === "invalid agentId") {
      return c.json({ success: false, error: message }, 400);
    }
    if (message.includes("AGENT_TOKEN_PRIVATE_KEY_PEM")) {
      return c.json(
        { success: false, error: "agent-token signing key is not configured" },
        503,
      );
    }
    logger.error("[agent-token] failed to mint Steward JWT", { error });
    return c.json({ success: false, error: "failed to mint agent token" }, 500);
  }
});

export default app;
