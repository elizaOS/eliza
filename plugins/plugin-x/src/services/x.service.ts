import {
  type Content,
  type IAgentRuntime,
  logger,
  type MessageConnectorQueryContext,
  type MessageConnectorTarget,
  type MessageConnectorUserContext,
  parseBooleanFromText,
  Service,
  type TargetInfo,
} from "@elizaos/core";
import { ClientBase } from "../base";
import { TwitterDiscoveryClient } from "../discovery";
import { validateTwitterConfig } from "../environment";
import { TwitterInteractionClient } from "../interactions";
import { TwitterPostClient } from "../post";
import { TwitterTimelineClient } from "../timeline";
import type { ITwitterClient, TwitterClientState } from "../types";
import { getSetting } from "../utils/settings";

const X_CONNECTOR_CONTEXTS = ["social", "connectors"];
const X_CONNECTOR_CAPABILITIES = [
  "send_message",
  "resolve_targets",
  "user_context",
];
const X_USER_ID_PATTERN = /^\d+$/;

function normalizeXConnectorQuery(value: string): string {
  return value.trim().replace(/^@/, "").toLowerCase();
}

/**
 * A manager that orchestrates all specialized Twitter logic:
 * - client: base operations (login, timeline caching, etc.)
 * - post: autonomous posting logic
 * - interaction: handling mentions, replies, and autonomous targeting
 * - timeline: processing timeline for actions (likes, retweets, replies)
 * - discovery: autonomous content discovery and engagement
 */
export class TwitterClientInstance implements ITwitterClient {
  client: ClientBase;
  post?: TwitterPostClient;
  interaction?: TwitterInteractionClient;
  timeline?: TwitterTimelineClient;
  discovery?: TwitterDiscoveryClient;

  constructor(runtime: IAgentRuntime, state: TwitterClientState) {
    // Pass twitterConfig to the base client
    this.client = new ClientBase(runtime, state);

    // Posting logic
    const postEnabled = parseBooleanFromText(
      getSetting(runtime, "TWITTER_ENABLE_POST"),
    );
    logger.debug(
      `TWITTER_ENABLE_POST setting value: ${JSON.stringify(postEnabled)}, type: ${typeof postEnabled}`,
    );

    if (postEnabled) {
      logger.info("Twitter posting is ENABLED - creating post client");
      this.post = new TwitterPostClient(this.client, runtime, state);
    } else {
      logger.info(
        "Twitter posting is DISABLED - set TWITTER_ENABLE_POST=true to enable automatic posting",
      );
    }

    // Mentions and interactions
    const repliesEnabled =
      (getSetting(runtime, "TWITTER_ENABLE_REPLIES") ??
        process.env.TWITTER_ENABLE_REPLIES) !== "false";

    if (repliesEnabled) {
      logger.info("Twitter replies/interactions are ENABLED");
      this.interaction = new TwitterInteractionClient(
        this.client,
        runtime,
        state,
      );
    } else {
      logger.info("Twitter replies/interactions are DISABLED");
    }

    // Timeline actions (likes, retweets, replies)
    const actionsEnabled =
      (getSetting(runtime, "TWITTER_ENABLE_ACTIONS") ??
        process.env.TWITTER_ENABLE_ACTIONS) === "true";

    if (actionsEnabled) {
      logger.info("Twitter timeline actions are ENABLED");
      this.timeline = new TwitterTimelineClient(this.client, runtime, state);
    } else {
      logger.info("Twitter timeline actions are DISABLED");
    }

    // Discovery service for autonomous content discovery
    const discoveryEnabled =
      (getSetting(runtime, "TWITTER_ENABLE_DISCOVERY") ??
        process.env.TWITTER_ENABLE_DISCOVERY) === "true" ||
      (actionsEnabled &&
        (getSetting(runtime, "TWITTER_ENABLE_DISCOVERY") ??
          process.env.TWITTER_ENABLE_DISCOVERY) !== "false");

    if (discoveryEnabled) {
      logger.info("Twitter discovery service is ENABLED");
      this.discovery = new TwitterDiscoveryClient(this.client, runtime, state);
    } else {
      logger.info(
        "Twitter discovery service is DISABLED - set TWITTER_ENABLE_DISCOVERY=true to enable",
      );
    }
  }
}

export class XService extends Service {
  static serviceType = "x";

  // Add the required abstract property
  capabilityDescription = "The agent is able to send and receive messages on X";

  public twitterClient?: TwitterClientInstance;

