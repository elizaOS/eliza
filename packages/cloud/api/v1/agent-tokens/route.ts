/**
 * POST /api/v1/agent-tokens
 * Mints a short-lived, RS256 Steward agent JWT for a cloud-provisioned agent.
 *
 * Auth: service-account bearer/header token, or an authenticated admin user.
 * Body: { agentId: string; ttl?: number }
 * Response: { token, expiresAt }
 */

import { Hono } from "hono";
import { mintAgentToken } from "@/lib/auth/agent-token";
import { timingSafeEqualSecret } from "@/lib/auth/cron";
import { getCurrentUser } from "@/lib/auth/workers-hono-auth";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

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

async function hasAdminAuth(c: AppContext): Promise<boolean> {
  const existing = c.get("user");
  if (existing?.role === "admin") return true;
  const user = await getCurrentUser(c).catch(() => null);
  return user?.role === "admin";
}

app.post("/", async (c) => {
  const serviceAccount = hasServiceAccountAuth(c);
  const admin = serviceAccount ? false : await hasAdminAuth(c);
  if (!serviceAccount && !admin) {
    return c.json(
      {
        success: false,
        error: "admin or container service-account auth required",
      },
      401,
    );
  }

  const body = (await c.req.json().catch(() => ({}))) as {
    agentId?: unknown;
    ttl?: unknown;
  };
  const agentId = typeof body.agentId === "string" ? body.agentId : "";
  if (!agentId.trim()) {
    return c.json({ success: false, error: "agentId is required" }, 400);
  }

  try {
    const minted = await mintAgentToken(agentId, body.ttl);
    logger.info("[agent-token] minted Steward JWT", {
      agentId: agentId.trim(),
      expiresAt: minted.expiresAt,
      actor: serviceAccount ? "service-account" : "admin",
    });
    return c.json(minted);
  } catch (error) {
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
