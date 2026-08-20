/**
 * Service-Account JWT Validation
 *
 * Validates HS256-signed JWTs issued by waifu-core's AgentClient.
 * Env: ELIZA_SERVICE_JWT_SECRET -- shared secret with waifu-core.
 *      ELIZA_SERVICE_JWT_ISSUER / ELIZA_SERVICE_JWT_AUDIENCE -- optional
 *      iss/aud pins for the service token class (jose enforces them only when
 *      configured, so deployments pin without a code change).
 */

import * as jose from "jose";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { logger } from "../utils/logger";
import { validateJwtLifetime } from "./jwt-lifetime";
import { STAGING_SESSION_TOKEN_TYP } from "./staging-session-binding";

export interface ServiceJwtPayload {
  userId: string;
  email?: string;
  tier?: string;
}

const SECRET_ENV_KEY = "ELIZA_SERVICE_JWT_SECRET";
const ISSUER_ENV_KEY = "ELIZA_SERVICE_JWT_ISSUER";
const AUDIENCE_ENV_KEY = "ELIZA_SERVICE_JWT_AUDIENCE";

/**
 * Service tokens are short-lived S2S credentials minted immediately before the
 * call; an hour covers the mint→verify round trip with clock-skew headroom.
 */
const MAX_SERVICE_JWT_TTL_SECONDS = 3600;
const SERVICE_JWT_CLOCK_TOLERANCE_SECONDS = 5 * 60;

let _secret: Uint8Array | null = null;
let _secretRaw: string | null = null;
let _warnedClaimsNotPinned = false;

function getSecret(): Uint8Array | null {
  const raw = getCloudAwareEnv()[SECRET_ENV_KEY];
  if (!raw) return null;
  if (_secret && _secretRaw === raw) return _secret;
  _secretRaw = raw;
  _secret = new TextEncoder().encode(raw);
  return _secret;
}

/**
 * Verify an HS256 service JWT from the Authorization header.
 */
export async function verifyServiceJwt(
  authHeader: string | null,
): Promise<ServiceJwtPayload | null> {
  if (!authHeader) return null;

  const secret = getSecret();
  if (!secret) return null;

  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
  if (!token) return null;

  const env = getCloudAwareEnv();
  const issuer = env[ISSUER_ENV_KEY]?.trim() || undefined;
  const audience = env[AUDIENCE_ENV_KEY]?.trim() || undefined;
  if (!issuer && !audience && !_warnedClaimsNotPinned) {
    // Once per process: without pins, any HS256 token under the shared secret
    // is accepted regardless of issuer/audience. Operators should set
    // ELIZA_SERVICE_JWT_ISSUER / ELIZA_SERVICE_JWT_AUDIENCE to the values the
    // minting service emits.
    _warnedClaimsNotPinned = true;
    logger.warn("[service-jwt] iss/aud not pinned — set ELIZA_SERVICE_JWT_ISSUER/AUDIENCE");
  }

  try {
    const { payload, protectedHeader } = await jose.jwtVerify(token, secret, {
      algorithms: ["HS256"],
      clockTolerance: SERVICE_JWT_CLOCK_TOLERANCE_SECONDS,
      ...(issuer ? { issuer } : {}),
      ...(audience ? { audience } : {}),
    });

    // A QA browser session must never acquire service-account authority, even
    // if an operator accidentally configures both token classes with the same
    // HMAC secret. Compat routes try this verifier before ordinary auth and
    // service identities bypass user credit/quota checks, so the token class is
    // an unconditional boundary in addition to the deployment-time key check.
    if (protectedHeader.typ === STAGING_SESSION_TOKEN_TYP) {
      logger.warn("[service-jwt] Rejected staging QA session token class");
      return null;
    }

    // jose enforces `exp` only when the claim exists — a token minted without
    // one would never expire. Service tokens are short-lived S2S credentials:
    // require an expiry and cap its horizon so a leaked token's usefulness is
    // bounded.
    const lifetime = validateJwtLifetime(payload, {
      maxTtlSeconds: MAX_SERVICE_JWT_TTL_SECONDS,
      clockToleranceSeconds: SERVICE_JWT_CLOCK_TOLERANCE_SECONDS,
    });
    if (!lifetime.valid) {
      logger.warn(`[service-jwt] Rejected token: ${lifetime.reason}`);
      return null;
    }

    const userId = payload.userId as string | undefined;
    if (!userId) {
      logger.warn("[service-jwt] Token missing userId claim");
      return null;
    }

    return {
      userId,
      email: (payload.email as string) ?? undefined,
      tier: (payload.tier as string) ?? undefined,
    };
  } catch (err) {
    if (typeof token === "string" && token.split(".").length === 3) {
      logger.debug(
        `[service-jwt] Verification failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return null;
  }
}

/**
 * Check if service JWT auth is configured.
 */
export function isServiceJwtEnabled(): boolean {
  return Boolean(getCloudAwareEnv()[SECRET_ENV_KEY]);
}
