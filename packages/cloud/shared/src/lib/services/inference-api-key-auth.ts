/**
 * Resolves inference API keys into active user and organization identities.
 * The inference auth resolver consumes this boundary so controlled probes and
 * cache-failure recovery can query authoritative repositories without changing
 * the cache semantics used by general API authentication.
 */

import { createHash } from "node:crypto";
import { apiKeysRepository } from "../../db/repositories/api-keys";
import { type UserWithOrganization, usersRepository } from "../../db/repositories/users";
import type { ApiKey } from "../../db/schemas/api-keys";
import type { Organization } from "../../db/schemas/organizations";
import { AuthenticationError, ForbiddenError } from "../api/errors";
import { apiKeysService } from "./api-keys";
import { usersService } from "./users";

export interface InferenceApiKeyAuthTimingObserver {
  keyLookup(durationMs: number): void;
  userOrgLookup(durationMs: number): void;
}

export interface InferenceApiKeyAuthOptions {
  /** Cache failures and authenticated probes must measure authoritative storage. */
  bypassCache?: boolean;
  timing?: InferenceApiKeyAuthTimingObserver;
  /** Marks typed credential/account rejection without intercepting the throw. */
  rejected?(): void;
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
): never {
  options.rejected?.();
  throw error;
}

async function findApiKey(rawKey: string, bypassCache: boolean): Promise<ApiKey | null> {
  if (!bypassCache) return await apiKeysService.validateApiKey(rawKey);

  const keyHash = createHash("sha256").update(rawKey).digest("hex");
  const replicaKey = await apiKeysRepository.findActiveByHash(keyHash);
  return replicaKey ?? (await apiKeysRepository.findActiveByHashConsistent(keyHash)) ?? null;
}

async function findUser(
  userId: string,
  bypassCache: boolean,
): Promise<UserWithOrganization | undefined> {
  return bypassCache
    ? await usersRepository.findWithOrganization(userId)
    : await usersService.getWithOrganization(userId);
}

/**
 * Preserve the general API-key boundary's error classes, messages, ordering,
 * and usage accounting while exposing per-hop timings to bounded telemetry.
 */
export async function requireInferenceApiKeyWithOrg(
  rawKey: string,
  options: InferenceApiKeyAuthOptions = {},
): Promise<InferenceApiKeyAuthResult> {
  const bypassCache = options.bypassCache === true;
  const keyStartedAt = performance.now();
  let apiKey: ApiKey | null;
  try {
    apiKey = await findApiKey(rawKey, bypassCache);
  } finally {
    options.timing?.keyLookup(performance.now() - keyStartedAt);
  }
  if (!apiKey) {
    reject(options, new AuthenticationError("Invalid or expired API key"));
  }
  if (!apiKey.is_active) {
    reject(options, new ForbiddenError("API key is inactive"));
  }
  if (apiKey.expires_at && new Date(apiKey.expires_at) < new Date()) {
    reject(options, new AuthenticationError("API key has expired"));
  }

  const userStartedAt = performance.now();
  let user: UserWithOrganization | undefined;
  try {
    user = await findUser(apiKey.user_id, bypassCache);
  } finally {
    options.timing?.userOrgLookup(performance.now() - userStartedAt);
  }
  if (!user) {
    reject(options, new AuthenticationError("User associated with API key not found"));
  }
  if (!user.is_active) {
    reject(options, new ForbiddenError("User account is inactive"));
  }
  if (!user.organization?.is_active) {
    reject(options, new ForbiddenError("Organization is inactive"));
  }
  if (!user.organization_id || !user.organization) {
    reject(
      options,
      new ForbiddenError("This feature requires a full account. Please sign up to continue."),
    );
  }

  void apiKeysService.incrementUsageDebounced(apiKey.id);
  return {
    user: user as InferenceApiKeyAuthResult["user"],
    apiKey,
    authMethod: "api_key",
  };
}
