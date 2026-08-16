/**
 * Internal JWT Authentication
 *
 * JWT signing and verification for service-to-service communication.
 * Used by the Discord gateway and other internal services.
 */

import { type JWTPayload, jwtVerify, SignJWT } from "jose";
import { nanoid } from "nanoid";
import { getAlgorithm, getKeyId, getPrivateKey, getPublicKey } from "./jwks";
import { isJtiRevoked } from "./jwt-internal-denylist";

export {
  isDenylistConfigured,
  isJtiRevoked,
  revokeInternalToken,
} from "./jwt-internal-denylist";

/**
 * JWT token lifetime in seconds (1 hour).
 * Gateway should refresh at 80% lifetime (48 minutes).
 */
export const TOKEN_LIFETIME_SECONDS = 3600;

/**
 * Gateway tokens cross the public network on every connector delivery. Their
 * one-minute lifetime bounds replay tightly enough for local signature
 * verification while ordinary internal tokens retain per-jti revocation.
 */
export const GATEWAY_TOKEN_LIFETIME_SECONDS = 60;

const SHORT_LIVED_GATEWAY_SERVICES = new Set(["webhook-gateway", "discord-gateway"]);

/**
 * Issuer claim for internal JWTs.
 */
const ISSUER = "eliza-cloud";

/**
 * Audience claim for internal JWTs.
 */
const AUDIENCE = "eliza-cloud-internal";

/**
 * Claims included in internal service JWTs.
 */
export interface InternalJWTPayload extends JWTPayload {
  /** Subject - the pod name or service identifier */
  sub: string;
  /** Issuer */
  iss: string;
  /** Audience */
  aud: string;
  /** Issued at (Unix timestamp) */
  iat: number;
  /** Expiration (Unix timestamp) */
  exp: number;
  /**
   * JWT ID — unique per-token nonce.
   *
   * Revocation model: a single token can be revoked before its natural expiry
   * via the `jti` denylist (`revokeInternalToken`), enforced fail-closed in
   * `verifyInternalToken`. When no Redis backend is configured, per-`jti`
   * revocation is unsupported and revocation falls back to signing-key
   * rotation + short TTL. See `./jwt-internal-denylist`.
   */
  jti: string;
  /** Service type (e.g., "discord-gateway") */
  service?: string;
}

/**
 * Result of token verification.
 */
export interface VerificationResult {
  valid: true;
  payload: InternalJWTPayload;
}

/**
 * Options for signing a new token.
 */
export interface SignTokenOptions {
  /** Subject - typically the pod name */
  subject: string;
  /** Service type for additional context */
  service?: string;
  /** Custom expiration in seconds (defaults to TOKEN_LIFETIME_SECONDS) */
  expiresIn?: number;
}

export function internalTokenLifetimeForService(service: string | undefined): number {
  return service && SHORT_LIVED_GATEWAY_SERVICES.has(service)
    ? GATEWAY_TOKEN_LIFETIME_SECONDS
    : TOKEN_LIFETIME_SECONDS;
}

/**
 * Sign a new JWT for an internal service.
 *
 * @param options - Token options including subject and optional service type
 * @returns Object with access_token, token_type, and expires_in
 */
export async function signInternalToken(options: SignTokenOptions): Promise<{
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
}> {
  const privateKey = await getPrivateKey();
  const expiresIn = options.expiresIn ?? TOKEN_LIFETIME_SECONDS;
  const jti = nanoid();

  const jwt = await new SignJWT({
    service: options.service,
  })
    .setProtectedHeader({
      alg: getAlgorithm(),
      kid: getKeyId(),
    })
    .setSubject(options.subject)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${expiresIn}s`)
    .setJti(jti)
    .sign(privateKey);

  return {
    access_token: jwt,
    token_type: "Bearer",
    expires_in: expiresIn,
  };
}

/**
 * Verify an internal JWT and extract its payload.
 *
 * Enforces the `jti` revocation contract: a token whose `jti` has been revoked
 * via `revokeInternalToken` is rejected. The denylist check is FAIL-CLOSED — if
 * the denylist store errors while it is configured, verification throws (the
 * token is NOT accepted). See `./jwt-internal-denylist`.
 *
 * @throws Error if token is invalid, expired, has wrong issuer/audience, is
 *   missing a required claim, has a revoked `jti`, or the denylist check fails.
 */
async function verifyInternalTokenClaims(token: string): Promise<VerificationResult> {
  const publicKey = await getPublicKey();

  const { payload } = await jwtVerify(token, publicKey, {
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithms: [getAlgorithm()],
  });

  // Validate required claims exist
  if (!payload.sub) {
    throw new Error("Token missing subject claim");
  }
  if (!payload.jti) {
    throw new Error("Token missing JWT ID claim");
  }

  return {
    valid: true,
    payload: payload as InternalJWTPayload,
  };
}

async function requireTokenNotRevoked(payload: InternalJWTPayload): Promise<void> {
  if (await isJtiRevoked(payload.jti)) {
    throw new Error("Token has been revoked");
  }
}

function isBoundedGatewayToken(payload: InternalJWTPayload): boolean {
  if (!payload.service || !SHORT_LIVED_GATEWAY_SERVICES.has(payload.service)) {
    return false;
  }
  if (
    typeof payload.iat !== "number" ||
    !Number.isInteger(payload.iat) ||
    typeof payload.exp !== "number" ||
    !Number.isInteger(payload.exp)
  ) {
    return false;
  }
  const lifetimeSeconds = payload.exp - payload.iat;
  return lifetimeSeconds > 0 && lifetimeSeconds <= GATEWAY_TOKEN_LIFETIME_SECONDS;
}

export async function verifyInternalToken(token: string): Promise<VerificationResult> {
  const result = await verifyInternalTokenClaims(token);
  await requireTokenNotRevoked(result.payload);
  return result;
}

/**
 * Verifies tokens presented on internal request routes. Only signed gateway
 * credentials whose complete lifetime is one minute or less avoid the remote
 * revocation read; every other token keeps the fail-closed denylist contract.
 */
export async function verifyInternalRequestToken(token: string): Promise<VerificationResult> {
  const result = await verifyInternalTokenClaims(token);
  if (!isBoundedGatewayToken(result.payload)) {
    await requireTokenNotRevoked(result.payload);
  }
  return result;
}

/**
 * Extract the Bearer token from an Authorization header.
 */
export function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;

  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") {
    return null;
  }

  return parts[1];
}
