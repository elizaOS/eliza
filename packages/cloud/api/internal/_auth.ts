// Handles internal cloud API internal auth route traffic with service-to-service auth.
import type { Context } from "hono";
import { jsonError } from "@/lib/api/cloud-worker-errors";
import {
  extractBearerToken,
  verifyInternalToken,
} from "@/lib/auth/jwt-internal";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

export interface InternalServiceAuth {
  podName: string;
  service?: string;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) {
    diff |= aBytes[i] ^ bBytes[i];
  }
  return diff === 0;
}

export async function requireInternalAuth(
  c: Context<AppEnv>,
): Promise<InternalServiceAuth | Response> {
  const token = extractBearerToken(c.req.header("Authorization") ?? null);
  if (!token) {
    return jsonError(c, 401, "Unauthorized", "authentication_required");
  }

  const sharedSecret = String(c.env.INTERNAL_SECRET ?? "").trim();
  if (sharedSecret && constantTimeEqual(token, sharedSecret)) {
    return {
      podName: "internal-secret",
      service: "shared-secret",
    };
  }

  try {
    const verified = await verifyInternalToken(token);
    return {
      podName: verified.payload.sub,
      service: verified.payload.service,
    };
  } catch (error) {
    // Rejection stays fail-closed (denylist store errors reject the token by
    // design), but the REASON must reach the logs: a swallowed error makes a
    // revocation-store outage indistinguishable from a bad token (live:
    // staging's Telegram live-fire 401'd here for hours with signature-valid
    // tokens before the Redis REST denylist read was isolated as the cause —
    // by elimination, because nothing logged it). Message only, never the
    // token or its claims.
    logger.warn("[internal-auth] internal token rejected", {
      reason: error instanceof Error ? error.message : String(error),
    });
    return jsonError(c, 401, "Unauthorized", "authentication_required");
  }
}
