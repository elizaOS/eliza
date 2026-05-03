/**
 * GET /.well-known/jwks.json
 * Returns the public keys used for JWT verification (RFC 7517).
 */

import { Hono } from "hono";
import { getJWKS, isJWKSConfigured } from "@/lib/auth/jwks";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  if (!isJWKSConfigured()) {
    return c.json({ error: "JWKS not configured" }, 503);
  }
  const jwks = await getJWKS();
  return c.json(jwks, 200, {
    "Cache-Control": "public, max-age=300",
    "Content-Type": "application/json",
  });
});

export default app;
