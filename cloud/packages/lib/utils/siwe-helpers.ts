/**
 * SIWE (Sign-In With Ethereum) EIP-4361 helpers.
 * WHY: Centralize nonce issuance, consumption, and message/signature validation
 * so nonce and domain are enforced in one place and routes stay thin.
 *
 * Redis is taken as a parameter rather than via the module-level `cache`
 * singleton because CacheClient's lazy-opened socket gets bound to the first
 * request's I/O context on Cloudflare Workers — see
 * https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/#considerations
 * Routes build a fresh client per request via `buildRedisClient(c.env)` (same
 * pattern as `rate-limit-hono-cloudflare.ts`).
 */

import { getAddress, verifyMessage } from "viem";
import { parseSiweMessage, type SiweMessage } from "viem/siwe";
import { CacheKeys, CacheTTL } from "@/lib/cache/keys";
import type { CompatibleRedis } from "@/lib/cache/redis-factory";

export type { SiweMessage };

const SIWE_DOMAIN_MISMATCH = "SIWE domain does not match app host";
const SIWE_NONCE_INVALID = "SIWE nonce invalid or already used";
const SIWE_SIGNATURE_INVALID = "SIWE signature invalid";
const SIWE_EXPIRED = "SIWE message has expired";
const SIWE_NOT_YET_VALID = "SIWE message not yet valid";

const NONCE_BYTES = 16;

function randomNonceHex(): string {
  const arr = new Uint8Array(NONCE_BYTES);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Allocate + persist a one-time SIWE nonce. Caller must have a per-request
 * Redis client.
 */
export async function issueNonce(redis: CompatibleRedis): Promise<string> {
  const nonce = randomNonceHex();
  await redis.setex(CacheKeys.siwe.nonce(nonce), CacheTTL.siwe.nonce, "1");
  return nonce;
}

/**
 * Consumes the nonce from cache (single-use). Returns true if the nonce was
 * present and is now consumed; false otherwise.
 */
export async function consumeNonce(redis: CompatibleRedis, nonce: string): Promise<boolean> {
  const value = await redis.getdel(CacheKeys.siwe.nonce(nonce));
  return value !== null;
}

/**
 * Validates EIP-4361 message and signature. Ensures domain matches the
 * passed-in expected host, then verifies the signature. Does NOT consume the
 * nonce (caller must call consumeNonce after successful validation).
 *
 * `expectedHost` is taken as a parameter because `getAppHost()` reads from
 * `process.env`, which is empty under Cloudflare Workers — routes resolve it
 * via `getAppHost(c.env)` and pass it down.
 *
 * @returns Parsed SIWE message and the checksummed address that signed it.
 * @throws Error if message is invalid, domain mismatch, or signature invalid.
 */
export async function validateSIWEMessage(
  message: string,
  signature: `0x${string}`,
  expectedHost: string,
): Promise<{ address: string; parsed: SiweMessage }> {
  const parsed = parseSiweMessage(message);
  if (!parsed.address) {
    throw new Error("SIWE message missing address");
  }
  if (!parsed.nonce) {
    throw new Error("SIWE message missing nonce");
  }
  if (parsed.domain !== expectedHost) {
    throw new Error(`${SIWE_DOMAIN_MISMATCH}: got ${parsed.domain}, expected ${expectedHost}`);
  }

  const address = getAddress(parsed.address);
  const valid = await verifyMessage({
    address,
    message,
    signature,
  });
  if (!valid) {
    throw new Error(SIWE_SIGNATURE_INVALID);
  }

  const now = Date.now();
  if (parsed.expirationTime && parsed.expirationTime.getTime() <= now) {
    throw new Error(SIWE_EXPIRED);
  }
  if (parsed.notBefore && parsed.notBefore.getTime() > now) {
    throw new Error(SIWE_NOT_YET_VALID);
  }

  return { address, parsed: parsed as SiweMessage };
}

/**
 * Full verify step: validate message/signature and consume nonce.
 * Order: validate first (domain + signature), then consume nonce so we don't
 * burn nonces on invalid requests.
 *
 * @returns Checksummed address and parsed message.
 * @throws Error if validation fails or nonce invalid/already used.
 */
export async function validateAndConsumeSIWE(
  redis: CompatibleRedis,
  message: string,
  signature: `0x${string}`,
  expectedHost: string,
): Promise<{ address: string; parsed: SiweMessage }> {
  const result = await validateSIWEMessage(message, signature, expectedHost);
  const consumed = await consumeNonce(redis, result.parsed.nonce);
  if (!consumed) {
    throw new Error(SIWE_NONCE_INVALID);
  }
  return result;
}
