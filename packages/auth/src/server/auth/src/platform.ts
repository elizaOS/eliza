import { createHash, timingSafeEqual } from "node:crypto";
import { createMiddleware } from "hono/factory";
import type { ApiResponse } from "../../shared/src/index.ts";

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
 * STEWARD_PLATFORM_KEY_SCOPES — optional JSON object mapping a raw key or its
 *   sha256 hex hash to an array of scopes (e.g. {"<hash>": ["platform:read"]}).
 *   Keys absent from this map receive [] scopes. Scope checks are deny-by-
 *   default, so an unscoped key passes authentication but is rejected by every
 *   hasPlatformScope gate (the in-repo platform routes require platform:read /
 *   platform:write on all non-OPTIONS requests).
 *
 * Request header
 * ──────────────
 * X-Steward-Platform-Key: <raw key>
 */

function getValidPlatformKeys(): string[] {
  return [process.env.STEWARD_PLATFORM_KEYS, process.env.STEWARD_PLATFORM_KEY]
    .filter((value): value is string => Boolean(value))
    .join(",")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

const PLATFORM_SCOPE_CONFIG_ERROR =
  "Platform key scope configuration is invalid";

class PlatformKeyScopesConfigurationError extends Error {
  constructor() {
    super(PLATFORM_SCOPE_CONFIG_ERROR);
    this.name = "PlatformKeyScopesConfigurationError";
  }
}

function parsePlatformKeyScopes(): Record<string, string[]> {
  const raw = process.env.STEWARD_PLATFORM_KEY_SCOPES;
  if (!raw?.trim()) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PlatformKeyScopesConfigurationError();
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PlatformKeyScopesConfigurationError();
  }

  const entries = Object.entries(parsed);
  if (
    entries.some(
      ([, value]) =>
        !Array.isArray(value) ||
        value.some((scope) => typeof scope !== "string"),
    )
  ) {
    throw new PlatformKeyScopesConfigurationError();
  }

  return Object.fromEntries(entries) as Record<string, string[]>;
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
 * Resolve the scopes configured for a platform key. Keys absent from
 * STEWARD_PLATFORM_KEY_SCOPES receive [] — deny-by-default under every
 * hasPlatformScope check (SEC-138).
 */
export function getPlatformKeyScopes(key: string): string[] {
  const configuredScopes = parsePlatformKeyScopes();
  const keyHash = hashKey(key).toString("hex");
  return configuredScopes[keyHash] ?? configuredScopes[key] ?? [];
}

export function hasPlatformScope(
  scopes: readonly string[] | undefined,
  required: string,
): boolean {
  return Boolean(
    scopes?.includes("*") ||
      scopes?.includes("platform:*") ||
      scopes?.includes(required),
  );
}

/**
 * Hono middleware that enforces platform key authentication.
 * Mount this on any route group that requires platform-level access.
 *
 * IMPORTANT (SEC-138): this middleware AUTHENTICATES only — it does not
 * authorize. Every route mounted behind it must additionally gate on
 * `hasPlatformScope(c.get("platformScopes"), ...)`. A route that mounts only
 * this middleware grants full platform access to every valid key, including
 * keys with no configured scopes.
 *
 * @example
 * ```ts
 * const platform = new Hono();
 * platform.use("*", platformAuthMiddleware());
 * platform.get("/stats", (c) => {
 *   if (!hasPlatformScope(c.get("platformScopes"), "platform:read")) {
 *     return c.json({ ok: false, error: "Forbidden" }, 403);
 *   }
 *   // ...
 * });
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
      return c.json<ApiResponse>(
        { ok: false, error: "Invalid platform key" },
        403,
      );
    }

    let scopes: string[];
    try {
      scopes = getPlatformKeyScopes(key);
    } catch (error) {
      if (error instanceof PlatformKeyScopesConfigurationError) {
        return c.json<ApiResponse>(
          { ok: false, error: PLATFORM_SCOPE_CONFIG_ERROR },
          500,
        );
      }
      throw error;
    }

    c.set("platformKeyHash", hashKey(key).toString("hex"));
    c.set("platformScopes", scopes);

    await next();
  });
}
