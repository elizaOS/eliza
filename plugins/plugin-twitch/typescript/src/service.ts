/**
 * Twitch service implementation for elizaOS.
 *
 * This service provides Twitch chat integration using the @twurple library.
 */

import {
  type EventPayload,
  type IAgentRuntime,
  logger,
  Service,
} from "@elizaos/core";
import { RefreshingAuthProvider, StaticAuthProvider } from "@twurple/auth";
import { ChatClient, type ChatMessage } from "@twurple/chat";
import {
  type ITwitchService,
  normalizeChannel,
  splitMessageForTwitch,
  stripMarkdownForTwitch,
  TWITCH_SERVICE_NAME,
  TwitchConfigurationError,
  TwitchEventTypes,
  type TwitchMessage,
  type TwitchMessageSendOptions,
  TwitchNotConnectedError,
  type TwitchRole,
  type TwitchSendResult,
  type TwitchSettings,
  type TwitchUserInfo,
} from "./types.js";

/**
 * Twitch chat service for elizaOS agents.
 */
export class TwitchService extends Service implements ITwitchService {
  static serviceType: string = TWITCH_SERVICE_NAME;
  capabilityDescription =
    "Provides Twitch chat integration for sending and receiving messages";

  private settings!: TwitchSettings;
  private client!: ChatClient;
  private connected: boolean = false;
  private joinedChannels: Set<string> = new Set();

  /**
   * Start the Twitch service.
   */
  static async start(runtime: IAgentRuntime): Promise<TwitchService> {
    const service = new TwitchService();
    await service.initialize(runtime);
    return service;
  }

  /**
   * Stop the Twitch service.
   */
  static async stopRuntime(runtime: IAgentRuntime): Promise<void> {
    const service = await runtime.getService<TwitchService>(TWITCH_SERVICE_NAME);
    if (service) {
      await service.stop();
    }
  }

  /**
   * Initialize the Twitch service.
   */
  private async initialize(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;

    // Load configuration
    this.settings = this.loadSettings();

    // Validate configuration
    this.validateSettings();

    // Create auth provider
    const authProvider = await this.createAuthProvider();

    // Create chat client
    const allChannels = [
      this.settings.channel,
      ...this.settings.additionalChannels,
    ].map(normalizeChannel);

    this.client = new ChatClient({
      authProvider,
      channels: allChannels,
      rejoinChannelsOnReconnect: true,
    });

    // Set up event handlers
    this.setupEventHandlers();

    // Connect
    await this.connect();

    logger.info(
      `Twitch service initialized for ${this.settings.username}, joined channels: ${allChannels.join(", ")}`,
    );
  }

  /**
   * Load settings from runtime.
   */
  private loadSettings(): TwitchSettings {
    const username = this.runtime.getSetting("TWITCH_USERNAME");
    const clientId = this.runtime.getSetting("TWITCH_CLIENT_ID");
    const accessToken = this.runtime.getSetting("TWITCH_ACCESS_TOKEN");
    const clientSecret = this.runtime.getSetting("TWITCH_CLIENT_SECRET");
    const refreshToken = this.runtime.getSetting("TWITCH_REFRESH_TOKEN");
    const channel = this.runtime.getSetting("TWITCH_CHANNEL");
    const additionalChannelsStr = this.runtime.getSetting("TWITCH_CHANNELS");
    const requireMentionStr = this.runtime.getSetting("TWITCH_REQUIRE_MENTION");
    const allowedRolesStr = this.runtime.getSetting("TWITCH_ALLOWED_ROLES");

    const additionalChannels =
      typeof additionalChannelsStr === "string" && additionalChannelsStr
        ? additionalChannelsStr
            .split(",")
            .map((c: string) => c.trim())
            .filter(Boolean)
        : [];

    const allowedRoles: TwitchRole[] =
      typeof allowedRolesStr === "string" && allowedRolesStr
        ? (allowedRolesStr
            .split(",")
            .map((r: string) => r.trim().toLowerCase()) as TwitchRole[])
        : ["all"];

    return {
      username: typeof username === "string" ? username : "",
      clientId: typeof clientId === "string" ? clientId : "",
      accessToken: typeof accessToken === "string" ? accessToken : "",
      clientSecret: typeof clientSecret === "string" ? clientSecret : undefined,
      refreshToken: typeof refreshToken === "string" ? refreshToken : undefined,
      channel: typeof channel === "string" ? channel : "",
      additionalChannels,
      requireMention: requireMentionStr === "true",
      allowedRoles,
      allowedUserIds: [],
      enabled: true,
    };
  }

