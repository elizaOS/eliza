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
  type LifeOpsConnectorGrant,
  type LifeOpsConnectorSide,
  type LifeOpsTelegramCapability,
  type LifeOpsTelegramConnectorStatus,
  type StartLifeOpsTelegramAuthRequest,
  type StartLifeOpsTelegramAuthResponse,
  type SubmitLifeOpsTelegramAuthRequest,
  type VerifyLifeOpsTelegramConnectorRequest,
  type VerifyLifeOpsTelegramConnectorResponse,
} from "@elizaos/shared";
import {
  searchTelegramMessagesWithRuntimeService,
  sendTelegramMessageWithRuntimeService,
} from "./runtime-service-delegates.js";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";
import { fail, requireNonEmptyString } from "./service-normalize.js";
import { normalizeOptionalConnectorSide } from "./service-normalize-connector.js";

type TelegramMessageSearchResult = {
  id: string | null;
  dialogId: string | null;
  threadId: string | null;
  dialogTitle: string | null;
  username: string | null;
  peerId: string | null;
  senderId: string | null;
  content: string;
  timestamp: string | null;
  outgoing: boolean;
};

type TelegramReadReceiptResult = {
  messageId: string;
  status: "delivered_read" | "sent" | "unknown";
  isRead: boolean | null;
  timestamp: string | null;
  content: string | null;
  outgoing: boolean | null;
};

const FULL_TELEGRAM_CAPABILITIES: LifeOpsTelegramCapability[] = [
  ...LIFEOPS_TELEGRAM_CAPABILITIES,
];

const TELEGRAM_PLUGIN_SETUP_MESSAGE =
  "Telegram is managed by @elizaos/plugin-telegram. Configure and enable the Telegram connector plugin; LifeOps no longer uses local Telegram API credentials.";

const TELEGRAM_ACCOUNT_AUTH_MIGRATED_MESSAGE =
  "Telegram account auth has moved to @elizaos/plugin-telegram. Use the Telegram connector setup routes (/api/telegram-account/auth/start and /api/telegram-account/auth/submit); LifeOps no longer stores Telegram API credentials.";

type TelegramPluginServiceLike = {
  messageManager?: unknown;
  connected?: boolean;
  isServiceConnected?: () => boolean;
  handleSendMessage?: unknown;
  searchConnectorMessages?: unknown;
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
  return Boolean(
    service?.messageManager ||
      service?.connected === true ||
      service?.isServiceConnected?.() === true ||
      telegramPluginCanRead(service) ||
      telegramPluginCanSend(service),
  );
}

function telegramPluginCanRead(service: TelegramPluginServiceLike | null): boolean {
  return typeof service?.searchConnectorMessages === "function";
}

function telegramPluginCanSend(service: TelegramPluginServiceLike | null): boolean {
  return typeof service?.handleSendMessage === "function";
}

