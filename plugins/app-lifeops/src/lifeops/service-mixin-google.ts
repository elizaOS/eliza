// @ts-nocheck — Mixin pattern: each `withFoo()` returns a class that calls
// methods belonging to sibling mixins (e.g. `this.recordScreenTimeEvent`).
// Type checking each mixin in isolation surfaces 700+ phantom errors because
// the local TBase constraint can't see sibling mixin methods. Real type
// safety is enforced at the composed-service level (LifeOpsService class).
// Refactoring requires either declaration-merging every cross-mixin method
// or moving to a single composed interface — tracked as separate work.
import crypto from "node:crypto";
import {
  getConnectorAccountManager,
  type ConnectorAccount,
  type ConnectorAccountManager,
  type ConnectorAccountProvider,
  type Metadata,
} from "@elizaos/core";
import type {
  DisconnectLifeOpsGoogleConnectorRequest,
  LifeOpsConnectorGrant,
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  LifeOpsGoogleConnectorStatus,
  StartLifeOpsGoogleConnectorRequest,
  StartLifeOpsGoogleConnectorResponse,
} from "../contracts/index.js";
import {
  GoogleApiError,
  googleErrorLooksLikeAdminPolicyBlock,
  googleErrorRequiresReauth,
} from "./google-api-error.js";
import {
  resolveGoogleAvailableModes,
  resolveGoogleExecutionTarget,
  resolveGoogleGrants,
  resolveGoogleSourceOfTruth,
  resolvePreferredGoogleGrant,
} from "./google-connector-gateway.js";
import {
  ManagedGoogleClientError,
  type ManagedGoogleConnectorStatusResponse,
  resolveManagedGoogleCloudConfig,
} from "./google-managed-client.js";
import {
  completeGoogleConnectorOAuth,
  deleteStoredGoogleToken,
  type GoogleConnectorCallbackResult,
  GoogleOAuthError,
  readStoredGoogleToken,
  resolveGoogleOAuthConfig,
  startGoogleConnectorOAuth,
} from "./google-oauth.js";
import {
  googleCapabilitiesToScopes,
  googleScopesToCapabilities,
} from "./google-scopes.js";
import { createLifeOpsConnectorGrant } from "./repository.js";
import type {
  Constructor,
  LifeOpsServiceBase,
  MixinClass,
} from "./service-mixin-core.js";

export interface LifeOpsGoogleService {
  getGoogleConnectorStatus(
    requestUrl: URL,
    requestedMode?: LifeOpsConnectorMode,
    requestedSide?: LifeOpsConnectorSide,
    grantId?: string,
  ): Promise<LifeOpsGoogleConnectorStatus>;
  getGoogleConnectorAccounts(
    requestUrl: URL,
    requestedSide?: LifeOpsConnectorSide,
  ): Promise<LifeOpsGoogleConnectorStatus[]>;
  selectGoogleConnectorMode(
    requestUrl: URL,
    preferredModeInput: LifeOpsConnectorMode | undefined,
    requestedSide?: LifeOpsConnectorSide,
  ): Promise<LifeOpsGoogleConnectorStatus>;
  startGoogleConnector(
    request: StartLifeOpsGoogleConnectorRequest,
    requestUrl: URL,
  ): Promise<StartLifeOpsGoogleConnectorResponse>;
  completeGoogleConnectorCallback(
    callbackUrl: URL,
  ): Promise<LifeOpsGoogleConnectorStatus>;
  disconnectGoogleConnector(
    request: DisconnectLifeOpsGoogleConnectorRequest,
    requestUrl: URL,
  ): Promise<LifeOpsGoogleConnectorStatus>;
}

import { fail, normalizeOptionalString } from "./service-normalize.js";
import {
  normalizeGoogleCapabilityRequest,
  normalizeGrantCapabilities,
  normalizeOptionalConnectorMode,
  normalizeOptionalConnectorSide,
} from "./service-normalize-connector.js";

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function clearGoogleGrantAuthFailureMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...metadata };
  delete next.authState;
  delete next.lastAuthError;
  delete next.lastAuthErrorAt;
  return next;
}

function sameNormalizedStringSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const normalize = (values: readonly string[]): string[] =>
    [...new Set(values.map((v) => v.trim()).filter(Boolean))].sort();
  const leftValues = normalize(left);
  const rightValues = normalize(right);
  if (leftValues.length !== rightValues.length) {
    return false;
  }
  return leftValues.every((value, index) => value === rightValues[index]);
}

function requestIncludesGmailCapabilities(
  capabilities: readonly string[] | undefined,
): boolean {
  if (capabilities === undefined) {
    return true;
  }
  return capabilities.some((capability) =>
    capability.startsWith("google.gmail."),
  );
}

interface GenericGoogleConnectorAccountAccess {
  manager: ConnectorAccountManager;
  provider: ConnectorAccountProvider;
}

const GENERIC_GOOGLE_GRANT_ID_PREFIX = "connector-account:";

function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function metadataString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function metadataBoolean(value: unknown): boolean {
  return value === true;
}

function metadataStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean)
    : [];
}

function metadataIsoString(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed)
      ? new Date(parsed).toISOString()
      : value.trim();
  }
  return null;
}

function readRuntimeSetting(runtime: unknown, key: string): string | null {
  const value = (runtime as { getSetting?: (name: string) => unknown })
    ?.getSetting?.(key);
  return metadataString(value);
}

function isGenericGoogleOAuthConfigured(runtime: unknown): boolean {
  return Boolean(
    readRuntimeSetting(runtime, "GOOGLE_CLIENT_ID") ??
      process.env.GOOGLE_CLIENT_ID,
  ) && Boolean(
    readRuntimeSetting(runtime, "GOOGLE_CLIENT_SECRET") ??
      process.env.GOOGLE_CLIENT_SECRET,
  ) && Boolean(
    readRuntimeSetting(runtime, "GOOGLE_REDIRECT_URI") ??
      process.env.GOOGLE_REDIRECT_URI,
  );
}

function normalizeGenericGoogleAvailableModes(
  modeAvailability: {
    defaultMode: LifeOpsConnectorMode;
    availableModes: LifeOpsConnectorMode[];
  },
  genericAvailable: boolean,
): { defaultMode: LifeOpsConnectorMode; availableModes: LifeOpsConnectorMode[] } {
  if (
    !genericAvailable ||
    modeAvailability.availableModes.includes("local")
  ) {
    return modeAvailability;
  }
  return {
    ...modeAvailability,
    availableModes: ["local", ...modeAvailability.availableModes],
  };
}

function genericGrantId(accountId: string): string {
  return `${GENERIC_GOOGLE_GRANT_ID_PREFIX}${accountId}`;
}

function genericAccountIdFromGrantId(
  grantId: string | undefined,
): string | null {
  const normalized = metadataString(grantId);
  if (!normalized) return null;
  return normalized.startsWith(GENERIC_GOOGLE_GRANT_ID_PREFIX)
    ? normalized.slice(GENERIC_GOOGLE_GRANT_ID_PREFIX.length)
    : normalized;
}

function genericGoogleSide(account: ConnectorAccount): LifeOpsConnectorSide {
  return account.role === "AGENT" ? "agent" : "owner";
}

function mapGenericGoogleCapability(value: string): string | null {
  switch (value) {
    case "google.basic_identity":
      return "google.basic_identity";
    case "google.calendar.read":
    case "calendar.read":
      return "google.calendar.read";
    case "google.calendar.write":
    case "calendar.write":
      return "google.calendar.write";
    case "google.gmail.triage":
    case "gmail.read":
      return "google.gmail.triage";
    case "google.gmail.send":
    case "gmail.send":
      return "google.gmail.send";
    case "google.gmail.manage":
    case "gmail.manage":
      return "google.gmail.manage";
    default:
      return null;
  }
}

