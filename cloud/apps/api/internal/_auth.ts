import type { Context } from "hono";
import { jsonError } from "@/lib/api/cloud-worker-errors";
import { extractBearerToken, verifyInternalToken } from "@/lib/auth/jwt-internal";
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
  } catch {
    return jsonError(c, 401, "Unauthorized", "authentication_required");
  }
}
