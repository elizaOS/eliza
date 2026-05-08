// @ts-nocheck — Mixin pattern: each `withFoo()` returns a class that calls
// methods belonging to sibling mixins (e.g. `this.recordScreenTimeEvent`).
// Type checking each mixin in isolation surfaces 700+ phantom errors because
// the local TBase constraint can't see sibling mixin methods. Real type
// safety is enforced at the composed-service level (LifeOpsService class).
// Refactoring requires either declaration-merging every cross-mixin method
// or moving to a single composed interface — tracked as separate work.
import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import { loadElizaConfig } from "@elizaos/agent/config/config";
import type { Plugin } from "@elizaos/core";
import { logger } from "@elizaos/core";
import type { LifeOpsIMessageConnectorStatus } from "@elizaos/shared";
import {
  getIMessageBackendStatus,
  getIMessageDeliveryStatus,
  type IMessageBackend,
  type IMessageBridgeConfig,
  type IMessageChat,
  type IMessageDeliveryResult,
  type IMessageRecord,
  type IMessageSendRequest,
  listIMessageChats as listIMessageChatsBridge,
  readIMessages as readIMessagesBridge,
  searchIMessages as searchIMessagesBridge,
  sendIMessage as sendIMessageBridge,
} from "./imessage-bridge.js";
import {
  readIMessagesWithRuntimeService,
  sendIMessageWithRuntimeService,
} from "./runtime-service-delegates.js";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";
import { fail } from "./service-normalize.js";

type JsonRecord = Record<string, unknown>;

type NativeIMessageStatus = {
  available: boolean;
  connected: boolean;
  chatDbAvailable: boolean;
  sendOnly: boolean;
  chatDbPath: string;
  reason: string | null;
  permissionAction: {
    type: "full_disk_access";
    label: string;
    url: string;
    instructions: string[];
  } | null;
};

type NativeIMessageMessage = {
  id: string;
  text: string;
  handle: string;
  chatId: string;
  timestamp: number;
  isFromMe: boolean;
  hasAttachments: boolean;
  attachmentPaths?: string[];
};

type NativeIMessageChat = {
  chatId: string;
  chatType: "direct" | "group";
  displayName?: string;
  participants: Array<{ handle: string; isPhoneNumber: boolean }>;
};

type NativeIMessageServiceLike = {
  isConnected(): boolean;
  getStatus?(): NativeIMessageStatus;
  sendMessage(
    to: string,
    text: string,
    options?: { mediaUrl?: string; maxBytes?: number },
  ): Promise<{
    success: boolean;
    messageId?: string;
    chatId?: string;
    error?: string;
  }>;
  getMessages?(options?: {
    chatId?: string;
    limit?: number;
  }): Promise<NativeIMessageMessage[]>;
  getRecentMessages?(limit?: number): Promise<NativeIMessageMessage[]>;
  getChats?(): Promise<NativeIMessageChat[]>;
};

type RuntimeWithPluginLifecycle = {
  getPluginOwnership?: (pluginName: string) => { plugin: Plugin } | null;
  registerPlugin?: (plugin: Plugin) => Promise<void>;
  reloadPlugin?: (plugin: Plugin) => Promise<void>;
  getServiceLoadPromise?: (serviceType: string) => Promise<unknown>;
};

const NATIVE_IMESSAGE_SERVICE_LOAD_TIMEOUT_MS = 8_000;
const NATIVE_IMESSAGE_SEND_TIMEOUT_MS = 20_000;
const NATIVE_IMESSAGE_SEND_TIMEOUT_MESSAGE = "native iMessage send timed out";
const IMESSAGE_URL_HANDOFF_TIMEOUT_MS = 12_000;
const IMESSAGE_URL_HANDOFF_SETTLE_MS = 700;
const IMESSAGE_URL_HANDOFF_CONFIRM_TIMEOUT_MS = 12_000;
const IMESSAGE_PLUGIN_PACKAGE = "@elizaos/plugin-imessage";
const execFileAsync = promisify(execFile);

function coerceString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function coerceRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as JsonRecord;
}

function coerceBackend(value: unknown): IMessageBackend | undefined {
  const raw = coerceString(value)?.toLowerCase();
  return raw === "imsg" || raw === "bluebubbles" || raw === "none"
    ? raw
    : undefined;
}

function explicitBackendDisablesNative(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const preferred =
    coerceBackend(env.ELIZA_IMESSAGE_BACKEND) ??
    coerceBackend(env.IMESSAGE_BACKEND);
  return preferred === "bluebubbles" || preferred === "none";
}

