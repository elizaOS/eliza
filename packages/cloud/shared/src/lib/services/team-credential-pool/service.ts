/**
 * Team credential pool use-cases (#11332) — the business layer behind
 * /api/organizations/credentials. Routes validate auth + shape and delegate
 * here.
 *
 * Contribution flow: validate provider (Phase 1 = direct API keys only) →
 * LIVE probe against the provider (a dead key never enters rotation) →
 * ciphertext into the secrets vault → metadata row into pooled_credentials.
 * The plaintext key is NEVER returned — not even in the creation response
 * (the contributor just typed it; echoing it back would only re-expose it).
 * Every read is masked to label/provider/last4/health/usage.
 *
 * Billing note: pooled-key usage is ZERO-RATED — the org pays the provider
 * directly on its own console account; no cloud credits are decremented and
 * no platform fee applies. See docs/team-credential-pooling.md ("Future
 * monetization") for how this COULD later meter against credits — documented,
 * deliberately not implemented.
 */

import type { LinkedAccountHealthDetail, LinkedAccountUsage } from "@elizaos/contracts";
import {
  type PooledCredential,
  type PooledCredentialWithContributor,
  pooledCredentialsRepository,
} from "../../../db/repositories/pooled-credentials";
import { logger } from "../../utils/logger";
import { type AuditContext, secretsService } from "../secrets/secrets";
import { probePooledApiKey } from "./probe";
import {
  isPooledDirectProvider,
  isSubscriptionProviderId,
  keyLast4,
  POOLED_PROVIDER_SECRET_PROVIDER,
  type PooledDirectProvider,
} from "./provider-map";
import { getTeamPoolRegistry } from "./registry";

export class TeamCredentialPoolError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "TeamCredentialPoolError";
  }
}

/** Masked view — the ONLY shape reads ever return. Never carries key material. */
export interface PooledCredentialSummary {
  id: string;
  provider: string;
  label: string;
  last4: string;
  enabled: boolean;
  priority: number;
  health: string;
  healthDetail: LinkedAccountHealthDetail | null;
  usage: LinkedAccountUsage | null;
  contributedBy: { id: string; name: string | null } | null;
  callsToday: number;
  lastUsedAt: string | null;
  createdAt: string;
}

function toSummary(
  row: PooledCredential,
  contributor?: { name: string | null } | null,
  callsToday = 0,
): PooledCredentialSummary {
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    last4: row.key_last4,
    enabled: row.enabled,
    priority: row.priority,
    health: row.health,
    healthDetail: row.health_detail ?? null,
    usage: row.usage ?? null,
    contributedBy: row.contributed_by
      ? { id: row.contributed_by, name: contributor?.name ?? null }
      : null,
    callsToday,
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface ContributePooledCredentialParams {
  organizationId: string;
  userId: string;
  provider: string;
  apiKey: string;
  label?: string;
  priority?: number;
  audit: AuditContext;
}

export async function contributePooledCredential(
  params: ContributePooledCredentialParams,
): Promise<PooledCredentialSummary> {
  const provider = params.provider.trim();
  if (isSubscriptionProviderId(provider)) {
    throw new TeamCredentialPoolError(
      "Subscription accounts (Claude Max / ChatGPT) cannot be pooled — only provider API keys.",
    );
  }
  if (!isPooledDirectProvider(provider)) {
    throw new TeamCredentialPoolError(`Unsupported provider '${provider}'.`);
  }
  const apiKey = params.apiKey.trim();
  if (apiKey.length < 8) {
    throw new TeamCredentialPoolError("API key is too short to be valid.");
  }

  // Live probe BEFORE pooling — a revoked/typo'd key never poisons rotation.
  const probe = await probePooledApiKey(provider as PooledDirectProvider, apiKey);
  if (!probe.ok) {
    throw new TeamCredentialPoolError(
      `Key failed live validation against ${provider} (status ${probe.status}). Not added.`,
    );
  }

  const last4 = keyLast4(apiKey);
  const secret = await secretsService.create(
    {
      organizationId: params.organizationId,
      name: `pooled/${provider}/${crypto.randomUUID()}`,
      value: apiKey,
      scope: "organization",
      description: `Team pool credential (${provider}, ...${last4})`,
      provider: POOLED_PROVIDER_SECRET_PROVIDER[provider as PooledDirectProvider],
      providerMetadata: {
        validated: true,
        lastValidatedAt: new Date().toISOString(),
      },
      createdBy: params.userId,
    },
    params.audit,
  );

  let row: PooledCredential;
  try {
    row = await pooledCredentialsRepository.create({
      organization_id: params.organizationId,
      provider,
      secret_id: secret.id,
      label: params.label?.trim() || `${provider} ...${last4}`,
      key_last4: last4,
      contributed_by: params.userId,
      ...(params.priority !== undefined ? { priority: params.priority } : {}),
    });
  } catch (err) {
    // Don't strand an orphaned vault secret when the pool row fails to land.
    await secretsService
      .delete(secret.id, params.organizationId, params.audit)
      .catch((cleanupErr: unknown) => {
        logger.warn(
          "[TeamCredentialPool] orphaned-secret cleanup failed after row insert failure",
          {
            organizationId: params.organizationId,
            secretId: secret.id,
            error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
          },
        );
      });
    throw err;
  }

  getTeamPoolRegistry().invalidate(params.organizationId);
  logger.info("[TeamCredentialPool] credential contributed", {
    organizationId: params.organizationId,
    credentialId: row.id,
    provider,
  });

  return toSummary(row);
}

export async function listPooledCredentials(
  organizationId: string,
): Promise<PooledCredentialSummary[]> {
  const [rows, todayTotals] = await Promise.all([
    pooledCredentialsRepository.listByOrganizationWithContributor(organizationId),
    pooledCredentialsRepository.usageTotalsForDay(organizationId, utcToday()),
  ]);
  return rows.map((row: PooledCredentialWithContributor) =>
    toSummary(row, { name: row.contributor_name }, todayTotals.get(row.id) ?? 0),
  );
}

export async function getPooledCredential(id: string): Promise<PooledCredential | undefined> {
  return pooledCredentialsRepository.findById(id);
}

export interface UpdatePooledCredentialParams {
  credentialId: string;
  organizationId: string;
  enabled?: boolean;
  priority?: number;
  label?: string;
}

export async function updatePooledCredential(
  params: UpdatePooledCredentialParams,
): Promise<PooledCredentialSummary> {
  const updated = await pooledCredentialsRepository.updatePoolState(params.credentialId, {
    ...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
    ...(params.priority !== undefined ? { priority: params.priority } : {}),
    ...(params.label !== undefined ? { label: params.label } : {}),
  });
  if (!updated) {
    throw new TeamCredentialPoolError("Credential not found", 404);
  }
  getTeamPoolRegistry().invalidate(params.organizationId);
  return toSummary(updated);
}

export async function removePooledCredential(params: {
  credentialId: string;
  organizationId: string;
  audit: AuditContext;
}): Promise<void> {
  const row = await pooledCredentialsRepository.delete(params.credentialId);
  if (!row) {
    throw new TeamCredentialPoolError("Credential not found", 404);
  }
  getTeamPoolRegistry().invalidate(params.organizationId);
  try {
    await secretsService.delete(row.secret_id, params.organizationId, params.audit);
  } catch (err) {
    // Pool row is gone — the credential can never be selected again. An
    // orphaned vault secret is logged for cleanup, not surfaced as a failure.
    logger.warn("[TeamCredentialPool] secret cleanup failed after credential delete", {
      organizationId: params.organizationId,
      credentialId: params.credentialId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
