/**
 * GET /.well-known/jwks.json
 * Returns the public keys used for JWT verification (RFC 7517).
 */

import {
  getAgentTokenJWKS,
  isAgentTokenSigningConfigured,
} from "@elizaos/cloud-shared/lib/auth/agent-token";
import { getJWKS, isJWKSConfigured } from "@elizaos/cloud-shared/lib/auth/jwks";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

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
