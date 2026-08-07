/**
 * GET /.well-known/oidc/jwks.json — the public half of the OIDC signing key
 * ring (also mounted by codegen at /api/.well-known/oidc/jwks.json).
 *
 * Deliberately NOT the existing shared `/.well-known/jwks.json`, which merges
 * the internal-service and agent-token key sets. Three reasons: that route 503s
 * when neither of those is configured, which would couple SSO availability to
 * unrelated key config; co-publishing would let a relying party's
 * `createRemoteJWKSet` resolve a token signed by an unrelated key class; and
 * the OIDC ring rotates on its own schedule. The shared route is untouched.
 *
 * Every key in the ring is published, not just the active signer, so a rotation
 * can overlap: jose's `createRemoteJWKSet` only refetches on an unknown `kid`,
 * so tokens signed by the outgoing key must stay verifiable until they expire.
 */

import { Hono } from "hono";
import {
  describeOidcConfigFailure,
  isOidcEnabled,
  resolveOidcConfig,
} from "@/lib/oidc/config";
import { getOidcPublicJwks, isOidcSigningConfigured } from "@/lib/oidc/keys";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  if (!isOidcEnabled(c.env)) {
    return c.json({ error: "not_found" }, 404);
  }

  const config = resolveOidcConfig(c.env);
  if (!config) {
    // Every relying party fetches this URL to verify a token; a silent 404 for
    // a bad issuer would read as "this provider signs nothing".
    logger.error("[oidc] JWKS unavailable", {
      reason: describeOidcConfigFailure(c.env),
    });
    return c.json({ error: "not_found" }, 404);
  }
  if (new URL(c.req.url).host.toLowerCase() !== config.issuerHost) {
    return c.json({ error: "not_found" }, 404);
  }

  if (!isOidcSigningConfigured()) {
    logger.error(
      "[oidc] JWKS unavailable: OIDC_SIGNING_JWKS is not configured",
    );
    return c.json({ error: "oidc_not_configured" }, 503);
  }

  const jwks = await getOidcPublicJwks();
  return c.json(jwks, 200, {
    "Cache-Control": "public, max-age=300",
    "Content-Type": "application/json",
  });
});

export default app;
