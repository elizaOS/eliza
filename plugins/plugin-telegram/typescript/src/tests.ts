import { type IAgentRuntime, logger, type TestCase } from "@elizaos/core";
import type { Chat, Message, User } from "@telegraf/types";
import type { Context, Telegraf } from "telegraf";
import type { MessageManager } from "./messageManager";
import type { TelegramService } from "./service";
import type { TelegramContent } from "./types";

const TEST_IMAGE_URL =
  "https://github.com/elizaOS/awesome-eliza/blob/main/assets/eliza-logo.jpg?raw=true";
export class TelegramTestSuite {
  name = "telegram";
  private telegramClient: TelegramService | null = null;
  private bot: Telegraf<Context> | null = null;
  private messageManager: MessageManager | null = null;
  tests: TestCase[];
  constructor() {
    this.tests = [
      {
        name: "Initialize and Validate Telegram Bot Connection",
        fn: this.testCreatingTelegramBot.bind(this),
      },
      {
        name: "Send Basic Text Message to Telegram Chat",
        fn: this.testSendingTextMessage.bind(this),
      },
      {
        name: "Send Text Message with an Image Attachment",
        fn: this.testSendingMessageWithAttachment.bind(this),
      },
      {
        name: "Handle and Process Incoming Telegram Messages",
        fn: this.testHandlingMessage.bind(this),
      },
      {
        name: "Process and Validate Image Attachments in Incoming Messages",
        fn: this.testProcessingImages.bind(this),
      },
    ] as TestCase[];
  }
  validateChatId(runtime: IAgentRuntime): string | number {
    const testChatId =
      runtime.getSetting("TELEGRAM_TEST_CHAT_ID") || process.env.TELEGRAM_TEST_CHAT_ID;
    if (!testChatId) {
      throw new Error(
        "TELEGRAM_TEST_CHAT_ID is not set. Please provide a valid chat ID in the environment variables."
      );
    }
    if (typeof testChatId === "boolean") {
      throw new Error("TELEGRAM_TEST_CHAT_ID must be a string or number, not a boolean.");
    }
    return testChatId;
  }
  async getChatInfo(runtime: IAgentRuntime): Promise<Context["chat"]> {
    try {
      const chatId = this.validateChatId(runtime);
      if (!this.bot) {
        throw new Error("Bot is not initialized.");
      }
      const chat = await this.bot.telegram.getChat(chatId);
      logger.log(`Fetched real chat: ${JSON.stringify(chat)}`);
      return chat;
    } catch (error) {
      throw new Error(`Error fetching real Telegram chat: ${error}`);
    }
  }
  async testCreatingTelegramBot(runtime: IAgentRuntime) {
    this.telegramClient = runtime.getService("telegram") as TelegramService;
    if (!this.telegramClient || !this.telegramClient.messageManager) {
      throw new Error(
        "Telegram service or message manager not initialized - check TELEGRAM_BOT_TOKEN"
      );
    }
    this.bot = this.telegramClient.messageManager.bot;
    this.messageManager = this.telegramClient.messageManager;
    logger.debug("Telegram bot initialized successfully.");
  }
  async testSendingTextMessage(runtime: IAgentRuntime) {
    try {
      if (!this.bot) throw new Error("Bot not initialized.");
      const chatId = this.validateChatId(runtime);
      await this.bot.telegram.sendMessage(chatId, "Testing Telegram message!");
      logger.debug("Message sent successfully.");
    } catch (error) {
      throw new Error(`Error sending Telegram message: ${error}`);
    }
  }
  async testSendingMessageWithAttachment(runtime: IAgentRuntime) {
    try {
      if (!this.messageManager) throw new Error("MessageManager not initialized.");
      if (!this.bot) throw new Error("Bot not initialized.");
      const chat = await this.getChatInfo(runtime);
      const mockContext: Partial<Context> = {
        chat,
        from: { id: 123, username: "TestUser" } as User,
        telegram: this.bot.telegram,
      };
      const messageContent = {
        text: "Here is an image attachment:",
        attachments: [
          {
            id: "123",
            title: "Sample Image",
            source: TEST_IMAGE_URL,
            text: "Sample Image",
            url: TEST_IMAGE_URL,
            contentType: "image/png",
            description: "Sample Image",
          },
        ],
      };
      await this.messageManager.sendMessageInChunks(
        mockContext as Context,
        messageContent as TelegramContent
      );
      logger.success("Message with image attachment sent successfully.");
    } catch (error) {
      throw new Error(`Error sending Telegram message with attachment: ${error}`);
    }
  }
  async testHandlingMessage(runtime: IAgentRuntime) {
    try {
      if (!this.bot) throw new Error("Bot not initialized.");
      if (!this.messageManager) throw new Error("MessageManager not initialized.");
      const chat = await this.getChatInfo(runtime);
      const mockContext = {
        chat,
        from: {
          id: 123,
          username: "TestUser",
          is_bot: false,
          first_name: "Test",
          last_name: "User",
        } as User,
        message: {
          message_id: 1,
          text: `@${this.bot.botInfo?.username}! Hello!`,
          date: Math.floor(Date.now() / 1000),
          chat,
        } as Message.TextMessage,
        telegram: this.bot.telegram,
      } as Partial<Context> as Context;
      try {
        await this.messageManager.handleMessage(mockContext);
      } catch (error) {
        throw new Error(`Error handling Telegram message: ${error}`);
      }
    } catch (error) {
      throw new Error(`Error handling Telegram message: ${error}`);
    }
  }
  async testProcessingImages(runtime: IAgentRuntime) {
    try {
      if (!this.bot) throw new Error("Bot not initialized.");
      if (!this.messageManager) throw new Error("MessageManager not initialized.");
      const chatId = this.validateChatId(runtime);
      const fileId = await this.getFileId(chatId, TEST_IMAGE_URL);
      const mockMessage = {
        message_id: 12345,
        chat: { id: chatId, type: "private" } as Chat,
        date: Math.floor(Date.now() / 1000),
        photo: [
          {
            file_id: fileId,
            file_unique_id: `unique_${fileId}`,
            width: 100,
            height: 100,
          },
        ],
        text: `@${this.bot.botInfo?.username}!`,
      };
      const result = await this.messageManager.processImage(mockMessage as Message.PhotoMessage);
      if (!result || !result.description) {
        throw new Error("Error processing Telegram image or description not found");
      }
      const { description } = result;
      logger.log(`Processing Telegram image successfully: ${description}`);
    } catch (error) {
      throw new Error(`Error processing Telegram image: ${error}`);
    }
  }
  async getFileId(chatId: string | number, imageUrl: string) {
    try {
      if (!this.bot) {
        throw new Error("Bot is not initialized.");
      }
      const message = await this.bot.telegram.sendPhoto(chatId, imageUrl);
      if (!message.photo || message.photo.length === 0) {
        throw new Error("No photo received in the message response.");
      }
      return message.photo[message.photo.length - 1].file_id;
    } catch (error) {
      logger.error({ error }, `Error sending image: ${error}`);
      throw error;
    }
  }
}
