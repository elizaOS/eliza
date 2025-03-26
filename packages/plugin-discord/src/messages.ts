import {
  ChannelType,
  type Content,
  EventType,
  type HandlerCallback,
  type IAgentRuntime,
  type IBrowserService,
  type IVideoService,
  type Media,
  type Memory,
  ServiceType,
  createUniqueUuid,
  logger,
} from '@elizaos/core';
import {
  type Channel,
  type Client,
  ChannelType as DiscordChannelType,
  type Message as DiscordMessage,
  type TextChannel,
} from 'discord.js';
import { AttachmentManager } from './attachments';
import { DiscordEventTypes } from './types';
import { canSendMessage, sendMessageInChunks } from './utils';

/**
 * Class representing a Message Manager for handling Discord messages.
 */

export class MessageManager {
  private client: Client;
  private runtime: IAgentRuntime;
  private attachmentManager: AttachmentManager;
  private getChannelType: (channel: Channel) => Promise<ChannelType>;
  /**
   * Constructor for a new instance of MyClass.
   * @param {any} discordClient - The Discord client object.
   */
  constructor(discordClient: any) {
    this.client = discordClient.client;
    this.runtime = discordClient.runtime;
    this.attachmentManager = new AttachmentManager(this.runtime);
    this.getChannelType = discordClient.getChannelType;
  }

  /**
   * Handles incoming Discord messages and processes them accordingly.
   *
   * @param {DiscordMessage} message - The Discord message to be handled
   */
  async handleMessage(message: DiscordMessage) {
    if (
      this.runtime.character.settings?.discord?.allowedChannelIds &&
      !this.runtime.character.settings.discord.allowedChannelIds.some(
        (id: string) => id === message.channel.id
      )
    ) {
      return;
    }

    if (message.interaction || message.author.id === this.client.user?.id) {
      return;
    }

    if (this.runtime.character.settings?.discord?.shouldIgnoreBotMessages && message.author?.bot) {
      return;
    }

    if (
      this.runtime.character.settings?.discord?.shouldIgnoreDirectMessages &&
      message.channel.type === DiscordChannelType.DM
    ) {
      return;
    }

    if (
      this.runtime.character.settings?.discord?.shouldRespondOnlyToMentions &&
      !message.mentions.users?.has(this.client.user?.id)
    ) {
      return;
    }

    const entityId = createUniqueUuid(this.runtime, message.author.id);

    const userName = message.author.bot
      ? `${message.author.username}#${message.author.discriminator}`
      : message.author.username;
    const name = message.author.displayName;
    const channelId = message.channel.id;
    const roomId = createUniqueUuid(this.runtime, channelId);

    let type: ChannelType;
    let serverId: string | undefined;

    if (message.guild) {
      const guild = await message.guild.fetch();
      type = await this.getChannelType(message.channel as Channel);
      serverId = guild.id;
    } else {
      type = ChannelType.DM;
      serverId = undefined;
    }

    await this.runtime.ensureConnection({
      entityId: entityId,
      roomId,
      userName,
      name: name,
      source: 'discord',
      channelId: message.channel.id,
      serverId,
      type,
    });

    try {
      const canSendResult = canSendMessage(message.channel);
      if (!canSendResult.canSend) {
        return logger.warn(`Cannot send message to channel ${message.channel}`, canSendResult);
      }

      const { processedContent, attachments } = await this.processMessage(message);

      const audioAttachments = message.attachments.filter((attachment) =>
        attachment.contentType?.startsWith('audio/')
      );

      if (audioAttachments.size > 0) {
        const processedAudioAttachments =
          await this.attachmentManager.processAttachments(audioAttachments);
        attachments.push(...processedAudioAttachments);
      }

      if (!processedContent && !attachments?.length) {
        // Only process messages that are not empty
        return;
      }

      const entityId = createUniqueUuid(this.runtime, message.author.id);

      const messageId = createUniqueUuid(this.runtime, message.id);

      const newMessage: Memory = {
        id: messageId,
        entityId: entityId,
        agentId: this.runtime.agentId,
        roomId: roomId,
        content: {
          // name: name,
          // userName: userName,
          text: processedContent || ' ',
          attachments: attachments,
          source: 'discord',
          url: message.url,
          inReplyTo: message.reference?.messageId
            ? createUniqueUuid(this.runtime, message.reference?.messageId)
            : undefined,
        },
        createdAt: message.createdTimestamp,
      };

      const callback: HandlerCallback = async (content: Content, files: any[]) => {
        try {
          if (message.id && !content.inReplyTo) {
            content.inReplyTo = createUniqueUuid(this.runtime, message.id);
          }
          const messages = await sendMessageInChunks(
            message.channel as TextChannel,
            content.text,
            message.id,
            files
          );

          const memories: Memory[] = [];
          for (const m of messages) {
            const actions = content.actions;

            const memory: Memory = {
              id: createUniqueUuid(this.runtime, m.id),
              entityId: this.runtime.agentId,
              agentId: this.runtime.agentId,
              content: {
                ...content,
                actions,
                inReplyTo: messageId,
                url: m.url,
                channelType: type,
              },
              roomId,
              createdAt: m.createdTimestamp,
            };
            memories.push(memory);
          }

          for (const m of memories) {
            await this.runtime.createMemory(m, 'messages');
          }
          return memories;
        } catch (error) {
          console.error('Error sending message:', error);
          return [];
        }
      };

      this.runtime.emitEvent([DiscordEventTypes.MESSAGE_RECEIVED, EventType.MESSAGE_RECEIVED], {
        runtime: this.runtime,
        message: newMessage,
        callback,
      });
    } catch (error) {
      console.error('Error handling message:', error);
    }
  }

