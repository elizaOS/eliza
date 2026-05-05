import {
  ChannelType,
  type Character,
  type Content,
  createUniqueUuid,
  type EventPayload,
  type HandlerCallback,
  type IAgentRuntime,
  type IMessageService,
  type Media,
  type Memory,
  type MessageConnectorChatContext,
  type MessageConnectorQueryContext,
  type MessageConnectorTarget,
  type MessageConnectorUserContext,
  type Room,
  Service,
  stringToUuid,
  type TargetInfo,
  type UUID,
  type World,
} from "@elizaos/core";
import { App, LogLevel } from "@slack/bolt";
import type { WebAPICallResult } from "@slack/web-api";

type WebClient = App["client"];

type SlackApiUserProfile = {
  title?: string;
  phone?: string;
  skype?: string;
  real_name?: string;
  real_name_normalized?: string;
  display_name?: string;
  display_name_normalized?: string;
  status_text?: string;
  status_emoji?: string;
  status_expiration?: number;
  avatar_hash?: string;
  email?: string;
  image_24?: string;
  image_32?: string;
  image_48?: string;
  image_72?: string;
  image_192?: string;
  image_512?: string;
  image_1024?: string;
  image_original?: string;
  team?: string;
};

type SlackApiUserMember = {
  id?: string;
  team_id?: string;
  name?: string;
  deleted?: boolean;
  real_name?: string;
  tz?: string;
  tz_label?: string;
  tz_offset?: number;
  profile?: SlackApiUserProfile;
  is_admin?: boolean;
  is_owner?: boolean;
  is_primary_owner?: boolean;
  is_restricted?: boolean;
  is_ultra_restricted?: boolean;
  is_bot?: boolean;
  is_app_user?: boolean;
  updated?: number;
};

const SLACK_CONNECTOR_CONTEXTS = ["social", "connectors"];
const SLACK_CONNECTOR_CAPABILITIES = [
  "send_message",
  "resolve_targets",
  "list_rooms",
  "chat_context",
  "user_context",
];
const SLACK_USER_ID_PATTERN = /^[UW][A-Z0-9]{2,}$/i;

