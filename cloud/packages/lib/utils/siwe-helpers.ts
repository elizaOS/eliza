/**
 * SIWE (Sign-In With Ethereum) EIP-4361 helpers.
 * WHY: Centralize nonce consumption and message/signature validation so nonce
 * and domain are enforced in one place and verify route stays thin.
 */

import { getAddress, verifyMessage } from "viem";
import { parseSiweMessage, type SiweMessage } from "viem/siwe";
import { cache } from "@/lib/cache/client";
import { CacheKeys } from "@/lib/cache/keys";
import { getAppHost } from "@/lib/utils/app-url";

export type { SiweMessage };

const SIWE_DOMAIN_MISMATCH = "SIWE domain does not match app host";
const SIWE_NONCE_INVALID = "SIWE nonce invalid or already used";
const SIWE_SIGNATURE_INVALID = "SIWE signature invalid";
const SIWE_EXPIRED = "SIWE message has expired";
const SIWE_NOT_YET_VALID = "SIWE message not yet valid";

/**
 * Consumes the nonce from cache (single-use). Returns true if the nonce was
 * present and is now consumed; false otherwise.
 */
export async function consumeNonce(nonce: string): Promise<boolean> {
  const key = CacheKeys.siwe.nonce(nonce);
  const value = await cache.getAndDelete<string>(key);
  return value !== null;
}

/**
 * Validates EIP-4361 message and signature. Ensures domain matches app host,
 * then verifies the signature. Does NOT consume the nonce (caller must call
 * consumeNonce after successful validation).
 *
 * @returns Parsed SIWE message and the checksummed address that signed it.
 * @throws Error if message is invalid, domain mismatch, or signature invalid.
 */
export async function validateSIWEMessage(
  message: string,
  signature: `0x${string}`,
): Promise<{ address: string; parsed: SiweMessage }> {
  const parsed = parseSiweMessage(message);
  if (!parsed.address) {
    throw new Error("SIWE message missing address");
  }
  if (!parsed.nonce) {
    throw new Error("SIWE message missing nonce");
  }
  const expectedHost = getAppHost();
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
  message: string,
  signature: `0x${string}`,
): Promise<{ address: string; parsed: SiweMessage }> {
  const result = await validateSIWEMessage(message, signature);
  const consumed = await consumeNonce(result.parsed.nonce);
  if (!consumed) {
    throw new Error(SIWE_NONCE_INVALID);
  }
  return result;
}