  /**
   * Processes the message content, mentions, code blocks, attachments, and URLs to generate
   * processed content and media attachments.
   *
   * @param {DiscordMessage} message The message to process
   * @returns {Promise<{ processedContent: string; attachments: Media[] }>} Processed content and media attachments
   */
  async processMessage(
    message: DiscordMessage
  ): Promise<{ processedContent: string; attachments: Media[] }> {
    let processedContent = message.content;
    let attachments: Media[] = [];

    const mentionRegex = /<@!?(\d+)>/g;
    processedContent = processedContent.replace(mentionRegex, (match, entityId) => {
      const user = message.mentions.users.get(entityId);
      if (user) {
        return `${user.username} (@${entityId})`;
      }
      return match;
    });

    const codeBlockRegex = /```([\s\S]*?)```/g;
    let match;
    while ((match = codeBlockRegex.exec(processedContent))) {
      const codeBlock = match[1];
      const lines = codeBlock.split('\n');
      const title = lines[0];
      const description = lines.slice(0, 3).join('\n');
      const attachmentId = `code-${Date.now()}-${Math.floor(Math.random() * 1000)}`.slice(-5);
      attachments.push({
        id: attachmentId,
        url: '',
        title: title || 'Code Block',
        source: 'Code',
        description: description,
        text: codeBlock,
      });
      processedContent = processedContent.replace(match[0], `Code Block (${attachmentId})`);
    }

    if (message.attachments.size > 0) {
      attachments = await this.attachmentManager.processAttachments(message.attachments);
    }

    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const urls = processedContent.match(urlRegex) || [];

    for (const url of urls) {
      if (this.runtime.getService<IVideoService>(ServiceType.VIDEO)?.isVideoUrl(url)) {
        const videoService = this.runtime.getService<IVideoService>(ServiceType.VIDEO);
        if (!videoService) {
          throw new Error('Video service not found');
        }
        const videoInfo = await videoService.processVideo(url, this.runtime);

        attachments.push({
          id: `youtube-${Date.now()}`,
          url: url,
          title: videoInfo.title,
          source: 'YouTube',
          description: videoInfo.description,
          text: videoInfo.text,
        });
      } else {
        const browserService = this.runtime.getService<IBrowserService>(ServiceType.BROWSER);
        if (!browserService) {
          throw new Error('Browser service not found');
        }

        const { title, description: summary } = await browserService.getPageContent(
          url,
          this.runtime
        );

        attachments.push({
          id: `webpage-${Date.now()}`,
          url: url,
          title: title || 'Web Page',
          source: 'Web',
          description: summary,
          text: summary,
        });
      }
    }

    return { processedContent, attachments };
  }

  /**
   * Asynchronously fetches the bot's username and discriminator from Discord API.
   *
   * @param {string} botToken The token of the bot to authenticate the request
   * @returns {Promise<string>} A promise that resolves with the bot's username and discriminator
   * @throws {Error} If there is an error while fetching the bot details
   */

  async fetchBotName(botToken: string) {
    const url = 'https://discord.com/api/v10/users/@me';
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bot ${botToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Error fetching bot details: ${response.statusText}`);
    }

    const data = await response.json();
    const discriminator = data.discriminator;
    return (data as { username: string }).username + (discriminator ? `#${discriminator}` : '');
  }
}
