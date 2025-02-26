import {
  Action,
  ChannelType,
  Evaluator,
  type IAgentRuntime,
  initializeOnboardingConfig,
  logger,
  type OnboardingConfig,
  Provider,
  RoleName,
  stringToUuid,
  type UUID
} from "@elizaos/core";
import type { Guild } from "discord.js";

export const initCharacter = ({
  runtime,
  config,
  actions,
  providers,
  evaluators
}: {
  runtime: IAgentRuntime,
  config: OnboardingConfig,
  actions?: Action[],
  providers?: Provider[],
  evaluators?: Evaluator[]
}) => {
  if (actions) {
    for (const action of actions) {
      runtime.registerAction(action);
    }
  }

  if(providers) {
    for (const provider of providers) {
      runtime.registerProvider(provider);
    }
  }

  if(evaluators) {
    for (const evaluator of evaluators) {
      runtime.registerEvaluator(evaluator);
    }
  }

  // Register runtime events
  runtime.registerEvent(
    "DISCORD_SERVER_JOINED",
    async (params: { server: Guild }) => {
      // TODO: Save settings config to runtime
      await initializeAllSystems(runtime, [params.server], config);
    }
  );

  // when booting up into a server we're in, fire a connected event
  runtime.registerEvent(
    "DISCORD_SERVER_CONNECTED",
    async (params: { server: Guild }) => {
      await initializeAllSystems(runtime, [params.server], config);
    }
  );
}

/**
 * Initializes all systems for a server
 */
export async function initializeAllSystems(
  runtime: IAgentRuntime,
  servers: Guild[],
  config: OnboardingConfig
): Promise<void> {

  // TODO: Remove this
  // wait 2 seconds
  await new Promise((resolve) => setTimeout(resolve, 2000));

  try {
    for (const server of servers) {
      const worldId = stringToUuid(`${server.id}-${runtime.agentId}`);

      const ownerId = stringToUuid(
        `${server.ownerId}-${runtime.agentId}`
      );

      const tenantSpecificOwnerId = runtime.generateTenantUserId(ownerId);

      await runtime.ensureWorldExists({
        id: worldId,
        name: server.name,
        agentId: runtime.agentId,
        serverId: server.id,
        metadata: {
          ownership: server.ownerId ? { ownerId } : undefined,
          roles: {
            [tenantSpecificOwnerId]: RoleName.OWNER,
          },
        }
      });

      const world = await runtime.getWorld(worldId);    
      
      if(world.metadata?.settings) {
        continue;
      }

      // Initialize settings configuration
      const worldSettings = await initializeOnboardingConfig(
        runtime,
        world,
        config
      );

      if (!worldSettings) {
        logger.error(`Failed to initialize settings for server ${server.id}`);
        continue;
      }

      // Start settings DM with server owner
      await startOnboardingDM(runtime, server, worldId);
    }
  } catch (error) {
    logger.error(`Error initializing systems: ${error}`);
  }
}

/**
 * Starts the settings DM with the server owner
 */
export async function startOnboardingDM(
  runtime: IAgentRuntime,
  guild: Guild,
  worldId: UUID
): Promise<void> {
  console.log("startOnboardingDM - worldId", worldId);
  try {
    const owner = await guild.members.fetch(guild.ownerId);
    if (!owner) {
      logger.error(
        `Could not fetch owner with ID ${guild.ownerId} for server ${guild.id}`
      );
      throw new Error(`Could not fetch owner with ID ${guild.ownerId}`);
    }

    const onboardingMessages = [
      "Hi! I need to collect some information to get set up. Is now a good time?",
      "Hey there! I need to configure a few things. Do you have a moment?",
      "Hello! Could we take a few minutes to get everything set up?",
    ];

    const randomMessage =
      onboardingMessages[Math.floor(Math.random() * onboardingMessages.length)];
    const msg = await owner.send(randomMessage);
    const roomId = stringToUuid(`${msg.channel.id}-${runtime.agentId}`);

    await runtime.ensureRoomExists({
      id: roomId,
      name: `Chat with ${owner.user.username}`,
      source: "discord",
      type: ChannelType.DM,
      channelId: msg.channelId,
      serverId: guild.id,
      worldId: worldId,
    });

    await runtime.getOrCreateUser(
      runtime.agentId,
      runtime.character.name,
      runtime.character.name,
      "discord"
    );

    // Create memory of the initial message
    await runtime.messageManager.createMemory({
      agentId: runtime.agentId as UUID,
      userId: runtime.agentId as UUID,
      roomId: roomId,
      content: {
        text: randomMessage,
        action: "BEGIN_ONBOARDING",
      },
      createdAt: Date.now(),
    });

    logger.info(
      `Started settings DM with owner ${owner.id} for server ${guild.id}`
    );
  } catch (error) {
    logger.error(`Error starting DM with owner: ${error}`);
    throw error;
  }
}