function normalizeGenericGoogleCapabilities(
  account: ConnectorAccount,
): string[] {
  const metadata = metadataRecord(account.metadata);
  const direct = [
    ...metadataStringArray(metadata.grantedCapabilities),
    ...metadataStringArray(metadata.capabilities),
  ];
  const scopes = metadataStringArray(metadata.grantedScopes);
  const fromScopes = googleScopesToCapabilities(scopes);
  const capabilities = new Set<string>(["google.basic_identity"]);
  for (const capability of [...direct, ...fromScopes]) {
    const mapped = mapGenericGoogleCapability(capability);
    if (mapped) {
      capabilities.add(mapped);
    }
  }
  if (capabilities.has("google.calendar.write")) {
    capabilities.add("google.calendar.read");
  }
  return normalizeGrantCapabilities([...capabilities]);
}

function genericGoogleGrantedScopes(
  account: ConnectorAccount,
  capabilities: readonly string[],
): string[] {
  const metadata = metadataRecord(account.metadata);
  const scopes = metadataStringArray(metadata.grantedScopes);
  return scopes.length > 0
    ? scopes
    : googleCapabilitiesToScopes(capabilities as never);
}

function genericGoogleIdentity(
  account: ConnectorAccount,
): Record<string, unknown> | null {
  const metadata = metadataRecord(account.metadata);
  const identity: Record<string, unknown> = {
    ...(metadataString(account.externalId) ? { sub: account.externalId } : {}),
    ...(metadataString(account.displayHandle)
      ? { email: account.displayHandle }
      : {}),
    ...metadataRecord(metadata.identity),
  };
  for (const key of ["email", "name", "picture", "locale"]) {
    const value = metadataString(metadata[key]);
    if (value) identity[key] = value;
  }
  return Object.keys(identity).length > 0 ? identity : null;
}

function genericGoogleGrantFromAccount(
  account: ConnectorAccount,
): LifeOpsConnectorGrant {
  const metadata = metadataRecord(account.metadata);
  const capabilities = normalizeGenericGoogleCapabilities(account);
  const nowIso = new Date(account.updatedAt ?? Date.now()).toISOString();
  return {
    id: genericGrantId(account.id),
    agentId: "",
    provider: "google",
    side: genericGoogleSide(account),
    mode: "local",
    identity: genericGoogleIdentity(account) ?? {},
    grantedScopes: genericGoogleGrantedScopes(account, capabilities),
    capabilities,
    tokenRef: null,
    connectorAccountId: account.id,
    cloudConnectionId: null,
    executionTarget: "local",
    sourceOfTruth: "local_storage",
    preferredByAgent: metadataBoolean(metadata.isDefault),
    metadata: {
      ...metadata,
      connectorAccountId: account.id,
      connectorAccountProvider: "google",
    },
    lastRefreshAt: metadataIsoString(metadata.expiresAt) ?? nowIso,
    createdAt: new Date(account.createdAt ?? Date.now()).toISOString(),
    updatedAt: nowIso,
  } as LifeOpsConnectorGrant;
}

// ---------------------------------------------------------------------------
// Google mixin
// ---------------------------------------------------------------------------

