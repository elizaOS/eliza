// @ts-nocheck — Mixin pattern: each `withFoo()` returns a class that calls
// methods belonging to sibling mixins (e.g. `this.recordScreenTimeEvent`).
// Type checking each mixin in isolation surfaces phantom errors because the
// local TBase constraint can't see sibling mixin methods.
import { basename } from "node:path";
import type { Plugin } from "@elizaos/core";
import { logger } from "@elizaos/core";
import type { LifeOpsIMessageConnectorStatus } from "@elizaos/shared";
import {
  readIMessagesWithRuntimeService,
  sendIMessageWithRuntimeService,
} from "./runtime-service-delegates.js";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";
import { fail } from "./service-normalize.js";

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
    options?: { mediaUrl?: string; maxBytes?: number; accountId?: string },
  ): Promise<{
    success: boolean;
    messageId?: string;
    chatId?: string;
    error?: string;
  }>;
  getMessages?(options?: {
    chatId?: string;
    limit?: number;
    accountId?: string;
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

export interface IMessageSendRequest {
  to: string;
  text: string;
  attachmentPaths?: string[];
}

export interface IMessageRecord {
  id: string;
  fromHandle: string;
  toHandles: string[];
  text: string;
  isFromMe: boolean;
  sentAt: string;
  chatId?: string;
  attachments?: Array<{ name: string; mimeType?: string; path?: string }>;
}

export interface IMessageChat {
  id: string;
  name: string;
  participants: string[];
  lastMessageAt?: string;
}

export interface IMessageDeliveryResult {
  messageId: string;
  status: "delivered_read" | "delivered" | "sent" | "unknown";
  isRead: boolean | null;
  isDelivered: boolean | null;
  checkedAt: string;
}

const NATIVE_IMESSAGE_SERVICE_LOAD_TIMEOUT_MS = 8_000;
const NATIVE_IMESSAGE_SEND_TIMEOUT_MS = 20_000;
const NATIVE_IMESSAGE_SEND_TIMEOUT_MESSAGE = "native iMessage send timed out";
const IMESSAGE_PLUGIN_PACKAGE = "@elizaos/plugin-imessage";
const IMESSAGE_PLUGIN_SETUP_MESSAGE =
  "iMessage is managed by @elizaos/plugin-imessage. Enable the iMessage connector plugin on a Mac host running Messages.app.";

function normalizeHostPlatform(): LifeOpsIMessageConnectorStatus["hostPlatform"] {
  return process.platform === "darwin" ||
    process.platform === "linux" ||
    process.platform === "win32"
    ? process.platform
    : "unknown";
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

function unavailableIMessageStatus(
  checkedAt: string,
  reason = "imessage_plugin_unavailable",
): LifeOpsIMessageConnectorStatus {
  return {
    available: false,
    connected: false,
    bridgeType: "none",
    hostPlatform: normalizeHostPlatform(),
    accountHandle: null,
    sendMode: "none",
    helperConnected: null,
    privateApiEnabled: null,
    diagnostics: [reason],
    lastSyncAt: null,
    lastCheckedAt: checkedAt,
    error: IMESSAGE_PLUGIN_SETUP_MESSAGE,
  };
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
    available: status?.available ?? true,
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

function unknownDeliveryStatus(messageIds: string[]): IMessageDeliveryResult[] {
  const checkedAt = new Date().toISOString();
  return messageIds.map((messageId) => ({
    messageId,
    status: "unknown",
    isRead: null,
    isDelivered: null,
    checkedAt,
  }));
}

/** @internal */
export function withIMessage<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
) {
  class LifeOpsIMessageServiceMixin extends Base {
    async getIMessageConnectorStatus(): Promise<LifeOpsIMessageConnectorStatus> {
      const checkedAt = new Date().toISOString();
      const nativeService = await getNativeIMessageService(this.runtime);
      return nativeService
        ? nativeStatusToLifeOps(nativeService, checkedAt)
        : unavailableIMessageStatus(checkedAt);
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
          "runtime_service_delegation_failed",
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
      if (!nativeService) {
        fail(503, IMESSAGE_PLUGIN_SETUP_MESSAGE);
      }
      const result = await withNativeIMessageSendTimeout(
        nativeService.sendMessage(req.to, req.text, {
          ...(req.attachmentPaths?.[0]
            ? { mediaUrl: req.attachmentPaths[0] }
            : {}),
        }),
      );
      if (!result.success) {
        fail(502, result.error ?? "iMessage runtime service send failed.");
      }
      return { ok: true, messageId: result.messageId };
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
          "runtime_service_delegation_failed",
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
      if (!nativeService || !nativeServiceCanRead(nativeService)) {
        fail(503, IMESSAGE_PLUGIN_SETUP_MESSAGE);
      }
      const rows = nativeService.getMessages
        ? await nativeService.getMessages({
            chatId: opts.chatId,
            limit: opts.limit,
          })
        : await nativeService.getRecentMessages?.(opts.limit);
      return filterSince((rows ?? []).map(nativeMessageToLifeOps), opts.since);
    }

    async listIMessageChats(): Promise<IMessageChat[]> {
      const nativeService = await getNativeIMessageService(this.runtime);
      if (nativeService?.getChats && nativeServiceCanRead(nativeService)) {
        return (await nativeService.getChats()).map(nativeChatToLifeOps);
      }
      fail(503, IMESSAGE_PLUGIN_SETUP_MESSAGE);
    }

    async searchIMessages(opts: {
      query: string;
      chatId?: string;
      limit?: number;
    }): Promise<IMessageRecord[]> {
      const nativeService = await getNativeIMessageService(this.runtime);
      if (!nativeService || !nativeServiceCanRead(nativeService)) {
        fail(503, IMESSAGE_PLUGIN_SETUP_MESSAGE);
      }
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

    async getIMessageDeliveryStatus(
      messageIds: string[],
    ): Promise<IMessageDeliveryResult[]> {
      return unknownDeliveryStatus(messageIds);
    }
  }

  return LifeOpsIMessageServiceMixin;
}
