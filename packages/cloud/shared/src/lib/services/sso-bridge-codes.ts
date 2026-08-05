/**
 * Single-use code + logout-marker store for the cross-host SSO bridge
 * (`/api/auth/sso-bridge` — dashboard origin ↔ Eliza app origin).
 *
 * Codes are opaque 256-bit values with a ≤60s TTL, stored ONLY as their
 * sha256 (a cache dump never yields a usable code) with the verified session
 * token as payload, and consumed atomically (`getAndDelete`) so a replayed or
 * raced code loses exactly once and every later attempt fails. `setIfNotExists`
 * makes an astronomically-unlikely collision fail loudly instead of silently
 * overwriting another user's pending handshake.
 *
 * The logout marker makes an explicit logout effective ACROSS the host pair:
 * `/api/auth/logout` stamps it per Steward user, and the bridge refuses to
 * mint or exchange for any token ISSUED BEFORE the stamp. Its TTL only needs
 * to cover the access-token lifetime — older tokens are expired once the
 * marker ages out — so a fresh post-logout login (newer issuedAt) bridges
 * again immediately.
 */

import { cache } from "../cache/client";
import { CacheKeys } from "../cache/keys";

export const SSO_BRIDGE_CODE_TTL_SECONDS = 60;
const SSO_BRIDGE_CODE_PREFIX = "esso_";

/** Matches the Steward access-token TTL (steward-client.ts). */
export const SSO_BRIDGE_LOGOUT_MARKER_TTL_SECONDS = 60 * 60;

export interface SsoBridgeCodeRecord {
  /** The verified Steward session JWT the code stands in for. */
  token: string;
  stewardUserId: string;
  issuedAt: number;
  expiresAt: number;
}

function createOpaqueCode(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${SSO_BRIDGE_CODE_PREFIX}${hex}`;
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function codeCacheKey(code: string): Promise<string> {
  return CacheKeys.ssoBridge.code(await sha256Hex(code));
}

export function looksLikeSsoBridgeCode(value: string | null | undefined): value is string {
  return (
    typeof value === "string" &&
    value.startsWith(SSO_BRIDGE_CODE_PREFIX) &&
    value.length === SSO_BRIDGE_CODE_PREFIX.length + 64
  );
}

export async function issueSsoBridgeCode(input: {
  token: string;
  stewardUserId: string;
}): Promise<{ code: string; expiresIn: number }> {
  if (!cache.isAvailable()) {
    throw new Error("SSO bridge code store is unavailable");
  }

  const code = createOpaqueCode();
  const now = Date.now();
  const record: SsoBridgeCodeRecord = {
    token: input.token,
    stewardUserId: input.stewardUserId,
    issuedAt: now,
    expiresAt: now + SSO_BRIDGE_CODE_TTL_SECONDS * 1000,
  };

  const stored = await cache.setIfNotExists(
    await codeCacheKey(code),
    record,
    SSO_BRIDGE_CODE_TTL_SECONDS * 1000,
  );
  if (!stored) {
    throw new Error("SSO bridge code collision");
  }

  return { code, expiresIn: SSO_BRIDGE_CODE_TTL_SECONDS };
}

/**
 * Atomic get-and-delete: exactly one caller ever receives a given record.
 * The embedded expiry re-check covers backends whose TTL granularity lags.
 */
export async function consumeSsoBridgeCode(code: string): Promise<SsoBridgeCodeRecord | null> {
  if (!looksLikeSsoBridgeCode(code)) return null;

  const record = await cache.getAndDelete<SsoBridgeCodeRecord>(await codeCacheKey(code));
  if (!record || record.expiresAt <= Date.now()) return null;
  return record;
}

/** Stamp "this user explicitly logged out now" for the bridge to honor. */
export async function markSsoBridgeLogout(stewardUserId: string): Promise<void> {
  await cache.set(
    CacheKeys.ssoBridge.logout(stewardUserId),
    { at: Date.now() },
    SSO_BRIDGE_LOGOUT_MARKER_TTL_SECONDS,
  );
}

/**
 * True when an explicit logout was stamped at-or-after the token's issuance —
 * the bridge must then refuse the token even though its signature is still
 * valid. Tokens minted by a NEW post-logout login pass.
 */
export async function isBlockedBySsoBridgeLogout(
  stewardUserId: string,
  tokenIssuedAtSeconds: number,
): Promise<boolean> {
  const marker = await cache.get<{ at: number }>(CacheKeys.ssoBridge.logout(stewardUserId));
  if (!marker || typeof marker.at !== "number") return false;
  return tokenIssuedAtSeconds * 1000 <= marker.at;
}