function telegramReadyCapabilities(args: {
  readReady: boolean;
  sendReady: boolean;
}): LifeOpsTelegramCapability[] {
  return FULL_TELEGRAM_CAPABILITIES.filter((capability) =>
    capability === "telegram.read" ? args.readReady : args.sendReady,
  );
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

function stripLegacyTokenRef(
  grant: LifeOpsConnectorGrant | null,
): LifeOpsConnectorGrant | null {
  if (!grant) {
    return null;
  }
  if (!grant.tokenRef) {
    return grant;
  }
  return {
    ...grant,
    tokenRef: null,
    metadata: {
      ...grant.metadata,
      legacyTokenRefIgnored: true,
    },
  };
}

function telegramStatusDegradations(args: {
  connected: boolean;
  readReady: boolean;
  sendReady: boolean;
  hasLegacyTokenRef: boolean;
}): LifeOpsConnectorDegradation[] {
  const degradations: LifeOpsConnectorDegradation[] = [];
  if (!args.connected) {
    degradations.push({
      axis: "transport-offline",
      code: "telegram_plugin_unavailable",
      message: TELEGRAM_PLUGIN_SETUP_MESSAGE,
      retryable: true,
    });
  }
  if (args.connected && !args.readReady) {
    degradations.push({
      axis: "transport-offline",
      code: "telegram_plugin_read_unavailable",
      message:
        "Telegram is connected, but @elizaos/plugin-telegram does not expose a message search/read path.",
      retryable: true,
    });
  }
  if (args.connected && !args.sendReady) {
    degradations.push({
      axis: "delivery-degraded",
      code: "telegram_plugin_send_unavailable",
      message:
        "Telegram is connected, but @elizaos/plugin-telegram does not expose a send path.",
      retryable: true,
    });
  }
  if (args.hasLegacyTokenRef) {
    degradations.push({
      axis: "auth-expired",
      code: "legacy_lifeops_credentials_ignored",
      message:
        "Legacy LifeOps Telegram credentials are present but ignored. Migrate this account to @elizaos/plugin-telegram before sending or reading Telegram messages.",
      retryable: false,
    });
  }
  return degradations;
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
      const pluginService = getTelegramPluginService(this.runtime);
      const connected = telegramPluginConnected(pluginService);
      const readReady = telegramPluginCanRead(pluginService);
      const sendReady = telegramPluginCanSend(pluginService);
      const legacyGrant = await this.repository
        .getConnectorGrant(this.agentId(), "telegram", "local", side)
        .catch((error) => {
          this.logLifeOpsWarn(
            "telegram_legacy_grant_status_failed",
            error instanceof Error ? error.message : String(error),
            { provider: "telegram", side },
          );
          return null;
        });
      const grant = stripLegacyTokenRef(legacyGrant);
      const legacyMetadata =
        legacyGrant?.metadata && typeof legacyGrant.metadata === "object"
          ? legacyGrant.metadata
          : {};
      const degradations = telegramStatusDegradations({
        connected,
        readReady,
        sendReady,
        hasLegacyTokenRef: Boolean(legacyGrant?.tokenRef),
      });
      const grantedCapabilities = connected
        ? telegramReadyCapabilities({ readReady, sendReady })
        : [];

      return {
        provider: "telegram",
        side,
        connected,
        reason: connected
          ? "connected"
          : legacyGrant?.tokenRef
            ? "auth_expired"
            : "disconnected",
        identity: connected
          ? (telegramPluginIdentity(pluginService) ??
            (legacyGrant?.identity as LifeOpsTelegramConnectorStatus["identity"]) ??
            null)
          : legacyGrant?.identity &&
              Object.keys(legacyGrant.identity).length > 0
            ? (legacyGrant.identity as LifeOpsTelegramConnectorStatus["identity"])
            : null,
        grantedCapabilities,
        authState: connected
          ? "connected"
          : legacyGrant?.tokenRef
            ? "error"
            : "idle",
        authError: connected ? null : TELEGRAM_PLUGIN_SETUP_MESSAGE,
        phone:
          typeof legacyMetadata.phone === "string"
            ? legacyMetadata.phone
            : null,
        managedCredentialsAvailable: false,
        storedCredentialsAvailable: Boolean(legacyGrant?.tokenRef),
        grant,
        ...(degradations.length > 0 ? { degradations } : {}),
      };
    }

    async startTelegramAuth(
      _request: StartLifeOpsTelegramAuthRequest,
    ): Promise<StartLifeOpsTelegramAuthResponse> {
      fail(410, TELEGRAM_ACCOUNT_AUTH_MIGRATED_MESSAGE);
    }

    async submitTelegramAuth(
      _request: SubmitLifeOpsTelegramAuthRequest,
    ): Promise<StartLifeOpsTelegramAuthResponse> {
      fail(410, TELEGRAM_ACCOUNT_AUTH_MIGRATED_MESSAGE);
    }

    async disconnectTelegram(
      requestedSide?: LifeOpsConnectorSide,
    ): Promise<LifeOpsTelegramConnectorStatus> {
      const side =
        normalizeOptionalConnectorSide(requestedSide, "side") ?? "owner";
      const legacyGrant = await this.repository.getConnectorGrant(
        this.agentId(),
        "telegram",
        "local",
        side,
      );
      if (legacyGrant) {
        await this.repository.deleteConnectorGrant(
          this.agentId(),
          "telegram",
          "local",
          side,
        );
        await this.recordConnectorAudit(
          `telegram:${side}`,
          "legacy telegram connector grant disconnected",
          { side },
          {
            disconnected: true,
            tokenRefIgnored: Boolean(legacyGrant.tokenRef),
          },
        );
      }

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
        managedCredentialsAvailable: false,
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
      const target = requireNonEmptyString(request.target, "target");
      const message = requireNonEmptyString(request.message, "message");
      const status = await this.getTelegramConnectorStatus(side);
      if (!status.connected) {
        fail(409, TELEGRAM_PLUGIN_SETUP_MESSAGE);
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
          "runtime_service_delegation_failed",
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
      fail(
        503,
        `Telegram runtime service send is unavailable: ${delegated.reason} ${TELEGRAM_PLUGIN_SETUP_MESSAGE}`,
      );
    }

    async verifyTelegramConnector(
      request: VerifyLifeOpsTelegramConnectorRequest,
    ): Promise<VerifyLifeOpsTelegramConnectorResponse> {
      const side =
        normalizeOptionalConnectorSide(request.side, "side") ?? "owner";
      const status = await this.getTelegramConnectorStatus(side);
      if (!status.connected) {
        fail(409, TELEGRAM_PLUGIN_SETUP_MESSAGE);
      }

      let read = {
        ok: false,
        error: "Telegram plugin is missing read permission.",
        dialogCount: 0,
        dialogs: [],
      };
      if (status.grantedCapabilities.includes("telegram.read")) {
        try {
          const messages = await this.searchTelegramMessages({
            side,
            query: "",
            limit: request.recentLimit ?? 10,
          });
          read = {
            ok: true,
            error: null,
            dialogCount: messages.length,
            dialogs: [],
          };
        } catch (error) {
          read = {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            dialogCount: 0,
            dialogs: [],
          };
        }
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
        read,
        send,
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
        fail(409, TELEGRAM_PLUGIN_SETUP_MESSAGE);
      }
      if (!status.grantedCapabilities.includes("telegram.read")) {
        fail(403, "Telegram plugin is missing read permission.");
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
          "runtime_service_delegation_failed",
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
      fail(
        503,
        `Telegram runtime service search is unavailable: ${delegated.reason} ${TELEGRAM_PLUGIN_SETUP_MESSAGE}`,
      );
    }

    async getTelegramDeliveryStatus(_request: {
      side?: LifeOpsConnectorSide;
      target: string;
      messageIds: string[];
    }): Promise<TelegramReadReceiptResult[]> {
      fail(
        501,
        "Telegram delivery receipts require a @elizaos/plugin-telegram runtime read-receipt service. LifeOps no longer calls its local GramJS client.",
      );
    }
  }

  return LifeOpsTelegramServiceMixin;
}
