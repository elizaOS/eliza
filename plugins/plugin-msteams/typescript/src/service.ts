import http from "node:http";
import {
  ChannelType,
  type Content,
  createUniqueUuid,
  type Entity,
  type EventPayload,
  EventType,
  type IAgentRuntime,
  logger,
  type Room,
  Service,
  type TargetInfo,
  type UUID,
  type World,
} from "@elizaos/core";
import { ActivityTypes, MessageFactory, type TurnContext } from "botbuilder";
import { MSTeamsClient } from "./client";
import {
  buildMSTeamsSettings,
  type MSTeamsSettings,
  resolveMSTeamsCredentials,
  validateMSTeamsConfig,
} from "./environment";
import {
  type MSTeamsContent,
  type MSTeamsConversationType,
  MSTeamsEventType,
  type MSTeamsMessagePayload,
  type MSTeamsUser,
} from "./types";

export const MSTEAMS_SERVICE_NAME = "msteams";

/**
 * MS Teams Service for elizaOS
 *
 * Provides integration with Microsoft Teams via Bot Framework:
 * - Webhook handling for incoming messages
 * - Proactive messaging
 * - Adaptive Cards
 * - Polls
 * - File sharing via Graph API
 */
export class MSTeamsService extends Service {
  static serviceType = MSTEAMS_SERVICE_NAME;
  capabilityDescription =
    "The agent is able to send and receive messages on Microsoft Teams";

