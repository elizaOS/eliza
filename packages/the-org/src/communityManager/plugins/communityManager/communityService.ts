import {
  type Entity,
  type IAgentRuntime,
  type Memory,
  ModelType,
  Service,
  type UUID,
  logger,
  World,
  createUniqueUuid,
  ChannelType,
} from '@elizaos/core';
import { ServiceType } from './types';
import dedent from 'dedent';

export class CommunityManagerService extends Service {
  static serviceType = ServiceType.COMMUNITY_MANAGER;
  capabilityDescription = 'community manager';

  private handleDiscordUserJoined = this.onDiscordUserJoined.bind(this);

  constructor(protected runtime: IAgentRuntime) {
    super(runtime);

    this.addEventListener(runtime);
  }

  static async start(runtime: IAgentRuntime): Promise<CommunityManagerService> {
    const service = new CommunityManagerService(runtime);
    return service;
  }

  static async stop(runtime: IAgentRuntime): Promise<void> {
    const service = runtime.getService(ServiceType.COMMUNITY_MANAGER);
    if (service) {
      await service.stop();
    }
  }

  async stop(): Promise<void> {}

  getDiscordGreetChannelId(world: World, guild): string | null {
    if (!world) {
      logger.warn('World not found!');
      return null;
    }
    const shouldGreetUser = world.metadata?.settings['SHOULD_GREET_NEW_PERSONS']?.value;
    const greetChannel = world.metadata?.settings['GREETING_CHANNEL']?.value;

    if (
      !(
        shouldGreetUser === true ||
        String(shouldGreetUser).toLowerCase() === 'true' ||
        String(shouldGreetUser).toLowerCase() === 'yes'
      )
    ) {
      return null;
    }

    if (greetChannel) {
      // Try to get channel by ID
      let channel = guild.channels.cache.get(greetChannel);
      if (channel?.isTextBased()) return channel.id;

      // Try to match by name if not found by ID
      const foundByName = guild.channels.cache.find(
        (ch) => ch.isTextBased() && ch.name === greetChannel
      );
      if (foundByName) return foundByName.id;

      logger.warn(`Greet channel "${greetChannel}" not found by ID or name.`);
    }

    // Fallback: pick any text-based channel
    const fallback = guild.channels.cache.find((ch) => ch.isTextBased());
    if (fallback) return fallback.id;

    return null;
  }

  async getGreetingMessage(runtime: IAgentRuntime, userName: string, greetingMessage?: string) {
    const basePrompt = dedent`
      You're a helpful assistant generating welcome messages for new users.

      Please create a warm and friendly welcome message for a new user named "${userName}".

      ${
        greetingMessage
          ? `Here are some keywords or ideas the server owner would like to include: "${greetingMessage}".`
          : ''
      }

      Make sure the message feels personal and inviting.
      Return only the welcome message as a raw string. Do not wrap it in JSON or add any labels.
    `;

    const message = await runtime.useModel(ModelType.OBJECT_LARGE, {
      prompt: basePrompt,
    });

    function extractString(value: unknown): string {
      let result = '';

      function traverse(node: unknown): void {
        if (typeof node === 'string') {
          result += node;
        } else if (Array.isArray(node)) {
          for (const item of node) {
            traverse(item);
          }
        } else if (typeof node === 'object' && node !== null) {
          for (const val of Object.values(node)) {
            traverse(val);
          }
        }
      }

      traverse(value);
      return result.trim();
    }

    return typeof message === 'string' ? message : extractString(message);
  }

  async onDiscordUserJoined(params) {
    const runtime = params.runtime;
    const member = params.member;
    const entityId = params.entityId;
    const guild = params.guild;
    const worldId = params.worldId;

    const world = await runtime.adapter.getWorld(worldId);

    const greetChannelId = this.getDiscordGreetChannelId(world, guild);

    if (world && greetChannelId) {
      const greetingMsgSettings = world.metadata?.settings['GREETING_MESSAGE']?.value;
      const channel = guild.channels.cache.get(greetChannelId);
      if (channel?.isTextBased()) {
        let greetingMessage = await this.getGreetingMessage(
          runtime,
          `<@${member.id}>`,
          greetingMsgSettings
        );

        //Replace any plain member ID with a proper Discord mention format, but skip ones already formatted
        if (greetingMessage) {
          greetingMessage = greetingMessage.replace(
            new RegExp(`(?<!<@)${member.id}(?!>)`, 'g'),
            `<@${member.id}>`
          );
        }

        const welcomeText =
          greetingMessage ||
          `Welcome <@${member.id}>! I'm ${runtime.character.name}, the community manager. Feel free to introduce yourself!`;

        await channel.send(welcomeText);

        const roomId = createUniqueUuid(runtime, greetChannelId);

        await runtime.ensureRoomExists({
          id: roomId,
          source: 'discord',
          type: ChannelType.GROUP,
          channelId: greetChannelId,
          serverId: guild.id,
          worldId: worldId,
        });

        // Create memory of the initial message
        await runtime.createMemory(
          {
            agentId: runtime.agentId,
            entityId,
            roomId: roomId,
            content: {
              text: welcomeText,
              actions: ['GREET_NEW_PERSON'],
            },
            createdAt: Date.now(),
          },
          'messages'
        );
      } else {
        logger.warn(`Channel ${greetChannelId} is not a text-based channel or not found.`);
      }
    }
  }

  addEventListener(runtime: IAgentRuntime): void {
    runtime.registerEvent('DISCORD_USER_JOINED', this.handleDiscordUserJoined);
  }
}
