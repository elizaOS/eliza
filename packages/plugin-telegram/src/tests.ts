import { type IAgentRuntime, type TestSuite, logger } from '@elizaos/core';
import type { Chat, User } from '@telegraf/types';
import type { Telegraf } from 'telegraf';
import type { Context } from 'telegraf';
import type { MessageManager } from './messageManager';
import type { TelegramService } from './service';

const TEST_IMAGE_URL =
  'https://github.com/elizaOS/awesome-eliza/blob/main/assets/eliza-logo.jpg?raw=true';

/**
 * Represents a test suite for testing Telegram functionality.
 *
 * This test suite includes methods to initialize and validate a Telegram bot connection,
 * send basic text messages to a Telegram chat, send text messages with image attachments,
 * handle and process incoming Telegram messages, and process and validate image attachments
 * in incoming messages.
 *
 * @implements {TestSuite}
 */

export class TelegramTestSuite implements TestSuite {
  name = 'telegram';
  private telegramClient: TelegramService = null;
  private bot: Telegraf<Context> | null = null;
  private messageManager: MessageManager | null = null;
  tests: { name: string; fn: (runtime: IAgentRuntime) => Promise<void> }[];

  /**
   * Constructor for initializing a set of test cases for a Telegram bot.
   *
   * @constructor
   * @property {Array<Object>} tests - An array of test cases with name and corresponding test functions.
   * @property {string} tests.name - The name of the test case.
   * @property {function} tests.fn - The test function to be executed.
   */
  constructor() {
    this.tests = [
      {
        name: 'Initialize and Validate Telegram Bot Connection',
        fn: this.testCreatingTelegramBot.bind(this),
      },
      {
        name: 'Send Basic Text Message to Telegram Chat',
        fn: this.testSendingTextMessage.bind(this),
      },
      {
        name: 'Send Text Message with an Image Attachment',
        fn: this.testSendingMessageWithAttachment.bind(this),
      },
      {
        name: 'Handle and Process Incoming Telegram Messages',
        fn: this.testHandlingMessage.bind(this),
      },
      {
        name: 'Process and Validate Image Attachments in Incoming Messages',
        fn: this.testProcessingImages.bind(this),
      },
    ];
  }

  /**
   * Retrieves the Telegram test chat ID from environment variables.
   *
   * Reference on getting the Telegram chat ID:
   * https://stackoverflow.com/a/32572159
   */
  /**
   * Validates the chat ID by checking if it is set in the runtime settings or environment variables.
   * If not set, an error is thrown with a message instructing to provide a valid chat ID.
   * @param {IAgentRuntime} runtime - The runtime object that provides access to the settings and environment variables.
   * @throws {Error} If TELEGRAM_TEST_CHAT_ID is not set in the runtime settings or environment variables.
   * @returns {string} The validated chat ID.
   */
  validateChatId(runtime: IAgentRuntime) {
    const testChatId =
      runtime.getSetting('TELEGRAM_TEST_CHAT_ID') || process.env.TELEGRAM_TEST_CHAT_ID;
    if (!testChatId) {
      throw new Error(
        'TELEGRAM_TEST_CHAT_ID is not set. Please provide a valid chat ID in the environment variables.'
      );
    }
    return testChatId;
  }

  async getChatInfo(runtime: IAgentRuntime): Promise<Context['chat']> {
    try {
      const chatId = this.validateChatId(runtime);
      const chat = await this.bot.telegram.getChat(chatId);
      logger.log(`Fetched real chat: ${JSON.stringify(chat)}`);
      return chat;
    } catch (error) {
      throw new Error(`Error fetching real Telegram chat: ${error}`);
    }
  }

  async testCreatingTelegramBot(runtime: IAgentRuntime) {
    this.telegramClient = runtime.getService('telegram') as TelegramService;
    this.bot = this.telegramClient.messageManager.bot;
    this.messageManager = this.telegramClient.messageManager;
    logger.debug('Telegram bot initialized successfully.');
  }

  async testSendingTextMessage(runtime: IAgentRuntime) {
    try {
      if (!this.bot) throw new Error('Bot not initialized.');

      const chatId = this.validateChatId(runtime);
      await this.bot.telegram.sendMessage(chatId, 'Testing Telegram message!');
      logger.debug('Message sent successfully.');
    } catch (error) {
      throw new Error(`Error sending Telegram message: ${error}`);
    }
  }

  async testSendingMessageWithAttachment(runtime: IAgentRuntime) {
    try {
      if (!this.messageManager) throw new Error('MessageManager not initialized.');

      const chat = await this.getChatInfo(runtime);
      const mockContext: Partial<Context> = {
        chat,
        from: { id: 123, username: 'TestUser' } as User,
        telegram: this.bot.telegram,
      };

      const messageContent = {
        text: 'Here is an image attachment:',
        attachments: [
          {
            id: '123',
            title: 'Sample Image',
            source: TEST_IMAGE_URL,
            text: 'Sample Image',
            url: TEST_IMAGE_URL,
            contentType: 'image/png',
            description: 'Sample Image',
          },
        ],
      };

      await this.messageManager.sendMessageInChunks(mockContext as Context, messageContent);

      logger.success('Message with image attachment sent successfully.');
    } catch (error) {
      throw new Error(`Error sending Telegram message with attachment: ${error}`);
    }
  }

  async testHandlingMessage(runtime: IAgentRuntime) {
    try {
      const chat = await this.getChatInfo(runtime);
      const mockContext: Partial<Context> = {
        chat,
        from: {
          id: 123,
          username: 'TestUser',
          is_bot: false,
          first_name: 'Test',
          last_name: 'User',
        } as User,
        message: {
          message_id: undefined,
          text: `@${this.bot.botInfo?.username}! Hello!`,
          date: Math.floor(Date.now() / 1000),
          chat,
        } as any,
        telegram: this.bot.telegram,
      };

      try {
        await this.messageManager.handleMessage(mockContext as Context);
      } catch (error) {
        throw new Error(`Error handling Telegram message: ${error}`);
      }
    } catch (error) {
      throw new Error(`Error handling Telegram message: ${error}`);
    }
  }

  async testProcessingImages(runtime: IAgentRuntime) {
    try {
      const chatId = this.validateChatId(runtime);
      const fileId = await this.getFileId(chatId, TEST_IMAGE_URL);

      const mockMessage = {
        message_id: undefined,
        chat: { id: chatId } as Chat,
        date: Math.floor(Date.now() / 1000),
        photo: [{ file_id: fileId }],
        text: `@${this.bot.botInfo?.username}!`,
      };

      const { description } = await this.messageManager.processImage(mockMessage);
      if (!description) {
        throw new Error('Error processing Telegram image');
      }
      logger.log(`Processing Telegram image successfully: ${description}`);
    } catch (error) {
      throw new Error(`Error processing Telegram image: ${error}`);
    }
  }

  async getFileId(chatId: string, imageUrl: string) {
    try {
      const message = await this.bot.telegram.sendPhoto(chatId, imageUrl);
      return message.photo[message.photo.length - 1].file_id;
    } catch (error) {
      logger.error(`Error sending image: ${error}`);
      throw error;
    }
  }
}
