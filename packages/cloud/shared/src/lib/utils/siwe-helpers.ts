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
import { CacheKeys, CacheTTL } from "../cache/keys";
import type { CompatibleRedis } from "../cache/redis-factory";

export type { SiweMessage };

const SIWE_DOMAIN_MISMATCH = "SIWE domain does not match app host";
const SIWE_URI_MISMATCH = "SIWE uri does not match the server-issued uri";
const SIWE_CHAIN_MISMATCH = "SIWE chainId does not match the server-issued chainId";
const SIWE_NONCE_INVALID = "SIWE nonce invalid or already used";
const SIWE_SIGNATURE_INVALID = "SIWE signature invalid";
const SIWE_EXPIRED = "SIWE message has expired";
const SIWE_NOT_YET_VALID = "SIWE message not yet valid";

const NONCE_BYTES = 16;

/**
 * The `uri` + `chainId` the server issued alongside a nonce. These are bound to
 * the nonce at issuance and re-checked at verify so the signed message cannot
 * substitute a different `uri`/`chainId` on the same domain (EIP-4361
 * completeness — the message must match every parameter the server offered).
 */
export interface SiweNonceBinding {
  uri: string;
  chainId: number;
}

function randomNonceHex(): string {
  const arr = new Uint8Array(NONCE_BYTES);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Allocate + persist a one-time SIWE nonce, binding the `uri`/`chainId` the
 * server offered. Caller must have a per-request Redis client.
 */
export async function issueNonce(
  redis: CompatibleRedis,
  binding: SiweNonceBinding,
): Promise<string> {
  const nonce = randomNonceHex();
  await redis.setex(CacheKeys.siwe.nonce(nonce), CacheTTL.siwe.nonce, JSON.stringify(binding));
  return nonce;
}

/**
 * Non-destructively read the `uri`/`chainId` bound to a nonce. Returns null if
 * the nonce is absent or was stored in a legacy format without a binding (an
 * in-flight nonce issued before this field existed) — legacy nonces simply skip
 * the uri/chainId assertions, preserving the prior behavior for the short TTL
 * window after a deploy.
 */
export async function readNonceBinding(
  redis: CompatibleRedis,
  nonce: string,
): Promise<SiweNonceBinding | null> {
  const value = await redis.get<string>(CacheKeys.siwe.nonce(nonce));
  if (value === null || value === undefined) return null;
  const parsed: unknown = typeof value === "string" ? safeJsonParse(value) : value;
  if (
    parsed &&
    typeof parsed === "object" &&
    "uri" in parsed &&
    "chainId" in parsed &&
    typeof (parsed as SiweNonceBinding).uri === "string" &&
    typeof (parsed as SiweNonceBinding).chainId === "number"
  ) {
    return { uri: (parsed as SiweNonceBinding).uri, chainId: (parsed as SiweNonceBinding).chainId };
  }
  return null;
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
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
  expected?: SiweNonceBinding | null,
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
  // EIP-4361 completeness: the signed `uri`/`chainId` must match what the server
  // issued with the nonce. Domain + single-use nonce already block cross-site
  // replay; this closes the gap where a message on the right domain signs a
  // different uri/chainId than the one presented to the user.
  if (expected) {
    if (parsed.uri !== expected.uri) {
      throw new Error(`${SIWE_URI_MISMATCH}: got ${parsed.uri}, expected ${expected.uri}`);
    }
    if (parsed.chainId !== expected.chainId) {
      throw new Error(
        `${SIWE_CHAIN_MISMATCH}: got ${parsed.chainId}, expected ${expected.chainId}`,
      );
    }
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
  // Peek the nonce binding (uri/chainId) before validating so the signed
  // message is checked against exactly what the server issued. The nonce is
  // only consumed (getdel) after full validation so an invalid request does not
  // burn it.
  const nonceFromMessage = parseSiweMessage(message).nonce;
  const binding = nonceFromMessage ? await readNonceBinding(redis, nonceFromMessage) : null;
  const result = await validateSIWEMessage(message, signature, expectedHost, binding);
  const consumed = await consumeNonce(redis, result.parsed.nonce);
  if (!consumed) {
    throw new Error(SIWE_NONCE_INVALID);
  }
  return result;
}