function normalizeHostPlatform(): LifeOpsIMessageConnectorStatus["hostPlatform"] {
  return process.platform === "darwin" ||
    process.platform === "linux" ||
    process.platform === "win32"
    ? process.platform
    : "unknown";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messagesUrlFor(to: string, text: string): string {
  return `sms:${to}?body=${encodeURIComponent(text)}`;
}

async function pressMessagesReturn(): Promise<void> {
  await execFileAsync(
    "/usr/bin/osascript",
    [
      "-e",
      'tell application "Messages" to activate',
      "-e",
      "delay 0.2",
      "-e",
      'tell application "System Events"',
      "-e",
      "keystroke return",
      "-e",
      "end tell",
    ],
    { timeout: IMESSAGE_URL_HANDOFF_TIMEOUT_MS },
  );
}

async function waitForNativeIMessageService(
  runtime: Constructor<LifeOpsServiceBase>["prototype"]["runtime"],
): Promise<boolean> {
  const runtimeWithLifecycle = runtime as typeof runtime &
    RuntimeWithPluginLifecycle;
  if (typeof runtimeWithLifecycle.getServiceLoadPromise !== "function") {
    return Boolean(runtime.getService("imessage"));
  }

  await Promise.race([
    runtimeWithLifecycle.getServiceLoadPromise("imessage"),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("native iMessage service load timed out")),
        NATIVE_IMESSAGE_SERVICE_LOAD_TIMEOUT_MS,
      ),
    ),
  ]);

  return Boolean(runtime.getService("imessage"));
}

async function withNativeIMessageSendTimeout<T>(
  promise: Promise<T>,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(NATIVE_IMESSAGE_SEND_TIMEOUT_MESSAGE)),
      NATIVE_IMESSAGE_SEND_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function ensureNativeIMessagePluginLoaded(
  runtime: Constructor<LifeOpsServiceBase>["prototype"]["runtime"],
): Promise<boolean> {
  if (process.platform !== "darwin") {
    return false;
  }

  if (runtime.getService("imessage")) {
    return true;
  }

  const runtimeWithLifecycle = runtime as typeof runtime &
    RuntimeWithPluginLifecycle;
  if (
    typeof runtimeWithLifecycle.registerPlugin !== "function" &&
    typeof runtimeWithLifecycle.reloadPlugin !== "function"
  ) {
    return false;
  }

  const mod = (await import(/* @vite-ignore */ IMESSAGE_PLUGIN_PACKAGE)) as {
    default?: Plugin;
    plugin?: Plugin;
  };
  const plugin = (mod.default ?? mod.plugin) as Plugin | undefined;
  if (!plugin) {
    return false;
  }

  const existingOwnership =
    typeof runtimeWithLifecycle.getPluginOwnership === "function"
      ? runtimeWithLifecycle.getPluginOwnership("imessage")
      : null;
  if (
    existingOwnership &&
    typeof runtimeWithLifecycle.reloadPlugin === "function"
  ) {
    await runtimeWithLifecycle.reloadPlugin(plugin);
    return waitForNativeIMessageService(runtime);
  }

  if (typeof runtimeWithLifecycle.registerPlugin === "function") {
    await runtimeWithLifecycle.registerPlugin(plugin);
    return waitForNativeIMessageService(runtime);
  }

  return false;
}

async function getNativeIMessageService(
  runtime: Constructor<LifeOpsServiceBase>["prototype"]["runtime"],
): Promise<NativeIMessageServiceLike | null> {
  if (explicitBackendDisablesNative()) {
    return null;
  }

  let service = runtime.getService(
    "imessage",
  ) as NativeIMessageServiceLike | null;
  if (service) {
    return service;
  }

  try {
    await ensureNativeIMessagePluginLoaded(runtime);
  } catch (error) {
    logger.warn(
      `[lifeops-imessage] failed to load native iMessage plugin: ${String(
        error,
      )}`,
    );
  }

  service = runtime.getService("imessage") as NativeIMessageServiceLike | null;
  return service ?? null;
}

