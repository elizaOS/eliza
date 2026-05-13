/**
 * Twitch service implementation for ElizaOS.
 *
 * This service provides Twitch chat integration using the @twurple library.
 */

import {
  type Content,
  type EventPayload,
  type IAgentRuntime,
  logger,
  type MessageConnectorChannelOpParams,
  type MessageConnectorChatContext,
  type MessageConnectorQueryContext,
  type MessageConnectorTarget,
  Service,
  type TargetInfo,
} from "@elizaos/core";
import { RefreshingAuthProvider, StaticAuthProvider } from "@twurple/auth";
import { ChatClient, type ChatMessage } from "@twurple/chat";
import {
  listTwitchAccountIds,
  normalizeTwitchAccountId,
  readTwitchAccountId,
  resolveDefaultTwitchAccountId,
  resolveTwitchAccountSettings,
} from "./accounts.js";
import {
  formatChannelForDisplay,
  type ITwitchService,
  MAX_TWITCH_MESSAGE_LENGTH,
  normalizeChannel,
  splitMessageForTwitch,
  stripMarkdownForTwitch,
  TWITCH_SERVICE_NAME,
  TwitchConfigurationError,
  TwitchEventTypes,
  type TwitchMessage,
  type TwitchMessageSendOptions,
  TwitchNotConnectedError,
  type TwitchSendResult,
  type TwitchSettings,
  type TwitchUserInfo,
} from "./types.js";

const TWITCH_CONNECTOR_CONTEXTS = ["social", "connectors"];
const TWITCH_CONNECTOR_CAPABILITIES = [
  "send_message",
  "resolve_targets",
  "list_rooms",
  "join",
  "leave",
  "chat_context",
];

function normalizeTwitchConnectorQuery(value: string): string {
  return normalizeChannel(value.trim().replace(/^@/, "")).toLowerCase();
}

function scoreTwitchChannelMatch(query: string, channel: string): number {
  const normalized = normalizeTwitchConnectorQuery(channel);
  if (!query) {
    return 0.45;
  }
  if (normalized === query) {
    return 1;
  }
  if (normalized.startsWith(query)) {
    return 0.85;
  }
  if (normalized.includes(query)) {
    return 0.7;
  }
  return 0;
}

async function logTwurpleCall<T>(
  op: string,
  context: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  logger.debug(
    { sdk: "twurple", op, ...context },
    `[TwitchService] ${op} started`,
  );
  try {
    const result = await fn();
    logger.info(
      {
        sdk: "twurple",
        op,
        ...context,
        durationMs: Date.now() - startedAt,
      },
      `[TwitchService] ${op} ok`,
    );
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(
      {
        sdk: "twurple",
        op,
        ...context,
        durationMs: Date.now() - startedAt,
        error: message,
      },
      `[TwitchService] ${op} failed`,
    );
    throw error;
  }
}

/**
 * Twitch chat service for ElizaOS agents.
 */
export class TwitchService extends Service implements ITwitchService {
  static serviceType: string = TWITCH_SERVICE_NAME;
  capabilityDescription =
    "Provides Twitch chat integration for sending and receiving messages";

  private settings!: TwitchSettings;
  private client!: ChatClient;
  private connected: boolean = false;
  private joinedChannels: Set<string> = new Set();
  private accountServices = new Map<string, TwitchService>();

  /**
   * Start the Twitch service.
   */
  static async start(runtime: IAgentRuntime): Promise<TwitchService> {
    const service = new TwitchService();
    await service.initialize(runtime);
    return service;
  }

  static registerSendHandlers(
    runtime: IAgentRuntime,
    serviceInstance: TwitchService,
  ): void {
    if (!serviceInstance) {
      return;
    }

    for (const accountService of serviceInstance.getAccountServiceList()) {
      const accountId = accountService.getAccountId(runtime);
      const sendHandler = accountService.handleSendMessage.bind(accountService);
      if (typeof runtime.registerMessageConnector === "function") {
        runtime.registerMessageConnector({
          source: "twitch",
          accountId,
          label: "Twitch",
          description:
            "Twitch public chat connector for sending messages to joined channels.",
          capabilities: [...TWITCH_CONNECTOR_CAPABILITIES],
          supportedTargetKinds: ["channel"],
          contexts: [...TWITCH_CONNECTOR_CONTEXTS],
          metadata: {
            accountId,
            service: TWITCH_SERVICE_NAME,
            maxMessageLength: MAX_TWITCH_MESSAGE_LENGTH,
          },
          resolveTargets:
            accountService.resolveConnectorTargets.bind(accountService),
          listRecentTargets:
            accountService.listRecentConnectorTargets.bind(accountService),
          listRooms: accountService.listConnectorRooms.bind(accountService),
          joinHandler: accountService.handleJoinChannel.bind(accountService),
          leaveHandler: accountService.handleLeaveChannel.bind(accountService),
          getChatContext:
            accountService.getConnectorChatContext.bind(accountService),
          sendHandler,
        });
        runtime.logger.info(
          { src: "plugin:twitch", agentId: runtime.agentId },
          "Registered Twitch chat connector",
        );
      }
    }
  }

