import {
  type ConnectorAccount,
  getConnectorAccountManager,
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
  disconnectedGoogleStatus,
  googleAccountIdFromGrantId,
  googleGrantFromAccount,
  googleGrantIdForAccount,
  googleScopesForAccount,
  googleSideForAccount,
  googleStatusFromAccount,
  listGoogleConnectorAccounts,
  resolveGoogleConnectorAccount,
} from "./google-plugin-delegates.js";
import type {
  Constructor,
  LifeOpsServiceBase,
  MixinClass,
} from "./service-mixin-core.js";
import { fail, normalizeOptionalString } from "./service-normalize.js";
import {
  normalizeGoogleCapabilityRequest,
  normalizeOptionalConnectorMode,
  normalizeOptionalConnectorSide,
} from "./service-normalize-connector.js";

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

function roleForSide(side: LifeOpsConnectorSide): "OWNER" | "AGENT" {
  return side === "agent" ? "AGENT" : "OWNER";
}

function sideFromMetadata(value: unknown): LifeOpsConnectorSide {
  return value === "agent" ? "agent" : "owner";
}

function requestedScopesForCapabilities(
  capabilities: readonly string[] | undefined,
): string[] | undefined {
  if (!capabilities || capabilities.length === 0) {
    return undefined;
  }
  return googleScopesForAccount(
    {
      id: "requested",
      provider: "google",
      role: "OWNER",
      purpose: [],
      accessGate: "owner_binding",
      status: "pending",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: { grantedCapabilities: [...capabilities] },
    } as ConnectorAccount,
    capabilities as never,
  );
}

function assertLocalMode(mode?: LifeOpsConnectorMode): void {
  if (mode && mode !== "local") {
    fail(
      410,
      "LifeOps no longer manages cloud or legacy Google modes. Use @elizaos/plugin-google connector accounts.",
    );
  }
}

function googlePluginUnavailableStatus(
  side: LifeOpsConnectorSide,
): LifeOpsGoogleConnectorStatus {
  return {
    ...disconnectedGoogleStatus(side),
    configured: false,
    reason: "config_missing",
    degradations: [
      {
        axis: "disconnected",
        code: "google_plugin_unavailable",
        message:
          "@elizaos/plugin-google is required for Google accounts. LifeOps no longer stores Google OAuth tokens directly.",
        retryable: true,
      },
    ],
  };
}