function nativeStatusToLifeOps(
  service: NativeIMessageServiceLike,
  checkedAt: string,
): LifeOpsIMessageConnectorStatus {
  const status = service.getStatus?.();
  const diagnostics: string[] = [];
  const connected = status?.connected ?? service.isConnected();

  if (status && !status.chatDbAvailable) {
    diagnostics.push(
      status.permissionAction?.type === "full_disk_access"
        ? "full_disk_access_required"
        : "chat_db_unavailable",
    );
  }
  if (!connected) {
    diagnostics.push("native_bridge_not_connected");
  }

  return {
    available: true,
    connected,
    bridgeType: "native",
    hostPlatform: normalizeHostPlatform(),
    accountHandle: null,
    sendMode: connected ? "apple-script" : "none",
    helperConnected: null,
    privateApiEnabled: null,
    diagnostics,
    lastSyncAt: null,
    lastCheckedAt: checkedAt,
    error: status?.reason ?? null,
    chatDbAvailable: status?.chatDbAvailable ?? false,
    sendOnly: status?.sendOnly ?? !status?.chatDbAvailable,
    chatDbPath: status?.chatDbPath,
    reason: status?.reason ?? null,
    permissionAction: status?.permissionAction ?? null,
  };
}

function bridgeStatusToLifeOps(
  status: Awaited<ReturnType<typeof getIMessageBackendStatus>>,
  checkedAt: string,
): LifeOpsIMessageConnectorStatus {
  return {
    available: status.backend !== "none",
    connected: status.backend !== "none",
    bridgeType: status.backend,
    hostPlatform: normalizeHostPlatform(),
    accountHandle: status.accountHandle,
    sendMode: status.sendMode,
    helperConnected: status.helperConnected,
    privateApiEnabled: status.privateApiEnabled,
    diagnostics: status.diagnostics,
    lastSyncAt: null,
    lastCheckedAt: checkedAt,
    error: status.backend === "none" ? "no_backend_available" : null,
  };
}

function nativeServiceCanRead(service: NativeIMessageServiceLike): boolean {
  const status = service.getStatus?.();
  if (status && !status.chatDbAvailable) {
    return false;
  }
  return (
    typeof service.getMessages === "function" ||
    typeof service.getRecentMessages === "function"
  );
}

async function getConfiguredBridgeStatusOrNull(): Promise<Awaited<
  ReturnType<typeof getIMessageBackendStatus>
> | null> {
  try {
    const status = await getIMessageBackendStatus(
      resolveLifeOpsIMessageBridgeConfig(),
    );
    return status.backend === "none" ? null : status;
  } catch (error) {
    logger.warn(
      `[lifeops-imessage] configured iMessage bridge probe failed: ${String(
        error,
      )}`,
    );
    return null;
  }
}

function nativeMessageToLifeOps(
  message: NativeIMessageMessage,
): IMessageRecord {
  const attachmentPaths = message.attachmentPaths ?? [];
  return {
    id: message.id,
    fromHandle: message.isFromMe ? "me" : message.handle,
    toHandles: message.isFromMe && message.handle ? [message.handle] : [],
    text: message.text,
    isFromMe: message.isFromMe,
    sentAt: new Date(message.timestamp || Date.now()).toISOString(),
    chatId: message.chatId,
    attachments:
      attachmentPaths.length > 0
        ? attachmentPaths.map((path) => ({
            name: basename(path),
            path,
          }))
        : undefined,
  };
}

function nativeChatToLifeOps(chat: NativeIMessageChat): IMessageChat {
  const participants = chat.participants.map(
    (participant) => participant.handle,
  );
  return {
    id: chat.chatId,
    name: chat.displayName ?? (participants.join(", ") || chat.chatId),
    participants,
  };
}

function filterSince(
  messages: IMessageRecord[],
  since: string | undefined,
): IMessageRecord[] {
  if (!since) {
    return messages;
  }
  const sinceMs = Date.parse(since);
  if (!Number.isFinite(sinceMs)) {
    return messages;
  }
  return messages.filter((message) => Date.parse(message.sentAt) >= sinceMs);
}

function readConfiguredConnectors(): {
  bluebubbles: JsonRecord | null;
  imessage: JsonRecord | null;
} {
  try {
    const config = coerceRecord(loadElizaConfig());
    const connectors = coerceRecord(config?.connectors ?? config?.channels);
    return {
      bluebubbles: coerceRecord(connectors?.bluebubbles),
      imessage: coerceRecord(connectors?.imessage),
    };
  } catch {
    return {
      bluebubbles: null,
      imessage: null,
    };
  }
}

