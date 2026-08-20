/**
 * Session-bound OAuth success-proof verification.
 *
 * GET /api/v1/oauth/success-proof/verify?proof=…
 *
 * Requires an authenticated browser/API-key session that matches the org/user
 * the OAuth callback bound into the proof, then consumes the one-time ticket.
 * Anonymous or mismatched visitors cannot claim Connected from a forwarded URL.
 */

import { Hono } from "hono";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { consumeOAuthSuccessProof } from "@/lib/services/oauth/success-proof";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  const proof = c.req.query("proof");

  let organizationId: string;
  let userId: string;
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(c.req.raw);
    organizationId = user.organization_id;
    userId = user.id;
  } catch {
    // error-policy:J1 public verify boundary — no session means no Connected claim.
    return c.json({ ok: false, reason: "unauthorized" }, 401);
  }

  const result = await consumeOAuthSuccessProof(proof, {
    organizationId,
    userId,
  });
  if (!result.ok) {
    const status =
      result.reason === "missing_secret" ||
      result.reason === "ticket_store_unavailable"
        ? 503
        : result.reason === "binding_mismatch"
          ? 403
          : 400;
    return c.json(
      {
        ok: false,
        reason: result.reason,
      },
      status,
    );
  }
  return c.json({
    ok: true,
    platform: result.payload.platform,
    connectionId: result.payload.connectionId,
    capabilityContinuation: result.payload.capabilityContinuation,
    exp: result.payload.exp,
  });
});

export default app;
