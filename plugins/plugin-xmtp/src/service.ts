import {
  ChannelType,
  Content,
  createUniqueUuid,
  elizaLogger,
  EventType,
  HandlerCallback,
  IAgentRuntime,
  logger,
  Memory,
  Service,
  stringToUuid,
  UUID,
} from "@elizaos/core";
import {
  Conversation,
  DecodedMessage,
  Client as XmtpClient,
} from "@xmtp/node-sdk";
import { XMTP_SERVICE_NAME } from "./constants";
import { createSCWSigner, createEOASigner } from "./helper";

type RuntimeWithOptionalConnectorRegistry = IAgentRuntime & {
  registerMessageConnector?: (
    registration: MessageConnectorRegistration,
  ) => void;
};
type RuntimeSendHandler = Parameters<IAgentRuntime["registerSendHandler"]>[1];
type ConnectorTargetInfo = Parameters<RuntimeSendHandler>[1];
type ConnectorContent = Parameters<RuntimeSendHandler>[2];
type MessageConnectorRegistration = Parameters<
  IAgentRuntime["registerMessageConnector"]
>[0];
type MessageConnectorTarget = Awaited<
  ReturnType<NonNullable<MessageConnectorRegistration["resolveTargets"]>>
>[number];
type MessageConnectorQueryContext = Parameters<
  NonNullable<MessageConnectorRegistration["resolveTargets"]>
>[1];
type MessageConnectorChatContext = NonNullable<
  Awaited<
    ReturnType<NonNullable<MessageConnectorRegistration["getChatContext"]>>
  >
>;
type MessageConnectorUserContext = NonNullable<
  Awaited<
    ReturnType<NonNullable<MessageConnectorRegistration["getUserContext"]>>
  >
>;

type KnownXmtpConversation = {
  conversationId: string;
  peerInboxId: string;
  label: string;
  lastMessageAt: number;
  roomId?: UUID;
};

function registerMessageConnectorIfAvailable(
  runtime: IAgentRuntime,
  registration: MessageConnectorRegistration,
): void {
  const withRegistry = runtime as RuntimeWithOptionalConnectorRegistry;
  if (typeof withRegistry.registerMessageConnector === "function") {
    withRegistry.registerMessageConnector(registration);
    return;
  }
  runtime.registerSendHandler(registration.source, registration.sendHandler);
}

function normalizedSearchText(value: string | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, " ")
    .trim();
}

function matchesQuery(
  query: string,
  ...values: Array<string | undefined>
): boolean {
  const normalizedQuery = normalizedSearchText(query);
  if (!normalizedQuery) return true;
  return values.some((value) =>
    normalizedSearchText(value).includes(normalizedQuery),
  );
}

function knownConversationToTarget(
  known: KnownXmtpConversation,
  score = 0.72,
): MessageConnectorTarget {
  return {
    target: {
      source: XMTP_SERVICE_NAME,
      channelId: known.conversationId,
      entityId: known.peerInboxId as unknown as UUID,
      roomId: known.roomId,
    },
    label: known.label,
    kind: "thread",
    description: "Known XMTP conversation",
    score,
    metadata: {
      conversationId: known.conversationId,
      peerInboxId: known.peerInboxId,
      lastMessageAt: known.lastMessageAt,
    },
  };
}

async function resolveXmtpConversationId(
  runtime: IAgentRuntime,
  service: XmtpService,
  target: ConnectorTargetInfo,
): Promise<string | null> {
  if (target.channelId?.trim()) return target.channelId.trim();
  if (target.threadId?.trim()) return target.threadId.trim();
  if (target.entityId?.trim()) {
    return (
      service.findKnownConversation(target.entityId)?.conversationId ?? null
    );
  }
  if (target.roomId) {
    const room = await runtime.getRoom(target.roomId);
    if (room?.channelId) return room.channelId;
  }
  return null;
}

export class XmtpService extends Service {
  static serviceType = XMTP_SERVICE_NAME;

  capabilityDescription =
    "The agent is able to send and receive messages using XMTP.";

  private client!: XmtpClient;
  private knownConversations: Map<string, KnownXmtpConversation> = new Map();

  constructor(runtime: IAgentRuntime) {
    super(runtime);
  }

