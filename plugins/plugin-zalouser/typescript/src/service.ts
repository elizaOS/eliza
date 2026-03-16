import {
  ChannelType,
  createUniqueUuid,
  type EventPayload,
  type IAgentRuntime,
  logger,
  type Room,
  Service,
  type UUID,
  type World,
} from "@elizaos/core";
import {
  checkZcaAuthenticated,
  checkZcaInstalled,
  getZcaUserInfo,
  listFriends,
  listGroupMembers,
  listGroups,
  parseJsonOutput,
  runZca,
  runZcaStreaming,
  sendImage,
  sendLink,
  sendMessage,
} from "./client";
import {
  DEFAULT_PROFILE,
  MAX_MESSAGE_LENGTH,
  ZALOUSER_SERVICE_NAME,
} from "./constants";
import {
  buildZaloUserSettings,
  validateZaloUserConfig,
  type ZaloUserSettings,
} from "./environment";
import type {
  SendMediaParams,
  SendMessageParams,
  SendMessageResult,
  ZaloChat,
  ZaloFriend,
  ZaloGroup,
  ZaloMessage,
  ZaloUser,
  ZaloUserInfo,
  ZaloUserProbe,
} from "./types";
import { ZaloUserChatType, ZaloUserEventTypes } from "./types";

/**
 * Zalo User Service for elizaOS.
 * Provides personal Zalo account integration via zca-cli.
 */
export class ZaloUserService extends Service {
  static serviceType = ZALOUSER_SERVICE_NAME;
  capabilityDescription =
    "The agent can send and receive messages on Zalo personal account";

  private settings: ZaloUserSettings | null = null;
  private currentUser: ZaloUserInfo | null = null;
  private running = false;
  private listenerAbortController: AbortController | null = null;
  private knownChats: Map<string, ZaloChat> = new Map();

  /**
   * Get current settings.
   */
  getSettings(): ZaloUserSettings | null {
    return this.settings;
  }

  /**
   * Get current authenticated user.
   */
  getCurrentUser(): ZaloUserInfo | null {
    return this.currentUser;
  }

