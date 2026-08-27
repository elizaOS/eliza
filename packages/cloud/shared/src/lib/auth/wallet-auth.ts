/**
 * Per-request wallet auth via X-Wallet-Address, X-Timestamp, X-Wallet-Signature.
 * WHY: Clients can authenticate without storing an API key; method+path in message prevents replay on other endpoints.
 * Unknown wallets are created on first valid signature (findOrCreateUserByWalletAddress).
 *
 * Signed payload binding: the message also commits to a SHA-256 of the
 * canonical query string and raw body (`Payload-SHA256`), so a captured
 * header triple cannot be replayed within its freshness window with a
 * rewritten body or query on the same path. The legacy method+path message
 * (no payload hash) is still accepted ONLY for requests with no query string
 * and no body, where there is nothing to rewrite — every other request must
 * present the payload-bound signature.
 */
import { getAddress, verifyMessage } from "viem";
import { cache } from "../cache/client";
import { CacheKeys, CacheTTL } from "../cache/keys";
import { sha256Hex } from "../crypto/worker";
import { findOrCreateUserByWalletAddress } from "../services/wallet-signup";
import type { UserWithOrganization } from "../types";

const MAX_TIMESTAMP_AGE_MS = 5 * 60 * 1000; // WHY: limits replay window while allowing clock skew

/**
 * Canonical query string for the payload hash: decoded `key=value` pairs
 * sorted by key then value and joined with `&`, so parameter reordering does
 * not change the digest. Documented in packages/docs/cloud/authentication.mdx.
 */
export function canonicalWalletAuthQuery(url: URL): string {
  return [...url.searchParams.entries()]
    .sort(([keyA, valueA], [keyB, valueB]) =>
      keyA === keyB ? (valueA < valueB ? -1 : valueA > valueB ? 1 : 0) : keyA < keyB ? -1 : 1,
    )
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

export async function verifyWalletSignature(
  request: Request,
  options?: { bodyText?: string },
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
  const url = new URL(request.url);
  const path = url.pathname;

  // The exact body bytes enter the payload hash. Callers that already
  // consumed the body (topup handler, wallet RPC route) pass them via
  // options; otherwise read through a clone so the original stream stays
  // consumable by the downstream handler. Bodyless requests hash as "".
  const bodyText = options?.bodyText ?? (await request.clone().text());
  const canonicalQuery = canonicalWalletAuthQuery(url);
  const payloadHash = await sha256Hex(`${canonicalQuery}\n${bodyText}`);

  const nonce = `${walletAddress}-${timestamp}-${method}-${path}-${payloadHash}`;
  const nonceKey = `wallet-nonce:${nonce}`;

  // Fail closed if cache unavailable to prevent replay attacks during Redis outages.
  // SLA: Wallet-header auth is fully unavailable during Redis outages; no fallback.
  if (!cache.isAvailable()) {
    throw new Error("Service temporarily unavailable");
  }

  const message = `Eliza Cloud Authentication\nTimestamp: ${timestamp}\nMethod: ${method}\nPath: ${path}\nPayload-SHA256: ${payloadHash}`;

  // Note: Verify signature BEFORE consuming nonce to prevent attackers from burning valid nonces with invalid signatures
  let isValid = await verifyMessage({
    address: walletAddress as `0x${string}`,
    message,
    signature: signature as `0x${string}`,
  });

  if (!isValid) {
    // Legacy transition window: the pre-payload-binding message is equivalent
    // to the bound one only when the request carries no query and no body, so
    // that is the only case where it remains acceptable.
    if (canonicalQuery.length > 0 || bodyText.length > 0) {
      throw new Error("Invalid wallet signature");
    }
    const legacyMessage = `Eliza Cloud Authentication\nTimestamp: ${timestamp}\nMethod: ${method}\nPath: ${path}`;
    isValid = await verifyMessage({
      address: walletAddress as `0x${string}`,
      message: legacyMessage,
      signature: signature as `0x${string}`,
    });
  }

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

  // Reached only after the signature over method+path+timestamp verified and the
  // nonce was claimed, so this request proved control of the address.
  const { user } = await findOrCreateUserByWalletAddress(walletAddress, {
    walletProven: true,
  });

  if (!user.is_active) {
    throw new Error("User account is inactive");
  }

  if (!user.organization?.is_active) {
    throw new Error("Organization is inactive");
  }

  await cache.set(cacheKey, user, CacheTTL.walletAuth.user);

  return user;
}
