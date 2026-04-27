// @ts-nocheck — mixin: type safety is enforced on the composed class
import {
  LIFEOPS_TELEGRAM_CAPABILITIES,
  type LifeOpsConnectorSide,
  type LifeOpsTelegramCapability,
  type LifeOpsTelegramConnectorStatus,
  type StartLifeOpsTelegramAuthRequest,
  type StartLifeOpsTelegramAuthResponse,
  type SubmitLifeOpsTelegramAuthRequest,
  type VerifyLifeOpsTelegramConnectorRequest,
  type VerifyLifeOpsTelegramConnectorResponse,
} from "@elizaos/shared";
import { createLifeOpsConnectorGrant } from "./repository.js";
import {
  fail,
  requireNonEmptyString,
} from "./service-normalize.js";
import {
  normalizeOptionalConnectorSide,
} from "./service-normalize-connector.js";
import {
  buildTelegramTokenRef,
  cancelTelegramAuth,
  deleteStoredTelegramToken,
  findPendingTelegramAuthSession,
  inferRetryableTelegramAuthState,
  hasManagedTelegramCredentials,
  readStoredTelegramToken,
  startTelegramAuth as startTelegramAuthFlow,
  submitTelegramAuthCode,
  submitTelegramAuthPassword,
} from "./telegram-auth.js";
import {
  getTelegramReadReceipts,
  searchTelegramMessages,
  sendTelegramAccountMessage,
  telegramLocalSessionAvailable,
  verifyTelegramLocalConnector,
  type TelegramDeliveryStatus,
  type TelegramMessageSearchResult,
  type TelegramReadReceiptResult,
} from "./telegram-local-client.js";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";

function isLifeOpsTelegramCapability(
  value: unknown,
): value is LifeOpsTelegramCapability {
  return (
    typeof value === "string" &&
    (LIFEOPS_TELEGRAM_CAPABILITIES as readonly string[]).includes(value)
  );
}

