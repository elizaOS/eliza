/**
 * Service-Account JWT Validation
 *
 * Validates HS256-signed JWTs issued by waifu-core's AgentClient.
 * Env: ELIZA_SERVICE_JWT_SECRET -- shared secret with waifu-core.
 */

import * as jose from "jose";
import { getCloudAwareEnv } from "@/lib/runtime/cloud-bindings";
import { logger } from "@/lib/utils/logger";

export interface ServiceJwtPayload {
  userId: string;
  email?: string;
  tier?: string;
}

const SECRET_ENV_KEY = "ELIZA_SERVICE_JWT_SECRET";

let _secret: Uint8Array | null = null;
let _secretRaw: string | null = null;

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

  try {
    const { payload } = await jose.jwtVerify(token, secret, {
      algorithms: ["HS256"],
    });

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
