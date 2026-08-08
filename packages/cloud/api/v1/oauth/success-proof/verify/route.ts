/**
 * Public OAuth success-proof verification.
 *
 * GET /api/v1/oauth/success-proof/verify?proof=…
 *
 * Validates the short-lived HMAC minted by OAuth callbacks so the browser
 * landing page can confirm completion without an API-key session.
 */

import { Hono } from "hono";
import { verifyOAuthSuccessProof } from "@/lib/services/oauth/success-proof";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", (c) => {
  const proof = c.req.query("proof");
  const result = verifyOAuthSuccessProof(proof);
  if (!result.ok) {
    return c.json(
      {
        ok: false,
        reason: result.reason,
      },
      result.reason === "missing_secret" ? 503 : 400,
    );
  }
  return c.json({
    ok: true,
    platform: result.payload.platform,
    connectionId: result.payload.connectionId,
    exp: result.payload.exp,
  });
});

export default app;