  /**
   * Stop the Twitch service.
   */
  static async stopRuntime(runtime: IAgentRuntime): Promise<void> {
    const service = runtime.getService<TwitchService>(TWITCH_SERVICE_NAME);
    if (service) {
      await service.stop();
    }
  }

  /**
   * Initialize the Twitch service.
   */
  private async initialize(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;

    const startedAccounts: string[] = [];
    for (const accountId of listTwitchAccountIds(runtime)) {
      const settings = resolveTwitchAccountSettings(runtime, accountId);
      if (settings.enabled === false) {
        continue;
      }

      const accountService = new TwitchService();
      await accountService.initializeAccount(runtime, accountId);
      this.accountServices.set(accountService.getAccountId(), accountService);
      startedAccounts.push(accountService.getAccountId());
    }

    if (startedAccounts.length === 0) {
      logger.warn("No enabled Twitch accounts configured");
      return;
    }

    logger.info(
      `Twitch service started ${startedAccounts.length} account(s): ${startedAccounts.join(", ")}`,
    );
  }

  private async initializeAccount(
    runtime: IAgentRuntime,
    accountId?: string,
  ): Promise<void> {
    this.runtime = runtime;

    // Load configuration
    this.settings = this.loadSettings(accountId);

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
  private loadSettings(accountId?: string): TwitchSettings {
    return resolveTwitchAccountSettings(this.runtime, accountId);
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
        accountId: this.getAccountId(),
      } as EventPayload);
    });

    this.client.onDisconnect((_manually, reason) => {
      this.connected = false;
      logger.warn(`Twitch chat disconnected: ${reason || "unknown reason"}`);
      this.runtime.emitEvent(TwitchEventTypes.CONNECTION_LOST, {
        runtime: this.runtime,
        accountId: this.getAccountId(),
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
          accountId: this.getAccountId(),
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
          accountId: this.getAccountId(),
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
      accountId: this.getAccountId(),
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
    if (this.accountServices?.size > 0) {
      await Promise.all(
        Array.from(this.accountServices.values()).map((service) =>
          service.stop(),
        ),
      );
      this.accountServices.clear();
      logger.info("Twitch service stopped");
      return;
    }

    if (this.client) {
      this.client.quit();
    }
    this.connected = false;
    this.joinedChannels.clear();
    logger.info("Twitch service stopped");
  }

  private getAccountServiceList(): TwitchService[] {
    return this.accountServices?.size > 0
      ? Array.from(this.accountServices.values())
      : [this];
  }

  private getDefaultAccountService(): TwitchService {
    if (!this.accountServices || this.accountServices.size === 0) {
      return this;
    }

    const defaultAccountId = normalizeTwitchAccountId(
      resolveDefaultTwitchAccountId(this.runtime),
    );
    return (
      this.accountServices.get(defaultAccountId) ??
      Array.from(this.accountServices.values())[0]
    );
  }

  private getAccountService(accountId: string): TwitchService {
    if (!this.accountServices || this.accountServices.size === 0) {
      const ownAccountId = this.getAccountId();
      if (normalizeTwitchAccountId(accountId) !== ownAccountId) {
        throw new Error(
          `Twitch account '${accountId}' is not available in this service instance`,
        );
      }
      return this;
    }

    const normalized = normalizeTwitchAccountId(accountId);
    const service = this.accountServices.get(normalized);
    if (!service) {
      throw new Error(`Twitch account '${normalized}' is not available`);
    }
    return service;
  }

  // ============================================================================
  // Public Interface
  // ============================================================================

  isConnected(): boolean {
    if (this.accountServices?.size > 0) {
      return Array.from(this.accountServices.values()).some((service) =>
        service.isConnected(),
      );
    }
    return this.connected;
  }

  getBotUsername(): string {
    if (this.accountServices?.size > 0) {
      return this.getDefaultAccountService().getBotUsername();
    }
    return this.settings.username;
  }

  getAccountId(runtime?: IAgentRuntime): string {
    if (this.accountServices?.size > 0) {
      return this.getDefaultAccountService().getAccountId(runtime);
    }
    return normalizeTwitchAccountId(
      this.settings?.accountId ??
        (runtime ? resolveDefaultTwitchAccountId(runtime) : undefined),
    );
  }

  getPrimaryChannel(): string {
    if (this.accountServices?.size > 0) {
      return this.getDefaultAccountService().getPrimaryChannel();
    }
    return this.settings.channel;
  }

  getJoinedChannels(): string[] {
    if (this.accountServices?.size > 0) {
      return this.getDefaultAccountService().getJoinedChannels();
    }
    return Array.from(this.joinedChannels);
  }

  async handleSendMessage(
    runtime: IAgentRuntime,
    target: TargetInfo,
    content: Content,
  ): Promise<void> {
    const requestedAccountId = normalizeTwitchAccountId(
      target.accountId ??
        readTwitchAccountId(content, target) ??
        this.getAccountId(),
    );
    if (this.accountServices?.size > 0) {
      await this.getAccountService(requestedAccountId).handleSendMessage(
        runtime,
        target,
        content,
      );
      return;
    }

    if (requestedAccountId !== this.getAccountId()) {
      throw new Error(
        `Twitch account '${requestedAccountId}' is not available in this service instance`,
      );
    }

    const text = typeof content.text === "string" ? content.text.trim() : "";
    if (!text) {
      throw new Error("Twitch connector requires non-empty text content.");
    }

    let channel = target.channelId;
    let replyTo = target.threadId;

    if (target.roomId && !channel) {
      const room = await runtime.getRoom(target.roomId);
      channel = room?.channelId;
      const metadata = room?.metadata as Record<string, unknown> | undefined;
      replyTo =
        replyTo ??
        (typeof metadata?.twitchReplyTo === "string"
          ? metadata.twitchReplyTo
          : undefined);
    }

    await this.sendMessage(text, {
      channel: channel ? normalizeChannel(channel) : this.getPrimaryChannel(),
      replyTo,
    });
  }

  async resolveConnectorTargets(
    query: string,
    _context: MessageConnectorQueryContext,
  ): Promise<MessageConnectorTarget[]> {
    const normalizedQuery = normalizeTwitchConnectorQuery(query);
    return this.getConnectorChannels()
      .map((channel) => {
        const score = scoreTwitchChannelMatch(normalizedQuery, channel);
        return score > 0 ? this.buildChannelTarget(channel, score) : null;
      })
      .filter((target): target is MessageConnectorTarget => Boolean(target))
      .slice(0, 25);
  }

  async listConnectorRooms(
    _context: MessageConnectorQueryContext,
  ): Promise<MessageConnectorTarget[]> {
    return this.getConnectorChannels()
      .map((channel) => this.buildChannelTarget(channel, 0.5))
      .slice(0, 50);
  }

  async listRecentConnectorTargets(
    context: MessageConnectorQueryContext,
  ): Promise<MessageConnectorTarget[]> {
    const targets: MessageConnectorTarget[] = [];
    const room =
      context.roomId && typeof context.runtime.getRoom === "function"
        ? await context.runtime.getRoom(context.roomId)
        : null;
    const channel = context.target?.channelId ?? room?.channelId;
    if (channel) {
      targets.push(this.buildChannelTarget(channel, 0.95));
    }
    targets.push(...(await this.listConnectorRooms(context)));

    const seen = new Set<string>();
    return targets
      .filter((target) => {
        const channelId = target.target.channelId;
        if (!channelId || seen.has(channelId)) {
          return false;
        }
        seen.add(channelId);
        return true;
      })
      .slice(0, 25);
  }

  async handleJoinChannel(
    _runtime: IAgentRuntime,
    params: MessageConnectorChannelOpParams,
  ): Promise<void> {
    const channel = this.resolveChannelOpTarget(params);
    if (!channel) {
      throw new Error(
        "Twitch MESSAGE operation=join requires channelId, alias, or target channel.",
      );
    }
    if (this.joinedChannels.has(channel)) {
      return;
    }
    await this.joinChannel(channel);
  }

  async handleLeaveChannel(
    _runtime: IAgentRuntime,
    params: MessageConnectorChannelOpParams,
  ): Promise<void> {
    const channel = this.resolveChannelOpTarget(params);
    if (!channel) {
      throw new Error(
        "Twitch MESSAGE operation=leave requires channelId, alias, or target channel.",
      );
    }
    if (channel === normalizeChannel(this.getPrimaryChannel())) {
      throw new Error(`Cannot leave the primary Twitch channel #${channel}.`);
    }
    if (!this.joinedChannels.has(channel)) {
      throw new Error(`Not currently in Twitch channel #${channel}.`);
    }
    await this.leaveChannel(channel);
  }

  async getConnectorChatContext(
    target: TargetInfo,
    context: MessageConnectorQueryContext,
  ): Promise<MessageConnectorChatContext | null> {
    let channel = target.channelId;
    if (!channel && target.roomId) {
      const room = await context.runtime.getRoom(target.roomId);
      channel = room?.channelId;
    }
    channel = channel ? normalizeChannel(channel) : this.getPrimaryChannel();

    return {
      target: {
        source: "twitch",
        accountId: this.getAccountId(),
        channelId: channel,
      } as TargetInfo,
      label: formatChannelForDisplay(channel),
      summary:
        "Twitch chat messages are public and visible to viewers in the channel.",
      metadata: {
        accountId: this.getAccountId(),
        twitchChannel: channel,
        botUsername: this.getBotUsername(),
        joined: this.joinedChannels.has(channel),
      },
    };
  }

  private getConnectorChannels(): string[] {
    const channels = new Set<string>();
    if (this.settings?.channel) {
      channels.add(normalizeChannel(this.settings.channel));
    }
    for (const channel of this.settings?.additionalChannels ?? []) {
      channels.add(normalizeChannel(channel));
    }
    for (const channel of this.joinedChannels) {
      channels.add(normalizeChannel(channel));
    }
    return Array.from(channels);
  }

  private resolveChannelOpTarget(
    params: MessageConnectorChannelOpParams,
  ): string | null {
    const targetRecord = params.target as Record<string, unknown> | undefined;
    const raw =
      params.target?.channelId ??
      params.channelId ??
      params.alias ??
      targetRecord?.alias ??
      targetRecord?.name;
    return typeof raw === "string" && raw.trim()
      ? normalizeChannel(raw.trim())
      : null;
  }

  private buildChannelTarget(
    channel: string,
    score: number,
  ): MessageConnectorTarget {
    const normalized = normalizeChannel(channel);
    return {
      target: {
        source: "twitch",
        accountId: this.getAccountId(),
        channelId: normalized,
      } as TargetInfo,
      label: formatChannelForDisplay(normalized),
      kind: "channel",
      description: "Twitch public chat channel",
      score,
      contexts: [...TWITCH_CONNECTOR_CONTEXTS],
      metadata: {
        accountId: this.getAccountId(),
        twitchChannel: normalized,
        joined: this.joinedChannels.has(normalized),
        primary: normalized === this.getPrimaryChannel(),
      },
    };
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
    if (this.accountServices?.size > 0) {
      const accountId = normalizeTwitchAccountId(
        (options as TwitchMessageSendOptions & { accountId?: string })
          ?.accountId ?? this.getAccountId(),
      );
      return this.getAccountService(accountId).sendMessage(text, options);
    }

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
      await logTwurpleCall(
        "say",
        { channel, chunkLen: chunk.length, replyTo: options?.replyTo },
        async () => {
          if (options?.replyTo) {
            await this.client.say(channel, chunk, {
              replyTo: options.replyTo,
            });
          } else {
            await this.client.say(channel, chunk);
          }
        },
      );

      // Generate a message ID since Twurple doesn't return one
      lastMessageId = crypto.randomUUID();

      // Small delay between chunks
      if (chunks.length > 1) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }

    this.runtime.emitEvent(TwitchEventTypes.MESSAGE_SENT, {
      runtime: this.runtime,
      accountId: this.getAccountId(),
      channel,
      text: cleanedText,
      messageId: lastMessageId,
    } as EventPayload);

    return { success: true, messageId: lastMessageId };
  }

  async joinChannel(channel: string): Promise<void> {
    if (this.accountServices?.size > 0) {
      await this.getDefaultAccountService().joinChannel(channel);
      return;
    }

    const normalized = normalizeChannel(channel);
    await logTwurpleCall("join", { channel: normalized }, async () => {
      await this.client.join(normalized);
    });
    this.joinedChannels.add(normalized);
  }

  async leaveChannel(channel: string): Promise<void> {
    if (this.accountServices?.size > 0) {
      await this.getDefaultAccountService().leaveChannel(channel);
      return;
    }

    const normalized = normalizeChannel(channel);
    await logTwurpleCall("part", { channel: normalized }, async () => {
      await this.client.part(normalized);
    });
    this.joinedChannels.delete(normalized);
  }
}