  /**
   * Validate the settings.
   */
  private validateSettings(): void {
    if (!this.settings.username) {
      throw new TwitchConfigurationError(
        "TWITCH_USERNAME is required",
        "TWITCH_USERNAME",
      );
    }

    if (!this.settings.clientId) {
      throw new TwitchConfigurationError(
        "TWITCH_CLIENT_ID is required",
        "TWITCH_CLIENT_ID",
      );
    }

    if (!this.settings.accessToken) {
      throw new TwitchConfigurationError(
        "TWITCH_ACCESS_TOKEN is required",
        "TWITCH_ACCESS_TOKEN",
      );
    }

    if (!this.settings.channel) {
      throw new TwitchConfigurationError(
        "TWITCH_CHANNEL is required",
        "TWITCH_CHANNEL",
      );
    }
  }

  /**
   * Create the authentication provider.
   */
  private async createAuthProvider(): Promise<
    StaticAuthProvider | RefreshingAuthProvider
  > {
    const token = this.normalizeToken(this.settings.accessToken);

    if (this.settings.clientSecret) {
      const authProvider = new RefreshingAuthProvider({
        clientId: this.settings.clientId,
        clientSecret: this.settings.clientSecret,
      });

      await authProvider.addUserForToken({
        accessToken: token,
        refreshToken: this.settings.refreshToken || null,
        expiresIn: null,
        obtainmentTimestamp: Date.now(),
      });

      authProvider.onRefresh((userId, newToken) => {
        logger.info(
          `Twitch token refreshed for user ${userId}, expires in ${newToken.expiresIn}s`,
        );
      });

      authProvider.onRefreshFailure((userId, error) => {
        logger.error(
          `Twitch token refresh failed for user ${userId}: ${error.message}`,
        );
      });

      logger.info(`Using RefreshingAuthProvider for ${this.settings.username}`);
      return authProvider;
    }

    logger.info(`Using StaticAuthProvider for ${this.settings.username}`);
    return new StaticAuthProvider(this.settings.clientId, token);
  }

  /**
   * Normalize an OAuth token (remove oauth: prefix if present).
   */
  private normalizeToken(token: string): string {
    return token.startsWith("oauth:") ? token.slice(6) : token;
  }

  /**
   * Set up event handlers for the chat client.
   */
  private setupEventHandlers(): void {
    // Connection events
    this.client.onConnect(() => {
      this.connected = true;
      logger.info("Twitch chat connected");
      this.runtime.emitEvent(TwitchEventTypes.CONNECTION_READY, {
        runtime: this.runtime,
      } as EventPayload);
    });

    this.client.onDisconnect((_manually, reason) => {
      this.connected = false;
      logger.warn(`Twitch chat disconnected: ${reason || "unknown reason"}`);
      this.runtime.emitEvent(TwitchEventTypes.CONNECTION_LOST, {
        runtime: this.runtime,
        reason,
      } as EventPayload);
    });

    // Channel events
    this.client.onJoin((channel, user) => {
      const normalized = normalizeChannel(channel);
      if (user.toLowerCase() === this.settings.username.toLowerCase()) {
        this.joinedChannels.add(normalized);
        logger.info(`Joined Twitch channel: ${normalized}`);
        this.runtime.emitEvent(TwitchEventTypes.JOIN_CHANNEL, {
          runtime: this.runtime,
          channel: normalized,
        } as EventPayload);
      }
    });

    this.client.onPart((channel, user) => {
      const normalized = normalizeChannel(channel);
      if (user.toLowerCase() === this.settings.username.toLowerCase()) {
        this.joinedChannels.delete(normalized);
        logger.info(`Left Twitch channel: ${normalized}`);
        this.runtime.emitEvent(TwitchEventTypes.LEAVE_CHANNEL, {
          runtime: this.runtime,
          channel: normalized,
        } as EventPayload);
      }
    });

    // Message events
    this.client.onMessage(
      (channel: string, user: string, text: string, msg: ChatMessage) => {
        this.handleMessage(channel, user, text, msg);
      },
    );
  }