  static async start(runtime: IAgentRuntime): Promise<Service> {
    logger.log("Constructing new XmtpService...");

    const service = new XmtpService(runtime);

    await service.setupClient();

    await service.setupMessageHandler();

    return service;
  }

  static registerSendHandlers(
    runtime: IAgentRuntime,
    service: XmtpService,
  ): void {
    registerMessageConnectorIfAvailable(runtime, {
      source: XMTP_SERVICE_NAME,
      label: "XMTP",
      capabilities: ["send_message", "chat_context"],
      supportedTargetKinds: ["thread", "room", "user", "contact"],
      contexts: ["social", "connectors"],
      description:
        "Send text messages to known XMTP conversations by conversation id, room, or peer inbox id.",
      metadata: {
        aliases: ["xmtp", "wallet dm", "wallet messages"],
      },
      sendHandler: async (
        _runtime: IAgentRuntime,
        target: ConnectorTargetInfo,
        content: ConnectorContent,
      ) => {
        const text =
          typeof content.text === "string" ? content.text.trim() : "";
        if (!text) return;

        const conversationId = await resolveXmtpConversationId(
          runtime,
          service,
          target,
        );
        if (!conversationId) {
          throw new Error("XMTP target is missing a known conversation id");
        }

        const conversation = await service.getConversation(conversationId);
        if (!conversation) {
          throw new Error(`XMTP conversation not found: ${conversationId}`);
        }

        const responseMessageId = await conversation.send(text);
        if (target.roomId) {
          const responseMemory: Memory = {
            id: createUniqueUuid(runtime, String(responseMessageId)),
            entityId: runtime.agentId,
            agentId: runtime.agentId,
            roomId: target.roomId,
            content: {
              ...content,
              text,
              source: XMTP_SERVICE_NAME,
              channelType: ChannelType.DM,
            },
            createdAt: Date.now(),
          };
          await runtime.createMemory(responseMemory, "messages");
        }
      },
      resolveTargets: (query: string) =>
        service
          .listKnownConversations()
          .filter((known) =>
            matchesQuery(
              query,
              known.label,
              known.conversationId,
              known.peerInboxId,
            ),
          )
          .map((known) => knownConversationToTarget(known, 0.82)),
      listRecentTargets: () =>
        service
          .listKnownConversations()
          .map((known) => knownConversationToTarget(known, 0.66)),
      listRooms: () =>
        service
          .listKnownConversations()
          .map((known) => knownConversationToTarget(known, 0.7)),
      getChatContext: async (
        target: ConnectorTargetInfo,
        context: MessageConnectorQueryContext,
      ): Promise<MessageConnectorChatContext | null> => {
        const conversationId = await resolveXmtpConversationId(
          context.runtime,
          service,
          target,
        );
        if (!conversationId) return null;
        const known = service.getKnownConversation(conversationId);
        return {
          target,
          label: known?.label ?? conversationId,
          summary: "XMTP encrypted conversation.",
          metadata: {
            conversationId,
            peerInboxId: known?.peerInboxId,
            lastMessageAt: known?.lastMessageAt,
          },
        };
      },
      getUserContext: async (
        entityId: string | UUID,
      ): Promise<MessageConnectorUserContext | null> => {
        const known = service.findKnownConversation(String(entityId));
        return {
          entityId,
          label: known?.label ?? String(entityId),
          aliases: known
            ? [known.peerInboxId, known.conversationId]
            : [String(entityId)],
          handles: {
            xmtp: known?.conversationId ?? String(entityId),
            inboxId: known?.peerInboxId ?? String(entityId),
          },
          metadata: {
            conversationId: known?.conversationId,
            peerInboxId: known?.peerInboxId,
          },
        };
      },
    });
  }

  static async stop(_runtime: IAgentRuntime): Promise<void> {}

  stop(): Promise<void> {
    return Promise.resolve();
  }

  private async setupClient() {
    const walletKey = this.runtime.getSetting("WALLET_KEY");
    const signerType = this.runtime.getSetting("XMTP_SIGNER_TYPE");
    const chainId = this.runtime.getSetting("XMTP_SCW_CHAIN_ID");
    const env = this.runtime.getSetting("XMTP_ENV") || "production";

    const signer =
      signerType === "SCW"
        ? createSCWSigner(walletKey, BigInt(chainId))
        : createEOASigner(walletKey);

    const client = await XmtpClient.create(signer, { env });

    this.client = client;

    logger.success(
      "XMTP client created successfully with inboxId: ",
      this.client.inboxId,
    );
  }

