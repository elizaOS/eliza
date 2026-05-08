// @ts-nocheck — Mixin pattern: each `withFoo()` returns a class that calls
// methods belonging to sibling mixins (e.g. `this.recordScreenTimeEvent`).
// Type checking each mixin in isolation surfaces 700+ phantom errors because
// the local TBase constraint can't see sibling mixin methods. Real type
// safety is enforced at the composed-service level (LifeOpsService class).
// Refactoring requires either declaration-merging every cross-mixin method
// or moving to a single composed interface — tracked as separate work.
import {
  LIFEOPS_TELEGRAM_CAPABILITIES,
  type LifeOpsConnectorDegradation,
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
  searchTelegramMessagesWithRuntimeService,
  sendTelegramMessageWithRuntimeService,
} from "./runtime-service-delegates.js";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";
import { fail, requireNonEmptyString } from "./service-normalize.js";
import { normalizeOptionalConnectorSide } from "./service-normalize-connector.js";
import {
  buildTelegramTokenRef,
  cancelTelegramAuth,
  deleteStoredTelegramToken,
  findPendingTelegramAuthSession,
  findStoredTelegramTokenForSide,
  hasManagedTelegramCredentials,
  inferRetryableTelegramAuthState,
  readStoredTelegramToken,
  startTelegramAuth as startTelegramAuthFlow,
  submitTelegramAuthCode,
  submitTelegramAuthPassword,
} from "./telegram-auth.js";
import {
  getTelegramReadReceipts,
  searchTelegramMessages,
  sendTelegramAccountMessage,
  type TelegramMessageSearchResult,
  type TelegramReadReceiptResult,
  telegramLocalSessionAvailable,
  verifyTelegramLocalConnector,
} from "./telegram-local-client.js";

function isLifeOpsTelegramCapability(
  value: unknown,
): value is LifeOpsTelegramCapability {
  return (
    typeof value === "string" &&
    (LIFEOPS_TELEGRAM_CAPABILITIES as readonly string[]).includes(value)
  );
}

const FULL_TELEGRAM_CAPABILITIES: LifeOpsTelegramCapability[] = [
  ...LIFEOPS_TELEGRAM_CAPABILITIES,
];

type TelegramPluginServiceLike = {
  messageManager?: unknown;
  bot?: {
    botInfo?: {
      id?: number | string;
      username?: string;
      first_name?: string;
      firstName?: string;
    } | null;
  } | null;
};

function getTelegramPluginService(
  runtime: Constructor<LifeOpsServiceBase>["prototype"]["runtime"],
): TelegramPluginServiceLike | null {
  const service = runtime.getService?.("telegram") as
    | TelegramPluginServiceLike
    | null
    | undefined;
  return service && typeof service === "object" ? service : null;
}

function telegramPluginConnected(
  service: TelegramPluginServiceLike | null,
): boolean {
  return Boolean(service?.messageManager);
}

function telegramPluginIdentity(
  service: TelegramPluginServiceLike | null,
): LifeOpsTelegramConnectorStatus["identity"] {
  const botInfo = service?.bot?.botInfo;
  if (!botInfo?.id && !botInfo?.username) {
    return null;
  }
  return {
    ...(botInfo.id !== undefined ? { id: String(botInfo.id) } : {}),
    ...(botInfo.username ? { username: botInfo.username } : {}),
    ...(botInfo.first_name || botInfo.firstName
      ? { firstName: botInfo.first_name ?? botInfo.firstName }
      : {}),
  };
}

function telegramAgentPluginDegradations(
  connected: boolean,
): LifeOpsConnectorDegradation[] {
  if (connected) {
    return [];
  }
  return [
    {
      axis: "transport-offline",
      code: "telegram_plugin_unavailable",
      message:
        "Agent-side Telegram is served by @elizaos/plugin-telegram. Configure and enable the Telegram bot connector; LifeOps will not create a separate agent Telegram account.",
      retryable: true,
    },
  ];
}