  /**
   * Handle an incoming chat message.
   */
  private handleMessage(
    channel: string,
    _user: string,
    text: string,
    msg: ChatMessage,
  ): void {
    const normalizedChannel = normalizeChannel(channel);

    // Ignore own messages
    if (
      msg.userInfo.userName.toLowerCase() ===
      this.settings.username.toLowerCase()
    ) {
      return;
    }

    const userInfo: TwitchUserInfo = {
      userId: msg.userInfo.userId,
      username: msg.userInfo.userName,
      displayName: msg.userInfo.displayName,
      isModerator: msg.userInfo.isMod,
      isBroadcaster: msg.userInfo.isBroadcaster,
      isVip: msg.userInfo.isVip,
      isSubscriber: msg.userInfo.isSubscriber,
      color: msg.userInfo.color,
      badges: msg.userInfo.badges,
    };

    // Check access control
    if (!this.isUserAllowed(userInfo)) {
      return;
    }

    // Check mention requirement
    if (this.settings.requireMention) {
      const mentionPattern = new RegExp(`@${this.settings.username}\\b`, "i");
      if (!mentionPattern.test(text)) {
        return;
      }
    }

    const message: TwitchMessage = {
      id: msg.id,
      channel: normalizedChannel,
      text,
      user: userInfo,
      timestamp: new Date(),
      isAction: msg.isCheer,
      isHighlighted: msg.isHighlight,
      replyTo: msg.parentMessageId
        ? {
            messageId: msg.parentMessageId,
            userId: msg.parentMessageUserId || "",
            username: msg.parentMessageUserName || "",
            text: msg.parentMessageText || "",
          }
        : undefined,
    };

    logger.debug(
      `Twitch message from ${userInfo.displayName} in #${normalizedChannel}: ${text.slice(0, 50)}...`,
    );

    this.runtime.emitEvent(TwitchEventTypes.MESSAGE_RECEIVED, {
      runtime: this.runtime,
      message,
    } as EventPayload);
  }

  /**
   * Connect to Twitch.
   */
  private async connect(): Promise<void> {
    await this.client.connect();
    this.connected = true;
  }

  /**
   * Stop the service.
   */
  async stop(): Promise<void> {
    if (this.client) {
      this.client.quit();
    }
    this.connected = false;
    this.joinedChannels.clear();
    logger.info("Twitch service stopped");
  }

  // ============================================================================
  // Public Interface
  // ============================================================================

  isConnected(): boolean {
    return this.connected;
  }

  getBotUsername(): string {
    return this.settings.username;
  }

  getPrimaryChannel(): string {
    return this.settings.channel;
  }

  getJoinedChannels(): string[] {
    return Array.from(this.joinedChannels);
  }

  isUserAllowed(user: TwitchUserInfo): boolean {
    // Check allowlist first
    if (
      this.settings.allowedUserIds.length > 0 &&
      !this.settings.allowedUserIds.includes(user.userId)
    ) {
      return false;
    }

    // Check roles
    if (this.settings.allowedRoles.includes("all")) {
      return true;
    }

    if (this.settings.allowedRoles.includes("owner") && user.isBroadcaster) {
      return true;
    }

    if (this.settings.allowedRoles.includes("moderator") && user.isModerator) {
      return true;
    }

    if (this.settings.allowedRoles.includes("vip") && user.isVip) {
      return true;
    }

    if (
      this.settings.allowedRoles.includes("subscriber") &&
      user.isSubscriber
    ) {
      return true;
    }

    return false;
  }

  async sendMessage(
    text: string,
    options?: TwitchMessageSendOptions,
  ): Promise<TwitchSendResult> {
    if (!this.connected) {
      throw new TwitchNotConnectedError();
    }

    const channel = normalizeChannel(options?.channel || this.settings.channel);

    // Strip markdown for Twitch
    const cleanedText = stripMarkdownForTwitch(text);
    if (!cleanedText) {
      return { success: true, messageId: "skipped-empty" };
    }

    // Split long messages
    const chunks = splitMessageForTwitch(cleanedText);

    let lastMessageId: string | undefined;

    for (const chunk of chunks) {
      if (options?.replyTo) {
        await this.client.say(channel, chunk, { replyTo: options.replyTo });
      } else {
        await this.client.say(channel, chunk);
      }

      // Generate a message ID since Twurple doesn't return one
      lastMessageId = crypto.randomUUID();

      // Small delay between chunks
      if (chunks.length > 1) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }

    this.runtime.emitEvent(TwitchEventTypes.MESSAGE_SENT, {
      runtime: this.runtime,
      channel,
      text: cleanedText,
      messageId: lastMessageId,
    } as EventPayload);

    return { success: true, messageId: lastMessageId };
  }

  async joinChannel(channel: string): Promise<void> {
    const normalized = normalizeChannel(channel);
    await this.client.join(normalized);
    this.joinedChannels.add(normalized);
  }

  async leaveChannel(channel: string): Promise<void> {
    const normalized = normalizeChannel(channel);
    await this.client.part(normalized);
    this.joinedChannels.delete(normalized);
  }
}
