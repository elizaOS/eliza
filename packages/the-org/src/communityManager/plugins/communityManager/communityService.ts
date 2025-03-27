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

  async onDiscordUserJoined(params) {
    const runtime = params.runtime;
    const member = params.member;
    const entityId = params.entityId;
    const guild = params.guild;
    const worldId = params.worldId;

    const world = await runtime.adapter.getWorld(worldId);

    const greetChannelId = this.getDiscordGreetChannelId(world, guild);

    if (greetChannelId) {
      const channel = guild.channels.cache.get(greetChannelId);
      if (channel?.isTextBased()) {
        // TODO: Allow agents to use a custom greeting prompt from metadata.
        // This allows server owners to personalize the bot's introduction message for new members.

        const welcomeText = `Welcome <@${member.id}>! I'm ${runtime.character.name}, the community manager. Feel free to introduce yourself!`;
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