  private async setupMessageHandler() {
    this.client.conversations.streamAllMessages(async (err, message) => {
      if (err) {
        logger.error("Error streaming messages", err);
        return;
      }

      if (
        message?.senderInboxId.toLowerCase() ===
          this.client.inboxId.toLowerCase() ||
        message?.contentType?.typeId !== "text"
      ) {
        return;
      }

      // Ignore own messages
      if (message.senderInboxId === this.client.inboxId) {
        return;
      }

      logger.success(
        `Received message: ${message.content as string} by ${
          message.senderInboxId
        }`,
      );

      const conversation = await this.client.conversations.getConversationById(
        message.conversationId,
      );

      if (!conversation) {
        console.log("Unable to find conversation, skipping");
        return;
      }

      logger.success(`Sending "gm" response...`);

      await this.processMessage(message, conversation);

      logger.success("Waiting for messages...");
    });
  }

  private async processMessage(
    message: DecodedMessage<any>,
    conversation: Conversation,
  ) {
    try {
      const text = message?.content ?? "";
      const entityId = createUniqueUuid(this.runtime, message.senderInboxId);
      const messageId = stringToUuid(message.id as string);
      const userId = stringToUuid(message.senderInboxId as string);
      const roomId = stringToUuid(message.conversationId as string);

      this.rememberConversation({
        conversationId: message.conversationId,
        peerInboxId: message.senderInboxId,
        label: message.senderInboxId,
        lastMessageAt: Date.now(),
        roomId,
      });

      await this.runtime.ensureConnection({
        entityId,
        userName: message.senderInboxId,
        userId,
        roomId,
        channelId: message.conversationId,
        serverId: message.conversationId,
        source: "xmtp",
        type: ChannelType.DM,
        worldId: roomId, // For DM channels, using the same ID as roomId
      });

      const content: Content = {
        text,
        source: "xmtp",
        inReplyTo: undefined,
      };

      const memory: Memory = {
        id: messageId,
        entityId,
        agentId: this.runtime.agentId,
        roomId,
        content,
      };

      const callback: HandlerCallback = async (
        content: Content,
        _files?: string[],
      ) => {
        try {
          if (!content.text) return [];

          const responseMessageId = await conversation.send(content.text);

          const responseMemory: Memory = {
            id: createUniqueUuid(this.runtime, responseMessageId),
            entityId: this.runtime.agentId,
            agentId: this.runtime.agentId,
            roomId,
            content: {
              ...content,
              text: content.text,
              inReplyTo: messageId,
              channelType: ChannelType.DM,
            },
          };

          await this.runtime.createMemory(responseMemory, "messages");

          return [responseMemory];
        } catch (error) {
          elizaLogger.error("Error in callback", error);
        }
      };

      this.runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
        runtime: this.runtime,
        message: memory,
        callback,
        source: "xmtp",
      });
    } catch (error) {
      elizaLogger.error("Error in onMessage", error);
    }
  }

  listKnownConversations(): KnownXmtpConversation[] {
    return Array.from(this.knownConversations.values()).sort(
      (left, right) => right.lastMessageAt - left.lastMessageAt,
    );
  }

  getKnownConversation(conversationId: string): KnownXmtpConversation | null {
    return this.knownConversations.get(conversationId) ?? null;
  }

  findKnownConversation(value: string): KnownXmtpConversation | null {
    const normalized = value.toLowerCase();
    for (const known of this.knownConversations.values()) {
      if (
        known.conversationId.toLowerCase() === normalized ||
        known.peerInboxId.toLowerCase() === normalized
      ) {
        return known;
      }
    }
    return null;
  }

  async getConversation(conversationId: string): Promise<Conversation | null> {
    return (
      (await this.client.conversations.getConversationById(conversationId)) ??
      null
    );
  }

  private rememberConversation(conversation: KnownXmtpConversation): void {
    this.knownConversations.set(conversation.conversationId, conversation);
  }
}