/** @internal */
export function withTelegram<TBase extends Constructor<LifeOpsServiceBase>>(Base: TBase) {
  class LifeOpsTelegramServiceMixin extends Base {
    async getTelegramConnectorStatus(
      requestedSide?: LifeOpsConnectorSide,
    ): Promise<LifeOpsTelegramConnectorStatus> {
      const side =
        normalizeOptionalConnectorSide(requestedSide, "side") ?? "owner";
      const grant = await this.repository.getConnectorGrant(
        this.agentId(),
        "telegram",
        "local",
        side,
      );
      const pendingSession = findPendingTelegramAuthSession(this.agentId(), side);

      const tokenRef = grant?.tokenRef ?? null;
      const storedToken = tokenRef
        ? readStoredTelegramToken(tokenRef)
        : null;
      const sessionAvailable = telegramLocalSessionAvailable();
      const connected = Boolean(grant && storedToken && sessionAvailable);
      const retryableAuthState = pendingSession
        ? inferRetryableTelegramAuthState({
            state: pendingSession.state,
            error: pendingSession.error,
          })
        : null;
      const authState = connected
        ? "connected"
        : retryableAuthState ?? pendingSession?.state ?? "idle";

      const capabilities: LifeOpsTelegramCapability[] = grant
        ? grant.capabilities.filter(isLifeOpsTelegramCapability)
        : [];

      return {
        provider: "telegram",
        side,
        connected,
        reason: connected
          ? "connected"
          : pendingSession
            ? "auth_pending"
            : grant || storedToken
              ? "auth_expired"
              : "disconnected",
        identity:
          storedToken?.identity &&
          Object.keys(storedToken.identity).length > 0 &&
          storedToken.identity.id
            ? storedToken.identity
            : grant?.identity &&
                Object.keys(grant.identity).length > 0
              ? (grant.identity as LifeOpsTelegramConnectorStatus["identity"])
              : null,
        grantedCapabilities: capabilities,
        authState,
        authError: pendingSession?.error ?? null,
        phone:
          pendingSession?.phone ??
          storedToken?.phone ??
          (typeof grant?.metadata.phone === "string" ? grant.metadata.phone : null),
        managedCredentialsAvailable: hasManagedTelegramCredentials(),
        storedCredentialsAvailable: Boolean(
          storedToken?.apiId && storedToken?.apiHash,
        ),
        grant: grant ?? null,
      };
    }

    async startTelegramAuth(
      request: StartLifeOpsTelegramAuthRequest,
    ): Promise<StartLifeOpsTelegramAuthResponse> {
      const side =
        normalizeOptionalConnectorSide(request.side, "side") ?? "owner";
      const phone = requireNonEmptyString(request.phone, "phone");

      // startTelegramAuthFlow is now async — it creates a real GramJS client.
      const session = await startTelegramAuthFlow({
        agentId: this.agentId(),
        side,
        phone,
        apiId: request.apiId,
        apiHash: request.apiHash,
      });

      return {
        provider: "telegram",
        side,
        state: session.state === "idle"
          ? "waiting_for_code"
          : session.state === "waiting_for_provisioning_code"
            ? "waiting_for_provisioning_code"
            : session.state as StartLifeOpsTelegramAuthResponse["state"],
        error: session.error ?? undefined,
      };
    }

    async submitTelegramAuth(
      request: SubmitLifeOpsTelegramAuthRequest,
    ): Promise<StartLifeOpsTelegramAuthResponse> {
      const side =
        normalizeOptionalConnectorSide(request.side, "side") ?? "owner";

      let resultState: StartLifeOpsTelegramAuthResponse["state"];
      let resultError: string | undefined;

      if (request.code) {
        const session = findPendingTelegramAuthSession(this.agentId(), side);
        if (!session) {
          fail(404, "No pending Telegram auth session found for this agent/side.");
        }
        // submitTelegramAuthCode is now async — it invokes GramJS.
        const result = await submitTelegramAuthCode(session.sessionId, request.code);
        resultState = result.state as StartLifeOpsTelegramAuthResponse["state"];
        resultError = result.error ?? undefined;

        if (result.state === "connected") {
          await this.persistTelegramGrant(side, result.phone, result.identity);
          await cancelTelegramAuth(result.sessionId);
        }
      } else if (request.password) {
        const session = findPendingTelegramAuthSession(this.agentId(), side);
        if (!session) {
          fail(404, "No pending Telegram auth session found for this agent/side.");
        }
        const result = await submitTelegramAuthPassword(
          session.sessionId,
          request.password,
        );
        resultState = result.state as StartLifeOpsTelegramAuthResponse["state"];
        resultError = result.error ?? undefined;

        if (result.state === "connected") {
          await this.persistTelegramGrant(side, result.phone, result.identity);
          await cancelTelegramAuth(result.sessionId);
        }
      } else {
        fail(400, "Either code or password must be provided.");
      }

      return {
        provider: "telegram",
        side,
        state: resultState,
        error: resultError,
      };
    }

    async disconnectTelegram(
      requestedSide?: LifeOpsConnectorSide,
    ): Promise<LifeOpsTelegramConnectorStatus> {
      const side =
        normalizeOptionalConnectorSide(requestedSide, "side") ?? "owner";
      const grant = await this.repository.getConnectorGrant(
        this.agentId(),
        "telegram",
        "local",
        side,
      );
      const pendingSession = findPendingTelegramAuthSession(this.agentId(), side);

      if (pendingSession) {
        await cancelTelegramAuth(pendingSession.sessionId);
      }

      if (grant?.tokenRef) {
        deleteStoredTelegramToken(grant.tokenRef);
      }

      if (grant) {
        await this.repository.deleteConnectorGrant(
          this.agentId(),
          "telegram",
          "local",
          side,
        );
      }

      await this.recordConnectorAudit(
        `telegram:${side}`,
        "telegram connector disconnected",
        { side },
        { disconnected: true },
      );

      return {
        provider: "telegram",
        side,
        connected: false,
        reason: "disconnected",
        identity: null,
        grantedCapabilities: [],
        authState: "idle",
        authError: null,
        phone: null,
        managedCredentialsAvailable: hasManagedTelegramCredentials(),
        storedCredentialsAvailable: false,
        grant: null,
      };
    }

    async sendTelegramMessage(request: {
      side?: LifeOpsConnectorSide;
      target: string;
      message: string;
    }): Promise<{ ok: true; messageId: string | null }> {
      const side =
        normalizeOptionalConnectorSide(request.side, "side") ?? "owner";
      const status = await this.getTelegramConnectorStatus(side);
      if (!status.connected || !status.grant?.tokenRef) {
        fail(409, "Telegram connector is not connected.");
      }
      if (!status.grantedCapabilities.includes("telegram.send")) {
        fail(403, "Telegram connector is missing send permission.");
      }

      const result = await sendTelegramAccountMessage({
        tokenRef: status.grant.tokenRef,
        target: requireNonEmptyString(request.target, "target"),
        message: requireNonEmptyString(request.message, "message"),
      });

      return {
        ok: true,
        messageId: result.messageId,
      };
    }

    async verifyTelegramConnector(
      request: VerifyLifeOpsTelegramConnectorRequest,
    ): Promise<VerifyLifeOpsTelegramConnectorResponse> {
      const side =
        normalizeOptionalConnectorSide(request.side, "side") ?? "owner";
      const status = await this.getTelegramConnectorStatus(side);
      if (!status.connected || !status.grant?.tokenRef) {
        fail(409, "Telegram connector is not connected.");
      }
      if (!status.grantedCapabilities.includes("telegram.read")) {
        fail(403, "Telegram connector is missing read permission.");
      }
      if (!status.grantedCapabilities.includes("telegram.send")) {
        fail(403, "Telegram connector is missing send permission.");
      }

      const result = await verifyTelegramLocalConnector({
        tokenRef: status.grant.tokenRef,
        recentLimit: request.recentLimit,
        sendTarget: request.sendTarget,
        sendMessage: request.sendMessage,
      });

      return {
        provider: "telegram",
        side,
        ...result,
      };
    }

    async searchTelegramMessages(request: {
      side?: LifeOpsConnectorSide;
      query: string;
      scope?: string;
      limit?: number;
    }): Promise<TelegramMessageSearchResult[]> {
      const side =
        normalizeOptionalConnectorSide(request.side, "side") ?? "owner";
      const status = await this.getTelegramConnectorStatus(side);
      if (!status.connected || !status.grant?.tokenRef) {
        fail(409, "Telegram connector is not connected.");
      }
      if (!status.grantedCapabilities.includes("telegram.read")) {
        fail(403, "Telegram connector is missing read permission.");
      }
      return searchTelegramMessages({
        tokenRef: status.grant.tokenRef,
        query: request.query,
        scope: request.scope,
        limit: request.limit,
      });
    }

    async getTelegramDeliveryStatus(request: {
      side?: LifeOpsConnectorSide;
      target: string;
      messageIds: string[];
    }): Promise<TelegramReadReceiptResult[]> {
      const side =
        normalizeOptionalConnectorSide(request.side, "side") ?? "owner";
      const status = await this.getTelegramConnectorStatus(side);
      if (!status.connected || !status.grant?.tokenRef) {
        fail(409, "Telegram connector is not connected.");
      }
      if (!status.grantedCapabilities.includes("telegram.read")) {
        fail(403, "Telegram connector is missing read permission.");
      }
      return getTelegramReadReceipts({
        tokenRef: status.grant.tokenRef,
        target: requireNonEmptyString(request.target, "target"),
        messageIds: request.messageIds,
      });
    }

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    /** @internal */
    async persistTelegramGrant(
      side: LifeOpsConnectorSide,
      phone: string,
      authIdentity?: { id: string; username: string; firstName: string } | null,
    ): Promise<void> {
      const tokenRef = buildTelegramTokenRef(this.agentId(), side);
      const storedToken = readStoredTelegramToken(tokenRef);
      const identity: Record<string, unknown> = authIdentity
        ? { ...authIdentity, phone }
        : storedToken?.identity
          ? { ...storedToken.identity, phone }
          : { phone };

      const existing = await this.repository.getConnectorGrant(
        this.agentId(),
        "telegram",
        "local",
        side,
      );

      const capabilities: LifeOpsTelegramCapability[] = [
        ...LIFEOPS_TELEGRAM_CAPABILITIES,
      ];

      const grant = existing
        ? {
            ...existing,
            identity,
            capabilities,
            tokenRef,
            metadata: {
              ...existing.metadata,
              phone,
            },
            updatedAt: new Date().toISOString(),
          }
        : createLifeOpsConnectorGrant({
            agentId: this.agentId(),
            provider: "telegram",
            identity,
            grantedScopes: [],
            capabilities,
            tokenRef,
            mode: "local",
            side,
            metadata: { phone },
            lastRefreshAt: new Date().toISOString(),
          });

      await this.repository.upsertConnectorGrant(grant);

      await this.recordConnectorAudit(
        `telegram:${side}`,
        "telegram connector authenticated",
        { phone, side },
        { capabilities },
      );
    }
  }

  return LifeOpsTelegramServiceMixin;
}
