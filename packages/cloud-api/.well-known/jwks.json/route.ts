/**
 * GET /.well-known/jwks.json
 * Returns the public keys used for JWT verification (RFC 7517).
 */

import { Hono } from "hono";
import {
  getAgentTokenJWKS,
  isAgentTokenSigningConfigured,
} from "@/lib/auth/agent-token";
import { getJWKS, isJWKSConfigured } from "@/lib/auth/jwks";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  const keys = [];
  if (isJWKSConfigured()) {
    keys.push(...(await getJWKS()).keys);
  }
  if (isAgentTokenSigningConfigured()) {
    keys.push(...(await getAgentTokenJWKS()).keys);
  }
  if (keys.length === 0) {
    return c.json({ error: "JWKS not configured" }, 503);
  }
  return c.json({ keys }, 200, {
    "Cache-Control": "public, max-age=300",
    "Content-Type": "application/json",
  });
});

export default app;
