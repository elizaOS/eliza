/**
 * Health connector status projection: reads the owner's connector grant(s)
 * and stored OAuth token for a provider and shapes them into the
 * `LifeOpsHealthConnectorStatus` DTO. Split out of `health-service.ts` so
 * this branch-heavy read path (grant-present/absent, token-present/absent,
 * reauth/sync-failed/config-missing) can be covered independently of the
 * rest of the health domain. `HealthDomain` delegates to these functions;
 * they take the shared `LifeOpsContext` explicitly rather than depending on
 * `this` so they stay unit-testable without a class instance.
 */
import {
  healthConnectorCapabilities,
  readStoredHealthToken,
  resolveHealthOAuthConfig,
} from "@elizaos/plugin-health";
import type {
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  LifeOpsHealthConnectorCapability,
  LifeOpsHealthConnectorProvider,
  LifeOpsHealthConnectorStatus,
} from "../../contracts/index.js";
import {
  LIFEOPS_HEALTH_CONNECTOR_CAPABILITIES,
  LIFEOPS_HEALTH_CONNECTOR_PROVIDERS,
} from "../../contracts/index.js";
import type { LifeOpsContext } from "../lifeops-context.js";
import { normalizeEnumValue } from "../service-normalize.js";
import {
  normalizeOptionalConnectorMode,
  normalizeOptionalConnectorSide,
} from "../service-normalize-connector.js";

function normalizeHealthProvider(
  value: unknown,
  field = "provider",
): LifeOpsHealthConnectorProvider {
  return normalizeEnumValue(value, field, LIFEOPS_HEALTH_CONNECTOR_PROVIDERS);
}

function healthCapabilitiesFromGrant(
  capabilities: readonly string[],
): LifeOpsHealthConnectorCapability[] {
  return capabilities.filter(
    (capability): capability is LifeOpsHealthConnectorCapability =>
      (LIFEOPS_HEALTH_CONNECTOR_CAPABILITIES as readonly string[]).includes(
        capability,
      ),
  );
}

export async function getHealthDataConnectorStatus(
  ctx: LifeOpsContext,
  providerInput: LifeOpsHealthConnectorProvider,
  requestUrl: URL,
  requestedMode?: LifeOpsConnectorMode,
  requestedSide?: LifeOpsConnectorSide,
): Promise<LifeOpsHealthConnectorStatus> {
  const provider = normalizeHealthProvider(providerInput);
  const side = normalizeOptionalConnectorSide(requestedSide, "side") ?? "owner";
  const explicitMode = normalizeOptionalConnectorMode(requestedMode, "mode");
  const grants = (
    await ctx.repository.listConnectorGrants(ctx.agentId())
  ).filter(
    (grant) =>
      grant.provider === provider &&
      grant.side === side &&
      (!explicitMode || grant.mode === explicitMode),
  );
  const preferredGrant =
    [...grants].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    )[0] ?? null;
  const config = resolveHealthOAuthConfig(
    provider,
    requestUrl,
    explicitMode ?? preferredGrant?.mode,
  );
  const grant =
    preferredGrant ??
    (await ctx.repository.getConnectorGrant(
      ctx.agentId(),
      provider,
      config.mode,
      side,
    ));
  const token = readStoredHealthToken(grant?.tokenRef);
  const syncState = grant
    ? await ctx.repository.getHealthSyncState(ctx.agentId(), provider, grant.id)
    : null;
  const metadataAuthState =
    typeof grant?.metadata.authState === "string"
      ? grant.metadata.authState
      : null;
  const connected = Boolean(
    grant && token && metadataAuthState !== "needs_reauth",
  );
  const reason: LifeOpsHealthConnectorStatus["reason"] = connected
    ? syncState?.lastSyncError
      ? "sync_failed"
      : "connected"
    : grant && (grant.tokenRef || metadataAuthState === "needs_reauth")
      ? "needs_reauth"
      : config.configured
        ? "disconnected"
        : "config_missing";
  return {
    provider,
    side,
    mode: grant?.mode ?? config.mode,
    defaultMode: config.defaultMode,
    availableModes: config.availableModes,
    executionTarget: grant?.executionTarget ?? "local",
    sourceOfTruth: grant?.sourceOfTruth ?? "local_storage",
    configured: config.configured,
    connected,
    reason,
    identity: token?.identity ?? grant?.identity ?? null,
    grantedCapabilities: grant
      ? healthCapabilitiesFromGrant(grant.capabilities)
      : healthConnectorCapabilities(provider),
    grantedScopes: token?.grantedScopes ?? grant?.grantedScopes ?? [],
    expiresAt: token?.expiresAt
      ? new Date(token.expiresAt).toISOString()
      : typeof grant?.metadata.expiresAt === "string"
        ? grant.metadata.expiresAt
        : null,
    hasRefreshToken:
      Boolean(token?.refreshToken) || Boolean(grant?.metadata.hasRefreshToken),
    lastSyncAt: syncState?.lastSyncedAt ?? null,
    grant,
    degradations: syncState?.lastSyncError
      ? [
          {
            axis: "delivery-degraded",
            code: "last_sync_failed",
            message: syncState.lastSyncError,
            retryable: true,
          },
        ]
      : undefined,
  };
}

export async function getHealthDataConnectorStatuses(
  ctx: LifeOpsContext,
  providers: readonly LifeOpsHealthConnectorProvider[],
  requestUrl: URL,
  requestedMode?: LifeOpsConnectorMode,
  requestedSide?: LifeOpsConnectorSide,
): Promise<LifeOpsHealthConnectorStatus[]> {
  return Promise.all(
    providers.map((provider) =>
      getHealthDataConnectorStatus(
        ctx,
        provider,
        requestUrl,
        requestedMode,
        requestedSide,
      ),
    ),
  );
}