  static async start(runtime: IAgentRuntime): Promise<XService> {
    const service = new XService();
    service.runtime = runtime;

    try {
      await validateTwitterConfig(runtime);
      logger.log("✅ Twitter configuration validated successfully");

      // Create the Twitter client instance
      service.twitterClient = new TwitterClientInstance(runtime, {});

      // Initialize the base client (this is where the runtime database access happens)
      await service.twitterClient.client.init();

      // Start appropriate services based on configuration
      if (service.twitterClient.post) {
        logger.log("📮 Starting Twitter post client...");
        await service.twitterClient.post.start();
      }

      if (service.twitterClient.interaction) {
        logger.log("💬 Starting Twitter interaction client...");
        await service.twitterClient.interaction.start();
      }

      if (service.twitterClient.timeline) {
        logger.log("📊 Starting Twitter timeline client...");
        await service.twitterClient.timeline.start();
      }

      if (service.twitterClient.discovery) {
        logger.log("🔍 Starting Twitter discovery client...");
        await service.twitterClient.discovery.start();
      }

      logger.log("✅ Twitter service started successfully");
    } catch (error) {
      logger.error(
        `🚨 Failed to start Twitter service: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }

    return service;
  }

  static registerSendHandlers(
    runtime: IAgentRuntime,
    serviceInstance: XService,
  ): void {
    if (!serviceInstance) {
      return;
    }

    const sendHandler = serviceInstance.handleSendMessage.bind(serviceInstance);
    if (typeof runtime.registerMessageConnector === "function") {
      runtime.registerMessageConnector({
        source: "x",
        label: "X DMs",
        description:
          "X/Twitter direct-message connector. Public tweets remain under X post actions.",
        capabilities: [...X_CONNECTOR_CAPABILITIES],
        supportedTargetKinds: ["user", "contact"],
        contexts: [...X_CONNECTOR_CONTEXTS],
        metadata: {
          service: XService.serviceType,
        },
        resolveTargets:
          serviceInstance.resolveConnectorTargets.bind(serviceInstance),
        listRecentTargets:
          serviceInstance.listRecentConnectorTargets.bind(serviceInstance),
        getUserContext:
          serviceInstance.getConnectorUserContext.bind(serviceInstance),
        sendHandler,
      });
      runtime.logger.info(
        { src: "plugin:x", agentId: runtime.agentId },
        "Registered X DM connector",
      );
      return;
    }

    runtime.registerSendHandler("x", sendHandler);
  }

  async handleSendMessage(
    _runtime: IAgentRuntime,
    target: TargetInfo,
    content: Content,
  ): Promise<void> {
    const text = typeof content.text === "string" ? content.text.trim() : "";
    if (!text) {
      throw new Error("X DM connector requires non-empty text content.");
    }

    const metadata = (target as { metadata?: unknown }).metadata;
    const metadataRecord =
      metadata && typeof metadata === "object"
        ? (metadata as Record<string, unknown>)
        : undefined;
    const recipient = await this.resolveDmRecipient(
      (typeof metadataRecord?.xUserId === "string"
        ? metadataRecord.xUserId
        : undefined) ??
        (typeof metadataRecord?.twitterUserId === "string"
          ? metadataRecord.twitterUserId
          : undefined) ??
        (typeof metadataRecord?.xUsername === "string"
          ? metadataRecord.xUsername
          : undefined) ??
        (typeof metadataRecord?.twitterUsername === "string"
          ? metadataRecord.twitterUsername
          : undefined) ??
        (typeof target.entityId === "string" ? target.entityId : undefined) ??
        target.channelId ??
        target.threadId,
    );

    if (!recipient) {
      throw new Error(
        "X DM connector requires a resolvable recipient user id.",
      );
    }

    await this.sendXDirectMessage(recipient, text);
  }

  async resolveConnectorTargets(
    query: string,
    _context: MessageConnectorQueryContext,
  ): Promise<MessageConnectorTarget[]> {
    const normalizedQuery = normalizeXConnectorQuery(query);
    if (!normalizedQuery) {
      return this.listRecentConnectorTargets(_context);
    }

    if (X_USER_ID_PATTERN.test(normalizedQuery)) {
      return [this.buildUserTarget(normalizedQuery, undefined, 1)];
    }

    const base = this.twitterClient?.client;
    if (!base) {
      return [];
    }

    try {
      const profile = await base.fetchProfile(normalizedQuery);
      return [this.buildUserTarget(profile.id, profile.username, 0.95)];
    } catch (error) {
      logger.debug(
        {
          src: "plugin:x",
          query,
          error: error instanceof Error ? error.message : String(error),
        },
        "X connector profile resolution failed",
      );
      return [];
    }
  }

  async listRecentConnectorTargets(
    _context: MessageConnectorQueryContext,
  ): Promise<MessageConnectorTarget[]> {
    const messages = await this.listRecentDirectMessages(25).catch(() => []);
    const seen = new Set<string>();
    const targets: MessageConnectorTarget[] = [];
    for (const message of messages) {
      if (!message.senderId || seen.has(message.senderId)) {
        continue;
      }
      seen.add(message.senderId);
      targets.push(
        this.buildUserTarget(
          message.senderId,
          message.senderUsername ?? undefined,
          0.8,
        ),
      );
    }
    return targets;
  }

  async getConnectorUserContext(
    entityId: string,
    _context: MessageConnectorQueryContext,
  ): Promise<MessageConnectorUserContext | null> {
    const base = this.twitterClient?.client;
    if (!base) {
      return null;
    }

    try {
      if (X_USER_ID_PATTERN.test(entityId)) {
        const username =
          await base.twitterClient.getScreenNameByUserId(entityId);
        return {
          entityId,
          label: `@${username}`,
          aliases: [username, entityId],
          handles: { x: username },
          metadata: { xUserId: entityId },
        };
      }

      const username = normalizeXConnectorQuery(entityId);
      const profile = await base.fetchProfile(username);
      return {
        entityId,
        label: `@${profile.username}`,
        aliases: [profile.username, profile.screenName, profile.id].filter(
          Boolean,
        ),
        handles: { x: profile.username },
        metadata: { xUserId: profile.id, bio: profile.bio },
      };
    } catch {
      return null;
    }
  }

  private buildUserTarget(
    userId: string,
    username: string | undefined,
    score: number,
  ): MessageConnectorTarget {
    return {
      target: {
        source: "x",
        entityId: userId,
      } as TargetInfo,
      label: username ? `@${username}` : `X user ${userId}`,
      kind: "user",
      description: "X/Twitter direct-message recipient",
      score,
      contexts: [...X_CONNECTOR_CONTEXTS],
      metadata: {
        xUserId: userId,
        ...(username ? { xUsername: username } : {}),
      },
    };
  }

  private async getV2DmClient(): Promise<{
    v2: {
      sendDmToParticipant?: (
        participantId: string,
        body: { text: string },
      ) => Promise<{ data?: { dm_event_id?: string } }>;
      listDmEvents?: (opts: Record<string, unknown>) => AsyncIterable<{
        id?: string;
        sender_id?: string;
        text?: string;
        created_at?: string;
        event_type?: string;
      }> & {
        includes?: { users?: Array<{ id: string; username?: string }> };
      };
    };
  }> {
    const base = this.twitterClient?.client;
    const auth = (
      base as unknown as { auth?: { getV2Client: () => Promise<unknown> } }
    )?.auth;
    if (!auth) {
      throw new Error("X auth client not initialized");
    }
    return (await auth.getV2Client()) as {
      v2: {
        sendDmToParticipant?: (
          participantId: string,
          body: { text: string },
        ) => Promise<{ data?: { dm_event_id?: string } }>;
        listDmEvents?: (opts: Record<string, unknown>) => AsyncIterable<{
          id?: string;
          sender_id?: string;
          text?: string;
          created_at?: string;
          event_type?: string;
        }> & {
          includes?: { users?: Array<{ id: string; username?: string }> };
        };
      };
    };
  }

  private async sendXDirectMessage(
    recipient: string,
    text: string,
  ): Promise<void> {
    const client = await this.getV2DmClient();
    if (!client.v2.sendDmToParticipant) {
      throw new Error(
        "X v2 client does not expose sendDmToParticipant; DM send requires DM API scopes.",
      );
    }
    await client.v2.sendDmToParticipant(recipient, { text });
  }

  private async resolveDmRecipient(
    value: string | undefined,
  ): Promise<string | null> {
    if (!value) {
      return null;
    }

    const normalized = normalizeXConnectorQuery(value);
    if (!normalized) {
      return null;
    }

    if (X_USER_ID_PATTERN.test(normalized)) {
      return normalized;
    }

    const base = this.twitterClient?.client;
    if (!base) {
      return null;
    }

    const profile = await base.fetchProfile(normalized);
    return profile.id;
  }

  private async listRecentDirectMessages(limit: number): Promise<
    Array<{
      id: string;
      senderId: string;
      senderUsername: string | null;
      text: string;
      createdAt: string | null;
    }>
  > {
    const client = await this.getV2DmClient();
    const iterator = client.v2.listDmEvents?.({
      max_results: Math.min(Math.max(1, limit), 50),
      "dm_event.fields": [
        "id",
        "created_at",
        "sender_id",
        "text",
        "event_type",
      ],
      "user.fields": ["id", "username"],
      expansions: ["sender_id"],
      event_types: ["MessageCreate"],
    });
    if (!iterator) {
      return [];
    }

    const usernameMap = new Map<string, string>();
    for (const user of iterator.includes?.users ?? []) {
      if (user.id && user.username) {
        usernameMap.set(user.id, user.username);
      }
    }

    const messages: Array<{
      id: string;
      senderId: string;
      senderUsername: string | null;
      text: string;
      createdAt: string | null;
    }> = [];
    for await (const event of iterator) {
      if (event.event_type && event.event_type !== "MessageCreate") {
        continue;
      }
      messages.push({
        id: event.id ?? "",
        senderId: event.sender_id ?? "",
        senderUsername: event.sender_id
          ? (usernameMap.get(event.sender_id) ?? null)
          : null,
        text: event.text ?? "",
        createdAt: event.created_at ?? null,
      });
      if (messages.length >= limit) {
        break;
      }
    }
    return messages;
  }

  async stop(): Promise<void> {
    // Stop all the clients
    if (this.twitterClient?.post) {
      await this.twitterClient.post.stop();
    }

    if (this.twitterClient?.interaction) {
      await this.twitterClient.interaction.stop();
    }

    if (this.twitterClient?.timeline) {
      await this.twitterClient.timeline.stop();
    }

    if (this.twitterClient?.discovery) {
      await this.twitterClient.discovery.stop();
    }

    logger.log("X service stopped");
  }
}

// Backward-compatible alias for users still importing { TwitterService }.
export const TwitterService = XService;