  /**
   * Check if the service is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Probe the Zalo connection for health checks.
   */
  async probeZaloUser(_timeoutMs = 5000): Promise<ZaloUserProbe> {
    const startTime = Date.now();

    try {
      const installed = await checkZcaInstalled();
      if (!installed) {
        return {
          ok: false,
          error: "zca-cli not found in PATH",
          latencyMs: Date.now() - startTime,
        };
      }

      const profile = this.settings?.defaultProfile || DEFAULT_PROFILE;
      const authenticated = await checkZcaAuthenticated(profile);
      if (!authenticated) {
        return {
          ok: false,
          error: "Not authenticated",
          latencyMs: Date.now() - startTime,
        };
      }

      const userInfo = await getZcaUserInfo(profile);
      if (!userInfo) {
        return {
          ok: false,
          error: "Failed to get user info",
          latencyMs: Date.now() - startTime,
        };
      }

      return {
        ok: true,
        user: {
          id: userInfo.userId,
          displayName: userInfo.displayName,
          avatar: userInfo.avatar,
        },
        latencyMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        latencyMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Start the Zalo User service.
   */
  static async start(runtime: IAgentRuntime): Promise<ZaloUserService> {
    const service = new ZaloUserService(runtime);

    // Validate and load configuration
    const config = await validateZaloUserConfig(runtime);
    if (config) {
      service.settings = buildZaloUserSettings(config);
    }

    if (!service.settings?.enabled) {
      logger.warn("Zalo User plugin is disabled");
      return service;
    }

    // Check if zca-cli is installed
    const installed = await checkZcaInstalled();
    if (!installed) {
      logger.error(
        "zca-cli is not installed. Please install it first: npm install -g zca-cli",
      );
      return service;
    }

    const profile = service.settings?.defaultProfile || DEFAULT_PROFILE;

    // Check authentication status
    const authenticated = await checkZcaAuthenticated(profile);
    if (!authenticated) {
      logger.warn(
        `Zalo User not authenticated for profile "${profile}". Run "zca auth login" to authenticate.`,
      );
      return service;
    }

    // Get current user info
    service.currentUser = await getZcaUserInfo(profile);
    if (service.currentUser) {
      logger.info(
        `Zalo User connected: ${service.currentUser.displayName} (${service.currentUser.userId})`,
      );
    }

    // Start message listener
    await service.startMessageListener();

    service.running = true;

    // Emit started event
    runtime.emitEvent(ZaloUserEventTypes.CLIENT_STARTED, {
      runtime,
      source: "zalouser",
      profile,
      user: service.currentUser
        ? {
            id: service.currentUser.userId,
            displayName: service.currentUser.displayName,
            avatar: service.currentUser.avatar,
          }
        : undefined,
      running: true,
      timestamp: Date.now(),
    } as EventPayload);

    logger.success(`Zalo User service started for ${runtime.character.name}`);
    return service;
  }

  /**
   * Stop the Zalo User service.
   */
  static async stop(runtime: IAgentRuntime): Promise<void> {
    const service = runtime.getService(ZALOUSER_SERVICE_NAME) as
      | ZaloUserService
      | undefined;
    if (service) {
      await service.stop();
    }
  }

  /**
   * Stop the service instance.
   */
  async stop(): Promise<void> {
    logger.info("Stopping Zalo User service...");

    // Abort message listener
    if (this.listenerAbortController) {
      this.listenerAbortController.abort();
      this.listenerAbortController = null;
    }

    this.running = false;

    // Emit stopped event
    if (this.runtime) {
      this.runtime.emitEvent(ZaloUserEventTypes.CLIENT_STOPPED, {
        runtime: this.runtime,
        source: "zalouser",
        profile: this.settings?.defaultProfile,
        user: this.currentUser
          ? {
              id: this.currentUser.userId,
              displayName: this.currentUser.displayName,
              avatar: this.currentUser.avatar,
            }
          : undefined,
        running: false,
        timestamp: Date.now(),
      } as EventPayload);
    }

    logger.info("Zalo User service stopped");
  }

  /**
   * Start the message listener.
   */
  private async startMessageListener(): Promise<void> {
    const profile = this.settings?.defaultProfile || DEFAULT_PROFILE;

    this.listenerAbortController = new AbortController();

    const { proc, promise } = runZcaStreaming(["listen", "-j"], {
      profile,
      onData: (data) => {
        this.handleIncomingData(data);
      },
      onError: (err) => {
        logger.error(`Zalo listener error: ${err.message}`);
      },
    });

    // Handle abort
    this.listenerAbortController.signal.addEventListener("abort", () => {
      proc.kill("SIGTERM");
    });

    // Don't await promise to keep listener running in background
    promise.then((result) => {
      if (!result.ok && this.running) {
        logger.warn(
          `Zalo listener exited: ${result.stderr || "Unknown error"}`,
        );
        // Attempt to restart after a delay
        setTimeout(() => {
          if (this.running) {
            this.startMessageListener().catch((e) => {
              logger.error(`Failed to restart Zalo listener: ${e}`);
            });
          }
        }, 5000);
      }
    });
  }

  /**
   * Handle incoming data from the message listener.
   */
  private handleIncomingData(data: string): void {
    const lines = data.split("\n").filter((l) => l.trim());

    for (const line of lines) {
      const message = parseJsonOutput<ZaloMessage>(line);
      if (!message) continue;

      this.handleMessage(message).catch((e) => {
        logger.error(`Error handling Zalo message: ${e}`);
      });
    }
  }

  /**
   * Handle an incoming message.
   */
  private async handleMessage(message: ZaloMessage): Promise<void> {
    const isGroup = message.metadata?.isGroup ?? false;
    const threadId = message.threadId;

    // Check if thread is allowed
    if (this.settings?.allowedThreads.length) {
      if (!this.settings.allowedThreads.includes(threadId)) {
        logger.debug(`Ignoring message from non-allowed thread: ${threadId}`);
        return;
      }
    }

    // Apply DM/group policy
    if (!isGroup && this.settings?.dmPolicy === "disabled") {
      logger.debug(`Ignoring DM due to policy: ${threadId}`);
      return;
    }
    if (isGroup && this.settings?.groupPolicy === "disabled") {
      logger.debug(`Ignoring group message due to policy: ${threadId}`);
      return;
    }

    // Build chat info
    const chat: ZaloChat = {
      threadId,
      type: isGroup ? ZaloUserChatType.GROUP : ZaloUserChatType.PRIVATE,
      name: message.metadata?.threadName,
      isGroup,
    };

    // Handle new chat
    if (!this.knownChats.has(threadId)) {
      this.knownChats.set(threadId, chat);
      await this.handleNewChat(chat);
    }

    // Build sender info
    const sender: ZaloUser | undefined = message.metadata?.senderId
      ? {
          id: message.metadata.senderId,
          displayName: message.metadata.senderName || "Unknown",
        }
      : undefined;

    // Emit message received event
    if (this.runtime) {
      this.runtime.emitEvent(ZaloUserEventTypes.MESSAGE_RECEIVED, {
        runtime: this.runtime,
        source: "zalouser",
        originalMessage: message,
        chat,
        sender,
      } as EventPayload);
    }

    // Create room and entity if needed
    const roomId = createUniqueUuid(this.runtime, threadId) as UUID;
    const worldId = createUniqueUuid(this.runtime, threadId) as UUID;

    if (sender) {
      const entityId = createUniqueUuid(this.runtime, sender.id) as UUID;
      await this.runtime.ensureConnection({
        entityId,
        roomId,
        userName: sender.displayName,
        userId: sender.id as UUID,
        name: sender.displayName,
        source: "zalouser",
        channelId: threadId,
        messageServerId: worldId,
        type: isGroup ? ChannelType.GROUP : ChannelType.DM,
        worldId,
      });
    }
  }

  /**
   * Handle a new chat being discovered.
   */
  private async handleNewChat(chat: ZaloChat): Promise<void> {
    const worldId = createUniqueUuid(this.runtime, chat.threadId) as UUID;
    const roomId = createUniqueUuid(this.runtime, chat.threadId) as UUID;

    const world: World = {
      id: worldId,
      name: chat.name || `Zalo Chat ${chat.threadId}`,
      agentId: this.runtime.agentId,
      messageServerId: worldId,
      metadata: {
        extra: {
          chatType: chat.type,
          isGroup: chat.isGroup,
        },
      },
    };

    await this.runtime.ensureWorldExists(world);

    const room: Room = {
      id: roomId,
      name: chat.name || `Zalo Chat ${chat.threadId}`,
      source: "zalouser",
      type: chat.isGroup ? ChannelType.GROUP : ChannelType.DM,
      channelId: chat.threadId,
      messageServerId: worldId,
      worldId,
    };

    await this.runtime.ensureRoomExists(room);

    // Emit world joined event
    if (this.runtime) {
      this.runtime.emitEvent(ZaloUserEventTypes.WORLD_JOINED, {
        runtime: this.runtime,
        source: "zalouser",
        world,
        rooms: [room],
        entities: [],
        chat,
        currentUser: this.currentUser
          ? {
              id: this.currentUser.userId,
              displayName: this.currentUser.displayName,
              avatar: this.currentUser.avatar,
            }
          : undefined,
      } as EventPayload);
    }
  }

  /**
   * Send a text message.
   */
  async sendMessage(params: SendMessageParams): Promise<SendMessageResult> {
    const profile =
      params.profile || this.settings?.defaultProfile || DEFAULT_PROFILE;

    const result = await sendMessage(params.threadId, params.text, {
      profile,
      isGroup: params.isGroup,
    });

    if (result.ok && this.runtime) {
      this.runtime.emitEvent(ZaloUserEventTypes.MESSAGE_SENT, {
        runtime: this.runtime,
        source: "zalouser",
        threadId: params.threadId,
        messageId: result.messageId,
      } as EventPayload);
    }

    return {
      success: result.ok,
      threadId: params.threadId,
      messageId: result.messageId,
      error: result.error,
    };
  }

  /**
   * Send a media message (image, video, etc.).
   */
  async sendMedia(params: SendMediaParams): Promise<SendMessageResult> {
    const profile =
      params.profile || this.settings?.defaultProfile || DEFAULT_PROFILE;

    // Determine media type from URL
    const lowerUrl = params.mediaUrl.toLowerCase();
    let result: { ok: boolean; messageId?: string; error?: string };

    if (lowerUrl.match(/\.(mp4|mov|avi|webm)$/)) {
      // Video - use image command with video URL (zca handles it)
      result = await sendImage(params.threadId, params.mediaUrl, {
        profile,
        caption: params.caption,
        isGroup: params.isGroup,
      });
    } else if (lowerUrl.match(/^https?:\/\//)) {
      // URL - could be image or link
      if (lowerUrl.match(/\.(jpg|jpeg|png|gif|webp)$/)) {
        result = await sendImage(params.threadId, params.mediaUrl, {
          profile,
          caption: params.caption,
          isGroup: params.isGroup,
        });
      } else {
        result = await sendLink(params.threadId, params.mediaUrl, {
          profile,
          isGroup: params.isGroup,
        });
      }
    } else {
      // Default to image
      result = await sendImage(params.threadId, params.mediaUrl, {
        profile,
        caption: params.caption,
        isGroup: params.isGroup,
      });
    }

    if (result.ok && this.runtime) {
      this.runtime.emitEvent(ZaloUserEventTypes.MESSAGE_SENT, {
        runtime: this.runtime,
        source: "zalouser",
        threadId: params.threadId,
        messageId: result.messageId,
      } as EventPayload);
    }

    return {
      success: result.ok,
      threadId: params.threadId,
      messageId: result.messageId,
      error: result.error,
    };
  }

  /**
   * List friends.
   */
  async listFriends(query?: string): Promise<ZaloFriend[]> {
    const profile = this.settings?.defaultProfile || DEFAULT_PROFILE;
    return listFriends(profile, query);
  }

  /**
   * List groups.
   */
  async listGroups(): Promise<ZaloGroup[]> {
    const profile = this.settings?.defaultProfile || DEFAULT_PROFILE;
    return listGroups(profile);
  }

  /**
   * List members of a group.
   */
  async listGroupMembers(groupId: string): Promise<ZaloFriend[]> {
    const profile = this.settings?.defaultProfile || DEFAULT_PROFILE;
    return listGroupMembers(groupId, profile);
  }

  /**
   * Initiate QR code login.
   */
  async startQrLogin(
    profile?: string,
  ): Promise<{ qrDataUrl?: string; message: string }> {
    const targetProfile =
      profile || this.settings?.defaultProfile || DEFAULT_PROFILE;

    const result = await runZca(["auth", "login", "--qr-base64"], {
      profile: targetProfile,
      timeout: 30000,
    });

    if (!result.ok) {
      return { message: result.stderr || "Failed to start QR login" };
    }

    // Extract QR code data URL from output
    const qrMatch = result.stdout.match(
      /data:image\/png;base64,[A-Za-z0-9+/=]+/,
    );
    if (qrMatch) {
      if (this.runtime) {
        this.runtime.emitEvent(ZaloUserEventTypes.QR_CODE_READY, {
          runtime: this.runtime,
          source: "zalouser",
          qrDataUrl: qrMatch[0],
          message: "Scan QR code with Zalo app",
          profile: targetProfile,
        } as EventPayload);
      }
      return { qrDataUrl: qrMatch[0], message: "Scan QR code with Zalo app" };
    }

    return { message: result.stdout || "QR login started" };
  }

  /**
   * Wait for QR login to complete.
   */
  async waitForLogin(
    profile?: string,
    timeoutMs = 60000,
  ): Promise<{ connected: boolean; message: string }> {
    const targetProfile =
      profile || this.settings?.defaultProfile || DEFAULT_PROFILE;

    const result = await runZca(["auth", "status"], {
      profile: targetProfile,
      timeout: timeoutMs,
    });

    if (result.ok) {
      if (this.runtime) {
        this.runtime.emitEvent(ZaloUserEventTypes.LOGIN_SUCCESS, {
          runtime: this.runtime,
          source: "zalouser",
          profile: targetProfile,
          timestamp: Date.now(),
        } as EventPayload);
      }
      return { connected: true, message: "Login successful" };
    }

    if (this.runtime) {
      this.runtime.emitEvent(ZaloUserEventTypes.LOGIN_FAILED, {
        runtime: this.runtime,
        source: "zalouser",
        profile: targetProfile,
        error: result.stderr || "Login pending",
        timestamp: Date.now(),
      } as EventPayload);
    }

    return { connected: false, message: result.stderr || "Login pending" };
  }

  /**
   * Logout from Zalo.
   */
  async logout(
    profile?: string,
  ): Promise<{ loggedOut: boolean; message: string }> {
    const targetProfile =
      profile || this.settings?.defaultProfile || DEFAULT_PROFILE;

    const result = await runZca(["auth", "logout"], {
      profile: targetProfile,
      timeout: 10000,
    });

    return {
      loggedOut: result.ok,
      message: result.ok ? "Logged out" : result.stderr || "Failed to logout",
    };
  }

  /**
   * Split a long message into chunks.
   */
  static splitMessage(text: string, limit = MAX_MESSAGE_LENGTH): string[] {
    if (!text || text.length <= limit) {
      return text ? [text] : [];
    }

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > limit) {
      const window = remaining.slice(0, limit);
      const lastNewline = window.lastIndexOf("\n");
      const lastSpace = window.lastIndexOf(" ");
      let breakIdx = lastNewline > 0 ? lastNewline : lastSpace;
      if (breakIdx <= 0) {
        breakIdx = limit;
      }

      const chunk = remaining.slice(0, breakIdx).trimEnd();
      if (chunk.length > 0) {
        chunks.push(chunk);
      }

      const nextStart = Math.min(remaining.length, breakIdx + 1);
      remaining = remaining.slice(nextStart).trimStart();
    }

    if (remaining.length) {
      chunks.push(remaining);
    }

    return chunks;
  }
}
