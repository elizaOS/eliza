/**
 * Workers-compatible service-key auth (WebCrypto — no Node `crypto`).
 *
 * Required env vars (read from `c.env`):
 *   WAIFU_SERVICE_KEY      — shared secret callers send in `X-Service-Key`
 *   WAIFU_SERVICE_ORG_ID   — owning organization id for service-provisioned resources
 *   WAIFU_SERVICE_USER_ID  — user id attributed as creator
 */

import { ApiError, AuthenticationError } from "@/lib/api/cloud-worker-errors";
import type { AppContext, Bindings } from "@/types/cloud-worker-env";

export interface ServiceKeyIdentity {
  organizationId: string;
  userId: string;
}

async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey("raw", salt, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const enc = new TextEncoder();
  const da = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(a)));
  const db = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(b)));
  let diff = 0;
  for (let i = 0; i < da.length; i++) diff |= da[i] ^ db[i];
  return diff === 0;
}

export async function validateServiceKey(c: AppContext): Promise<ServiceKeyIdentity | null> {
  const header = c.req.header("X-Service-Key") || c.req.header("x-service-key") || "";
  if (!header.trim()) return null;

  const env = c.env as Bindings & {
    WAIFU_SERVICE_KEY?: string;
    WAIFU_SERVICE_ORG_ID?: string;
    WAIFU_SERVICE_USER_ID?: string;
  };
  const expected = (env.WAIFU_SERVICE_KEY || "").trim();
  if (!expected) return null;

  const ok = await constantTimeEqual(header, expected);
  if (!ok) return null;

  const orgId = env.WAIFU_SERVICE_ORG_ID?.trim();
  const userId = env.WAIFU_SERVICE_USER_ID?.trim();
  if (!orgId || !userId) {
    throw new ApiError(
      500,
      "internal_error",
      "WAIFU_SERVICE_ORG_ID and WAIFU_SERVICE_USER_ID must be set when WAIFU_SERVICE_KEY is configured",
    );
  }

  return { organizationId: orgId, userId };
}

export async function requireServiceKey(c: AppContext): Promise<ServiceKeyIdentity> {
  const identity = await validateServiceKey(c);
  if (!identity) throw AuthenticationError("Invalid or missing service key");
  return identity;
}

export class ServiceKeyAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceKeyAuthError";
  }
}