/** @internal */
export function withGoogle<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
): MixinClass<TBase, LifeOpsGoogleService> {
  const GoogleBase = Base as unknown as Constructor<LifeOpsServiceBase>;

  class LifeOpsGoogleServiceMixin extends GoogleBase {
    private googleConnectorManager() {
      try {
        return getConnectorAccountManager(this.runtime);
      } catch {
        return null;
      }
    }

    private googleAccountStatus(
      account: ConnectorAccount,
    ): LifeOpsGoogleConnectorStatus {
      return googleStatusFromAccount({
        account,
        agentId: this.agentId(),
        defaultMode: "local",
        availableModes: ["local"],
      });
    }

    public async withGoogleGrantOperation<T>(
      _grant: LifeOpsConnectorGrant,
      operation: () => Promise<T>,
    ): Promise<T> {
      return operation();
    }

    public async runManagedGoogleOperation<T>(
      _grant: LifeOpsConnectorGrant,
      _operation: () => Promise<T>,
    ): Promise<T> {
      fail(
        410,
        "Cloud-managed Google operations were removed from LifeOps. Use @elizaos/plugin-google connector accounts.",
      );
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
      await this.deleteCalendarReminderPlansForEvents(
        (
          await this.repository.listCalendarEvents(
            this.agentId(),
            "google",
            undefined,
            undefined,
            grant.side,
          )
        )
          .filter((event) => event.grantId === grant.id)
          .map((event) => event.id),
      );
      await this.repository.deleteCalendarEventsForProvider(
        this.agentId(),
        "google",
        grant.id,
        grant.side,
      );
      await this.repository.deleteCalendarSyncState(
        this.agentId(),
        "google",
        grant.id,
        grant.side,
      );
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
        grant.id,
        grant.side,
      );
    }

    public async deleteCalendarReminderPlansForEvents(
      _eventIds: string[],
    ): Promise<void> {
      // Implemented by withCalendar; this stub keeps withGoogle independently
      // usable in unit tests that compose only connector status methods.
    }

    public async setPreferredGoogleConnectorMode(
      _mode: LifeOpsConnectorMode | null,
      _side?: LifeOpsConnectorSide,
    ): Promise<LifeOpsConnectorGrant | null> {
      return null;
    }

    public async requireGoogleCalendarGrant(
      requestUrl: URL,
      requestedMode?: LifeOpsConnectorMode,
      requestedSide?: LifeOpsConnectorSide,
      grantId?: string,
    ): Promise<LifeOpsConnectorGrant> {
      assertLocalMode(normalizeOptionalConnectorMode(requestedMode, "mode"));
      const status = await this.getGoogleConnectorStatus(
        requestUrl,
        "local",
        requestedSide,
        grantId,
      );
      const grant = status.grant;
      if (!status.connected || !grant) {
        fail(409, "Google Calendar is not connected.");
      }
      if (!grant.capabilities.includes("google.calendar.read")) {
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
      const grant = await this.requireGoogleCalendarGrant(
        requestUrl,
        requestedMode,
        requestedSide,
        grantId,
      );
      if (!grant.capabilities.includes("google.calendar.write")) {
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
      assertLocalMode(normalizeOptionalConnectorMode(requestedMode, "mode"));
      const status = await this.getGoogleConnectorStatus(
        requestUrl,
        "local",
        requestedSide,
        grantId,
      );
      const grant = status.grant;
      if (!status.connected || !grant) {
        fail(409, "Google Gmail is not connected.");
      }
      if (!grant.capabilities.includes("google.gmail.triage")) {
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
      const grant = await this.requireGoogleGmailGrant(
        requestUrl,
        requestedMode,
        requestedSide,
        grantId,
      );
      if (!grant.capabilities.includes("google.gmail.send")) {
        fail(403, "Google Gmail send access has not been granted.");
      }
      return grant;
    }

    async getGoogleConnectorStatus(
      _requestUrl: URL,
      requestedMode?: LifeOpsConnectorMode,
      requestedSide?: LifeOpsConnectorSide,
      grantId?: string,
    ): Promise<LifeOpsGoogleConnectorStatus> {
      const mode = normalizeOptionalConnectorMode(requestedMode, "mode");
      assertLocalMode(mode);
      const side =
        normalizeOptionalConnectorSide(requestedSide, "side") ?? "owner";
      const manager = this.googleConnectorManager();
      if (!manager?.getProvider?.("google")) {
        return googlePluginUnavailableStatus(side);
      }
      const account = await resolveGoogleConnectorAccount({
        runtime: this.runtime,
        requestedSide: side,
        grantId,
      });
      return account
        ? this.googleAccountStatus(account)
        : disconnectedGoogleStatus(side);
    }

    async getGoogleConnectorAccounts(
      _requestUrl: URL,
      requestedSide?: LifeOpsConnectorSide,
    ): Promise<LifeOpsGoogleConnectorStatus[]> {
      const side = normalizeOptionalConnectorSide(requestedSide, "side");
      const manager = this.googleConnectorManager();
      if (!manager?.getProvider?.("google")) {
        return side
          ? [googlePluginUnavailableStatus(side)]
          : [
              googlePluginUnavailableStatus("owner"),
              googlePluginUnavailableStatus("agent"),
            ];
      }
      const accounts = await listGoogleConnectorAccounts({
        runtime: this.runtime,
        requestedSide: side,
      });
      if (accounts.length === 0) {
        return side ? [disconnectedGoogleStatus(side)] : [];
      }
      return accounts.map((account) => this.googleAccountStatus(account));
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
      assertLocalMode(preferredMode);
      return this.getGoogleConnectorStatus(requestUrl, "local", requestedSide);
    }

    async startGoogleConnector(
      request: StartLifeOpsGoogleConnectorRequest,
      requestUrl: URL,
    ): Promise<StartLifeOpsGoogleConnectorResponse> {
      const mode = normalizeOptionalConnectorMode(request.mode, "mode");
      assertLocalMode(mode);
      const requestedSide =
        normalizeOptionalConnectorSide(request.side, "side") ?? "owner";
      const requestedCapabilities = normalizeGoogleCapabilityRequest(
        request.capabilities,
      );
      const manager = this.googleConnectorManager();
      if (!manager?.getProvider?.("google")) {
        fail(
          503,
          "@elizaos/plugin-google is required before starting Google OAuth.",
        );
      }

      const requestedAccountId = googleAccountIdFromGrantId(request.grantId);
      const redirectUri = new URL(
        "/api/connectors/google/oauth/callback",
        requestUrl.origin,
      ).toString();
      const flow = await manager.startOAuth("google", {
        redirectUri,
        accountId: requestedAccountId ?? undefined,
        scopes: requestedScopesForCapabilities(requestedCapabilities),
        metadata: {
          lifeops: true,
          side: requestedSide,
          role: roleForSide(requestedSide),
          requestedRole: roleForSide(requestedSide),
          requestedCapabilities,
          privacy: "owner_only",
          redirectUrl: normalizeOptionalString(request.redirectUrl),
        },
      });
      return {
        provider: "google",
        side: requestedSide,
        mode: "local",
        requestedCapabilities,
        redirectUri: flow.redirectUri ?? redirectUri,
        authUrl: flow.authUrl ?? "",
      };
    }

    async completeGoogleConnectorCallback(
      callbackUrl: URL,
    ): Promise<LifeOpsGoogleConnectorStatus> {
      const manager = this.googleConnectorManager();
      if (!manager?.getProvider?.("google")) {
        fail(
          503,
          "@elizaos/plugin-google is required before completing Google OAuth.",
        );
      }
      const state = callbackUrl.searchParams.get("state") ?? "";
      const completed = await manager.completeOAuth("google", {
        state,
        code: callbackUrl.searchParams.get("code") ?? undefined,
        error: callbackUrl.searchParams.get("error") ?? undefined,
        errorDescription:
          callbackUrl.searchParams.get("error_description") ?? undefined,
        query: Object.fromEntries(callbackUrl.searchParams.entries()),
      });
      const side = sideFromMetadata(completed.flow.metadata?.side);
      const accountId =
        completed.account?.id ?? completed.flow.accountId ?? undefined;
      return this.getGoogleConnectorStatus(
        callbackUrl,
        "local",
        side,
        accountId ? googleGrantIdForAccount(accountId) : undefined,
      );
    }

    async disconnectGoogleConnector(
      request: DisconnectLifeOpsGoogleConnectorRequest,
      requestUrl: URL,
    ): Promise<LifeOpsGoogleConnectorStatus> {
      const mode = normalizeOptionalConnectorMode(request.mode, "mode");
      assertLocalMode(mode);
      const side = normalizeOptionalConnectorSide(request.side, "side");
      const manager = this.googleConnectorManager();
      if (!manager?.getProvider?.("google")) {
        fail(
          503,
          "@elizaos/plugin-google is required before disconnecting Google accounts.",
        );
      }
      const requestedGrantId = normalizeOptionalString(request.grantId);
      const account = await resolveGoogleConnectorAccount({
        runtime: this.runtime,
        requestedSide: side,
        grantId: requestedGrantId,
      });
      if (!account) {
        if (requestedGrantId) {
          fail(404, "Google connector account not found.");
        }
        return this.getGoogleConnectorStatus(requestUrl, "local", side);
      }
      const grant = googleGrantFromAccount({
        account,
        agentId: this.agentId(),
      });
      await manager.deleteAccount("google", account.id);
      await this.clearGoogleGrantData(grant);
      await this.recordConnectorAudit(
        "google:connector-account",
        "google connector account disconnected",
        {
          connectorAccountId: account.id,
          side: googleSideForAccount(account),
        },
        { disconnected: true },
      );
      return this.getGoogleConnectorStatus(
        requestUrl,
        "local",
        side ?? googleSideForAccount(account),
      );
    }
  }

  return LifeOpsGoogleServiceMixin as unknown as MixinClass<
    TBase,
    LifeOpsGoogleService
  >;
}