export function resolveLifeOpsIMessageBridgeConfig(
  env: NodeJS.ProcessEnv = process.env,
): IMessageBridgeConfig {
  const { bluebubbles, imessage } = readConfiguredConnectors();
  const preferredBackend =
    coerceBackend(env.ELIZA_IMESSAGE_BACKEND) ??
    coerceBackend(env.IMESSAGE_BACKEND);
  const bluebubblesUrl =
    coerceString(env.ELIZA_BLUEBUBBLES_URL) ??
    coerceString(env.BLUEBUBBLES_SERVER_URL) ??
    coerceString(bluebubbles?.serverUrl);
  const bluebubblesPassword =
    coerceString(env.ELIZA_BLUEBUBBLES_PASSWORD) ??
    coerceString(env.BLUEBUBBLES_PASSWORD) ??
    coerceString(bluebubbles?.password);
  const imsgPath =
    coerceString(env.ELIZA_IMESSAGE_CLI_PATH) ??
    coerceString(env.IMESSAGE_CLI_PATH) ??
    coerceString(imessage?.cliPath);
  const fallbackPreferredBackend =
    bluebubbles?.enabled !== false && bluebubblesUrl && bluebubblesPassword
      ? "bluebubbles"
      : imessage?.enabled !== false && imsgPath
        ? "imsg"
        : undefined;
  return {
    preferredBackend: preferredBackend ?? fallbackPreferredBackend,
    bluebubblesUrl,
    bluebubblesPassword,
    imsgPath:
      imessage?.enabled === false &&
      preferredBackend !== "imsg" &&
      fallbackPreferredBackend !== "imsg"
        ? undefined
        : imsgPath,
  };
}