function normalizeSlackConnectorQuery(value: string): string {
  return value
    .trim()
    .replace(/^<#([A-Z0-9]+)(?:\|[^>]+)?>$/i, "$1")
    .replace(/^<@([A-Z0-9]+)>$/i, "$1")
    .replace(/^#/, "")
    .replace(/^@/, "")
    .toLowerCase();
}

function scoreSlackConnectorMatch(
  query: string,
  id: string,
  labels: Array<string | null | undefined>,
): number {
  if (!query) {
    return 0.45;
  }
  if (id.toLowerCase() === query) {
    return 1;
  }

  let bestScore = 0;
  for (const label of labels) {
    const normalized = label?.trim().toLowerCase();
    if (!normalized) {
      continue;
    }
    if (normalized === query) {
      bestScore = Math.max(bestScore, 0.95);
    } else if (normalized.startsWith(query)) {
      bestScore = Math.max(bestScore, 0.85);
    } else if (normalized.includes(query)) {
      bestScore = Math.max(bestScore, 0.7);
    }
  }
  return bestScore;
}

function extractSlackUserIdFromMetadata(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") {
    return null;
  }

  const record = metadata as Record<string, unknown>;
  const slack =
    record.slack && typeof record.slack === "object"
      ? (record.slack as Record<string, unknown>)
      : null;
  const candidates = [
    slack?.userId,
    slack?.id,
    record.slackUserId,
    record.originalId,
  ];

  for (const candidate of candidates) {
    if (
      typeof candidate === "string" &&
      SLACK_USER_ID_PATTERN.test(candidate)
    ) {
      return candidate;
    }
  }
  return null;
}

// Define Slack event types inline to avoid import issues
interface SlackMessageEventType {
  type: "message";
  channel: string;
  channel_type?: string;
  user?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  team?: string;
  bot_id?: string;
  files?: Array<Record<string, unknown>>;
}

interface SlackAppMentionEventType {
  type: "app_mention";
  channel: string;
  user?: string;
  text: string;
  ts: string;
  thread_ts?: string;
  event_ts: string;
}

// Helper to get message service from runtime
const getMessageService = (runtime: IAgentRuntime): IMessageService | null => {
  if ("messageService" in runtime) {
    const withMessageService = runtime as IAgentRuntime & {
      messageService?: IMessageService | null;
    };
    return withMessageService.messageService ?? null;
  }
  return null;
};

import { markdownToSlackMrkdwn } from "./formatting";
import {
  getSlackChannelType,
  getSlackUserDisplayName,
  type ISlackService,
  isValidChannelId,
  MAX_SLACK_MESSAGE_LENGTH,
  SLACK_SERVICE_NAME,
  type SlackAttachment,
  type SlackBlock,
  type SlackChannel,
  SlackEventTypes,
  type SlackFile,
  type SlackMessage,
  type SlackMessageSendOptions,
  type SlackSettings,
  type SlackUser,
} from "./types";

/**
 * SlackService class for interacting with Slack via Socket Mode
 */
export class SlackService extends Service implements ISlackService {
  static serviceType: string = SLACK_SERVICE_NAME;
  capabilityDescription =
    "The agent is able to send and receive messages on Slack";

  app: App | null = null;
  client: WebClient | null = null;
  character: Character;
  botUserId: string | null = null;
  teamId: string | null = null;

  private settings: SlackSettings;
  private botToken: string | null = null;
  private appToken: string | null = null;
  private signingSecret: string | null = null;
  private allowedChannelIds: Set<string> = new Set();
  private dynamicChannelIds: Set<string> = new Set();
  private userCache: Map<string, SlackUser> = new Map();
  private channelCache: Map<string, SlackChannel> = new Map();
  private isStarting = false;
  private isConnected = false;

  constructor(runtime: IAgentRuntime) {
    super(runtime);
    this.character = runtime.character;
    this.settings = this.loadSettings();

    // Parse allowed channel IDs
    const channelIdsRaw = runtime.getSetting("SLACK_CHANNEL_IDS") as
      | string
      | undefined;
    if (channelIdsRaw?.trim()) {
      channelIdsRaw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && isValidChannelId(s))
        .forEach((id) => {
          this.allowedChannelIds.add(id);
        });

      this.runtime.logger.debug(
        {
          src: "plugin:slack",
          agentId: this.runtime.agentId,
          allowedChannelIds: Array.from(this.allowedChannelIds),
        },
        "Channel restrictions enabled",
      );
    }
  }

  private loadSettings(): SlackSettings {
    const ignoreBotMessages = this.runtime.getSetting(
      "SLACK_SHOULD_IGNORE_BOT_MESSAGES",
    );
    const respondOnlyToMentions = this.runtime.getSetting(
      "SLACK_SHOULD_RESPOND_ONLY_TO_MENTIONS",
    );

    return {
      allowedChannelIds: undefined,
      shouldIgnoreBotMessages:
        ignoreBotMessages === "true" || ignoreBotMessages === true,
      shouldRespondOnlyToMentions:
        respondOnlyToMentions === "true" || respondOnlyToMentions === true,
    };
  }

  static async start(runtime: IAgentRuntime): Promise<SlackService> {
    const service = new SlackService(runtime);

    const botToken = runtime.getSetting("SLACK_BOT_TOKEN") as string;
    const appToken = runtime.getSetting("SLACK_APP_TOKEN") as string;
    const signingSecret = runtime.getSetting("SLACK_SIGNING_SECRET") as
      | string
      | undefined;
    if (!botToken?.trim()) {
      runtime.logger.warn(
        { src: "plugin:slack", agentId: runtime.agentId },
        "SLACK_BOT_TOKEN not provided, Slack service will not start",
      );
      return service;
    }

    if (!appToken?.trim()) {
      runtime.logger.warn(
        { src: "plugin:slack", agentId: runtime.agentId },
        "SLACK_APP_TOKEN not provided, Socket Mode will not work",
      );
      return service;
    }

    service.botToken = botToken;
    service.appToken = appToken;
    service.signingSecret = signingSecret || undefined;

    await service.initialize();

    return service;
  }

  static async stop(runtime: IAgentRuntime): Promise<void> {
    const service = runtime.getService(SLACK_SERVICE_NAME) as
      | SlackService
      | undefined;
    if (service) {
      await service.shutdown();
    }
  }

  static registerSendHandlers(
    runtime: IAgentRuntime,
    serviceInstance: SlackService,
  ): void {
    if (!serviceInstance) {
      return;
    }

    const sendHandler = serviceInstance.handleSendMessage.bind(serviceInstance);
    if (typeof runtime.registerMessageConnector === "function") {
      runtime.registerMessageConnector({
        source: "slack",
        label: "Slack",
        description:
          "Slack connector for sending messages to channels, threads, and users.",
        capabilities: [...SLACK_CONNECTOR_CAPABILITIES],
        supportedTargetKinds: ["channel", "thread", "user"],
        contexts: [...SLACK_CONNECTOR_CONTEXTS],
        metadata: {
          service: SLACK_SERVICE_NAME,
          maxMessageLength: MAX_SLACK_MESSAGE_LENGTH,
        },
        resolveTargets:
          serviceInstance.resolveConnectorTargets.bind(serviceInstance),
        listRecentTargets:
          serviceInstance.listRecentConnectorTargets.bind(serviceInstance),
        listRooms: serviceInstance.listConnectorRooms.bind(serviceInstance),
        getChatContext:
          serviceInstance.getConnectorChatContext.bind(serviceInstance),
        getUserContext:
          serviceInstance.getConnectorUserContext.bind(serviceInstance),
        sendHandler,
      });
      runtime.logger.info(
        { src: "plugin:slack", agentId: runtime.agentId },
        "Registered Slack message connector",
      );
      return;
    }

    runtime.registerSendHandler("slack", sendHandler);
    runtime.logger.info(
      { src: "plugin:slack", agentId: runtime.agentId },
      "Registered Slack send handler",
    );
  }

  async stop(): Promise<void> {
    await this.shutdown();
  }

  private async initialize(): Promise<void> {
    if (this.isStarting || this.isConnected) {
      return;
    }

    this.isStarting = true;
    const botToken = this.botToken;
    const appToken = this.appToken;

    if (!botToken || !appToken) {
      this.isStarting = false;
      throw new Error("Slack service requires bot and app tokens");
    }

    this.runtime.logger.info(
      { src: "plugin:slack", agentId: this.runtime.agentId },
      "Initializing Slack service with Socket Mode",
    );

    this.app = new App({
      token: botToken,
      appToken,
      socketMode: true,
      logLevel: LogLevel.INFO,
      ...(this.signingSecret ? { signingSecret: this.signingSecret } : {}),
    });

    this.client = this.app.client;

    // Get bot user info
    const authResult = await this.client.auth.test();
    this.botUserId = authResult.user_id as string;
    this.teamId = authResult.team_id as string;

    this.runtime.logger.info(
      {
        src: "plugin:slack",
        agentId: this.runtime.agentId,
        botUserId: this.botUserId,
        teamId: this.teamId,
      },
      "Slack bot authenticated",
    );

    // Register event handlers
    this.registerEventHandlers();

    // Start the Socket Mode connection
    await this.app.start();

    this.isConnected = true;
    this.isStarting = false;

    this.runtime.logger.info(
      { src: "plugin:slack", agentId: this.runtime.agentId },
      "Slack service started successfully",
    );

    // Ensure all workspaces exist
    await this.ensureWorkspaceExists();
  }

  private async shutdown(): Promise<void> {
    if (this.app) {
      await this.app.stop();
      this.app = null;
      this.client = null;
      this.isConnected = false;

      this.runtime.logger.info(
        { src: "plugin:slack", agentId: this.runtime.agentId },
        "Slack service stopped",
      );
    }
  }

  private registerEventHandlers(): void {
    if (!this.app) return;

    // Handle regular messages
    this.app.message(async ({ message, client }) => {
      await this.handleMessage(message as SlackMessageEventType, client);
    });

    // Handle app mentions
    this.app.event("app_mention", async ({ event, client }) => {
      await this.handleAppMention(event as SlackAppMentionEventType, client);
    });

    // Handle reactions
    this.app.event("reaction_added", async ({ event }) => {
      await this.handleReactionAdded(event);
    });

    this.app.event("reaction_removed", async ({ event }) => {
      await this.handleReactionRemoved(event);
    });

    // Handle channel joins/leaves
    this.app.event("member_joined_channel", async ({ event }) => {
      await this.handleMemberJoinedChannel(event);
    });

    this.app.event("member_left_channel", async ({ event }) => {
      await this.handleMemberLeftChannel(event);
    });

    // Handle file shares
    this.app.event("file_shared", async ({ event }) => {
      await this.handleFileShared(event);
    });
  }

  private async handleMessage(
    message: SlackMessageEventType,
    _client: WebClient,
  ): Promise<void> {
    // Ignore bot messages if configured
    if (this.settings.shouldIgnoreBotMessages && message.bot_id) {
      return;
    }

    // Ignore messages from self
    if (message.user === this.botUserId) {
      return;
    }

    // Check channel restrictions
    if (!this.isChannelAllowed(message.channel)) {
      this.runtime.logger.debug(
        {
          src: "plugin:slack",
          agentId: this.runtime.agentId,
          channelId: message.channel,
        },
        "Message received in non-allowed channel, ignoring",
      );
      return;
    }

    // Check if we should only respond to mentions
    const isMentioned = message.text?.includes(`<@${this.botUserId}>`);
    // Skip @mentions in channels — handleAppMention handles those
    if (isMentioned && message.channel_type !== "im") {
      return;
    }
    if (this.settings.shouldRespondOnlyToMentions && !isMentioned) {
      return;
    }

    const _isThreadReply = Boolean(
      message.thread_ts && message.thread_ts !== message.ts,
    );

    // Build memory from message
    const memory = await this.buildMemoryFromMessage(message);
    if (!memory) return;

    // Get or create room
    const room = await this.ensureRoomExists(
      message.channel,
      message.thread_ts,
    );

    const existingEntity = await this.runtime.getEntityById(memory.entityId);
    if (!existingEntity) {
      const user = await this.getUser(message.user);
      const displayName = user ? getSlackUserDisplayName(user) : message.user;
      await this.runtime.createEntity({
        id: memory.entityId,
        names: [displayName],
        metadata: {
          slack: {
            id: message.user,
            name: displayName,
            userName: user?.name || message.user,
          },
        },
        agentId: this.runtime.agentId,
      });
    }

    // Store the memory
    await this.runtime.createMemory(memory, "messages");

    // Emit event
    await this.runtime.emitEvent(
      SlackEventTypes.MESSAGE_RECEIVED as string,
      {
        runtime: this.runtime,
        source: "slack",
      } as EventPayload,
    );

    // Process the message through the agent
    await this.processAgentMessage(
      memory,
      room,
      message.channel,
      message.thread_ts || message.ts,
    );
  }

  private async handleAppMention(
    event: SlackAppMentionEventType,
    _client: WebClient,
  ): Promise<void> {
    // Skip if no user (optional in AppMentionEvent)
    if (!event.user) return;

    // Build memory from mention
    const memory = await this.buildMemoryFromMention({
      user: event.user,
      text: event.text,
      channel: event.channel,
      ts: event.ts,
      thread_ts: event.thread_ts,
    });
    if (!memory) return;

    // Get or create room
    const room = await this.ensureRoomExists(event.channel, event.thread_ts);

    const existingEntity = await this.runtime.getEntityById(memory.entityId);
    if (!existingEntity) {
      const user = await this.getUser(event.user);
      const displayName = user ? getSlackUserDisplayName(user) : event.user;
      await this.runtime.createEntity({
        id: memory.entityId,
        names: [displayName],
        metadata: {
          slack: {
            id: event.user,
            name: displayName,
            userName: user?.name || event.user,
          },
        },
        agentId: this.runtime.agentId,
      });
    }

    // Store the memory
    await this.runtime.createMemory(memory, "messages");

    // Emit event
    await this.runtime.emitEvent(
      SlackEventTypes.APP_MENTION as string,
      {
        runtime: this.runtime,
        source: "slack",
      } as EventPayload,
    );

    // Process the message
    await this.processAgentMessage(
      memory,
      room,
      event.channel,
      event.thread_ts || event.ts,
    );
  }

  private async handleReactionAdded(_event: {
    user: string;
    reaction: string;
    item: { type: string; channel: string; ts: string };
    item_user?: string;
  }): Promise<void> {
    await this.runtime.emitEvent(
      SlackEventTypes.REACTION_ADDED as string,
      {
        runtime: this.runtime,
        source: "slack",
      } as EventPayload,
    );
  }

  private async handleReactionRemoved(_event: {
    user: string;
    reaction: string;
    item: { type: string; channel: string; ts: string };
    item_user?: string;
  }): Promise<void> {
    await this.runtime.emitEvent(
      SlackEventTypes.REACTION_REMOVED as string,
      {
        runtime: this.runtime,
        source: "slack",
      } as EventPayload,
    );
  }

  private async handleMemberJoinedChannel(event: {
    user: string;
    channel: string;
    team?: string;
  }): Promise<void> {
    // If the bot joined, add to dynamic channels
    if (event.user === this.botUserId) {
      this.dynamicChannelIds.add(event.channel);
      await this.ensureRoomExists(event.channel);
    }

    await this.runtime.emitEvent(
      SlackEventTypes.MEMBER_JOINED_CHANNEL as string,
      {
        runtime: this.runtime,
        source: "slack",
      } as EventPayload,
    );
  }

  private async handleMemberLeftChannel(event: {
    user: string;
    channel: string;
    team?: string;
  }): Promise<void> {
    // If the bot left, remove from dynamic channels
    if (event.user === this.botUserId) {
      this.dynamicChannelIds.delete(event.channel);
    }

    await this.runtime.emitEvent(
      SlackEventTypes.MEMBER_LEFT_CHANNEL as string,
      {
        runtime: this.runtime,
        source: "slack",
      } as EventPayload,
    );
  }

  private async handleFileShared(_event: {
    file_id: string;
    user_id: string;
    channel_id: string;
  }): Promise<void> {
    await this.runtime.emitEvent(
      SlackEventTypes.FILE_SHARED as string,
      {
        runtime: this.runtime,
        source: "slack",
      } as EventPayload,
    );
  }

  private isChannelAllowed(channelId: string): boolean {
    // If no restrictions, all channels allowed
    if (
      this.allowedChannelIds.size === 0 &&
      this.dynamicChannelIds.size === 0
    ) {
      return true;
    }

    // Check static and dynamic allowed lists
    return (
      this.allowedChannelIds.has(channelId) ||
      this.dynamicChannelIds.has(channelId)
    );
  }

  private async processAgentMessage(
    memory: Memory,
    room: Room,
    channelId: string,
    threadTs: string,
  ): Promise<void> {
    const callback: HandlerCallback = async (
      response: Content,
    ): Promise<Memory[]> => {
      const responseText = response.text || "";
      if (!responseText.trim()) {
        this.runtime.logger.warn(
          { src: "plugin:slack", channelId, roomId: room.id },
          "Empty response from model, skipping sendMessage",
        );
        return [];
      }

      await this.sendMessage(channelId, responseText, {
        threadTs,
        replyBroadcast: undefined,
        unfurlLinks: undefined,
        unfurlMedia: undefined,
        mrkdwn: undefined,
        attachments: undefined,
        blocks: undefined,
      });

      // Create memory for the response
      const responseMemory: Memory = {
        id: createUniqueUuid(this.runtime, `slack-response-${Date.now()}`),
        agentId: this.runtime.agentId,
        roomId: room.id,
        entityId: this.runtime.agentId,
        content: {
          text: response.text || "",
          source: "slack",
          inReplyTo: memory.id,
        },
        createdAt: Date.now(),
      };

      await this.runtime.createMemory(responseMemory, "messages");

      await this.runtime.emitEvent(
        SlackEventTypes.MESSAGE_SENT as string,
        {
          runtime: this.runtime,
          source: "slack",
        } as EventPayload,
      );

      return [responseMemory];
    };

    const messageService = getMessageService(this.runtime);
    if (messageService) {
      await messageService.handleMessage(this.runtime, memory, callback);
    }
  }

  private async buildMemoryFromMessage(
    message: SlackMessageEventType,
  ): Promise<Memory | null> {
    if (!message.user) return null;

    const roomId = await this.getRoomId(message.channel, message.thread_ts);
    const entityId = this.getEntityId(message.user);

    // Get user info for display name
    const user = await this.getUser(message.user);
    const displayName = user ? getSlackUserDisplayName(user) : message.user;

    // Extract media from files
    const media: Media[] = [];
    if ("files" in message && message.files) {
      for (const file of message.files as unknown as SlackFile[]) {
        media.push({
          id: file.id,
          url: file.urlPrivate,
          title: file.title || file.name,
          source: "slack",
          description: file.name,
        });
      }
    }

    const memory: Memory = {
      id: createUniqueUuid(this.runtime, `slack-${message.ts}`),
      agentId: this.runtime.agentId,
      roomId,
      entityId,
      content: {
        text: message.text || "",
        source: "slack",
        name: displayName,
        ...(media.length > 0 ? { attachments: media } : {}),
      },
      createdAt: this.parseSlackTimestamp(message.ts),
    };

    return memory;
  }

  private async buildMemoryFromMention(event: {
    user: string;
    text: string;
    channel: string;
    ts: string;
    thread_ts?: string;
  }): Promise<Memory | null> {
    const roomId = await this.getRoomId(event.channel, event.thread_ts);
    const entityId = this.getEntityId(event.user);

    const user = await this.getUser(event.user);
    const displayName = user ? getSlackUserDisplayName(user) : event.user;

    // Remove the bot mention from the text
    const cleanText = event.text.replace(`<@${this.botUserId}>`, "").trim();

    const memory: Memory = {
      id: createUniqueUuid(this.runtime, `slack-mention-${event.ts}`),
      agentId: this.runtime.agentId,
      roomId,
      entityId,
      content: {
        text: cleanText,
        source: "slack",
        name: displayName,
        mentionContext: { isMention: true, isReply: false, isThread: false },
      },
      createdAt: this.parseSlackTimestamp(event.ts),
    };

    return memory;
  }

  private async getRoomId(channelId: string, threadTs?: string): Promise<UUID> {
    // Use thread_ts to create unique rooms for threads
    const roomKey = threadTs ? `${channelId}-${threadTs}` : channelId;
    return createUniqueUuid(this.runtime, `slack-room-${roomKey}`);
  }

  private getEntityId(userId: string): UUID {
    return stringToUuid(`slack-user-${userId}`);
  }

  private parseSlackTimestamp(ts: string): number {
    // Slack timestamps are in the format: 1234567890.123456
    const [seconds] = ts.split(".");
    return parseInt(seconds, 10) * 1000;
  }

  private async ensureWorkspaceExists(): Promise<void> {
    if (!this.teamId || !this.client) return;

    const worldId = createUniqueUuid(
      this.runtime,
      `slack-workspace-${this.teamId}`,
    );

    const existingWorld = await this.runtime.getWorld(worldId);
    if (existingWorld) return;

    // Get team info
    const teamInfo = await this.client.team.info();
    const team = teamInfo.team;

    const world: World = {
      id: worldId,
      name:
        (team as { name?: string })?.name || `Slack Workspace ${this.teamId}`,
      agentId: this.runtime.agentId,
      metadata: {
        type: "slack",
        extra: {
          teamId: this.teamId,
          domain: (team as { domain?: string })?.domain,
        },
      },
    };

    await this.runtime.createWorld(world);

    this.runtime.logger.info(
      {
        src: "plugin:slack",
        agentId: this.runtime.agentId,
        worldId,
        teamId: this.teamId,
      },
      "Created Slack workspace world",
    );
  }

  private async ensureRoomExists(
    channelId: string,
    threadTs?: string,
  ): Promise<Room> {
    const roomId = await this.getRoomId(channelId, threadTs);

    const existingRoom = await this.runtime.getRoom(roomId);
    if (existingRoom) return existingRoom;

    // Get channel info
    const channel = await this.getChannel(channelId);
    const channelType = channel ? getSlackChannelType(channel) : "channel";

    const worldId = this.teamId
      ? createUniqueUuid(this.runtime, `slack-workspace-${this.teamId}`)
      : undefined;

    const elizaChannelType =
      channelType === "im"
        ? ChannelType.DM
        : channelType === "mpim"
          ? ChannelType.GROUP
          : ChannelType.GROUP;

    const room: Room = {
      id: roomId,
      name: channel?.name || channelId,
      agentId: this.runtime.agentId,
      source: "slack",
      type: elizaChannelType,
      channelId,
      worldId,
      metadata: {
        slackChannelType: channelType,
        threadTs,
        topic: channel?.topic?.value,
        purpose: channel?.purpose?.value,
        serverId: this.teamId,
      },
    };

    await this.runtime.createRoom(room);

    this.runtime.logger.debug(
      {
        src: "plugin:slack",
        agentId: this.runtime.agentId,
        roomId,
        channelId,
        threadTs,
      },
      "Created Slack room",
    );

    return room;
  }

  private buildConnectorChannelTarget(
    channel: SlackChannel,
    score = 0.5,
  ): MessageConnectorTarget | null {
    if (!channel.id || channel.isArchived) {
      return null;
    }
    if (!this.isChannelAllowed(channel.id)) {
      return null;
    }

    const kind = channel.isIm ? "user" : channel.isMpim ? "group" : "channel";
    const label = channel.name ? `#${channel.name}` : channel.id;
    return {
      target: {
        source: "slack",
        channelId: channel.id,
        serverId: this.teamId ?? undefined,
      } as TargetInfo,
      label,
      kind,
      description: channel.purpose?.value || channel.topic?.value || label,
      score,
      contexts: ["social", "connectors"],
      metadata: {
        slackChannelId: channel.id,
        slackTeamId: this.teamId,
        slackChannelType: getSlackChannelType(channel),
        channelName: channel.name,
        isPrivate: channel.isPrivate,
        isMember: channel.isMember,
        topic: channel.topic?.value,
        purpose: channel.purpose?.value,
      },
    };
  }

  private buildConnectorUserTarget(
    user: SlackUser,
    score = 0.5,
  ): MessageConnectorTarget | null {
    if (!user.id || user.deleted || user.isBot || user.isAppUser) {
      return null;
    }
    const label = getSlackUserDisplayName(user);
    return {
      target: {
        source: "slack",
        entityId: user.id as UUID,
        serverId: user.teamId ?? this.teamId ?? undefined,
      } as TargetInfo,
      label: `@${label}`,
      kind: "user",
      description: user.profile.title || "Slack user",
      score,
      contexts: ["social", "connectors"],
      metadata: {
        slackUserId: user.id,
        slackTeamId: user.teamId ?? this.teamId,
        slackName: user.name,
        slackRealName: user.realName,
        slackDisplayName: user.profile.displayName,
        email: user.profile.email,
      },
    };
  }

  private dedupeConnectorTargets(
    targets: MessageConnectorTarget[],
  ): MessageConnectorTarget[] {
    const byKey = new Map<string, MessageConnectorTarget>();
    for (const target of targets) {
      const key = [
        target.kind ?? "target",
        target.target.channelId ?? "",
        target.target.entityId ?? "",
        target.target.threadId ?? "",
      ].join(":");
      const existing = byKey.get(key);
      if (!existing || (target.score ?? 0) > (existing.score ?? 0)) {
        byKey.set(key, target);
      }
    }
    return Array.from(byKey.values()).sort(
      (a, b) => (b.score ?? 0) - (a.score ?? 0),
    );
  }

  private async resolveSlackTargetUserId(
    runtime: IAgentRuntime,
    entityId: string,
  ): Promise<string | null> {
    if (SLACK_USER_ID_PATTERN.test(entityId)) {
      return entityId;
    }

    const entity =
      typeof runtime.getEntityById === "function"
        ? await runtime.getEntityById(entityId as UUID)
        : null;
    const metadataUserId = extractSlackUserIdFromMetadata(entity?.metadata);
    if (metadataUserId) {
      return metadataUserId;
    }

    if (typeof runtime.getRelationships !== "function") {
      return null;
    }

    const relationships = await runtime.getRelationships({
      entityIds: [entityId as UUID],
      tags: ["identity_link"],
    });
    for (const relationship of relationships) {
      const linkedEntityId =
        relationship.sourceEntityId === entityId
          ? relationship.targetEntityId
          : relationship.targetEntityId === entityId
            ? relationship.sourceEntityId
            : null;
      if (!linkedEntityId || linkedEntityId === entityId) {
        continue;
      }
      const linkedEntity =
        typeof runtime.getEntityById === "function"
          ? await runtime.getEntityById(linkedEntityId as UUID)
          : null;
      const linkedUserId = extractSlackUserIdFromMetadata(
        linkedEntity?.metadata,
      );
      if (linkedUserId) {
        return linkedUserId;
      }
    }

    return null;
  }

  private async openDirectMessageChannel(userId: string): Promise<string> {
    if (!this.client) {
      throw new Error("Slack client not initialized");
    }
    const result = await this.client.conversations.open({ users: userId });
    const channel = result.channel as { id?: string } | undefined;
    if (!channel?.id) {
      throw new Error(`Could not open Slack DM channel for user ${userId}`);
    }
    return channel.id;
  }

  async handleSendMessage(
    runtime: IAgentRuntime,
    target: TargetInfo,
    content: Content,
  ): Promise<void> {
    if (!this.client) {
      throw new Error("Slack client not initialized");
    }

    const text = typeof content.text === "string" ? content.text.trim() : "";
    if (!text) {
      throw new Error("Slack SendHandler requires non-empty text content.");
    }

    let channelId = target.channelId;
    let threadTs = target.threadId;

    if (target.roomId && (!channelId || !threadTs)) {
      const room = await runtime.getRoom(target.roomId);
      channelId = channelId ?? room?.channelId;
      const metadata = room?.metadata as Record<string, unknown> | undefined;
      const metadataThreadTs =
        typeof metadata?.threadTs === "string" ? metadata.threadTs : undefined;
      threadTs = threadTs ?? metadataThreadTs;
    }

    if (channelId && SLACK_USER_ID_PATTERN.test(channelId)) {
      channelId = await this.openDirectMessageChannel(channelId);
    }

    if (!channelId && target.entityId) {
      const slackUserId = await this.resolveSlackTargetUserId(
        runtime,
        String(target.entityId),
      );
      if (!slackUserId) {
        throw new Error(
          `Could not resolve Slack user ID for entity ${target.entityId}`,
        );
      }
      channelId = await this.openDirectMessageChannel(slackUserId);
    }

    if (!channelId) {
      throw new Error(
        "Slack SendHandler requires channelId, roomId, or entityId.",
      );
    }

    await this.sendMessage(channelId, text, {
      threadTs,
      replyBroadcast: undefined,
      unfurlLinks: undefined,
      unfurlMedia: undefined,
      mrkdwn: undefined,
      attachments: undefined,
      blocks: undefined,
    });
  }

  async resolveConnectorTargets(
    query: string,
    context: MessageConnectorQueryContext,
  ): Promise<MessageConnectorTarget[]> {
    if (!this.client) {
      return [];
    }

    const normalizedQuery = normalizeSlackConnectorQuery(query);
    const targets: MessageConnectorTarget[] = [];

    try {
      const channels = await this.listChannels({
        types: "public_channel,private_channel,mpim,im",
        limit: 1000,
      });
      for (const channel of channels) {
        const score = scoreSlackConnectorMatch(normalizedQuery, channel.id, [
          channel.name,
          channel.topic?.value,
          channel.purpose?.value,
        ]);
        if (score <= 0) {
          continue;
        }
        const target = this.buildConnectorChannelTarget(channel, score);
        if (target) {
          targets.push(target);
        }
      }
    } catch (error) {
      this.runtime.logger.debug(
        {
          src: "plugin:slack",
          agentId: this.runtime.agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Slack connector channel query failed",
      );
    }

    try {
      const usersResult = await this.client.users.list({ limit: 200 });
      const members = (usersResult.members ?? []) as SlackApiUserMember[];
      for (const member of members) {
        const user: SlackUser = {
          id: member.id ?? "",
          teamId: member.team_id,
          name: member.name ?? "",
          deleted: Boolean(member.deleted),
          realName: member.real_name,
          tz: member.tz,
          tzLabel: member.tz_label,
          tzOffset: member.tz_offset,
          profile: {
            title: member.profile?.title,
            phone: member.profile?.phone,
            skype: member.profile?.skype,
            realName: member.profile?.real_name,
            realNameNormalized: member.profile?.real_name_normalized,
            displayName: member.profile?.display_name,
            displayNameNormalized: member.profile?.display_name_normalized,
            statusText: member.profile?.status_text,
            statusEmoji: member.profile?.status_emoji,
            statusExpiration: member.profile?.status_expiration,
            avatarHash: member.profile?.avatar_hash,
            email: member.profile?.email,
            image24: member.profile?.image_24,
            image32: member.profile?.image_32,
            image48: member.profile?.image_48,
            image72: member.profile?.image_72,
            image192: member.profile?.image_192,
            image512: member.profile?.image_512,
            image1024: member.profile?.image_1024,
            imageOriginal: member.profile?.image_original,
            team: member.profile?.team,
          },
          isAdmin: Boolean(member.is_admin),
          isOwner: Boolean(member.is_owner),
          isPrimaryOwner: Boolean(member.is_primary_owner),
          isRestricted: Boolean(member.is_restricted),
          isUltraRestricted: Boolean(member.is_ultra_restricted),
          isBot: Boolean(member.is_bot),
          isAppUser: Boolean(member.is_app_user),
          updated: member.updated ?? 0,
        };
        const score = scoreSlackConnectorMatch(normalizedQuery, user.id, [
          user.name,
          user.realName,
          user.profile.displayName,
          user.profile.realName,
          user.profile.email,
        ]);
        if (score <= 0) {
          continue;
        }
        const target = this.buildConnectorUserTarget(user, score);
        if (target) {
          targets.push(target);
        }
      }
    } catch (error) {
      this.runtime.logger.debug(
        {
          src: "plugin:slack",
          agentId: this.runtime.agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Slack connector user query failed",
      );
    }

    if (context.target?.channelId) {
      const channel = await this.getChannel(context.target.channelId);
      if (channel) {
        const target = this.buildConnectorChannelTarget(channel, 0.6);
        if (target) {
          targets.push(target);
        }
      }
    }

    return this.dedupeConnectorTargets(targets).slice(0, 25);
  }

  async listConnectorRooms(
    _context: MessageConnectorQueryContext,
  ): Promise<MessageConnectorTarget[]> {
    if (!this.client) {
      return [];
    }

    const channels = await this.listChannels({
      types: "public_channel,private_channel,mpim,im",
      limit: 1000,
    });
    return this.dedupeConnectorTargets(
      channels
        .map((channel) => this.buildConnectorChannelTarget(channel, 0.5))
        .filter((target): target is MessageConnectorTarget => Boolean(target)),
    ).slice(0, 50);
  }

  async listRecentConnectorTargets(
    context: MessageConnectorQueryContext,
  ): Promise<MessageConnectorTarget[]> {
    const targets: MessageConnectorTarget[] = [];
    const room =
      context.roomId && typeof context.runtime.getRoom === "function"
        ? await context.runtime.getRoom(context.roomId)
        : null;
    const channelId =
      context.target?.channelId ??
      (room?.source === "slack" ? room.channelId : undefined);
    const roomMetadata = room?.metadata as Record<string, unknown> | undefined;
    const threadTs =
      context.target?.threadId ??
      (typeof roomMetadata?.threadTs === "string"
        ? roomMetadata.threadTs
        : undefined);

    if (channelId) {
      const channel = await this.getChannel(channelId);
      if (channel) {
        const target = this.buildConnectorChannelTarget(channel, 0.95);
        if (target) {
          if (threadTs) {
            target.kind = "thread";
            target.target.threadId = threadTs;
            target.label = `${target.label ?? channelId} thread`;
            target.metadata = {
              ...(target.metadata ?? {}),
              slackThreadTs: threadTs,
            };
          }
          targets.push(target);
        }
      }
    }

    targets.push(...(await this.listConnectorRooms(context)));
    return this.dedupeConnectorTargets(targets).slice(0, 25);
  }

  async getConnectorChatContext(
    target: TargetInfo,
    context: MessageConnectorQueryContext,
  ): Promise<MessageConnectorChatContext | null> {
    if (!this.client) {
      return null;
    }

    const room =
      target.roomId && typeof context.runtime.getRoom === "function"
        ? await context.runtime.getRoom(target.roomId)
        : null;
    const channelId = target.channelId ?? room?.channelId;
    if (!channelId) {
      return null;
    }

    const metadata = room?.metadata as Record<string, unknown> | undefined;
    const threadTs =
      target.threadId ??
      (typeof metadata?.threadTs === "string" ? metadata.threadTs : undefined);
    const channel = await this.getChannel(channelId);

    const messages = threadTs
      ? await this.client.conversations.replies({
          channel: channelId,
          ts: threadTs,
          limit: 10,
        })
      : { messages: await this.readHistory(channelId, { limit: 10 }) };
    const rawMessages = (messages.messages ?? []) as Array<
      SlackMessage | Record<string, unknown>
    >;
    const recentMessages: MessageConnectorChatContext["recentMessages"] = [];
    for (const rawMessage of rawMessages.slice().reverse()) {
      const text = String((rawMessage as SlackMessage).text ?? "");
      if (!text.trim()) {
        continue;
      }
      const userId =
        (rawMessage as SlackMessage).user ??
        (rawMessage as Record<string, string | undefined>).user;
      const user =
        typeof userId === "string" ? await this.getUser(userId) : null;
      recentMessages.push({
        entityId: userId ? (userId as UUID) : undefined,
        name: user ? getSlackUserDisplayName(user) : userId,
        text,
        timestamp: Number((rawMessage as SlackMessage).ts) * 1000 || undefined,
        metadata: {
          slackMessageTs: (rawMessage as SlackMessage).ts,
          slackUserId: userId,
        },
      });
    }

    return {
      target: {
        source: "slack",
        roomId: target.roomId ?? room?.id,
        channelId,
        serverId: target.serverId ?? this.teamId ?? undefined,
        threadId: threadTs,
      } as TargetInfo,
      label: channel?.name ? `#${channel.name}` : channelId,
      summary: channel?.purpose?.value || channel?.topic?.value,
      recentMessages,
      metadata: {
        slackChannelId: channelId,
        slackTeamId: this.teamId,
        slackThreadTs: threadTs,
        channelName: channel?.name,
      },
    };
  }

  async getConnectorUserContext(
    entityId: UUID | string,
    context: MessageConnectorQueryContext,
  ): Promise<MessageConnectorUserContext | null> {
    const slackUserId = await this.resolveSlackTargetUserId(
      context.runtime,
      String(entityId),
    );
    if (!slackUserId) {
      return null;
    }
    const user = await this.getUser(slackUserId);
    if (!user) {
      return null;
    }

    return {
      entityId,
      label: getSlackUserDisplayName(user),
      aliases: [
        user.name,
        user.realName,
        user.profile.displayName,
        user.profile.realName,
        user.profile.email,
      ].filter((value): value is string => Boolean(value)),
      handles: {
        slack: user.id,
        ...(user.profile.email ? { email: user.profile.email } : {}),
      },
      metadata: {
        slackUserId: user.id,
        slackTeamId: user.teamId ?? this.teamId,
        profile: { ...user.profile },
      },
    };
  }

  async getUser(userId: string): Promise<SlackUser | null> {
    // Check cache first
    const cachedUser = this.userCache.get(userId);
    if (cachedUser) {
      return cachedUser;
    }

    if (!this.client) return null;

    const result = await this.client.users.info({ user: userId });
    if (!result.user) return null;

    const user: SlackUser = {
      id: result.user.id ?? userId,
      teamId: result.user.team_id,
      name: result.user.name ?? "",
      deleted: result.user.deleted || false,
      realName: result.user.real_name,
      tz: result.user.tz,
      tzLabel: result.user.tz_label,
      tzOffset: result.user.tz_offset,
      profile: {
        title: result.user.profile?.title,
        phone: result.user.profile?.phone,
        skype: result.user.profile?.skype,
        realName: result.user.profile?.real_name,
        realNameNormalized: result.user.profile?.real_name_normalized,
        displayName: result.user.profile?.display_name,
        displayNameNormalized: result.user.profile?.display_name_normalized,
        statusText: result.user.profile?.status_text,
        statusEmoji: result.user.profile?.status_emoji,
        statusExpiration: result.user.profile?.status_expiration,
        avatarHash: result.user.profile?.avatar_hash,
        email: result.user.profile?.email,
        image24: result.user.profile?.image_24,
        image32: result.user.profile?.image_32,
        image48: result.user.profile?.image_48,
        image72: result.user.profile?.image_72,
        image192: result.user.profile?.image_192,
        image512: result.user.profile?.image_512,
        image1024: result.user.profile?.image_1024,
        imageOriginal: result.user.profile?.image_original,
        team: result.user.profile?.team,
      },
      isAdmin: result.user.is_admin || false,
      isOwner: result.user.is_owner || false,
      isPrimaryOwner: result.user.is_primary_owner || false,
      isRestricted: result.user.is_restricted || false,
      isUltraRestricted: result.user.is_ultra_restricted || false,
      isBot: result.user.is_bot || false,
      isAppUser: result.user.is_app_user || false,
      updated: result.user.updated || 0,
    };

    this.userCache.set(userId, user);
    return user;
  }

  async getChannel(channelId: string): Promise<SlackChannel | null> {
    // Check cache first
    const cachedChannel = this.channelCache.get(channelId);
    if (cachedChannel) {
      return cachedChannel;
    }

    if (!this.client) return null;

    const result = await this.client.conversations.info({ channel: channelId });
    if (!result.channel) return null;

    const channel: SlackChannel = {
      id: (result.channel as { id: string }).id,
      name: (result.channel as { name: string }).name || "",
      isChannel:
        (result.channel as { is_channel?: boolean }).is_channel || false,
      isGroup: (result.channel as { is_group?: boolean }).is_group || false,
      isIm: (result.channel as { is_im?: boolean }).is_im || false,
      isMpim: (result.channel as { is_mpim?: boolean }).is_mpim || false,
      isPrivate:
        (result.channel as { is_private?: boolean }).is_private || false,
      isArchived:
        (result.channel as { is_archived?: boolean }).is_archived || false,
      isGeneral:
        (result.channel as { is_general?: boolean }).is_general || false,
      isShared: (result.channel as { is_shared?: boolean }).is_shared || false,
      isOrgShared:
        (result.channel as { is_org_shared?: boolean }).is_org_shared || false,
      isMember: (result.channel as { is_member?: boolean }).is_member || false,
      topic: (
        result.channel as {
          topic?: { value: string; creator: string; last_set: number };
        }
      ).topic
        ? {
            value: (result.channel as { topic: { value: string } }).topic.value,
            creator: (result.channel as { topic: { creator: string } }).topic
              .creator,
            lastSet: (result.channel as { topic: { last_set: number } }).topic
              .last_set,
          }
        : undefined,
      purpose: (
        result.channel as {
          purpose?: { value: string; creator: string; last_set: number };
        }
      ).purpose
        ? {
            value: (result.channel as { purpose: { value: string } }).purpose
              .value,
            creator: (result.channel as { purpose: { creator: string } })
              .purpose.creator,
            lastSet: (result.channel as { purpose: { last_set: number } })
              .purpose.last_set,
          }
        : undefined,
      numMembers: (result.channel as { num_members?: number }).num_members,
      created: (result.channel as { created: number }).created,
      creator: (result.channel as { creator: string }).creator,
    };

    this.channelCache.set(channelId, channel);
    return channel;
  }

  async sendMessage(
    channelId: string,
    text: string,
    options?: SlackMessageSendOptions,
  ): Promise<{ ts: string; channelId: string }> {
    if (!this.client) {
      throw new Error("Slack client not initialized");
    }

    // Split message if too long
    const convertedText = markdownToSlackMrkdwn(text);
    const messages = this.splitMessage(convertedText);
    let lastTs = "";

    for (const msg of messages) {
      const result = await this.client.chat.postMessage({
        channel: channelId,
        text: msg,
        thread_ts: options?.threadTs,
        reply_broadcast: options?.replyBroadcast,
        unfurl_links: options?.unfurlLinks,
        unfurl_media: options?.unfurlMedia,
        mrkdwn: options?.mrkdwn ?? true,
        attachments: options?.attachments as never,
        blocks: options?.blocks as never,
      });

      lastTs = result.ts as string;
    }

    return { ts: lastTs, channelId };
  }

  async sendReaction(
    channelId: string,
    messageTs: string,
    emoji: string,
  ): Promise<void> {
    if (!this.client) {
      throw new Error("Slack client not initialized");
    }

    // Remove colons if present
    const cleanEmoji = emoji.replace(/^:/, "").replace(/:$/, "");

    await this.client.reactions.add({
      channel: channelId,
      timestamp: messageTs,
      name: cleanEmoji,
    });
  }

  async removeReaction(
    channelId: string,
    messageTs: string,
    emoji: string,
  ): Promise<void> {
    if (!this.client) {
      throw new Error("Slack client not initialized");
    }

    const cleanEmoji = emoji.replace(/^:/, "").replace(/:$/, "");

    await this.client.reactions.remove({
      channel: channelId,
      timestamp: messageTs,
      name: cleanEmoji,
    });
  }

  async editMessage(
    channelId: string,
    messageTs: string,
    text: string,
  ): Promise<void> {
    if (!this.client) {
      throw new Error("Slack client not initialized");
    }

    await this.client.chat.update({
      channel: channelId,
      ts: messageTs,
      text,
    });
  }

  async deleteMessage(channelId: string, messageTs: string): Promise<void> {
    if (!this.client) {
      throw new Error("Slack client not initialized");
    }

    await this.client.chat.delete({
      channel: channelId,
      ts: messageTs,
    });
  }

  async pinMessage(channelId: string, messageTs: string): Promise<void> {
    if (!this.client) {
      throw new Error("Slack client not initialized");
    }

    await this.client.pins.add({
      channel: channelId,
      timestamp: messageTs,
    });
  }

  async unpinMessage(channelId: string, messageTs: string): Promise<void> {
    if (!this.client) {
      throw new Error("Slack client not initialized");
    }

    await this.client.pins.remove({
      channel: channelId,
      timestamp: messageTs,
    });
  }

  async listPins(channelId: string): Promise<SlackMessage[]> {
    if (!this.client) {
      throw new Error("Slack client not initialized");
    }

    const result = await this.client.pins.list({ channel: channelId });

    return (result.items || [])
      .filter(
        (item): item is { type: "message"; message: Record<string, unknown> } =>
          item.type === "message" && "message" in item && !!item.message,
      )
      .map((item) => ({
        type: item.message.type as string,
        subtype: item.message.subtype as string | undefined,
        ts: item.message.ts as string,
        user: item.message.user as string | undefined,
        text: item.message.text as string,
        threadTs: item.message.thread_ts as string | undefined,
        replyCount: item.message.reply_count as number | undefined,
        replyUsersCount: item.message.reply_users_count as number | undefined,
        latestReply: item.message.latest_reply as string | undefined,
        reactions: item.message.reactions as
          | { name: string; count: number; users: string[] }[]
          | undefined,
        files: item.message.files as SlackFile[] | undefined,
        attachments: item.message.attachments as SlackAttachment[] | undefined,
        blocks: item.message.blocks as SlackBlock[] | undefined,
      }));
  }

  async readHistory(
    channelId: string,
    options?: { limit?: number; before?: string; after?: string },
  ): Promise<SlackMessage[]> {
    if (!this.client) {
      throw new Error("Slack client not initialized");
    }

    const result = await this.client.conversations.history({
      channel: channelId,
      limit: options?.limit || 100,
      latest: options?.before,
      oldest: options?.after,
    });

    return (result.messages || []).map((msg) => ({
      type: msg.type as string,
      subtype: msg.subtype as string | undefined,
      ts: msg.ts as string,
      user: msg.user as string | undefined,
      text: msg.text as string,
      threadTs: msg.thread_ts as string | undefined,
      replyCount: msg.reply_count as number | undefined,
      replyUsersCount: msg.reply_users_count as number | undefined,
      latestReply: msg.latest_reply as string | undefined,
      reactions: msg.reactions as
        | { name: string; count: number; users: string[] }[]
        | undefined,
      files: msg.files as SlackFile[] | undefined,
      attachments: msg.attachments as SlackAttachment[] | undefined,
      blocks: msg.blocks as SlackBlock[] | undefined,
    }));
  }

  async listChannels(options?: {
    types?: string;
    limit?: number;
  }): Promise<SlackChannel[]> {
    if (!this.client) {
      throw new Error("Slack client not initialized");
    }

    const result = await this.client.conversations.list({
      types: options?.types || "public_channel,private_channel",
      limit: options?.limit || 1000,
    });

    return (result.channels || []).map((ch) => ({
      id: ch.id ?? "",
      name: ch.name || "",
      isChannel: ch.is_channel || false,
      isGroup: ch.is_group || false,
      isIm: ch.is_im || false,
      isMpim: ch.is_mpim || false,
      isPrivate: ch.is_private || false,
      isArchived: ch.is_archived || false,
      isGeneral: ch.is_general || false,
      isShared: ch.is_shared || false,
      isOrgShared: ch.is_org_shared || false,
      isMember: ch.is_member || false,
      topic: ch.topic
        ? {
            value: ch.topic.value ?? "",
            creator: ch.topic.creator ?? "",
            lastSet: ch.topic.last_set ?? 0,
          }
        : undefined,
      purpose: ch.purpose
        ? {
            value: ch.purpose.value ?? "",
            creator: ch.purpose.creator ?? "",
            lastSet: ch.purpose.last_set ?? 0,
          }
        : undefined,
      numMembers: ch.num_members,
      created: ch.created || 0,
      creator: ch.creator || "",
    }));
  }

  async getEmojiList(): Promise<Record<string, string>> {
    if (!this.client) {
      throw new Error("Slack client not initialized");
    }

    const result = await this.client.emoji.list();
    return (result.emoji || {}) as Record<string, string>;
  }

  async uploadFile(
    channelId: string,
    content: Buffer | string,
    filename: string,
    options?: { title?: string; initialComment?: string; threadTs?: string },
  ): Promise<{ fileId: string; permalink: string }> {
    if (!this.client) {
      throw new Error("Slack client not initialized");
    }

    const result = await this.client.files.uploadV2({
      channel_id: channelId,
      content: typeof content === "string" ? content : undefined,
      file: typeof content !== "string" ? content : undefined,
      filename,
      title: options?.title,
      initial_comment: options?.initialComment,
      thread_ts: options?.threadTs,
    });

    const resultWithFile = result as WebAPICallResult & {
      file?: { id: string; permalink: string };
    };
    const file = resultWithFile.file;
    return {
      fileId: file?.id || "",
      permalink: file?.permalink || "",
    };
  }

  private splitMessage(text: string): string[] {
    if (text.length <= MAX_SLACK_MESSAGE_LENGTH) {
      return [text];
    }

    const messages: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= MAX_SLACK_MESSAGE_LENGTH) {
        messages.push(remaining);
        break;
      }

      // Find a good split point (prefer newlines, then spaces)
      let splitIndex = MAX_SLACK_MESSAGE_LENGTH;

      const lastNewline = remaining.lastIndexOf("\n", MAX_SLACK_MESSAGE_LENGTH);
      if (lastNewline > MAX_SLACK_MESSAGE_LENGTH / 2) {
        splitIndex = lastNewline + 1;
      } else {
        const lastSpace = remaining.lastIndexOf(" ", MAX_SLACK_MESSAGE_LENGTH);
        if (lastSpace > MAX_SLACK_MESSAGE_LENGTH / 2) {
          splitIndex = lastSpace + 1;
        }
      }

      messages.push(remaining.slice(0, splitIndex));
      remaining = remaining.slice(splitIndex);
    }

    return messages;
  }

  /**
   * Add a channel to the dynamic allowed list
   */
  addAllowedChannel(channelId: string): void {
    if (isValidChannelId(channelId)) {
      this.dynamicChannelIds.add(channelId);
    }
  }

  /**
   * Remove a channel from the dynamic allowed list
   */
  removeAllowedChannel(channelId: string): void {
    this.dynamicChannelIds.delete(channelId);
  }

  /**
   * Get all currently allowed channel IDs
   */
  getAllowedChannelIds(): string[] {
    return [...this.allowedChannelIds, ...this.dynamicChannelIds];
  }

  /**
   * Check if the service is connected
   */
  isServiceConnected(): boolean {
    return this.isConnected && this.app !== null;
  }

  /**
   * Get the bot's user ID
   */
  getBotUserId(): string | null {
    return this.botUserId;
  }

  /**
   * Get the team/workspace ID
   */
  getTeamId(): string | null {
    return this.teamId;
  }

  /**
   * Clear the user cache
   */
  clearUserCache(): void {
    this.userCache.clear();
  }

  /**
   * Clear the channel cache
   */
  clearChannelCache(): void {
    this.channelCache.clear();
  }
}
