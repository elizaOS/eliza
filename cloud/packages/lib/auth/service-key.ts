/**
 * Service-to-Service Authentication via X-Service-Key header.
 *
 * Used by trusted backend callers (e.g. waifu.fun) that provision and manage
 * Agent cloud agents on behalf of token owners.
 *
 * Required env vars:
 *   WAIFU_SERVICE_KEY       — shared secret the caller sends in X-Service-Key
 *   WAIFU_SERVICE_ORG_ID    — organization that owns service-provisioned agents
 *   WAIFU_SERVICE_USER_ID   — user id used as the creator of service-provisioned agents
 */

import crypto from "crypto";
import { getCloudAwareEnv } from "@/lib/runtime/cloud-bindings";
import { logger } from "@/lib/utils/logger";

export interface ServiceKeyIdentity {
  /** The organization that owns resources created through this service key. */
  organizationId: string;
  /** The user id attributed as creator of resources. */
  userId: string;
}

/**
 * Validate the X-Service-Key header and return the mapped identity.
 * Returns null when the header is missing or invalid.
 * Throws when env vars are misconfigured.
 */
export function validateServiceKey(request: Request): ServiceKeyIdentity | null {
  const header = request.headers.get("X-Service-Key");
  if (!header || header.trim().length === 0) {
    return null;
  }

  const expectedKey = getCloudAwareEnv().WAIFU_SERVICE_KEY;
  if (!expectedKey || expectedKey.trim().length === 0) {
    logger.warn("[service-key] WAIFU_SERVICE_KEY is not configured — rejecting service key auth");
    return null;
  }

  // Constant-time comparison via fixed-length HMAC digests.
  // Comparing digests instead of raw values avoids leaking the
  // expected key's length through early-exit on size mismatch.
  const hmacKey = crypto.randomBytes(32);
  const headerDigest = crypto.createHmac("sha256", hmacKey).update(header).digest();
  const expectedDigest = crypto.createHmac("sha256", hmacKey).update(expectedKey).digest();

  if (!crypto.timingSafeEqual(headerDigest, expectedDigest)) {
    logger.warn("[service-key] Invalid service key presented");
    return null;
  }

  const orgId = getCloudAwareEnv().WAIFU_SERVICE_ORG_ID;
  const userId = getCloudAwareEnv().WAIFU_SERVICE_USER_ID;

  if (!orgId?.trim() || !userId?.trim()) {
    throw new Error(
      "WAIFU_SERVICE_ORG_ID and WAIFU_SERVICE_USER_ID must be set when WAIFU_SERVICE_KEY is configured",
    );
  }

  return {
    organizationId: orgId,
    userId: userId,
  };
}

/**
 * Require valid service key — returns identity or throws 401/500.
 */
export function requireServiceKey(request: Request): ServiceKeyIdentity {
  const identity = validateServiceKey(request);
  if (!identity) {
    throw new ServiceKeyAuthError("Invalid or missing service key");
  }
  return identity;
}

export class ServiceKeyAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceKeyAuthError";
  }
}
