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
} from "@elizaos/core";
import {
  Conversation,
  DecodedMessage,
  Client as XmtpClient,
} from "@xmtp/node-sdk";
import { XMTP_SERVICE_NAME } from "./constants";
import { createSCWSigner, createEOASigner } from "./helper";

export class XmtpService extends Service {
  static serviceType = XMTP_SERVICE_NAME;

  capabilityDescription =
    "The agent is able to send and receive messages using XMTP.";

  private client: XmtpClient;

  constructor(runtime: IAgentRuntime) {
    super(runtime);
  }

  static async start(runtime: IAgentRuntime): Promise<Service> {
    logger.log("Constructing new XmtpService...");

    const service = new XmtpService(runtime);

    await service.setupClient()

    await service.setupMessageHandler();

    return service;
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

    logger.success("XMTP client created successfully with inboxId: ", this.client.inboxId);
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
        }`
      );

      const conversation = await this.client.conversations.getConversationById(
        message.conversationId
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
    conversation: Conversation
  ) {
    try {
      const text = message?.content ?? "";
      const entityId = createUniqueUuid(this.runtime, message.senderInboxId);
      const messageId = stringToUuid(message.id as string);
      const userId = stringToUuid(message.senderInboxId as string);
      const roomId = stringToUuid(message.conversationId as string);

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
        content
      };

      const callback: HandlerCallback = async (
        content: Content,
        _files?: string[]
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
            }
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
}
