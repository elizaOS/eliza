import { createRemoteJWKSet, jwtVerify } from "jose";

export class OidcAuthError extends Error {
  constructor(message, { code = "oidc_auth_failed" } = {}) {
    super(message);
    this.name = "OidcAuthError";
    this.code = code;
  }
}

export function createOidcVerifier(config = {}) {
  if (config.enabled !== true) return null;
  if (!config.issuerUrl) {
    throw new TypeError("OIDC verifier requires issuerUrl");
  }
  if (!config.audience) {
    throw new TypeError("OIDC verifier requires audience");
  }

  let jwksPromise;
  return {
    async verify(token) {
      jwksPromise ??= createRemoteJwks(config);
      const JWKS = await jwksPromise;
      const { payload, protectedHeader } = await jwtVerify(token, JWKS, {
        issuer: config.issuerUrl,
        audience: config.audience,
        clockTolerance: config.clockTolerance ?? "60s",
      });

      assertRequiredClaimIntersection(
        payload.roles,
        config.requiredRoles,
        "roles",
      );
      assertRequiredClaimIntersection(
        payload.groups,
        config.requiredGroups,
        "groups",
      );

      return {
        subject: payload.sub,
        payload,
        protectedHeader,
      };
    },
  };
}

async function createRemoteJwks(config) {
  const jwksUrl = config.jwksUrl ?? (await discoverJwksUrl(config));
  return createRemoteJWKSet(new URL(jwksUrl));
}

async function discoverJwksUrl(config) {
  const discoveryUrl =
    config.discoveryUrl ??
    new URL(
      ".well-known/openid-configuration",
      ensureTrailingSlash(config.issuerUrl),
    ).toString();
  const response = await fetch(discoveryUrl, {
    headers: {
      accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new OidcAuthError(`OIDC discovery failed with ${response.status}`, {
      code: "oidc_discovery_failed",
    });
  }

  const metadata = await response.json();
  if (metadata.issuer !== config.issuerUrl) {
    throw new OidcAuthError("OIDC discovery issuer mismatch", {
      code: "oidc_issuer_mismatch",
    });
  }
  if (!metadata.jwks_uri) {
    throw new OidcAuthError("OIDC discovery did not return jwks_uri", {
      code: "oidc_jwks_missing",
    });
  }
  return metadata.jwks_uri;
}

function assertRequiredClaimIntersection(value, required = [], claimName) {
  if (!required.length) return;
  const actual = new Set(normalizeClaimList(value));
  if (required.some((item) => actual.has(item))) return;
  throw new OidcAuthError(`OIDC token is missing required ${claimName}`, {
    code: `oidc_missing_${claimName}`,
  });
}

function normalizeClaimList(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    return value
      .split(/[,\s]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}
