import type {
  DisconnectLifeOpsGoogleConnectorRequest,
  LifeOpsConnectorGrant,
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  LifeOpsGoogleConnectorStatus,
  StartLifeOpsGoogleConnectorRequest,
  StartLifeOpsGoogleConnectorResponse,
} from "@elizaos/shared/contracts/lifeops";
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
import { createLifeOpsConnectorGrant } from "./repository.js";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";
import { fail } from "./service-normalize.js";
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

// ---------------------------------------------------------------------------
// Google mixin
// ---------------------------------------------------------------------------

/** @internal */
export function withGoogle<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
) {
  class LifeOpsGoogleServiceMixin extends Base {
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
      await this.repository.deleteGmailSyncState(
        this.agentId(),
        "google",
        undefined,
        side,
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

      const resolvedPreferredGrant =
        (preferredMode && preferredSide
          ? (googleGrants.find(
              (grant) =>
                grant.mode === preferredMode && grant.side === preferredSide,
            ) ?? null)
          : null) ??
        (preferredMode
          ? ([...googleGrants]
              .filter((grant) => grant.mode === preferredMode)
              .sort((left, right) =>
                right.updatedAt.localeCompare(left.updatedAt),
              )[0] ?? null)
          : null) ??
        (preferredSide
          ? ([...googleGrants]
              .filter((grant) => grant.side === preferredSide)
              .sort((left, right) =>
                right.updatedAt.localeCompare(left.updatedAt),
              )[0] ?? null)
          : null) ??
        [...googleGrants].sort((left, right) =>
          right.updatedAt.localeCompare(left.updatedAt),
        )[0] ??
        null;

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
        currentGoogleGrants.find(
          (grant) => grant.mode === "cloud_managed" && grant.side === side,
        ) ?? null;
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
      const cloudConfig = resolveManagedGoogleCloudConfig();
      const modeAvailability = resolveGoogleAvailableModes({
        requestUrl,
        cloudConfigured: cloudConfig.configured,
        grants,
      });
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
          managedStatus = await this.googleManagedClient.getStatus(side, grantId);
        } catch (error) {
          if (error instanceof ManagedGoogleClientError) {
            if (error.status === 404) {
              if (resolvedGrant?.mode === "cloud_managed") {
                await this.repository.deleteConnectorGrant(
                  this.agentId(),
                  "google",
                  "cloud_managed",
                  side,
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
      const allGrants = (
        await this.repository.listConnectorGrants(this.agentId())
      ).filter((g) => g.provider === "google");
      const grants = resolveGoogleGrants({
        grants: allGrants,
        requestedSide: side,
      });
      const results: LifeOpsGoogleConnectorStatus[] = [];
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
      const modeAvailability = resolveGoogleAvailableModes({
        requestUrl,
        cloudConfigured: resolveManagedGoogleCloudConfig().configured,
        grants,
      });
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
      const cloudConfig = resolveManagedGoogleCloudConfig();
      const modeAvailability = resolveGoogleAvailableModes({
        requestUrl,
        cloudConfigured: cloudConfig.configured,
      });
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

      try {
        return startGoogleConnectorOAuth({
          agentId: this.agentId(),
          side: requestedSide,
          requestUrl,
          mode: resolvedConfig.mode,
          requestedCapabilities,
          existingCapabilities: existingGrant
            ? normalizeGrantCapabilities(existingGrant.capabilities)
            : undefined,
          grantId: request.grantId,
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

      const existingGrant = result.grantId
        ? ((await this.repository.listConnectorGrants(this.agentId())).find(
            (g) => g.id === result.grantId,
          ) ?? null)
        : await this.repository.getConnectorGrant(
            this.agentId(),
            "google",
            result.mode,
            result.side,
          );
      const nowIso = new Date().toISOString();
      const clearedMetadata = clearGoogleGrantAuthFailureMetadata(
        existingGrant?.metadata ?? {},
      );
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
            metadata: {
              ...clearedMetadata,
              expiresAt: result.expiresAt,
              hasRefreshToken: result.hasRefreshToken,
            },
            lastRefreshAt: nowIso,
            updatedAt: nowIso,
          }
        : createLifeOpsConnectorGrant({
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
            preferredByAgent: true,
            cloudConnectionId: null,
            metadata: {
              expiresAt: result.expiresAt,
              hasRefreshToken: result.hasRefreshToken,
            },
            lastRefreshAt: nowIso,
          });

      await this.repository.upsertConnectorGrant(grant);
      const previousPreferredGrant = resolvePreferredGoogleGrant({
        grants: (
          await this.repository.listConnectorGrants(this.agentId())
        ).filter((candidate) => candidate.provider === "google"),
        defaultMode: result.mode,
      });
      const nextPreferredGrant = await this.setPreferredGoogleConnectorMode(
        result.mode,
        result.side,
      );
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
      );
    }

    async disconnectGoogleConnector(
      request: DisconnectLifeOpsGoogleConnectorRequest,
      requestUrl: URL,
    ): Promise<LifeOpsGoogleConnectorStatus> {
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
      const modeAvailability = resolveGoogleAvailableModes({
        requestUrl,
        cloudConfigured: resolveManagedGoogleCloudConfig().configured,
        grants,
      });
      const mode =
        requestedMode ??
        resolvePreferredGoogleGrant({
          grants,
          requestedMode,
          requestedSide,
          defaultMode: modeAvailability.defaultMode,
        })?.mode ??
        modeAvailability.defaultMode;
      const side =
        requestedSide ??
        resolvePreferredGoogleGrant({
          grants,
          requestedMode,
          requestedSide,
          defaultMode: modeAvailability.defaultMode,
        })?.side ??
        "owner";
      const grant = await this.repository.getConnectorGrant(
        this.agentId(),
        "google",
        mode,
        side,
      );

      if (!grant) {
        return this.getGoogleConnectorStatus(requestUrl, mode, side);
      }

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
      );
      const nextPreferredGrant =
        await this.setPreferredGoogleConnectorMode(null);
      if (previousPreferredGrant?.id === grant.id || !nextPreferredGrant) {
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
  }

  return LifeOpsGoogleServiceMixin;
}