  private client: MSTeamsClient | null = null;
  private settings: MSTeamsSettings | null = null;
  private server: http.Server | null = null;
  private knownConversations: Map<
    string,
    { type: MSTeamsConversationType; name?: string }
  > = new Map();
  private syncedEntityIds: Set<string> = new Set();

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
  }

  static async start(runtime: IAgentRuntime): Promise<MSTeamsService> {
    const service = new MSTeamsService(runtime);

    const config = await validateMSTeamsConfig(runtime);
    if (!config) {
      logger.warn("MS Teams configuration not valid - service will not start");
      return service;
    }

    const settings = buildMSTeamsSettings(config);
    if (!settings.enabled) {
      logger.info("MS Teams service disabled via configuration");
      return service;
    }

    const credentials = resolveMSTeamsCredentials(settings);
    if (!credentials) {
      logger.warn(
        "MS Teams credentials not configured - service will not start",
      );
      return service;
    }

    service.settings = settings;
    service.client = new MSTeamsClient(credentials, settings);

    await service.startWebhookServer();
    logger.success(
      `MS Teams service started for character ${runtime.character.name}`,
    );

    return service;
  }

  static async stop(runtime: IAgentRuntime): Promise<void> {
    const service = (await runtime.getService(MSTEAMS_SERVICE_NAME)) as
      | MSTeamsService
      | undefined;
    if (service) {
      await service.stop();
    }
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server?.close(() => resolve());
      });
      this.server = null;
      logger.info("MS Teams webhook server stopped");
    }
  }

  /**
   * Start the webhook server for incoming messages
   */
  private async startWebhookServer(): Promise<void> {
    if (!this.client || !this.settings) {
      throw new Error("Client not initialized");
    }

    const adapter = this.client.getAdapter();
    const webhookPath = this.settings.webhookPath;

    this.server = http.createServer(async (req, res) => {
      if (req.url === webhookPath && req.method === "POST") {
        try {
          // Collect request body
          const chunks: Buffer[] = [];
          req.on("data", (chunk) => chunks.push(chunk));
          req.on("end", async () => {
            const body = Buffer.concat(chunks).toString();

            // Create mock request/response for Bot Framework adapter
            const mockReq = {
              body: JSON.parse(body),
              headers: req.headers,
              method: req.method,
            };

            // Create a mock response object compatible with Bot Framework adapter
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const mockRes: Record<string, unknown> = {
              socket: res.socket,
              header: (name: string, value?: string | string[]) => {
                if (value !== undefined) {
                  res.setHeader(name, value);
                }
                return mockRes;
              },
              status: (code: number) => {
                res.statusCode = code;
                return mockRes;
              },
              send: (data?: unknown) => {
                if (data) {
                  res.setHeader("Content-Type", "application/json");
                  res.end(JSON.stringify(data));
                } else {
                  res.end();
                }
                return mockRes;
              },
              end: () => {
                res.end();
                return mockRes;
              },
            };

            // Cast to satisfy adapter.process type requirements
            // The mockReq and mockRes provide minimal compatibility with Bot Framework adapter
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await (
              adapter.process as (
                req: unknown,
                res: unknown,
                logic: (context: TurnContext) => Promise<void>,
              ) => Promise<void>
            )(mockReq, mockRes, async (context: TurnContext) => {
              await this.handleIncomingActivity(context);
            });
          });
        } catch (error) {
          logger.error({ error }, "Error processing MS Teams webhook");
          res.statusCode = 500;
          res.end();
        }
      } else if (req.url === "/health" && req.method === "GET") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ status: "ok", service: "msteams" }));
      } else {
        res.statusCode = 404;
        res.end();
      }
    });

    const port = this.settings.webhookPort;
    await new Promise<void>((resolve) => {
      this.server?.listen(port, () => {
        logger.info(`MS Teams webhook server listening on port ${port}`);
        resolve();
      });
    });
  }

  /**
   * Handle incoming Bot Framework activity
   */
  private async handleIncomingActivity(context: TurnContext): Promise<void> {
    const activity = context.activity;

    // Store conversation reference for proactive messaging
    this.client?.storeConversationReference(context);

    switch (activity.type) {
      case ActivityTypes.Message:
        await this.handleMessage(context);
        break;

      case ActivityTypes.ConversationUpdate:
        await this.handleConversationUpdate(context);
        break;

      case ActivityTypes.MessageReaction:
        await this.handleReaction(context);
        break;

      case ActivityTypes.Invoke:
        await this.handleInvoke(context);
        break;

      default:
        logger.debug(`Unhandled activity type: ${activity.type}`);
    }
  }

  /**
   * Handle incoming message
   */
  private async handleMessage(context: TurnContext): Promise<void> {
    if (!this.runtime) return;

    const activity = context.activity;

    // Skip messages from self
    const botId = activity.recipient?.id;
    if (activity.from?.id === botId) {
      return;
    }

    // Validate tenant if configured
    if (this.settings?.allowedTenants.length) {
      const tenantId = activity.conversation?.tenantId;
      if (!tenantId || !this.settings.allowedTenants.includes(tenantId)) {
        logger.debug(`Ignoring message from non-allowed tenant: ${tenantId}`);
        return;
      }
    }

    // Extract message text (strip mention tags)
    let text = activity.text ?? "";
    if (activity.entities) {
      text = MSTeamsClient.stripMentionTags(text);
    }

    // Skip empty messages
    if (!text.trim() && !activity.attachments?.length) {
      return;
    }

    const conversationId = activity.conversation?.id ?? "";
    const conversationType = (activity.conversation?.conversationType ??
      "personal") as MSTeamsConversationType;
    const from = activity.from;

    // Track known conversations
    if (!this.knownConversations.has(conversationId)) {
      this.knownConversations.set(conversationId, {
        type: conversationType,
        name: activity.conversation?.name,
      });

      // Ensure world/room exists
      await this.ensureWorldAndRoom(context);
    }

    // Build message payload
    const payload: MSTeamsMessagePayload = {
      runtime: this.runtime,
      source: "msteams",
      activityId: activity.id ?? "",
      conversationId,
      conversationType,
      from: {
        id: from?.id ?? "",
        name: from?.name,
        aadObjectId: from?.aadObjectId,
      },
      conversation: {
        id: conversationId,
        conversationType,
        tenantId: activity.conversation?.tenantId,
        name: activity.conversation?.name,
      },
      serviceUrl: activity.serviceUrl ?? "",
      channelData: activity.channelData,
      replyToId: activity.replyToId,
      message: {
        id: createUniqueUuid(this.runtime, activity.id ?? ""),
        agentId: this.runtime.agentId,
        roomId: createUniqueUuid(this.runtime, conversationId),
        entityId: createUniqueUuid(this.runtime, from?.id ?? "unknown"),
        content: {
          text,
          source: "msteams",
        },
        createdAt: Date.now(),
      },
    };

    // Emit message received event
    await this.runtime.emitEvent(
      MSTeamsEventType.MESSAGE_RECEIVED as string,
      payload as EventPayload,
    );

    // Process through agent
    await this.processMessage(context, payload);
  }

  /**
   * Process a message through the agent
   */
  private async processMessage(
    context: TurnContext,
    payload: MSTeamsMessagePayload,
  ): Promise<void> {
    if (!this.runtime) return;

    const roomId = createUniqueUuid(this.runtime, payload.conversationId);

    const callback = async (response: Content) => {
      if (!response.text?.trim()) return;

      // Send response
      if (this.client) {
        const messages = this.client.splitMessage(response.text);
        for (const msg of messages) {
          await context.sendActivity(MessageFactory.text(msg));
        }
      }

      // Create response memory
      const responseMemory = {
        id: createUniqueUuid(this.runtime, `msteams-response-${Date.now()}`),
        agentId: this.runtime.agentId,
        roomId,
        entityId: this.runtime.agentId,
        content: {
          text: response.text,
          source: "msteams",
          inReplyTo: payload.message?.id,
        },
        createdAt: Date.now(),
      };

      await this.runtime.createMemory(responseMemory, "messages");

      // Emit message sent event
      if (this.runtime) {
        await this.runtime.emitEvent(
          MSTeamsEventType.MESSAGE_SENT as string,
          {
            runtime: this.runtime,
            message: responseMemory,
            source: "msteams",
            conversationId: payload.conversationId,
          } as EventPayload,
        );
      }
    };

    if (payload.message && this.runtime) {
      await this.runtime.createMemory(payload.message, "messages");
      // Use event-based message handling
      await this.runtime.emitEvent([EventType.MESSAGE_RECEIVED], {
        runtime: this.runtime,
        message: payload.message,
        callback,
        source: "msteams",
      } as EventPayload);
    }
  }

  /**
   * Handle conversation update (members added/removed)
   */
  private async handleConversationUpdate(context: TurnContext): Promise<void> {
    if (!this.runtime) return;

    const activity = context.activity;
    const membersAdded = activity.membersAdded ?? [];
    const membersRemoved = activity.membersRemoved ?? [];

    for (const member of membersAdded) {
      // Skip the bot itself
      if (member.id === activity.recipient?.id) {
        continue;
      }

      await this.runtime.emitEvent(
        MSTeamsEventType.ENTITY_JOINED as string,
        {
          runtime: this.runtime,
          source: "msteams",
          user: {
            id: member.id,
            name: member.name,
            aadObjectId: member.aadObjectId,
          },
          action: "added",
          conversationId: activity.conversation?.id,
        } as EventPayload,
      );
    }

    for (const member of membersRemoved) {
      await this.runtime.emitEvent(
        MSTeamsEventType.ENTITY_LEFT as string,
        {
          runtime: this.runtime,
          source: "msteams",
          user: {
            id: member.id,
            name: member.name,
          },
          action: "removed",
          conversationId: activity.conversation?.id,
        } as EventPayload,
      );
    }
  }

  /**
   * Handle reactions
   */
  private async handleReaction(context: TurnContext): Promise<void> {
    if (!this.runtime) return;

    const activity = context.activity;

    for (const reaction of activity.reactionsAdded ?? []) {
      await this.runtime.emitEvent(
        MSTeamsEventType.REACTION_RECEIVED as string,
        {
          runtime: this.runtime,
          source: "msteams",
          activityId: activity.id,
          conversationId: activity.conversation?.id,
          from: activity.from,
          reactionType: reaction.type,
          messageId: activity.replyToId,
        } as EventPayload,
      );
    }
  }

  /**
   * Handle invoke activities (Adaptive Card actions, etc.)
   */
  private async handleInvoke(context: TurnContext): Promise<void> {
    if (!this.runtime) return;

    const activity = context.activity;
    const value = activity.value;

    // Handle Adaptive Card action submissions
    if (activity.name === "adaptiveCard/action" || value) {
      await this.runtime.emitEvent(
        MSTeamsEventType.CARD_ACTION_RECEIVED as string,
        {
          runtime: this.runtime,
          source: "msteams",
          activityId: activity.id,
          conversationId: activity.conversation?.id,
          from: activity.from,
          value,
        } as EventPayload,
      );

      // Acknowledge the invoke
      await context.sendActivity({
        type: ActivityTypes.InvokeResponse,
        value: { status: 200 },
      });
    }

    // Handle file consent responses
    if (activity.name === "fileConsent/invoke") {
      await this.runtime.emitEvent(
        MSTeamsEventType.FILE_CONSENT_RECEIVED as string,
        {
          runtime: this.runtime,
          source: "msteams",
          activityId: activity.id,
          conversationId: activity.conversation?.id,
          from: activity.from,
          value,
        } as EventPayload,
      );

      await context.sendActivity({
        type: ActivityTypes.InvokeResponse,
        value: { status: 200 },
      });
    }
  }

  /**
   * Ensure world and room exist for a conversation
   */
  private async ensureWorldAndRoom(context: TurnContext): Promise<void> {
    if (!this.runtime) return;

    const activity = context.activity;
    const conversationId = activity.conversation?.id ?? "";
    const conversationType =
      activity.conversation?.conversationType ?? "personal";
    const tenantId = activity.conversation?.tenantId;

    const worldId = createUniqueUuid(
      this.runtime,
      `msteams-${tenantId ?? "default"}`,
    );
    const roomId = createUniqueUuid(this.runtime, conversationId);

    // Ensure world exists
    const existingWorld = await this.runtime.getWorld(worldId);
    if (!existingWorld) {
      const world: World = {
        id: worldId,
        name: `MS Teams - ${tenantId ?? "Default Tenant"}`,
        agentId: this.runtime.agentId,
        messageServerId: worldId,
        metadata: {
          extra: {
            source: "msteams",
            tenantId,
          },
        },
      };
      await this.runtime.createWorld(world);
      logger.info(`Created MS Teams world: ${worldId}`);
    }

    // Ensure room exists
    const existingRoom = await this.runtime.getRoom(roomId);
    if (!existingRoom) {
      const elizaChannelType =
        conversationType === "personal"
          ? ChannelType.DM
          : conversationType === "groupChat"
            ? ChannelType.GROUP
            : ChannelType.GROUP;

      const room: Room = {
        id: roomId,
        name: activity.conversation?.name ?? conversationId,
        source: "msteams",
        type: elizaChannelType,
        channelId: conversationId,
        messageServerId: worldId,
        worldId,
      };
      await this.runtime.createRoom(room);
      logger.debug(`Created MS Teams room: ${roomId}`);
    }
  }

  /**
   * Register send handler for MS Teams
   */
  static registerSendHandlers(
    runtime: IAgentRuntime,
    service: MSTeamsService,
  ): void {
    if (service.client) {
      runtime.registerSendHandler(
        "msteams",
        service.handleSendMessage.bind(service),
      );
      logger.info("[MSTeams] Registered send handler");
    } else {
      logger.warn(
        "[MSTeams] Cannot register send handler - client not initialized",
      );
    }
  }

  /**
   * Handle send message from runtime
   */
  async handleSendMessage(
    runtime: IAgentRuntime,
    target: TargetInfo,
    content: Content,
  ): Promise<void> {
    if (!this.client) {
      throw new Error("MS Teams client not initialized");
    }

    let conversationId: string | undefined;

    if (target.channelId) {
      conversationId = target.channelId;
    } else if (target.roomId) {
      const room = await runtime.getRoom(target.roomId);
      conversationId = room?.channelId;
      if (!conversationId) {
        throw new Error(
          `Could not resolve MS Teams conversation ID from roomId ${target.roomId}`,
        );
      }
    } else {
      throw new Error("MS Teams SendHandler requires channelId or roomId");
    }

    // Check for Adaptive Card in content data
    const contentData = content.data as Record<string, unknown> | undefined;
    const adaptiveCard = contentData?.adaptiveCard as
      | Record<string, unknown>
      | undefined;

    if (adaptiveCard) {
      await this.client.sendAdaptiveCard(
        conversationId,
        adaptiveCard as unknown as import("./types").AdaptiveCard,
        content.text,
      );
    } else if (content.text) {
      await this.client.sendProactiveMessage(conversationId, content.text);
    }

    logger.info(`[MSTeams] Message sent to conversation: ${conversationId}`);
  }

  /**
   * Get the MS Teams client
   */
  getClient(): MSTeamsClient | null {
    return this.client;
  }
}