function memoryToTelegramMessageSearchResult(
  memory: unknown,
): TelegramMessageSearchResult {
  const record = memory && typeof memory === "object" ? memory : {};
  const content =
    (record as { content?: { text?: unknown; name?: unknown } }).content ?? {};
  const metadata =
    ((record as { metadata?: unknown }).metadata &&
    typeof (record as { metadata?: unknown }).metadata === "object"
      ? ((record as { metadata?: unknown }).metadata as Record<string, unknown>)
      : {}) ?? {};
  const telegram =
    metadata.telegram && typeof metadata.telegram === "object"
      ? (metadata.telegram as Record<string, unknown>)
      : {};
  const createdAt = Number((record as { createdAt?: unknown }).createdAt);
  const timestamp = Number.isFinite(createdAt)
    ? new Date(createdAt).toISOString()
    : null;
  const id =
    typeof metadata.messageId === "string"
      ? metadata.messageId
      : typeof telegram.messageId === "string"
        ? telegram.messageId
        : typeof (record as { id?: unknown }).id === "string"
          ? (record as { id: string }).id
          : null;
  return {
    id,
    dialogId:
      typeof telegram.chatId === "string"
        ? telegram.chatId
        : typeof metadata.chatId === "string"
          ? metadata.chatId
          : typeof metadata.channelId === "string"
            ? metadata.channelId
            : null,
    threadId:
      typeof telegram.threadId === "string"
        ? telegram.threadId
        : typeof metadata.threadId === "string"
          ? metadata.threadId
          : null,
    dialogTitle:
      typeof metadata.roomName === "string"
        ? metadata.roomName
        : typeof content.name === "string"
          ? content.name
          : null,
    username:
      typeof telegram.username === "string"
        ? telegram.username
        : typeof metadata.username === "string"
          ? metadata.username
          : null,
    peerId:
      typeof telegram.peerId === "string"
        ? telegram.peerId
        : typeof metadata.peerId === "string"
          ? metadata.peerId
          : null,
    senderId:
      typeof telegram.senderId === "string"
        ? telegram.senderId
        : typeof metadata.senderId === "string"
          ? metadata.senderId
          : null,
    content: typeof content.text === "string" ? content.text : "",
    timestamp,
    outgoing:
      (record as { entityId?: unknown; agentId?: unknown }).entityId ===
      (record as { entityId?: unknown; agentId?: unknown }).agentId,
  };
}