/** @internal */
export function withGoogle<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
): MixinClass<TBase, LifeOpsGoogleService> {
  return class extends Base {
    private getGenericGoogleConnectorAccountAccess():
      | GenericGoogleConnectorAccountAccess
      | null {
      try {
        const manager = getConnectorAccountManager(this.runtime);
        const provider = manager.getProvider?.("google");
        return provider ? { manager, provider } : null;
      } catch (error) {
        this.logLifeOpsWarn?.(
          "google_connector_account_manager",
          error instanceof Error ? error.message : String(error),
          { provider: "google" },
        );
        return null;
      }
    }

    private async listGenericGoogleConnectorAccounts(
      requestedSide?: LifeOpsConnectorSide,
    ): Promise<ConnectorAccount[]> {
      const access = this.getGenericGoogleConnectorAccountAccess();
      if (!access) return [];
      const accounts = await access.manager.listAccounts("google");
      return accounts.filter((account) => {
        if (requestedSide && genericGoogleSide(account) !== requestedSide) {
          return false;
        }
        return account.status !== "disabled" && account.status !== "revoked";
      });
    }

    private genericGoogleStatusFromAccount(
      account: ConnectorAccount,
      modeAvailability: {
        defaultMode: LifeOpsConnectorMode;
        availableModes: LifeOpsConnectorMode[];
      },
    ): LifeOpsGoogleConnectorStatus {
      const grant = {
        ...genericGoogleGrantFromAccount(account),
        agentId: this.agentId(),
      };
      const metadata = metadataRecord(account.metadata);
      const connected = account.status === "connected";
      const reason =
        account.status === "error" || account.status === "revoked"
          ? "needs_reauth"
          : connected
            ? "connected"
            : "disconnected";
      return {
        provider: "google",
        side: grant.side,
        mode: "local",
        defaultMode: modeAvailability.defaultMode,
        availableModes: modeAvailability.availableModes,
        executionTarget: "local",
        sourceOfTruth: "local_storage",
        configured: true,
        connected,
        reason,
        preferredByAgent: grant.preferredByAgent,
        cloudConnectionId: null,
        identity: genericGoogleIdentity(account),
        grantedCapabilities: normalizeGrantCapabilities(grant.capabilities),
        grantedScopes: [...grant.grantedScopes],
        expiresAt: metadataIsoString(metadata.expiresAt),
        hasRefreshToken: metadataBoolean(metadata.hasRefreshToken),
        grant,
      };
    }

    private genericGoogleDisconnectedStatus(
      side: LifeOpsConnectorSide,
      modeAvailability: {
        defaultMode: LifeOpsConnectorMode;
        availableModes: LifeOpsConnectorMode[];
      },
    ): LifeOpsGoogleConnectorStatus {
      const configured = isGenericGoogleOAuthConfigured(this.runtime);
      return {
        provider: "google",
        side,
        mode: "local",
        defaultMode: modeAvailability.defaultMode,
        availableModes: modeAvailability.availableModes,
        executionTarget: "local",
        sourceOfTruth: "local_storage",
        configured,
        connected: false,
        reason: configured ? "disconnected" : "config_missing",
        preferredByAgent: false,
        cloudConnectionId: null,
        identity: null,
        grantedCapabilities: [],
        grantedScopes: [],
        expiresAt: null,
        hasRefreshToken: false,
        grant: null,
      };
    }

    private async getGenericGoogleConnectorStatus(
      requestUrl: URL,
      requestedSide: LifeOpsConnectorSide,
      grantId: string | undefined,
      modeAvailability: {
        defaultMode: LifeOpsConnectorMode;
        availableModes: LifeOpsConnectorMode[];
      },
    ): Promise<LifeOpsGoogleConnectorStatus> {
      const accountId = genericAccountIdFromGrantId(grantId);
      const accounts = await this.listGenericGoogleConnectorAccounts(
        requestedSide,
      );
      const account = accountId
        ? accounts.find(
            (candidate) =>
              candidate.id === accountId ||
              candidate.externalId === accountId ||
              candidate.displayHandle === accountId,
          )
        : accounts.find(
            (candidate) =>
              metadataRecord(candidate.metadata).isDefault === true &&
              candidate.status === "connected",
          ) ??
          accounts.find((candidate) => candidate.status === "connected") ??
          accounts[0];
      return account
        ? this.genericGoogleStatusFromAccount(
            account,
            modeAvailability,
          )
        : this.genericGoogleDisconnectedStatus(
            requestedSide,
            modeAvailability,
          );
    }

    // -----------------------------------------------------------------
    // Internal Google grant operations
    // -----------------------------------------------------------------

    public async withGoogleGrantOperation<T>(
      grant: LifeOpsConnectorGrant,
      operation: () => Promise<T>,
    ): Promise<T> {
      try {
        const result = await operation();
        await this.clearGoogleGrantAuthFailure(grant);
        return result;
      } catch (error) {
        return this.rethrowGoogleServiceError(grant, error);
      }
    }

    public async rethrowGoogleServiceError(
      grant: LifeOpsConnectorGrant,
      error: unknown,
    ): Promise<never> {
      if (error instanceof GoogleOAuthError) {
        this.logLifeOpsWarn("google_connector_request", error.message, {
          provider: "google",
          mode: grant.mode,
          statusCode: error.status,
          authState: grant.metadata.authState ?? null,
        });
        const needsReauth = googleErrorRequiresReauth(
          error.status,
          error.message,
        );
        if (needsReauth) {
          await this.markGoogleGrantNeedsReauth(grant, error.message);
          fail(
            401,
            `Google connector needs re-authentication: ${error.message}`,
          );
        }
        fail(error.status, error.message);
      }

      if (error instanceof GoogleApiError) {
        this.logLifeOpsWarn("google_connector_request", error.message, {
          provider: "google",
          mode: grant.mode,
          statusCode: error.status,
          authState: grant.metadata.authState ?? null,
        });
        const needsReauth = googleErrorRequiresReauth(
          error.status,
          error.message,
        );
        if (needsReauth) {
          await this.markGoogleGrantNeedsReauth(grant, error.message);
          fail(
            401,
            `Google connector needs re-authentication: ${error.message}`,
          );
        }
        if (
          error.status === 403 &&
          googleErrorLooksLikeAdminPolicyBlock(error.message)
        ) {
          fail(
            403,
            `Google Workspace policy blocked the request: ${error.message}`,
          );
        }
        fail(error.status, error.message);
      }

      this.logLifeOpsError("google_connector_request", error, {
        provider: "google",
        mode: grant.mode,
        authState: grant.metadata.authState ?? null,
      });
      throw error;
    }

    public async clearGoogleConnectorData(
      side?: LifeOpsConnectorSide,
    ): Promise<void> {
      const calendarEvents = await this.repository.listCalendarEvents(
        this.agentId(),
        "google",
        undefined,
        undefined,
        side,
      );
      await this.deleteCalendarReminderPlansForEvents(
        calendarEvents.map((event) => event.id),
      );
      await this.repository.deleteCalendarEventsForProvider(
        this.agentId(),
        "google",
        undefined,
        side,
      );
      await this.repository.deleteCalendarSyncState(
        this.agentId(),
        "google",
        undefined,
        side,
      );
      await this.repository.deleteGmailMessagesForProvider(
        this.agentId(),
        "google",
        side,
      );
      await this.repository.deleteGmailSpamReviewItemsForProvider(
        this.agentId(),
        "google",
        side,
      );
      await this.repository.deleteGmailSyncState(
        this.agentId(),
        "google",
        undefined,
        side,
      );
    }

    public async clearGoogleGrantData(
      grant: LifeOpsConnectorGrant,
    ): Promise<void> {
      await this.repository.deleteGmailMessagesForProvider(
        this.agentId(),
        "google",
        grant.side,
        grant.id,
      );
      await this.repository.deleteGmailSpamReviewItemsForProvider(
        this.agentId(),
        "google",
        grant.side,
        grant.id,
      );
      await this.repository.deleteGmailSyncState(
        this.agentId(),
        "google",
        undefined,
        grant.side,
        grant.id,
      );
    }

    /**
     * Delete reminder plans for a set of calendar events.
     * This is a helper used by clearGoogleConnectorData. Subclasses that
     * add calendar functionality may override or extend this.
     */
    public async deleteCalendarReminderPlansForEvents(
      eventIds: string[],
    ): Promise<void> {
      if (eventIds.length === 0) {
        return;
      }
      const plans = await this.repository.listReminderPlansForOwners(
        this.agentId(),
        "calendar_event",
        eventIds,
      );
      for (const plan of plans) {
        await this.repository.deleteReminderPlan(this.agentId(), plan.id);
      }
    }

    public async setPreferredGoogleConnectorMode(
      preferredMode: LifeOpsConnectorMode | null,
      preferredSide?: LifeOpsConnectorSide | null,
    ): Promise<LifeOpsConnectorGrant | null> {
      const googleGrants = (
        await this.repository.listConnectorGrants(this.agentId())
      ).filter((grant) => grant.provider === "google");

      let resolvedPreferredGrant: LifeOpsConnectorGrant | null = null;
      if (preferredMode && preferredSide) {
        resolvedPreferredGrant =
          googleGrants.find(
            (grant) =>
              grant.mode === preferredMode && grant.side === preferredSide,
          ) ?? null;
      }
      if (resolvedPreferredGrant === null && preferredMode) {
        resolvedPreferredGrant =
          [...googleGrants]
            .filter((grant) => grant.mode === preferredMode)
            .sort((left, right) =>
              right.updatedAt.localeCompare(left.updatedAt),
            )[0] ?? null;
      }
      if (resolvedPreferredGrant === null && preferredSide) {
        resolvedPreferredGrant =
          [...googleGrants]
            .filter((grant) => grant.side === preferredSide)
            .sort((left, right) =>
              right.updatedAt.localeCompare(left.updatedAt),
            )[0] ?? null;
      }
      if (resolvedPreferredGrant === null) {
        resolvedPreferredGrant =
          [...googleGrants].sort((left, right) =>
            right.updatedAt.localeCompare(left.updatedAt),
          )[0] ?? null;
      }

      for (const grant of googleGrants) {
        const shouldPrefer =
          resolvedPreferredGrant !== null &&
          grant.id === resolvedPreferredGrant.id;
        if (grant.preferredByAgent === shouldPrefer) {
          continue;
        }
        await this.repository.upsertConnectorGrant({
          ...grant,
          preferredByAgent: shouldPrefer,
          updatedAt: new Date().toISOString(),
        });
      }
      return resolvedPreferredGrant;
    }

    public async upsertManagedGoogleGrant(
      status: ManagedGoogleConnectorStatusResponse,
      side: LifeOpsConnectorSide,
    ): Promise<LifeOpsConnectorGrant | null> {
      const currentGoogleGrants = (
        await this.repository.listConnectorGrants(this.agentId())
      ).filter((grant) => grant.provider === "google");
      const existingGrant =
        (status.connectionId
          ? currentGoogleGrants.find(
              (grant) =>
                grant.mode === "cloud_managed" &&
                grant.cloudConnectionId === status.connectionId,
            )
          : null) ??
        currentGoogleGrants.find(
          (grant) =>
            grant.mode === "cloud_managed" &&
            grant.side === side &&
            (status.identity?.email
              ? grant.identity.email === status.identity.email
              : grant.cloudConnectionId === null),
        ) ??
        null;
      if (!existingGrant && !status.connected) {
        return null;
      }

      const nowIso = new Date().toISOString();
      const preferredByAgent =
        existingGrant?.preferredByAgent ??
        (currentGoogleGrants.length === 0 ||
          !currentGoogleGrants.some((grant) => grant.preferredByAgent));
      const existingLinkedAt =
        typeof existingGrant?.metadata.linkedAt === "string" &&
        existingGrant.metadata.linkedAt.trim().length > 0
          ? existingGrant.metadata.linkedAt
          : null;
      const cloudRelinked =
        typeof status.linkedAt === "string" &&
        status.linkedAt.trim().length > 0 &&
        status.linkedAt !== existingLinkedAt;
      const preserveAuthFailure =
        existingGrant?.metadata.authState === "needs_reauth" &&
        !cloudRelinked &&
        existingGrant.cloudConnectionId === status.connectionId &&
        sameNormalizedStringSet(
          existingGrant.grantedScopes,
          status.grantedScopes,
        ) &&
        sameNormalizedStringSet(
          normalizeGrantCapabilities(existingGrant.capabilities),
          status.grantedCapabilities,
        );
      const clearedMetadata = clearGoogleGrantAuthFailureMetadata(
        existingGrant?.metadata ?? {},
      );
      const baseMetadata = {
        ...(preserveAuthFailure
          ? { ...(existingGrant?.metadata ?? {}) }
          : clearedMetadata),
        expiresAt: status.expiresAt,
        hasRefreshToken: status.hasRefreshToken,
        linkedAt: status.linkedAt,
        lastUsedAt: status.lastUsedAt,
      };
      const nextGrant = existingGrant
        ? {
            ...existingGrant,
            identity: status.identity ? { ...status.identity } : {},
            grantedScopes: [...status.grantedScopes],
            capabilities: [...status.grantedCapabilities],
            tokenRef: null,
            mode: "cloud_managed" as const,
            executionTarget: "cloud" as const,
            sourceOfTruth: "cloud_connection" as const,
            preferredByAgent,
            cloudConnectionId: status.connectionId,
            metadata:
              status.reason === "needs_reauth" || preserveAuthFailure
                ? {
                    ...baseMetadata,
                    authState: "needs_reauth",
                    lastAuthError:
                      preserveAuthFailure &&
                      typeof existingGrant?.metadata.lastAuthError ===
                        "string" &&
                      existingGrant.metadata.lastAuthError.trim().length > 0
                        ? existingGrant.metadata.lastAuthError
                        : "Managed Google connection needs re-authentication.",
                    lastAuthErrorAt:
                      preserveAuthFailure &&
                      typeof existingGrant?.metadata.lastAuthErrorAt ===
                        "string" &&
                      existingGrant.metadata.lastAuthErrorAt.trim().length > 0
                        ? existingGrant.metadata.lastAuthErrorAt
                        : nowIso,
                  }
                : baseMetadata,
            lastRefreshAt: nowIso,
            updatedAt: nowIso,
          }
        : createLifeOpsConnectorGrant({
            agentId: this.agentId(),
            provider: "google",
            side,
            identity: status.identity ? { ...status.identity } : {},
            grantedScopes: [...status.grantedScopes],
            capabilities: [...status.grantedCapabilities],
            tokenRef: null,
            mode: "cloud_managed",
            executionTarget: "cloud",
            sourceOfTruth: "cloud_connection",
            preferredByAgent,
            cloudConnectionId: status.connectionId,
            metadata: baseMetadata,
            lastRefreshAt: nowIso,
          });

      await this.repository.upsertConnectorGrant(nextGrant);
      return nextGrant;
    }

    public async runManagedGoogleOperation<T>(
      grant: LifeOpsConnectorGrant,
      operation: () => Promise<T>,
    ): Promise<T> {
      try {
        return await operation();
      } catch (error) {
        if (error instanceof ManagedGoogleClientError) {
          this.logLifeOpsWarn("google_connector_request", error.message, {
            provider: "google",
            mode: grant.mode,
            statusCode: error.status,
            authState: grant.metadata.authState ?? null,
          });
          const needsReauth = googleErrorRequiresReauth(
            error.status,
            error.message,
          );
          if (needsReauth) {
            await this.markGoogleGrantNeedsReauth(grant, error.message);
            fail(
              401,
              `Google connector needs re-authentication: ${error.message}`,
            );
          }
          fail(error.status, error.message);
        }
        this.logLifeOpsError("google_connector_request", error, {
          provider: "google",
          mode: grant.mode,
          authState: grant.metadata.authState ?? null,
        });
        throw error;
      }
    }

    // -----------------------------------------------------------------
    // Google grant requirement helpers
    // -----------------------------------------------------------------

    public async requireGoogleCalendarGrant(
      requestUrl: URL,
      requestedMode?: LifeOpsConnectorMode,
      requestedSide?: LifeOpsConnectorSide,
      grantId?: string,
    ): Promise<LifeOpsConnectorGrant> {
      const { hasGoogleCalendarReadCapability } = await import(
        "./service-normalize-calendar.js"
      );
      const status = await this.getGoogleConnectorStatus(
        requestUrl,
        requestedMode,
        requestedSide,
        grantId,
      );
      const grant = status.grant;
      if (!status.connected || !grant) {
        fail(409, "Google Calendar is not connected.");
      }
      if (!hasGoogleCalendarReadCapability(grant)) {
        fail(403, "Google Calendar read access has not been granted.");
      }
      return grant;
    }

    public async requireGoogleCalendarWriteGrant(
      requestUrl: URL,
      requestedMode?: LifeOpsConnectorMode,
      requestedSide?: LifeOpsConnectorSide,
      grantId?: string,
    ): Promise<LifeOpsConnectorGrant> {
      const { hasGoogleCalendarWriteCapability } = await import(
        "./service-normalize-calendar.js"
      );
      const grant = await this.requireGoogleCalendarGrant(
        requestUrl,
        requestedMode,
        requestedSide,
        grantId,
      );
      if (!hasGoogleCalendarWriteCapability(grant)) {
        fail(403, "Google Calendar write access has not been granted.");
      }
      return grant;
    }

    public async requireGoogleGmailGrant(
      requestUrl: URL,
      requestedMode?: LifeOpsConnectorMode,
      requestedSide?: LifeOpsConnectorSide,
      grantId?: string,
    ): Promise<LifeOpsConnectorGrant> {
      const { hasGoogleGmailTriageCapability } = await import(
        "./service-normalize-calendar.js"
      );
      const status = await this.getGoogleConnectorStatus(
        requestUrl,
        requestedMode,
        requestedSide,
        grantId,
      );
      const grant = status.grant;
      if (!status.connected || !grant) {
        fail(409, "Google Gmail is not connected.");
      }
      if (!hasGoogleGmailTriageCapability(grant)) {
        fail(403, "Google Gmail triage access has not been granted.");
      }
      return grant;
    }

    public async requireGoogleGmailSendGrant(
      requestUrl: URL,
      requestedMode?: LifeOpsConnectorMode,
      requestedSide?: LifeOpsConnectorSide,
      grantId?: string,
    ): Promise<LifeOpsConnectorGrant> {
      const { hasGoogleGmailSendCapability } = await import(
        "./service-normalize-calendar.js"
      );
      const grant = await this.requireGoogleGmailGrant(
        requestUrl,
        requestedMode,
        requestedSide,
        grantId,
      );
      if (!hasGoogleGmailSendCapability(grant)) {
        fail(403, "Google Gmail send access has not been granted.");
      }
      return grant;
    }

    // -----------------------------------------------------------------
    // Public Google connector methods
    // -----------------------------------------------------------------

    async getGoogleConnectorStatus(
      requestUrl: URL,
      requestedMode?: LifeOpsConnectorMode,
      requestedSide?: LifeOpsConnectorSide,
      grantId?: string,
    ): Promise<LifeOpsGoogleConnectorStatus> {
      const explicitMode = normalizeOptionalConnectorMode(
        requestedMode,
        "mode",
      );
      const explicitSide = normalizeOptionalConnectorSide(
        requestedSide,
        "side",
      );
      const grants = (
        await this.repository.listConnectorGrants(this.agentId())
      ).filter((candidate) => candidate.provider === "google");
      const cloudConfig = resolveManagedGoogleCloudConfig(this.runtime);
      const genericGoogleAccess = this.getGenericGoogleConnectorAccountAccess();
      const modeAvailability = normalizeGenericGoogleAvailableModes(
        resolveGoogleAvailableModes({
          requestUrl,
          cloudConfigured: cloudConfig.configured,
          grants,
        }),
        Boolean(genericGoogleAccess),
      );
      const resolvedGrant = resolvePreferredGoogleGrant({
        grants,
        requestedMode: explicitMode,
        requestedSide: explicitSide,
        grantId,
        defaultMode: modeAvailability.defaultMode,
      });
      const mode =
        explicitMode ?? resolvedGrant?.mode ?? modeAvailability.defaultMode;
      const side = explicitSide ?? resolvedGrant?.side ?? "owner";

      if (genericGoogleAccess && mode !== "cloud_managed") {
        const genericGrantRequested =
          typeof grantId === "string" &&
          grantId.startsWith(GENERIC_GOOGLE_GRANT_ID_PREFIX);
        const genericStatus = await this.getGenericGoogleConnectorStatus(
          requestUrl,
          side,
          grantId,
          modeAvailability,
        );
        if (genericStatus.connected || genericGrantRequested || !resolvedGrant) {
          return genericStatus;
        }
      }

      if (mode === "cloud_managed") {
        if (!cloudConfig.configured && !resolvedGrant) {
          return {
            provider: "google",
            side,
            mode,
            defaultMode: modeAvailability.defaultMode,
            availableModes: modeAvailability.availableModes,
            executionTarget: "cloud",
            sourceOfTruth: "cloud_connection",
            configured: false,
            connected: false,
            reason: "config_missing",
            preferredByAgent: false,
            cloudConnectionId: null,
            identity: null,
            grantedCapabilities: [],
            grantedScopes: [],
            expiresAt: null,
            hasRefreshToken: false,
            grant: null,
          };
        }

        if (!cloudConfig.configured && resolvedGrant) {
          return {
            provider: "google",
            side,
            mode,
            defaultMode: modeAvailability.defaultMode,
            availableModes: modeAvailability.availableModes,
            executionTarget: "cloud",
            sourceOfTruth: "cloud_connection",
            configured: false,
            connected: false,
            reason: "config_missing",
            preferredByAgent: resolvedGrant.preferredByAgent,
            cloudConnectionId: resolvedGrant.cloudConnectionId,
            identity:
              Object.keys(resolvedGrant.identity).length > 0
                ? { ...resolvedGrant.identity }
                : null,
            grantedCapabilities: normalizeGrantCapabilities(
              resolvedGrant.capabilities,
            ),
            grantedScopes: [...resolvedGrant.grantedScopes],
            expiresAt:
              typeof resolvedGrant.metadata.expiresAt === "string"
                ? resolvedGrant.metadata.expiresAt
                : null,
            hasRefreshToken: Boolean(resolvedGrant.metadata.hasRefreshToken),
            grant: resolvedGrant,
          };
        }

        let managedStatus: ManagedGoogleConnectorStatusResponse;
        try {
          managedStatus = await this.googleManagedClient.getStatus(
            side,
            resolvedGrant?.cloudConnectionId ?? grantId,
          );
        } catch (error) {
          if (error instanceof ManagedGoogleClientError) {
            if (error.status === 404) {
              if (resolvedGrant?.mode === "cloud_managed") {
                await this.repository.deleteConnectorGrant(
                  this.agentId(),
                  "google",
                  "cloud_managed",
                  side,
                  resolvedGrant.id,
                );
                if (
                  !grants.some(
                    (candidate) =>
                      candidate.provider === "google" &&
                      candidate.side === side &&
                      candidate.mode !== "cloud_managed",
                  )
                ) {
                  await this.clearGoogleConnectorData(side);
                }
                await this.setPreferredGoogleConnectorMode(null);
              }
              return {
                provider: "google",
                side,
                mode: "cloud_managed",
                defaultMode: modeAvailability.defaultMode,
                availableModes: modeAvailability.availableModes,
                executionTarget: "cloud",
                sourceOfTruth: "cloud_connection",
                configured: true,
                connected: false,
                reason: "disconnected",
                preferredByAgent: false,
                cloudConnectionId: null,
                identity: null,
                grantedCapabilities: [],
                grantedScopes: [],
                expiresAt: null,
                hasRefreshToken: false,
                grant: null,
              };
            }
            this.logLifeOpsWarn("google_connector_status", error.message, {
              provider: "google",
              mode: "cloud_managed",
              statusCode: error.status,
            });
            fail(
              error.status,
              `Failed to resolve managed Google connection: ${error.message}`,
            );
          }
          this.logLifeOpsError("google_connector_status", error, {
            provider: "google",
            mode: "cloud_managed",
          });
          throw error;
        }

        const mirroredGrant = await this.upsertManagedGoogleGrant(
          managedStatus,
          side,
        );
        const grant = mirroredGrant ?? resolvedGrant ?? null;
        const forcedNeedsReauth =
          grant?.metadata.authState === "needs_reauth" || false;
        return {
          provider: "google",
          side,
          mode,
          defaultMode: modeAvailability.defaultMode,
          availableModes: modeAvailability.availableModes,
          executionTarget: "cloud",
          sourceOfTruth: "cloud_connection",
          configured: managedStatus.configured,
          connected: managedStatus.connected && !forcedNeedsReauth,
          reason: forcedNeedsReauth ? "needs_reauth" : managedStatus.reason,
          preferredByAgent: grant?.preferredByAgent ?? false,
          cloudConnectionId: managedStatus.connectionId,
          identity: managedStatus.identity,
          grantedCapabilities: [...managedStatus.grantedCapabilities],
          grantedScopes: [...managedStatus.grantedScopes],
          expiresAt: managedStatus.expiresAt,
          hasRefreshToken: managedStatus.hasRefreshToken,
          grant,
        };
      }

      const config = resolveGoogleOAuthConfig(requestUrl, mode);
      const grant =
        resolvedGrant && resolvedGrant.mode === mode
          ? resolvedGrant
          : await this.repository.getConnectorGrant(
              this.agentId(),
              "google",
              mode,
              side,
            );

      if (!grant) {
        return {
          provider: "google",
          side,
          mode,
          defaultMode: modeAvailability.defaultMode,
          availableModes: modeAvailability.availableModes,
          executionTarget: "local",
          sourceOfTruth: "local_storage",
          configured: config.configured,
          connected: false,
          reason: config.configured ? "disconnected" : "config_missing",
          preferredByAgent: false,
          cloudConnectionId: null,
          identity: null,
          grantedCapabilities: [],
          grantedScopes: [],
          expiresAt: null,
          hasRefreshToken: false,
          grant: null,
        };
      }

      const token = grant.tokenRef
        ? readStoredGoogleToken(grant.tokenRef)
        : null;
      if (!token) {
        return {
          provider: "google",
          side: grant.side,
          mode: grant.mode,
          defaultMode: modeAvailability.defaultMode,
          availableModes: modeAvailability.availableModes,
          executionTarget: resolveGoogleExecutionTarget(grant),
          sourceOfTruth: resolveGoogleSourceOfTruth(grant),
          configured: config.configured,
          connected: false,
          reason: "token_missing",
          preferredByAgent: grant.preferredByAgent,
          cloudConnectionId: grant.cloudConnectionId,
          identity:
            Object.keys(grant.identity).length > 0
              ? { ...grant.identity }
              : null,
          grantedCapabilities: normalizeGrantCapabilities(grant.capabilities),
          grantedScopes: [...grant.grantedScopes],
          expiresAt: null,
          hasRefreshToken: false,
          grant,
        };
      }

      const refreshTokenValid =
        Boolean(token.refreshToken) &&
        (token.refreshTokenExpiresAt === null ||
          token.refreshTokenExpiresAt > Date.now());
      const accessTokenExpired = token.expiresAt <= Date.now();
      const forcedNeedsReauth = grant.metadata.authState === "needs_reauth";
      const connected =
        !forcedNeedsReauth && (!accessTokenExpired || refreshTokenValid);

      return {
        provider: "google",
        side: grant.side,
        mode: grant.mode,
        defaultMode: modeAvailability.defaultMode,
        availableModes: modeAvailability.availableModes,
        executionTarget: resolveGoogleExecutionTarget(grant),
        sourceOfTruth: resolveGoogleSourceOfTruth(grant),
        configured: config.configured,
        connected,
        reason: connected ? "connected" : "needs_reauth",
        preferredByAgent: grant.preferredByAgent,
        cloudConnectionId: grant.cloudConnectionId,
        identity:
          Object.keys(grant.identity).length > 0 ? { ...grant.identity } : null,
        grantedCapabilities: normalizeGrantCapabilities(grant.capabilities),
        grantedScopes: [...grant.grantedScopes],
        expiresAt: Number.isFinite(token.expiresAt)
          ? new Date(token.expiresAt).toISOString()
          : null,
        hasRefreshToken: refreshTokenValid,
        grant,
      };
    }

    async getGoogleConnectorAccounts(
      requestUrl: URL,
      requestedSide?: LifeOpsConnectorSide,
    ): Promise<LifeOpsGoogleConnectorStatus[]> {
      const side = normalizeOptionalConnectorSide(requestedSide, "side");
      const cloudConfig = resolveManagedGoogleCloudConfig(this.runtime);
      const genericGoogleAccess = this.getGenericGoogleConnectorAccountAccess();
      const modeAvailability = normalizeGenericGoogleAvailableModes(
        resolveGoogleAvailableModes({
          requestUrl,
          cloudConfigured: cloudConfig.configured,
        }),
        Boolean(genericGoogleAccess),
      );
      const results: LifeOpsGoogleConnectorStatus[] = [];
      const seenGrantIds = new Set<string>();
      const seenConnectorAccountIds = new Set<string>();

      if (genericGoogleAccess) {
        const accounts = await this.listGenericGoogleConnectorAccounts(side);
        for (const account of accounts) {
          const status = this.genericGoogleStatusFromAccount(
            account,
            modeAvailability,
          );
          if (status.grant) {
            seenGrantIds.add(status.grant.id);
            if (status.grant.connectorAccountId) {
              seenConnectorAccountIds.add(status.grant.connectorAccountId);
            }
          }
          results.push(status);
        }
      }

      if (cloudConfig.configured) {
        try {
          const managedAccounts =
            await this.googleManagedClient.listAccounts(side);
          for (const managedAccount of managedAccounts) {
            const grant = await this.upsertManagedGoogleGrant(
              managedAccount,
              managedAccount.side,
            );
            if (grant) {
              seenGrantIds.add(grant.id);
            }
            results.push({
              provider: "google",
              side: managedAccount.side,
              mode: "cloud_managed",
              defaultMode: modeAvailability.defaultMode,
              availableModes: modeAvailability.availableModes,
              executionTarget: "cloud",
              sourceOfTruth: "cloud_connection",
              configured: managedAccount.configured,
              connected: managedAccount.connected,
              reason: managedAccount.reason,
              preferredByAgent: grant?.preferredByAgent ?? false,
              cloudConnectionId: managedAccount.connectionId,
              identity: managedAccount.identity,
              grantedCapabilities: [...managedAccount.grantedCapabilities],
              grantedScopes: [...managedAccount.grantedScopes],
              expiresAt: managedAccount.expiresAt,
              hasRefreshToken: managedAccount.hasRefreshToken,
              grant,
            });
          }
        } catch (error) {
          if (error instanceof ManagedGoogleClientError) {
            this.logLifeOpsWarn("google_connector_accounts", error.message, {
              provider: "google",
              mode: "cloud_managed",
              statusCode: error.status,
            });
          } else {
            throw error;
          }
        }
      }

      const allGrants = (
        await this.repository.listConnectorGrants(this.agentId())
      ).filter((g) => g.provider === "google");
      const grants = resolveGoogleGrants({
        grants: allGrants,
        requestedSide: side,
      }).filter(
        (grant) =>
          !seenGrantIds.has(grant.id) &&
          !(
            grant.connectorAccountId &&
            seenConnectorAccountIds.has(grant.connectorAccountId)
          ),
      );
      for (const grant of grants) {
        const status = await this.getGoogleConnectorStatus(
          requestUrl,
          grant.mode,
          grant.side,
          grant.id,
        );
        results.push(status);
      }
      return results;
    }

    async selectGoogleConnectorMode(
      requestUrl: URL,
      preferredModeInput: LifeOpsConnectorMode | undefined,
      requestedSide?: LifeOpsConnectorSide,
    ): Promise<LifeOpsGoogleConnectorStatus> {
      const preferredMode = normalizeOptionalConnectorMode(
        preferredModeInput,
        "mode",
      );
      const preferredSide = normalizeOptionalConnectorSide(
        requestedSide,
        "side",
      );
      if (!preferredMode) {
        fail(400, "mode is required");
      }

      const grants = (
        await this.repository.listConnectorGrants(this.agentId())
      ).filter((grant) => grant.provider === "google");
      const modeAvailability = normalizeGenericGoogleAvailableModes(
        resolveGoogleAvailableModes({
          requestUrl,
          cloudConfigured: resolveManagedGoogleCloudConfig(this.runtime)
            .configured,
          grants,
        }),
        Boolean(this.getGenericGoogleConnectorAccountAccess()),
      );
      if (!modeAvailability.availableModes.includes(preferredMode)) {
        fail(
          400,
          `mode must be one of: ${modeAvailability.availableModes.join(", ")}`,
        );
      }

      const previousPreferredGrant = resolvePreferredGoogleGrant({
        grants,
        defaultMode: modeAvailability.defaultMode,
      });
      const targetGrant =
        grants.find(
          (grant) =>
            grant.mode === preferredMode &&
            (preferredSide === undefined || grant.side === preferredSide),
        ) ?? null;

      if (targetGrant) {
        const nextPreferredGrant = await this.setPreferredGoogleConnectorMode(
          preferredMode,
          preferredSide,
        );
        if (previousPreferredGrant?.id !== nextPreferredGrant?.id) {
          await this.clearGoogleConnectorData();
        }
        if (
          previousPreferredGrant?.id !== targetGrant.id ||
          !targetGrant.preferredByAgent
        ) {
          await this.recordConnectorAudit(
            "google:preferred-mode",
            "google connector preferred mode updated",
            {
              previousMode: previousPreferredGrant?.mode ?? null,
              previousSide: previousPreferredGrant?.side ?? null,
              nextMode: preferredMode,
              nextSide: targetGrant.side,
            },
            {
              persisted: true,
              availableModes: modeAvailability.availableModes,
            },
          );
        }
      }

      return this.getGoogleConnectorStatus(
        requestUrl,
        preferredMode,
        preferredSide,
      );
    }

    async startGoogleConnector(
      request: StartLifeOpsGoogleConnectorRequest,
      requestUrl: URL,
    ): Promise<StartLifeOpsGoogleConnectorResponse> {
      const requestedMode = normalizeOptionalConnectorMode(
        request.mode,
        "mode",
      );
      const requestedSide =
        normalizeOptionalConnectorSide(request.side, "side") ?? "owner";
      const requestedCapabilities = normalizeGoogleCapabilityRequest(
        request.capabilities,
      );
      if (
        requestedSide === "agent" &&
        requestIncludesGmailCapabilities(requestedCapabilities)
      ) {
        fail(
          409,
          "Agent-side Gmail is managed by the Gmail elizaOS plugin (@elizaos/plugin-gmail-watch / features.gmailWatch). Configure that plugin instead of creating a separate LifeOps Google grant.",
        );
      }
      const cloudConfig = resolveManagedGoogleCloudConfig(this.runtime);
      const genericGoogleAccess = this.getGenericGoogleConnectorAccountAccess();
      const modeAvailability = normalizeGenericGoogleAvailableModes(
        resolveGoogleAvailableModes({
          requestUrl,
          cloudConfigured: cloudConfig.configured,
        }),
        Boolean(genericGoogleAccess),
      );
      const mode = requestedMode ?? modeAvailability.defaultMode;
      if (mode === "cloud_managed") {
        try {
          return await this.googleManagedClient.startConnector({
            side: requestedSide,
            capabilities: requestedCapabilities,
            redirectUrl:
              typeof request.redirectUrl === "string" &&
              request.redirectUrl.trim().length > 0
                ? request.redirectUrl.trim()
                : undefined,
          });
        } catch (error) {
          if (error instanceof ManagedGoogleClientError) {
            this.logLifeOpsWarn("google_connector_start", error.message, {
              statusCode: error.status,
              mode,
            });
            fail(error.status, error.message);
          }
          this.logLifeOpsError("google_connector_start", error, { mode });
          throw error;
        }
      }

      const isGenericGrantRequest =
        typeof request.grantId === "string" &&
        request.grantId.startsWith(GENERIC_GOOGLE_GRANT_ID_PREFIX);
      if (
        genericGoogleAccess?.provider.startOAuth &&
        (!request.grantId || isGenericGrantRequest)
      ) {
        const accountId = isGenericGrantRequest
          ? genericAccountIdFromGrantId(request.grantId)
          : undefined;
        const redirectUri = new URL(
          "/api/connectors/google/oauth/callback",
          requestUrl.origin,
        ).toString();
        try {
          const flow = await genericGoogleAccess.manager.startOAuth("google", {
            redirectUri,
            accountId: accountId ?? undefined,
            scopes: googleCapabilitiesToScopes(requestedCapabilities as never),
            metadata: {
              lifeops: true,
              side: requestedSide,
              mode,
              requestedCapabilities,
              redirectUrl:
                typeof request.redirectUrl === "string" &&
                request.redirectUrl.trim().length > 0
                  ? request.redirectUrl.trim()
                  : undefined,
            } as Metadata,
          });
          return {
            provider: "google",
            side: requestedSide,
            mode,
            requestedCapabilities,
            redirectUri: flow.redirectUri ?? redirectUri,
            authUrl: flow.authUrl ?? "",
          };
        } catch (error) {
          this.logLifeOpsWarn("google_connector_start", String(error), {
            provider: "google",
            mode,
            sourceOfTruth: "connector_account",
          });
          fail(
            400,
            error instanceof Error
              ? error.message
              : "Failed to start Google connector OAuth.",
          );
        }
      }

      const resolvedConfig = resolveGoogleOAuthConfig(requestUrl, mode);
      const existingGrant = request.grantId
        ? ((await this.repository.listConnectorGrants(this.agentId())).find(
            (g) => g.id === request.grantId,
          ) ?? null)
        : await this.repository.getConnectorGrant(
            this.agentId(),
            "google",
            resolvedConfig.mode,
            requestedSide,
          );
      const pendingGrantId =
        request.grantId ??
        (request.createNewGrant ? crypto.randomUUID() : undefined);

      try {
        return startGoogleConnectorOAuth({
          agentId: this.agentId(),
          side: requestedSide,
          requestUrl,
          mode: resolvedConfig.mode,
          requestedCapabilities,
          existingCapabilities:
            existingGrant && !request.createNewGrant
              ? normalizeGrantCapabilities(existingGrant.capabilities)
              : undefined,
          grantId: pendingGrantId,
        });
      } catch (error) {
        if (error instanceof GoogleOAuthError) {
          this.logLifeOpsWarn("google_connector_start", error.message, {
            statusCode: error.status,
            mode: resolvedConfig.mode,
          });
          fail(error.status, error.message);
        }
        this.logLifeOpsError("google_connector_start", error, {
          mode: resolvedConfig.mode,
        });
        throw error;
      }
    }

    async completeGoogleConnectorCallback(
      callbackUrl: URL,
    ): Promise<LifeOpsGoogleConnectorStatus> {
      const genericGoogleAccess = this.getGenericGoogleConnectorAccountAccess();
      const genericState = callbackUrl.searchParams.get("state") ?? undefined;
      if (genericGoogleAccess?.provider.completeOAuth && genericState) {
        const flow = await genericGoogleAccess.manager.getOAuthFlow(
          "google",
          genericState,
        );
        if (flow) {
          try {
            const completed = await genericGoogleAccess.manager.completeOAuth(
              "google",
              {
                state: genericState,
                code: callbackUrl.searchParams.get("code") ?? undefined,
                error: callbackUrl.searchParams.get("error") ?? undefined,
                errorDescription:
                  callbackUrl.searchParams.get("error_description") ??
                  undefined,
                query: Object.fromEntries(callbackUrl.searchParams.entries()),
              },
            );
            const accountId =
              completed.account?.id ?? completed.flow.accountId ?? undefined;
            const side =
              completed.account ? genericGoogleSide(completed.account) : "owner";
            return this.getGoogleConnectorStatus(
              callbackUrl,
              "local",
              side,
              accountId ? genericGrantId(accountId) : undefined,
            );
          } catch (error) {
            this.logLifeOpsWarn("google_connector_callback", String(error), {
              provider: "google",
              sourceOfTruth: "connector_account",
            });
            fail(
              400,
              error instanceof Error
                ? error.message
                : "Failed to complete Google connector OAuth.",
            );
          }
        }
      }

      let result: GoogleConnectorCallbackResult;
      try {
        result = await completeGoogleConnectorOAuth({
          callbackUrl,
        });
      } catch (error) {
        if (error instanceof GoogleOAuthError) {
          this.logLifeOpsWarn("google_connector_callback", error.message, {
            statusCode: error.status,
          });
          fail(error.status, error.message);
        }
        this.logLifeOpsError("google_connector_callback", error);
        throw error;
      }

      if (result.agentId !== this.agentId()) {
        fail(409, "Google callback does not belong to the active agent.");
      }

      const currentGoogleGrants = (
        await this.repository.listConnectorGrants(this.agentId())
      ).filter((candidate) => candidate.provider === "google");
      const existingGrant = result.grantId
        ? (currentGoogleGrants.find((g) => g.id === result.grantId) ?? null)
        : await this.repository.getConnectorGrant(
            this.agentId(),
            "google",
            result.mode,
            result.side,
          );
      const previousPreferredGrant = resolvePreferredGoogleGrant({
        grants: currentGoogleGrants,
        defaultMode: result.mode,
      });
      const nowIso = new Date().toISOString();
      const clearedMetadata = clearGoogleGrantAuthFailureMetadata(
        existingGrant?.metadata ?? {},
      );
      const preferredByAgent =
        existingGrant?.preferredByAgent ?? previousPreferredGrant === null;
      const grant: LifeOpsConnectorGrant = existingGrant
        ? {
            ...existingGrant,
            identity: { ...result.identity },
            grantedScopes: [...result.grantedScopes],
            capabilities: [...result.grantedCapabilities],
            tokenRef: result.tokenRef,
            executionTarget: "local",
            sourceOfTruth: "local_storage",
            cloudConnectionId: null,
            preferredByAgent,
            metadata: {
              ...clearedMetadata,
              expiresAt: result.expiresAt,
              hasRefreshToken: result.hasRefreshToken,
            },
            lastRefreshAt: nowIso,
            updatedAt: nowIso,
          }
        : {
            ...createLifeOpsConnectorGrant({
              agentId: this.agentId(),
              provider: "google",
              side: result.side,
              identity: { ...result.identity },
              grantedScopes: [...result.grantedScopes],
              capabilities: [...result.grantedCapabilities],
              tokenRef: result.tokenRef,
              mode: result.mode,
              executionTarget: "local",
              sourceOfTruth: "local_storage",
              preferredByAgent,
              cloudConnectionId: null,
              metadata: {
                expiresAt: result.expiresAt,
                hasRefreshToken: result.hasRefreshToken,
              },
              lastRefreshAt: nowIso,
            }),
            ...(result.grantId ? { id: result.grantId } : {}),
          };

      await this.repository.upsertConnectorGrant(grant);
      const nextPreferredGrant =
        preferredByAgent || !previousPreferredGrant
          ? await this.setPreferredGoogleConnectorMode(result.mode, result.side)
          : previousPreferredGrant;
      if (previousPreferredGrant?.id !== nextPreferredGrant?.id) {
        await this.clearGoogleConnectorData();
      }
      await this.recordConnectorAudit(
        `google:${result.mode}`,
        "google connector granted",
        {
          side: result.side,
          mode: result.mode,
          capabilities: result.grantedCapabilities,
        },
        {
          tokenRef: result.tokenRef,
          expiresAt: result.expiresAt,
        },
      );
      return this.getGoogleConnectorStatus(
        callbackUrl,
        result.mode,
        result.side,
        grant.id,
      );
    }

    async disconnectGoogleConnector(
      request: DisconnectLifeOpsGoogleConnectorRequest,
      requestUrl: URL,
    ): Promise<LifeOpsGoogleConnectorStatus> {
      const requestedGrantId = normalizeOptionalString(request.grantId);
      const requestedMode = normalizeOptionalConnectorMode(
        request.mode,
        "mode",
      );
      const requestedSide = normalizeOptionalConnectorSide(
        request.side,
        "side",
      );
      const grants = (
        await this.repository.listConnectorGrants(this.agentId())
      ).filter((grant) => grant.provider === "google");
      const modeAvailability = normalizeGenericGoogleAvailableModes(
        resolveGoogleAvailableModes({
          requestUrl,
          cloudConfigured: resolveManagedGoogleCloudConfig(this.runtime)
            .configured,
          grants,
        }),
        Boolean(this.getGenericGoogleConnectorAccountAccess()),
      );
      const preferredGrant = resolvePreferredGoogleGrant({
        grants,
        requestedMode,
        requestedSide,
        defaultMode: modeAvailability.defaultMode,
      });
      const fallbackMode =
        requestedMode ?? preferredGrant?.mode ?? modeAvailability.defaultMode;
      const fallbackSide = requestedSide ?? preferredGrant?.side ?? "owner";
      const grant = requestedGrantId
        ? (grants.find((candidate) => candidate.id === requestedGrantId) ??
          null)
        : await this.repository.getConnectorGrant(
            this.agentId(),
            "google",
            fallbackMode,
            fallbackSide,
          );

      if (!grant) {
        const genericGoogleAccess = this.getGenericGoogleConnectorAccountAccess();
        if (genericGoogleAccess) {
          const accountId = requestedGrantId
            ? genericAccountIdFromGrantId(requestedGrantId)
            : null;
          const accounts = await this.listGenericGoogleConnectorAccounts(
            fallbackSide,
          );
          const account = accountId
            ? accounts.find(
                (candidate) =>
                  candidate.id === accountId ||
                  candidate.externalId === accountId ||
                  candidate.displayHandle === accountId,
              )
            : accounts.find((candidate) => candidate.status === "connected") ??
              accounts[0];
          if (account) {
            await genericGoogleAccess.manager.deleteAccount(
              "google",
              account.id,
            );
            const syntheticGrant = {
              ...genericGoogleGrantFromAccount(account),
              agentId: this.agentId(),
            };
            await this.clearGoogleGrantData(syntheticGrant);
            await this.clearGoogleConnectorData(fallbackSide);
            await this.recordConnectorAudit(
              "google:local",
              "google connector disconnected",
              {
                side: fallbackSide,
                mode: "local",
                connectorAccountId: account.id,
              },
              {
                disconnected: true,
                sourceOfTruth: "connector_account",
              },
            );
            return this.getGoogleConnectorStatus(
              requestUrl,
              "local",
              fallbackSide,
            );
          }
        }
        if (requestedGrantId) {
          fail(404, "Google connector grant not found.");
        }
        return this.getGoogleConnectorStatus(
          requestUrl,
          fallbackMode,
          fallbackSide,
        );
      }
      const mode = grant.mode;
      const side = grant.side;

      if (mode === "cloud_managed" && grant.cloudConnectionId) {
        try {
          await this.googleManagedClient.disconnectConnector(
            grant.cloudConnectionId,
            grant.side,
          );
        } catch (error) {
          if (error instanceof ManagedGoogleClientError) {
            this.logLifeOpsWarn("google_connector_disconnect", error.message, {
              statusCode: error.status,
              mode,
            });
            fail(error.status, error.message);
          }
          this.logLifeOpsError("google_connector_disconnect", error, { mode });
          throw error;
        }
      } else if (grant.tokenRef) {
        deleteStoredGoogleToken(grant.tokenRef);
      }
      const previousPreferredGrant = resolvePreferredGoogleGrant({
        grants,
        defaultMode: modeAvailability.defaultMode,
      });
      await this.repository.deleteConnectorGrant(
        this.agentId(),
        "google",
        mode,
        side,
        grant.id,
      );
      const nextPreferredGrant =
        previousPreferredGrant?.id === grant.id || !previousPreferredGrant
          ? await this.setPreferredGoogleConnectorMode(null)
          : previousPreferredGrant;
      await this.clearGoogleGrantData(grant);
      if (!nextPreferredGrant) {
        await this.clearGoogleConnectorData();
      }
      await this.recordConnectorAudit(
        `google:${mode}`,
        "google connector disconnected",
        {
          side: grant.side,
          mode,
        },
        {
          disconnected: true,
        },
      );
      return this.getGoogleConnectorStatus(requestUrl, mode, side);
    }
  } as unknown as MixinClass<TBase, LifeOpsGoogleService>;
}
