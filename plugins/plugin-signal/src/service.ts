/**
 * Signal native service — Presage-based Signal client for elizaOS.
 *
 * Mirrors the WhatsApp Baileys service pattern:
 * - Lazy-imports `@elizaos/signal-native` at runtime
 * - Uses QR-based device linking (secondary device)
 * - Receives messages via streaming callback
 * - Sends via registered send handler
 * - Auto-reconnects with exponential backoff
 */

import os from "node:os";
import path from "node:path";
import {
  type Content,
  createUniqueUuid,
  type IAgentRuntime,
  type Memory,
  Service,
  type UUID,
} from "@elizaos/core";

// Lazy-loaded native bindings type
type SignalNative = typeof import("@elizaos/signal-native");
const SIGNAL_NATIVE_MODULE_ID = "@elizaos/signal-native";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveAuthDir(runtime: IAgentRuntime): string {
  const customDir = runtime.getSetting("SIGNAL_AUTH_DIR");
  if (customDir && typeof customDir === "string" && customDir.trim()) {
    return customDir.trim();
  }
  const workspaceDir =
    process.env.ELIZA_WORKSPACE_DIR ??
    path.join(os.homedir(), ".eliza", "workspace");
  return path.join(workspaceDir, "signal-auth", "default");
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class SignalNativeService extends Service {
  static serviceType = "signal" as const;

  capabilityDescription =
    "The agent can send and receive Signal messages via native Presage bindings";

  private native: SignalNative | null = null;
  private authDir: string = "";
  connected = false;
  private reconnectDelay = 3000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // -- ServiceClass static interface ----------------------------------------

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new SignalNativeService(runtime);
    await service.initialize();
    return service;
  }

  static registerSendHandlers(runtime: IAgentRuntime, service: Service): void {
    const svc = service as SignalNativeService;
    runtime.registerSendHandler("signal", svc.handleSendMessage.bind(svc));
    runtime.logger.info("[signal] Registered send handler");
  }

  static async stopRuntime(runtime: IAgentRuntime): Promise<void> {
    const svc = runtime.getService("signal") as SignalNativeService | null;
    if (svc) {
      await svc.stop();
    }
  }

  // -- Lifecycle ------------------------------------------------------------

  async initialize(): Promise<void> {
    const runtime = this.runtime;
    this.authDir = resolveAuthDir(runtime);

    // Check if auth dir has data (device already linked)
    const fs = await import("node:fs");
    if (!fs.existsSync(this.authDir)) {
      runtime.logger.warn(
        `[signal] No auth data at ${this.authDir}. Pair via QR code first.`,
      );
      return;
    }

    // Lazy-import native bindings
    try {
      this.native = await import(/* @vite-ignore */ SIGNAL_NATIVE_MODULE_ID);
    } catch (err) {
      runtime.logger.error(
        `[signal] Failed to load @elizaos/signal-native: ${err}`,
      );
      runtime.logger.info(
        "[signal] Install it with: bun add @elizaos/signal-native",
      );
      return;
    }
    const native = this.native;
    if (!native) {
      runtime.logger.error("[signal] Native Signal module failed to load");
      return;
    }

    // Verify credentials by loading profile
    try {
      const profile = await native.getProfile(this.authDir);
      runtime.logger.info(
        `[signal] Authenticated as ${profile.uuid}${profile.phoneNumber ? ` (${profile.phoneNumber})` : ""}`,
      );
    } catch (err) {
      runtime.logger.warn(
        `[signal] Auth data exists but profile check failed: ${err}`,
      );
      runtime.logger.info(
        "[signal] You may need to re-link the device via QR code.",
      );
      return;
    }

    // Start receiving messages
    this.connected = true;
    await this.startReceiving();
  }

  private async startReceiving(): Promise<void> {
    if (!this.native) return;
    const runtime = this.runtime;

    try {
      await this.native.receiveMessages(this.authDir, (msg) => {
        if (msg.isQueueEmpty) {
          runtime.logger.debug("[signal] Message queue empty (sync complete)");
          return;
        }

        this.handleIncomingMessage(msg).catch((err) => {
          runtime.logger.error(
            `[signal] Error handling incoming message: ${err}`,
          );
        });
      });

      runtime.logger.info("[signal] Receive loop started");
    } catch (err) {
      runtime.logger.error(`[signal] Failed to start receiving: ${err}`);
      this.connected = false;
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60000);

    this.runtime.logger.info(
      `[signal] Scheduling reconnect in ${delay / 1000}s`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.startReceiving().catch((err) => {
        this.runtime.logger.error(`[signal] Reconnect failed: ${err}`);
      });
    }, delay);
  }

  async stop(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.native && this.authDir) {
      try {
        await this.native.stopReceiving(this.authDir);
      } catch {
        // Ignore — may already be stopped
      }
    }

    this.connected = false;
    this.runtime.logger.info("[signal] Service stopped");
  }

  // -- Outbound messages ----------------------------------------------------

  async handleSendMessage(
    runtime: IAgentRuntime,
    target: {
      channelId?: string;
      entityId?: string;
      roomId?: UUID;
      source?: string;
    },
    content: Content,
  ): Promise<void> {
    if (!this.native || !this.connected) {
      throw new Error(
        "Signal is not connected. Link as secondary device via QR code first.",
      );
    }

    // Determine recipient: channelId is the ServiceId/UUID string
    const recipient = target.channelId ?? target.entityId;
    if (!recipient) {
      throw new Error(
        "Signal SendHandler requires channelId or entityId (ServiceId/UUID).",
      );
    }

    const text = content.text ?? "";
    if (!text.trim()) return;

    await this.native.sendMessage(this.authDir, recipient, text);
    runtime.logger.debug(`[signal] Sent message to ${recipient}`);
  }

  // -- Inbound messages -----------------------------------------------------

  private async handleIncomingMessage(
    msg: Awaited<
      Parameters<Parameters<SignalNative["receiveMessages"]>[1]>[0]
    > extends infer M
      ? M
      : never,
  ): Promise<void> {
    const runtime = this.runtime;

    // Skip empty sender (queue-empty signals)
    if (!msg.senderUuid) return;

    const text = msg.text;
    if (!text || !text.trim()) return;

    const senderUuid = msg.senderUuid;

    // Create deterministic IDs (same pattern as WhatsApp)
    const entityId = createUniqueUuid(runtime, `signal-${senderUuid}`) as UUID;
    const roomId = createUniqueUuid(runtime, `signal-dm-${senderUuid}`) as UUID;
    const messageId = createUniqueUuid(
      runtime,
      `signal-msg-${msg.timestamp}`,
    ) as UUID;
    const worldId = createUniqueUuid(runtime, "signal-world") as UUID;

    // Ensure entity and room exist
    await runtime.ensureConnection({
      entityId,
      roomId,
      userName: senderUuid,
      name: senderUuid,
      source: "signal",
      channelId: senderUuid,
      type: "DM",
      worldId,
      worldName: "Signal",
    });

    // Build memory object
    const memory: Memory = {
      id: messageId,
      entityId,
      roomId,
      agentId: runtime.agentId,
      content: {
        text,
        source: "signal",
        channelType: "DM",
      } as Content,
      createdAt: msg.timestamp || Date.now(),
    };

    // Callback to send agent's reply back through Signal
    const callback = async (replyContent: Content): Promise<Memory[]> => {
      if (!this.native || !replyContent.text?.trim()) return [];

      try {
        await this.native.sendMessage(
          this.authDir,
          senderUuid,
          replyContent.text,
        );

        // Persist the reply as a memory
        const replyId = createUniqueUuid(
          runtime,
          `signal-reply-${Date.now()}`,
        ) as UUID;
        const replyMemory: Memory = {
          id: replyId,
          entityId: runtime.agentId,
          roomId,
          agentId: runtime.agentId,
          content: {
            ...replyContent,
            source: "signal",
            channelType: "DM",
          } as Content,
          createdAt: Date.now(),
        };
        await runtime.createMemory(replyMemory, "messages");
        return [replyMemory];
      } catch (err) {
        runtime.logger.error(`[signal] Failed to send reply: ${err}`);
        return [];
      }
    };

    // Route through messaging pipeline (3-tier fallback, same as WhatsApp)
    const messagingAPI = this.getMessagingAPI();
    if (messagingAPI) {
      await messagingAPI.sendMessage(runtime.agentId, memory, {
        onResponse: callback,
      });
      return;
    }

    const messageService = this.getMessageService();
    if (messageService) {
      await messageService.handleMessage(runtime, memory, callback);
      return;
    }

    // Fallback: emit event
    await (
      runtime.emitEvent as (
        event: string[],
        params: Record<string, unknown>,
      ) => Promise<void>
    )(["MESSAGE_RECEIVED"], {
      runtime,
      message: memory,
      callback,
      source: "signal",
    });
  }

  // -- Messaging API detection (same pattern as WhatsApp) -------------------

  private getMessagingAPI(): {
    sendMessage: (
      agentId: UUID,
      message: Memory,
      opts: { onResponse: (content: Content) => Promise<Memory[]> },
    ) => Promise<void>;
  } | null {
    const rt = this.runtime as unknown as Record<string, unknown>;
    if (
      rt.elizaOS &&
      typeof rt.elizaOS === "object" &&
      rt.elizaOS !== null &&
      "sendMessage" in rt.elizaOS &&
      typeof (rt.elizaOS as Record<string, unknown>).sendMessage === "function"
    ) {
      return rt.elizaOS as ReturnType<typeof this.getMessagingAPI> & object;
    }
    return null;
  }

  private getMessageService(): {
    handleMessage: (
      runtime: IAgentRuntime,
      message: Memory,
      callback: (content: Content) => Promise<Memory[]>,
    ) => Promise<unknown>;
  } | null {
    const rt = this.runtime as unknown as Record<string, unknown>;
    const svc = rt.messageService as Record<string, unknown> | null | undefined;
    if (svc && typeof svc.handleMessage === "function") {
      return svc as ReturnType<typeof this.getMessageService> & object;
    }
    return null;
  }
}