/** @internal */
export function withTelegram<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
) {
  class LifeOpsTelegramServiceMixin extends Base {
    async getTelegramConnectorStatus(
      requestedSide?: LifeOpsConnectorSide,
    ): Promise<LifeOpsTelegramConnectorStatus> {
      const side =
        normalizeOptionalConnectorSide(requestedSide, "side") ?? "owner";
      if (side === "agent") {
        const pluginService = getTelegramPluginService(this.runtime);
        const connected = telegramPluginConnected(pluginService);
        const degradations = telegramAgentPluginDegradations(connected);
        return {
          provider: "telegram",
          side,
          connected,
          reason: connected ? "connected" : "disconnected",
          identity: telegramPluginIdentity(pluginService),
          grantedCapabilities: connected ? FULL_TELEGRAM_CAPABILITIES : [],
          authState: connected ? "connected" : "idle",
          authError: null,
          phone: null,
          managedCredentialsAvailable: false,
          storedCredentialsAvailable: false,
          grant: null,
          ...(degradations.length > 0 ? { degradations } : {}),
        };
      }

      let grant = await this.repository.getConnectorGrant(
        this.agentId(),
        "telegram",
        "local",
        side,
      );
      const pendingSession = findPendingTelegramAuthSession(
        this.agentId(),
        side,
      );

      let tokenRef = grant?.tokenRef ?? null;
      let storedToken = tokenRef ? readStoredTelegramToken(tokenRef) : null;

      if (!storedToken) {
        const candidate = findStoredTelegramTokenForSide(this.agentId(), side);
        if (candidate) {
          const identity = {
            ...candidate.token.identity,
            phone: candidate.token.phone,
          };
          const capabilities: LifeOpsTelegramCapability[] = [
            ...LIFEOPS_TELEGRAM_CAPABILITIES,
          ];
          grant = grant
            ? {
                ...grant,
                identity,
                capabilities,
                tokenRef: candidate.tokenRef,
                metadata: {
                  ...grant.metadata,
                  phone: candidate.token.phone,
                  adoptedFromAgentId:
                    candidate.agentId === this.agentId()
                      ? null
                      : candidate.agentId,
                },
                lastRefreshAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              }
            : createLifeOpsConnectorGrant({
                agentId: this.agentId(),
                provider: "telegram",
                identity,
                grantedScopes: [],
                capabilities,
                tokenRef: candidate.tokenRef,
                mode: "local",
                side,
                metadata: {
                  phone: candidate.token.phone,
                  adoptedFromAgentId:
                    candidate.agentId === this.agentId()
                      ? null
                      : candidate.agentId,
                },
                lastRefreshAt: new Date().toISOString(),
              });
          await this.repository.upsertConnectorGrant(grant);
          tokenRef = candidate.tokenRef;
          storedToken = candidate.token;
        }
      }

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
        : (retryableAuthState ?? pendingSession?.state ?? "idle");

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
            : grant?.identity && Object.keys(grant.identity).length > 0
              ? (grant.identity as LifeOpsTelegramConnectorStatus["identity"])
              : null,
        grantedCapabilities: capabilities,
        authState,
        authError: pendingSession?.error ?? null,
        phone:
          pendingSession?.phone ??
          storedToken?.phone ??
          (typeof grant?.metadata.phone === "string"
            ? grant.metadata.phone
            : null),
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
      if (side === "agent") {
        fail(
          409,
          "Agent-side Telegram is managed by @elizaos/plugin-telegram. Configure the Telegram bot connector instead of linking a LifeOps Telegram account.",
        );
      }
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
        state:
          session.state === "idle"
            ? "waiting_for_code"
            : session.state === "waiting_for_provisioning_code"
              ? "waiting_for_provisioning_code"
              : (session.state as StartLifeOpsTelegramAuthResponse["state"]),
        error: session.error ?? undefined,
      };
    }

    async submitTelegramAuth(
      request: SubmitLifeOpsTelegramAuthRequest,
    ): Promise<StartLifeOpsTelegramAuthResponse> {
      const side =
        normalizeOptionalConnectorSide(request.side, "side") ?? "owner";
      if (side === "agent") {
        fail(
          409,
          "Agent-side Telegram auth is owned by @elizaos/plugin-telegram. Configure the Telegram bot connector instead of submitting LifeOps account credentials.",
        );
      }

      let resultState: StartLifeOpsTelegramAuthResponse["state"];
      let resultError: string | undefined;

      if (request.code) {
        const session = findPendingTelegramAuthSession(this.agentId(), side);
        if (!session) {
          fail(
            404,
            "No pending Telegram auth session found for this agent/side.",
          );
        }
        // submitTelegramAuthCode is now async — it invokes GramJS.
        const result = await submitTelegramAuthCode(
          session.sessionId,
          request.code,
        );
        resultState = result.state as StartLifeOpsTelegramAuthResponse["state"];
        resultError = result.error ?? undefined;

        if (result.state === "connected") {
          await this.persistTelegramGrant(side, result.phone, result.identity);
          await cancelTelegramAuth(result.sessionId);
        }
      } else if (request.password) {
        const session = findPendingTelegramAuthSession(this.agentId(), side);
        if (!session) {
          fail(
            404,
            "No pending Telegram auth session found for this agent/side.",
          );
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
      if (side === "agent") {
        fail(
          409,
          "Agent-side Telegram is owned by @elizaos/plugin-telegram. Disable or reconfigure the Telegram bot connector instead of deleting a LifeOps grant.",
        );
      }
      const grant = await this.repository.getConnectorGrant(
        this.agentId(),
        "telegram",
        "local",
        side,
      );
      const pendingSession = findPendingTelegramAuthSession(
        this.agentId(),
        side,
      );

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
      if (side === "agent") {
        const target = requireNonEmptyString(request.target, "target");
        const message = requireNonEmptyString(request.message, "message");
        const status = await this.getTelegramConnectorStatus(side);
        if (!status.connected) {
          fail(409, "Agent-side Telegram plugin is not connected.");
        }
        if (!status.grantedCapabilities.includes("telegram.send")) {
          fail(403, "Telegram plugin is missing send permission.");
        }
        const delegated = await sendTelegramMessageWithRuntimeService({
          runtime: this.runtime,
          grant: status.grant,
          target,
          message,
        });
        if (delegated.status === "handled") {
          return { ok: true, messageId: null };
        }
        if (delegated.error) {
          this.logLifeOpsWarn(
            "runtime_service_delegation_fallback",
            delegated.reason,
            {
              provider: "telegram",
              operation: "message.send",
              error:
                delegated.error instanceof Error
                  ? delegated.error.message
                  : String(delegated.error),
            },
          );
        }
        if (typeof this.runtime.sendMessageToTarget !== "function") {
          fail(503, "Telegram send handler is not available.");
        }
        await this.runtime.sendMessageToTarget(
          { source: "telegram", accountId: "default", channelId: target },
          { text: message, source: "lifeops", metadata: { accountId: "default" } },
        );
        return { ok: true, messageId: null };
      }
      const status = await this.getTelegramConnectorStatus(side);
      if (!status.connected || !status.grant?.tokenRef) {
        fail(409, "Telegram connector is not connected.");
      }
      if (!status.grantedCapabilities.includes("telegram.send")) {
        fail(403, "Telegram connector is missing send permission.");
      }

      const target = requireNonEmptyString(request.target, "target");
      const message = requireNonEmptyString(request.message, "message");
      const delegated = await sendTelegramMessageWithRuntimeService({
        runtime: this.runtime,
        grant: status.grant,
        target,
        message,
      });
      if (delegated.status === "handled") {
        return { ok: true, messageId: null };
      }
      if (delegated.error) {
        this.logLifeOpsWarn(
          "runtime_service_delegation_fallback",
          delegated.reason,
          {
            provider: "telegram",
            operation: "message.send",
            error:
              delegated.error instanceof Error
                ? delegated.error.message
                : String(delegated.error),
          },
        );
      }

      const result = await sendTelegramAccountMessage({
        tokenRef: status.grant.tokenRef,
        target,
        message,
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
      if (side === "agent") {
        const status = await this.getTelegramConnectorStatus(side);
        if (!status.connected) {
          fail(409, "Agent-side Telegram plugin is not connected.");
        }
        let send = {
          ok: true,
          error: null,
          target: request.sendTarget ?? "",
          message: request.sendMessage ?? "",
          messageId: null,
        };
        if (request.sendTarget) {
          try {
            const result = await this.sendTelegramMessage({
              side,
              target: request.sendTarget,
              message:
                request.sendMessage ??
                "LifeOps Telegram connector verification ping.",
            });
            send = {
              ok: true,
              error: null,
              target: request.sendTarget,
              message:
                request.sendMessage ??
                "LifeOps Telegram connector verification ping.",
              messageId: result.messageId,
            };
          } catch (error) {
            send = {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
              target: request.sendTarget,
              message:
                request.sendMessage ??
                "LifeOps Telegram connector verification ping.",
              messageId: null,
            };
          }
        }
        return {
          provider: "telegram",
          side,
          verifiedAt: new Date().toISOString(),
          read: {
            ok: true,
            error: null,
            dialogCount: 0,
            dialogs: [],
          },
          send,
        };
      }
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
      if (!status.connected) {
        fail(409, "Telegram connector is not connected.");
      }
      if (!status.grantedCapabilities.includes("telegram.read")) {
        fail(403, "Telegram connector is missing read permission.");
      }
      const delegated = await searchTelegramMessagesWithRuntimeService({
        runtime: this.runtime,
        grant: status.grant,
        query: request.query,
        channelId: request.scope,
        limit: request.limit,
      });
      if (delegated.status === "handled") {
        return delegated.value.map(memoryToTelegramMessageSearchResult);
      }
      if (delegated.error) {
        this.logLifeOpsWarn(
          "runtime_service_delegation_fallback",
          delegated.reason,
          {
            provider: "telegram",
            operation: "message.search",
            error:
              delegated.error instanceof Error
                ? delegated.error.message
                : String(delegated.error),
          },
        );
      }
      if (side === "agent") {
        fail(503, "Telegram plugin search service is not available.");
      }
      if (!status.grant?.tokenRef) {
        fail(409, "Telegram connector is not connected.");
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
