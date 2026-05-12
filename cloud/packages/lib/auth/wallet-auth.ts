/**
 * Per-request wallet auth via X-Wallet-Address, X-Timestamp, X-Wallet-Signature.
 * WHY: Clients can authenticate without storing an API key; method+path in message prevents replay on other endpoints.
 * Unknown wallets are created on first valid signature (findOrCreateUserByWalletAddress).
 */
import { getAddress, verifyMessage } from "viem";
import { cache } from "@/lib/cache/client";
import { CacheKeys, CacheTTL } from "@/lib/cache/keys";
import { findOrCreateUserByWalletAddress } from "@/lib/services/wallet-signup";
import type { UserWithOrganization } from "@/lib/types";

const MAX_TIMESTAMP_AGE_MS = 5 * 60 * 1000; // WHY: limits replay window while allowing clock skew

export async function verifyWalletSignature(
  request: Request,
): Promise<UserWithOrganization | null> {
  const rawWalletAddress = request.headers.get("X-Wallet-Address") || "";
  const timestampStr = request.headers.get("X-Timestamp") || "";
  const signature = request.headers.get("X-Wallet-Signature") || "";

  if (!rawWalletAddress || !timestampStr || !signature) {
    return null;
  }

  let walletAddress: string;
  try {
    walletAddress = getAddress(rawWalletAddress);
  } catch {
    throw new Error("Invalid wallet address format");
  }

  const timestamp = parseInt(timestampStr, 10);
  if (isNaN(timestamp)) {
    throw new Error("Invalid timestamp format");
  }

  const now = Date.now();
  if (Math.abs(now - timestamp) > MAX_TIMESTAMP_AGE_MS) {
    throw new Error("Signature timestamp expired");
  }

  /* WHY method+path in message: binds signature to this request so it cannot be replayed on another endpoint. */
  const method = request.method;
  const path = new URL(request.url).pathname;
  const nonce = `${walletAddress}-${timestamp}-${method}-${path}`;
  const nonceKey = `wallet-nonce:${nonce}`;

  // Fail closed if cache unavailable to prevent replay attacks during Redis outages.
  // SLA: Wallet-header auth is fully unavailable during Redis outages; no fallback.
  if (!cache.isAvailable()) {
    throw new Error("Service temporarily unavailable");
  }

  const message = `Eliza Cloud Authentication\nTimestamp: ${timestamp}\nMethod: ${method}\nPath: ${path}`;

  // Note: Verify signature BEFORE consuming nonce to prevent attackers from burning valid nonces with invalid signatures
  const isValid = await verifyMessage({
    address: walletAddress as `0x${string}`,
    message,
    signature: signature as `0x${string}`,
  });

  if (!isValid) {
    throw new Error("Invalid wallet signature");
  }

  // Atomic SET NX PX: only one concurrent request can claim this nonce; prevents TOCTOU race
  const claimed = await cache.setIfNotExists(nonceKey, "used", MAX_TIMESTAMP_AGE_MS);
  if (!claimed) {
    throw new Error("Signature has already been used");
  }

  const cacheKey = CacheKeys.walletAuth.user(walletAddress);
  const cached = await cache.get<UserWithOrganization>(cacheKey);
  if (cached && cached.is_active && cached.organization?.is_active) {
    return cached;
  }

  const { user } = await findOrCreateUserByWalletAddress(walletAddress);

  if (!user.is_active) {
    throw new Error("User account is inactive");
  }

  if (!user.organization?.is_active) {
    throw new Error("Organization is inactive");
  }

  await cache.set(cacheKey, user, CacheTTL.walletAuth.user);

  return user;
}
