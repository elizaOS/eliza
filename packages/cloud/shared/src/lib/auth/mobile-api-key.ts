/**
 * Recognizes native lifecycle credentials without loading database services and
 * derives non-secret ingress limiter identities for those credentials.
 */

import { createHash } from "node:crypto";
import type { ApiKey } from "../../db/schemas/api-keys";

export const MOBILE_API_KEY_PREFIX = "eliza_mobile_";
const MOBILE_API_KEY_RE = /^eliza_mobile_[0-9a-f]{64}$/;

export function isMobileApiKeySecret(value: string): boolean {
  return MOBILE_API_KEY_RE.test(value);
}

/** Finds the header credential selected by the API-key auth boundary. */
export function getPresentedMobileApiKeySecret(request: Request): string | null {
  const headerKey = request.headers.get("x-api-key")?.trim() || null;
  const authorization = request.headers.get("authorization")?.trim() || null;
  const bearerKey = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || null;
  const presented = headerKey ?? bearerKey;
  return presented && isMobileApiKeySecret(presented) ? presented : null;
}

/**
 * Cloudflare sees only this digest as the limiter key; the bearer secret never
 * enters platform limiter metadata or logs.
 */
export function mobileApiKeyIngressRateLimitKey(secret: string): string {
  if (!isMobileApiKeySecret(secret)) {
    throw new TypeError("A valid mobile API key is required");
  }
  const fingerprint = createHash("sha256").update(secret).digest("hex");
  return `mobile-api-key-ingress:sha256:${fingerprint}`;
}

/** Mobile keys require durable activation, a client binding and finite lifetime. */
export function isUsableMobileApiKey(value: ApiKey | undefined): boolean {
  return Boolean(
    value?.is_active &&
      !value.deleted_at &&
      typeof value.source_app_id === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.source_app_id) &&
      value.expires_at &&
      new Date(value.expires_at) > new Date(),
  );
}