/** @internal */
export function withIMessage<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
) {
  class LifeOpsIMessageServiceMixin extends Base {
    async getIMessageConnectorStatus(): Promise<LifeOpsIMessageConnectorStatus> {
      const checkedAt = new Date().toISOString();
      const nativeService = await getNativeIMessageService(this.runtime);
      if (nativeService) {
        if (nativeServiceCanRead(nativeService)) {
          return nativeStatusToLifeOps(nativeService, checkedAt);
        }
        const bridgeStatus = await getConfiguredBridgeStatusOrNull();
        return bridgeStatus
          ? bridgeStatusToLifeOps(bridgeStatus, checkedAt)
          : nativeStatusToLifeOps(nativeService, checkedAt);
      }

      const config = resolveLifeOpsIMessageBridgeConfig();
      const status = await getIMessageBackendStatus(config);
      return bridgeStatusToLifeOps(status, checkedAt);
    }

    async sendIMessage(
      req: IMessageSendRequest,
    ): Promise<{ ok: true; messageId?: string }> {
      const delegated = await sendIMessageWithRuntimeService({
        runtime: this.runtime,
        to: req.to,
        text: req.text,
        mediaUrl: req.attachmentPaths?.[0],
      });
      if (delegated.status === "handled") {
        return { ok: true, messageId: delegated.value.messageId };
      }
      if (delegated.error) {
        this.logLifeOpsWarn(
          "runtime_service_delegation_fallback",
          delegated.reason,
          {
            provider: "imessage",
            operation: "message.send",
            error:
              delegated.error instanceof Error
                ? delegated.error.message
                : String(delegated.error),
          },
        );
      }

      const nativeService = await getNativeIMessageService(this.runtime);
      if (nativeService) {
        let result;
        try {
          result = await withNativeIMessageSendTimeout(
            nativeService.sendMessage(req.to, req.text, {
              ...(req.attachmentPaths?.[0]
                ? { mediaUrl: req.attachmentPaths[0] }
                : {}),
            }),
          );
        } catch (error) {
          return this.sendIMessageViaMessagesUrl(req, error);
        }
        if (!result.success) {
          return this.sendIMessageViaMessagesUrl(
            req,
            new Error(result.error ?? "native iMessage send failed"),
          );
        }
        return { ok: true, messageId: result.messageId };
      }

      return sendIMessageBridge(req, resolveLifeOpsIMessageBridgeConfig());
    }

    async sendIMessageViaMessagesUrl(
      req: IMessageSendRequest,
      cause: unknown,
    ): Promise<{ ok: true; messageId?: string }> {
      if (req.attachmentPaths?.length) {
        throw cause instanceof Error ? cause : new Error(String(cause));
      }
      if (!req.text.trim()) {
        fail(400, "text is required");
      }

      try {
        await execFileAsync(
          "/usr/bin/open",
          [messagesUrlFor(req.to, req.text)],
          {
            timeout: IMESSAGE_URL_HANDOFF_TIMEOUT_MS,
          },
        );
        await sleep(IMESSAGE_URL_HANDOFF_SETTLE_MS);
        await pressMessagesReturn();

        const deadline = Date.now() + IMESSAGE_URL_HANDOFF_CONFIRM_TIMEOUT_MS;
        while (Date.now() < deadline) {
          const messages = await this.readIMessages({ limit: 25 });
          const sent = [...messages]
            .reverse()
            .find((message) => message.isFromMe && message.text === req.text);
          if (sent) {
            return { ok: true, messageId: sent.id };
          }
          await sleep(500);
        }

        fail(504, "iMessage URL handoff sent no confirmable chat.db message.");
      } catch (error) {
        const causeMessage =
          cause instanceof Error ? cause.message : String(cause);
        const fallbackMessage =
          error instanceof Error ? error.message : String(error);
        fail(
          502,
          `native iMessage send failed (${causeMessage}); URL handoff failed (${fallbackMessage}).`,
        );
      }
    }

    async readIMessages(opts: {
      chatId?: string;
      since?: string;
      limit?: number;
    }): Promise<IMessageRecord[]> {
      const delegated = await readIMessagesWithRuntimeService({
        runtime: this.runtime,
        chatId: opts.chatId,
        limit: opts.limit,
      });
      if (delegated.status === "handled") {
        return filterSince(
          delegated.value.map((message) =>
            nativeMessageToLifeOps(message as NativeIMessageMessage),
          ),
          opts.since,
        );
      }
      if (delegated.error) {
        this.logLifeOpsWarn(
          "runtime_service_delegation_fallback",
          delegated.reason,
          {
            provider: "imessage",
            operation: "message.read",
            error:
              delegated.error instanceof Error
                ? delegated.error.message
                : String(delegated.error),
          },
        );
      }

      const nativeService = await getNativeIMessageService(this.runtime);
      if (nativeService && nativeServiceCanRead(nativeService)) {
        const rows = nativeService.getMessages
          ? await nativeService.getMessages({
              chatId: opts.chatId,
              limit: opts.limit,
            })
          : await nativeService.getRecentMessages?.(opts.limit);
        return filterSince(
          (rows ?? []).map(nativeMessageToLifeOps),
          opts.since,
        );
      }

      return readIMessagesBridge(opts, resolveLifeOpsIMessageBridgeConfig());
    }

    async listIMessageChats(): Promise<IMessageChat[]> {
      const nativeService = await getNativeIMessageService(this.runtime);
      if (nativeService?.getChats && nativeServiceCanRead(nativeService)) {
        return (await nativeService.getChats()).map(nativeChatToLifeOps);
      }

      return listIMessageChatsBridge(resolveLifeOpsIMessageBridgeConfig());
    }

    async searchIMessages(opts: {
      query: string;
      chatId?: string;
      limit?: number;
    }): Promise<IMessageRecord[]> {
      const nativeService = await getNativeIMessageService(this.runtime);
      if (nativeService && nativeServiceCanRead(nativeService)) {
        const rows = nativeService.getMessages
          ? await nativeService.getMessages({
              chatId: opts.chatId,
              limit: Math.max(opts.limit ?? 100, 100),
            })
          : await nativeService.getRecentMessages?.(
              Math.max(opts.limit ?? 100, 100),
            );
        const query = opts.query.trim().toLowerCase();
        return (rows ?? [])
          .map(nativeMessageToLifeOps)
          .filter((message) => message.text.toLowerCase().includes(query))
          .slice(0, opts.limit ?? 100);
      }

      return searchIMessagesBridge(opts, resolveLifeOpsIMessageBridgeConfig());
    }

    async getIMessageDeliveryStatus(
      messageIds: string[],
    ): Promise<IMessageDeliveryResult[]> {
      const nativeService = await getNativeIMessageService(this.runtime);
      if (nativeService) {
        const bridgeStatus = await getConfiguredBridgeStatusOrNull();
        if (bridgeStatus) {
          return getIMessageDeliveryStatus(
            messageIds,
            resolveLifeOpsIMessageBridgeConfig(),
          );
        }
        return messageIds.map((messageId) => ({
          messageId,
          status: "unknown",
          isRead: null,
          isDelivered: null,
          checkedAt: new Date().toISOString(),
        }));
      }

      return getIMessageDeliveryStatus(
        messageIds,
        resolveLifeOpsIMessageBridgeConfig(),
      );
    }
  }

  return LifeOpsIMessageServiceMixin;
}
