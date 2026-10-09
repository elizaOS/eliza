/**
 * Resolves inference API keys into active user and organization identities.
 * The inference auth resolver consumes this boundary so controlled probes and
 * cache-failure recovery can query authoritative repositories without changing
 * the cache semantics used by general API authentication.
 */

import { createHash } from "node:crypto";
import { apiKeysRepository } from "../../db/repositories/api-keys";
import type { UserWithOrganization } from "../../db/repositories/users";
import type { ApiKey } from "../../db/schemas/api-keys";
import type { Organization } from "../../db/schemas/organizations";
import { AuthenticationError, ForbiddenError } from "../api/errors";
import type { InferenceAuthRejectionReason } from "./inference-auth-cache";

export interface InferenceApiKeyAuthTimingObserver {
  /** One primary statement resolving key, user, and organization together. */
  identityLookup(durationMs: number): void;
}

export interface InferenceApiKeyAuthOptions {
  timing?: InferenceApiKeyAuthTimingObserver;
  /** Marks typed credential/account rejection without intercepting the throw. */
  rejected?(reason: InferenceAuthRejectionReason): void;
}

export interface InferenceApiKeyAuthResult {
  user: UserWithOrganization & {
    organization_id: string;
    organization: Organization;
  };
  apiKey: ApiKey;
  authMethod: "api_key";
}

function reject(
  options: InferenceApiKeyAuthOptions,
  error: AuthenticationError | ForbiddenError,
  reason: InferenceAuthRejectionReason,
): never {
  options.rejected?.(reason);
  throw error;
}

/**
 * Preserve the general API-key boundary's error classes, messages, and
 * ordering while exposing per-hop timings to bounded telemetry. The caller
 * owns retained usage accounting after the authorization result is consumed.
 */
export async function requireInferenceApiKeyWithOrg(
  rawKey: string,
  options: InferenceApiKeyAuthOptions = {},
): Promise<InferenceApiKeyAuthResult> {
  const keyHash = createHash("sha256").update(rawKey).digest("hex");
  const identityStartedAt = performance.now();
  let identity: Awaited<ReturnType<typeof apiKeysRepository.findIdentityByHashConsistent>>;
  try {
    identity = await apiKeysRepository.findIdentityByHashConsistent(keyHash);
  } finally {
    options.timing?.identityLookup(performance.now() - identityStartedAt);
  }
  const apiKey: ApiKey | null = identity?.apiKey ?? null;
  if (!apiKey) {
    reject(options, new AuthenticationError("Invalid or expired API key"), "credential_invalid");
  }
  if (apiKey.deleted_at) {
    reject(options, new AuthenticationError("Invalid or expired API key"), "credential_invalid");
  }
  if (apiKey.expires_at && new Date(apiKey.expires_at) < new Date()) {
    reject(options, new AuthenticationError("API key has expired"), "credential_invalid");
  }
  if (!apiKey.is_active) {
    reject(options, new ForbiddenError("API key is inactive"), "credential_inactive");
  }

  const user: UserWithOrganization | null = identity?.user ?? null;
  if (!user) {
    reject(
      options,
      new AuthenticationError("User associated with API key not found"),
      "membership_missing",
    );
  }
  if (!user.is_active) {
    reject(options, new ForbiddenError("User account is inactive"), "account_inactive");
  }
  if (!user.organization_id || !user.organization) {
    reject(
      options,
      new ForbiddenError("This feature requires a full account. Please sign up to continue."),
      "membership_missing",
    );
  }
  if (!user.organization.is_active) {
    reject(options, new ForbiddenError("Organization is inactive"), "organization_inactive");
  }

  return {
    user: user as InferenceApiKeyAuthResult["user"],
    apiKey,
    authMethod: "api_key",
  };
}
