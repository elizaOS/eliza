/**
 * Shared X (Twitter) identity verification contract.
 *
 * Callback success projection, generic connection-catalog readiness, and
 * OAuth2 token-exchange identity resolution must all use this same rule:
 * a complete provider identity is a non-empty trimmed user id AND username.
 * Stored tokens without that identity are recoverable but not verified.
 */
import type { OAuthConnectionStatus } from "./types";

export const X_PROVIDER_IDENTITY_VERIFICATION_FAILED =
  "provider_identity_verification_failed" as const;

export type XProviderIdentityVerificationFailed = typeof X_PROVIDER_IDENTITY_VERIFICATION_FAILED;

export interface CompleteXProviderIdentity {
  userId: string;
  username: string;
}

/** Normalize required X identity fields; returns null when unverified. */
export function normalizeXProviderIdentity(identity: {
  userId?: unknown;
  username?: unknown;
}): CompleteXProviderIdentity | null {
  const userId = typeof identity.userId === "string" ? identity.userId.trim() : "";
  const username = typeof identity.username === "string" ? identity.username.trim() : "";
  if (userId.length === 0 || username.length === 0) {
    return null;
  }
  return { userId, username };
}

/** Catalog projection: verified identity is active; stored-but-unverified is error. */
export function projectXCatalogIdentity(identity: { userId?: unknown; username?: unknown }): {
  verified: boolean;
  status: Extract<OAuthConnectionStatus, "active" | "error">;
  platformUserId: string;
  username?: string;
  displayName?: string;
} {
  const normalized = normalizeXProviderIdentity(identity);
  if (!normalized) {
    return {
      verified: false,
      status: "error",
      platformUserId: "",
    };
  }
  return {
    verified: true,
    status: "active",
    platformUserId: normalized.userId,
    username: normalized.username,
    displayName: `@${normalized.username}`,
  };
}
