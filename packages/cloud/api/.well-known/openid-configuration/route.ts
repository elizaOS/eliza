/**
 * GET /.well-known/openid-configuration — the OpenID Provider discovery
 * document (also mounted by codegen at /api/.well-known/openid-configuration).
 *
 * Relying parties pin what this returns: Merge Steward throws
 * `oidc_issuer_mismatch` unless `issuer` byte-equals its configured issuer URL,
 * and Forgejo's auth source is created from this URL. So the document is served
 * ONLY on the host the issuer names — the Worker also answers
 * `*.elizacloud.ai/*`, and without that guard every subdomain, including the
 * ones serving user-controlled content, would advertise itself as this issuer.
 *
 * The route is unauthenticated by construction: `authMiddleware` returns early
 * for any path outside `/api/`, and the `/api/` twin sits under the existing
 * `/api/.well-known` public prefix.
 */

import { Hono } from "hono";
import {
  isOidcClientRegistryConfigured,
  listOidcClients,
} from "@/lib/oidc/clients";
import { isOidcEnabled, resolveOidcConfig } from "@/lib/oidc/config";
import {
  getOidcSigningAlgorithms,
  isOidcSigningConfigured,
} from "@/lib/oidc/keys";
import { buildOidcDiscoveryDocument } from "@/lib/oidc/metadata";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  if (!isOidcEnabled(c.env)) {
    return c.json({ error: "not_found" }, 404);
  }

  const config = resolveOidcConfig(c.env);
  if (!config) {
    logger.error(
      "[oidc] discovery unavailable: OIDC_ISSUER_URL is missing or unusable",
    );
    return c.json({ error: "oidc_not_configured" }, 503);
  }

  const requestHost = new URL(c.req.url).host.toLowerCase();
  if (requestHost !== config.issuerHost) {
    // Only the issuer host may advertise this document. Answering elsewhere
    // would let a sibling host present itself as this OpenID Provider.
    return c.json({ error: "not_found" }, 404);
  }

  if (!isOidcSigningConfigured()) {
    // A wiped `OIDC_SIGNING_JWKS` secret must fail loudly, never as a document
    // advertising a JWKS URL that will return nothing.
    logger.error(
      "[oidc] discovery unavailable: OIDC_SIGNING_JWKS is not configured",
    );
    return c.json({ error: "oidc_not_configured" }, 503);
  }

  // A registry that fails to parse must not silently drop the constant claims
  // from the document; it means no login can succeed anyway.
  if (!isOidcClientRegistryConfigured()) {
    logger.error(
      "[oidc] discovery unavailable: OIDC_CLIENTS is not configured",
    );
    return c.json({ error: "oidc_not_configured" }, 503);
  }
  let constantClaimNames: string[];
  try {
    constantClaimNames = listOidcClients().flatMap((client) =>
      Object.keys(client.constant_claims),
    );
  } catch (error) {
    // error-policy:J1 route boundary — an incoherent registry is a deploy fault.
    // Advertising a document built from it would pin an RP to a provider that
    // cannot answer /authorize.
    logger.error("[oidc] discovery unavailable: OIDC_CLIENTS did not load", {
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json({ error: "oidc_not_configured" }, 503);
  }

  const document = buildOidcDiscoveryDocument(
    config,
    await getOidcSigningAlgorithms(),
    constantClaimNames,
  );
  return c.json(document, 200, {
    "Cache-Control": "public, max-age=300",
    "Content-Type": "application/json",
  });
});

export default app;
