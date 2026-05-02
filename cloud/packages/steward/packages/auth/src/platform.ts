import { createHash, timingSafeEqual } from "node:crypto";
import type { ApiResponse } from "@stwd/shared";
import { createMiddleware } from "hono/factory";

/**
 * Platform-level authentication middleware.
 *
 * Platform keys grant elevated access (cross-tenant management, provisioning,
 * stats) and are issued out-of-band to trusted platform operators such as
 * Eliza Cloud.
 *
 * Configuration
 * ─────────────
 * STEWARD_PLATFORM_KEYS — comma-separated list of valid raw platform key
 *   strings (e.g. "stw_platform_elizacloud_xxx,stw_platform_internal_yyy").
 *
 * Request header
 * ──────────────
 * X-Steward-Platform-Key: <raw key>
 */

function getValidPlatformKeys(): string[] {
  return (process.env.STEWARD_PLATFORM_KEYS || "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

/**
 * Hash a key with SHA-256 so we always compare fixed-length 32-byte buffers.
 * This prevents length-based timing leaks when using timingSafeEqual.
 */
function hashKey(key: string): Buffer {
  return createHash("sha256").update(key).digest();
}

/**
 * Timing-safe string equality via SHA-256 digest comparison.
 * Both strings are hashed first → always 32-byte buffers → no length leak.
 */
function timingSafeStringEqual(a: string, b: string): boolean {
  const hashA = hashKey(a);
  const hashB = hashKey(b);
  return timingSafeEqual(hashA, hashB);
}

/**
 * Validate a supplied key against the list of allowed platform keys.
 *
 * Iterates ALL valid keys without short-circuiting to avoid timing oracles
 * that could reveal how many keys are configured or their ordering.
 */
export function isValidPlatformKey(key: string): boolean {
  const validKeys = getValidPlatformKeys();
  if (validKeys.length === 0) return false;

  let found = false;
  for (const validKey of validKeys) {
    // Always run every comparison — no early return on match
    if (timingSafeStringEqual(key, validKey)) {
      found = true;
    }
  }
  return found;
}

/**
 * Hono middleware that enforces platform key authentication.
 * Mount this on any route group that requires platform-level access.
 *
 * @example
 * ```ts
 * const platform = new Hono();
 * platform.use("*", platformAuthMiddleware());
 * ```
 */
export function platformAuthMiddleware() {
  return createMiddleware(async (c, next) => {
    const key = c.req.header("X-Steward-Platform-Key");

    if (!key) {
      return c.json<ApiResponse>(
        { ok: false, error: "X-Steward-Platform-Key header is required" },
        401,
      );
    }

    if (!isValidPlatformKey(key)) {
      return c.json<ApiResponse>({ ok: false, error: "Invalid platform key" }, 403);
    }

    await next();
  });
}
