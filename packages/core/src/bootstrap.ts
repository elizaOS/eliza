import { UUID } from "crypto";
import { Guild } from "discord.js";
import { v4 } from "uuid";
import { cancelTaskAction } from "./actions/cancel.ts";
import { confirmTaskAction } from "./actions/confirm.ts";
import { followRoomAction } from "./actions/followRoom.ts";
import { ignoreAction } from "./actions/ignore.ts";
import { muteRoomAction } from "./actions/muteRoom.ts";
import { noneAction } from "./actions/none.ts";
import { unfollowRoomAction } from "./actions/unfollowRoom.ts";
import { unmuteRoomAction } from "./actions/unmuteRoom.ts";
import { composeContext } from "./context.ts";
import { factEvaluator } from "./evaluators/fact.ts";
import { goalEvaluator } from "./evaluators/goal.ts";
import { generateMessageResponse, generateShouldRespond } from "./index.ts";
import { logger } from "./logger.ts";
import { messageCompletionFooter, shouldRespondFooter } from "./parsing.ts";
import { confirmationTasksProvider } from "./providers/confirmation.ts";
import { factsProvider } from "./providers/facts.ts";
import { timeProvider } from "./providers/time.ts";
import { ChannelType, HandlerCallback, IAgentRuntime, Memory, ModelClass, Plugin, State } from "./types.ts";
import { stringToUuid } from "./uuid.ts";
export * as actions from "./actions/index.ts";
export * as evaluators from "./evaluators/index.ts";
export * as providers from "./providers/index.ts";

type ServerJoinedParams = {
  runtime: IAgentRuntime;
  server: any; // Platform-specific server object
  source: string; // "discord", "telegram", etc.
};

type ServerConnectedParams = {
  runtime: IAgentRuntime;
  server: any;
  source: string;
};

type ChannelJoinedParams = {
  runtime: IAgentRuntime;
  channel: any;
  serverId: string;
  source: string;
};

type UserJoinedParams = {
  runtime: IAgentRuntime;
  user: any;
  serverId: string;
  channelId: string;
  source: string;
};

type UsersSyncParams = {
  runtime: IAgentRuntime;
  users: any[];
  serverId: string;
  channelId: string;
  source: string;
};

export const shouldRespondTemplate =
  `# Task: Decide if {{agentName}} should respond.
{{providers}}

About {{agentName}}:
{{bio}}

{{recentMessages}}

# INSTRUCTIONS: Respond with the word RESPOND if {{agentName}} should respond to the message. Respond with STOP if a user asks {{agentName}} to be quiet. Respond with IGNORE if {{agentName}} should ignore the message.
${shouldRespondFooter}`;

const messageHandlerTemplate =
  // {{goals}}
  `# Task: Generate dialog and actions for the character {{agentName}}.
{{system}}

{{actionExamples}}
(Action examples are for reference only. Do not use the information from them in your response.)

# Knowledge
{{knowledge}}

About {{agentName}}:
{{bio}}

Examples of {{agentName}}'s dialog and actions:
{{characterMessageExamples}}

{{attachments}}

# Capabilities
Note that {{agentName}} is capable of reading/seeing/hearing various forms of media, including images, videos, audio, plaintext and PDFs. Recent attachments have been included above under the "Attachments" section.

{{providers}}

{{actions}}

{{messageDirections}}

{{recentMessages}}

# Instructions: Write the next message for {{agentName}}. Include the appropriate action from the list: {{actionNames}}
${messageCompletionFooter}`;

type MessageReceivedHandlerParams = {
  runtime: IAgentRuntime;
  message: Memory;
  callback: HandlerCallback;
};

const checkShouldRespond = async (
  runtime: IAgentRuntime,
  message: Memory,
  state: State
): Promise<boolean> => {
  if (message.userId === runtime.agentId) return false;

  const agentUserState = await runtime.databaseAdapter.getParticipantUserState(
    message.roomId,
    message.agentId,
    runtime.agentId,
  );

  if (
    agentUserState === "MUTED" &&
    !message.content.text
      .toLowerCase()
      .includes(runtime.character.name.toLowerCase())
  ) {
    console.log("Ignoring muted room");
    return false;
  }

  if (agentUserState === "FOLLOWED") {
    return true;
  }

  if (
    message.content.text
      .toLowerCase()
      .includes(runtime.character.name.toLowerCase())
  ) {
    return true;
  }

  const shouldRespondContext = composeContext({
    state,
    template:
      runtime.character.templates?.shouldRespondTemplate ||
      shouldRespondTemplate,
  });

  const response = await generateShouldRespond({
    runtime: runtime,
    context: shouldRespondContext,
    modelClass: ModelClass.TEXT_SMALL,
  });

  if (response.includes("RESPOND")) {
    return true;
  }

  if (response.includes("IGNORE")) {
    return false;
  }

  if (response.includes("STOP")) {
    return false;
  }
    console.error("Invalid response from response generateText:", response);
    return false;
};

const messageReceivedHandler = async ({
  runtime,
  message,
  callback,
}: MessageReceivedHandlerParams) => {

  // First, save the incoming message
  await runtime.messageManager.addEmbeddingToMemory(message);
  await runtime.messageManager.createMemory(message);

  // Then, compose the state, which includes the incoming message in the recent messages
  let state = await runtime.composeState(message);

  const shouldRespond = await checkShouldRespond(runtime, message, state);

  if (shouldRespond) {
    const context = composeContext({
      state,
      template:
        runtime.character.templates?.messageHandlerTemplate ||
        messageHandlerTemplate,
    });
      const responseContent = await generateMessageResponse({
        runtime: runtime,
        context,
        modelClass: ModelClass.TEXT_LARGE,
      });

      responseContent.text = responseContent.text?.trim();
      responseContent.inReplyTo = stringToUuid(
        `${message.id}-${runtime.agentId}`
      );

      const responseMessages: Memory[] = [
        {
          id: v4() as UUID,
          userId: runtime.agentId,
          agentId: runtime.agentId,
          content: responseContent,
          roomId: message.roomId,
          createdAt: Date.now(),
        },
      ];

      state = await runtime.updateRecentMessageState(state);

      await runtime.processActions(message, responseMessages, state, callback);
  }

  await runtime.evaluate(message, state, shouldRespond);
};

const reactionReceivedHandler = async ({
  runtime,
  message,
}: {
  runtime: IAgentRuntime;
  message: Memory;
}) => {
  try {
    await runtime.messageManager.createMemory(message);
  } catch (error) {
    if (error.code === "23505") {
      logger.warn("Duplicate reaction memory, skipping");
      return;
    }
    logger.error("Error in reaction handler:", error);
  }
};

/**
 * Syncs all users from a server into entities with smart handling for large servers
 */
const syncServerUsers = async (
  runtime: IAgentRuntime,
  server: any,
  source: string
) => {
  logger.info(`Syncing users for server: ${server.name || server.id}`);
  
  try {
    // Create/ensure the world exists for this server
    const worldId = stringToUuid(`${server.id}-${runtime.agentId}`);
    await runtime.ensureWorldExists({
      id: worldId,
      name: server.name || `Server ${server.id}`,
      agentId: runtime.agentId,
      serverId: server.id
    });
    
    // Always sync channels
    await syncServerChannels(runtime, server, source);
    
    // For Discord, use specialized sync based on server size
    if (source === "discord") {
      const guild = await server.fetch();
      
      if (guild.memberCount > 1000) {
        // Large server strategy - don't sync all users at once
        await syncLargeServerUsers(runtime, guild, source);
      } else {
        // Small/medium server - can sync all users
        await syncRegularServerUsers(runtime, guild, source);
      }
    } else if (source === "telegram") {
      // Telegram-specific handling
      // Telegram generally doesn't have the same scale issues
    }
    
    logger.success(`Successfully synced server structure for: ${server.name || server.id}`);
  } catch (error) {
    logger.error(`Error syncing server: ${error instanceof Error ? error.message : String(error)}`);
  }
};

/**
 * Handles syncing for very large servers (>1000 members)
 * Uses progressive loading and focuses on active users only
 */
const syncLargeServerUsers = async (
  runtime: IAgentRuntime,
  guild: Guild,
  source: string
) => {
  logger.info(`Using large server sync strategy for ${guild.name} (${guild.memberCount} members)`);
  
  try {
    // 1. Only sync text channels first
    for (const [channelId, channel] of guild.channels.cache) {
      if (channel.type === 0) { // Text channel        
        // 2. For each channel, only grab a small sample of most recent active users
        const messages = await channel.messages.fetch({ limit: 10 });
        
        // Create a set to track unique users
        const activeUsers = new Set();
        
        messages.forEach(msg => {
          if (!msg.author.bot) {
            activeUsers.add({
              id: msg.author.id,
              username: msg.author.username, 
              displayName: msg.author.displayName || msg.author.username
            });
          }
        });
        
        // If we found active users, sync them
        if (activeUsers.size > 0) {
          await syncMultipleUsers(
            runtime,
            Array.from(activeUsers),
            guild.id,
            channelId,
            source
          );
        }
      }
    }
    
    // 3. In the background, sync online members (with delay to avoid rate limits)
    setTimeout(async () => {
      try {
        // This gets presence data but only for online users
        const onlineMembers = guild.members.cache.filter(
          member => member.presence?.status === 'online'
        );
        
        // Process in small batches
        const batchSize = 50;
        const onlineMembersArray = Array.from(onlineMembers.values());
        
        for (let i = 0; i < onlineMembersArray.length; i += batchSize) {
          const batch = onlineMembersArray.slice(i, i + batchSize);
          
          const users = batch.map(member => ({
            id: member.id,
            username: member.user.username,
            displayName: member.displayName || member.user.username
          }));
          
          // Sync this batch to the general server (not channel-specific)
          await syncMultipleUsers(runtime, users, guild.id, null, source);
          
          // Add a delay between batches to avoid rate limits
          if (i + batchSize < onlineMembersArray.length) {
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        }
        
        logger.success(`Completed background sync of ${onlineMembersArray.length} online users for ${guild.name}`);
      } catch (error) {
        logger.error(`Error in background sync: ${error.message}`);
      }
    }, 5000); // Start after 5 seconds
    
    logger.info(`Completed initial sync for large server ${guild.name}`);
  } catch (error) {
    logger.error(`Error in large server sync: ${error.message}`);
  }
};

/**
 * Syncs all channels from a server
 */
const syncServerChannels = async (
  runtime: IAgentRuntime,
  server: any,
  source: string
) => {
  try {
    if (source === "discord") {
      const guild = await server.fetch();
      const worldId = stringToUuid(`${guild.id}-${runtime.agentId}`);
      
      // Loop through all channels and create room entities
      for (const [channelId, channel] of guild.channels.cache) {
        // Only process text and voice channels
        if (channel.type === 0 || channel.type === 2) { // GUILD_TEXT or GUILD_VOICE
          const roomId = stringToUuid(`${channelId}-${runtime.agentId}`);
          const room = await runtime.getRoom(roomId);
          
          // Skip if room already exists
          if (room) continue;
          
          let channelType;
          switch (channel.type) {
            case 0: // GUILD_TEXT
              channelType = ChannelType.GROUP;
              break;
            case 2: // GUILD_VOICE
              channelType = ChannelType.VOICE_GROUP;
              break;
            default:
              channelType = ChannelType.GROUP;
          }
          
          await runtime.ensureRoomExists({
            id: roomId,
            name: channel.name,
            source: "discord",
            type: channelType,
            channelId: channel.id,
            serverId: guild.id,
            worldId
          });
        }
      }
    }
  } catch (error) {
    logger.error(`Error syncing channels: ${error.message}`);
  }
};

/**
 * For smaller servers, we can sync all users more comprehensively
 */
const syncRegularServerUsers = async (
  runtime: IAgentRuntime,
  guild: Guild,
  source: string
) => {
  try {
    logger.info(`Syncing all users for guild ${guild.name}`);
    console.log("guild", guild)
    // We can fetch all members for smaller servers
    // Get members from cache first
    let members = guild.members.cache;
    // If cache is empty, fetch all members
    if(members.size === 0){
      members = await guild.members.fetch();
    }
    logger.info(`Syncing ${members.size} members for guild ${guild.name}`);
    // Process in batches to avoid overwhelming the system
    const batchSize = 100;
    const membersArray = Array.from(members.values());
    
    for (let i = 0; i < membersArray.length; i += batchSize) {
      const batch = membersArray.slice(i, i + batchSize);
      const users = batch.map(member => ({
        id: member.id,
        username: member.user.username,
        displayName: member.displayName || member.user.username
      }));
      
      // Note: null channelId means this sync is server-wide
      await syncMultipleUsers(runtime, users, guild.id, null, source);
      
      // Add a small delay between batches
      if (i + batchSize < membersArray.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    logger.success(`Completed sync of all ${membersArray.length} users for ${guild.name}`);
  } catch (error) {
    logger.error(`Error in regular server sync: ${error.message}`);
  }
};

/**
 * Syncs a single user into an entity
 */
const syncSingleUser = async (
  runtime: IAgentRuntime,
  user: any,
  serverId: string,
  channelId: string,
  source: string
) => {
  logger.info(`Syncing user: ${user.username || user.id}`);
  
  try {
    const userId = stringToUuid(`${user.id}-${runtime.agentId}`);
    const roomId = stringToUuid(`${channelId}-${runtime.agentId}`);
    
    // Ensure user exists
    await runtime.getOrCreateUser(
      userId,
      user.username || `User${user.id}`,
      user.displayName || user.username || `User${user.id}`,
      source
    );
    
    // Add user to the channel's room
    await runtime.ensureParticipantInRoom(userId, roomId);
    
    logger.success(`Successfully synced user: ${user.username || user.id}`);
  } catch (error) {
    logger.error(`Error syncing user: ${error instanceof Error ? error.message : String(error)}`);
  }
};

/**
 * Syncs multiple users into entities at once
 */
const syncMultipleUsers = async (
  runtime: IAgentRuntime,
  users: any[],
  serverId: string,
  channelId: string,
  source: string
) => {
  logger.info(`Syncing ${users.length} users for channel ${channelId}`);
  
  try {
    const roomId = stringToUuid(`${channelId}-${runtime.agentId}`);
    
    // Process users in batches to avoid overwhelming the system
    const batchSize = 10;
    for (let i = 0; i < users.length; i += batchSize) {
      const batch = users.slice(i, i + batchSize);
      
      await Promise.all(
        batch.map(async (user) => {
          try {
            const userId = stringToUuid(`${user.id}-${runtime.agentId}`);
            
            // Create user entity
            await runtime.getOrCreateUser(
              userId,
              user.username || `User${user.id}`,
              user.displayName || user.username || `User${user.id}`,
              source
            );
            
            // Add user to the room
            await runtime.ensureParticipantInRoom(userId, roomId);
          } catch (err) {
            logger.warn(`Failed to sync user ${user.id}: ${err}`);
          }
        })
      );
    }
    
    logger.success(`Successfully synced ${users.length} users for channel ${channelId}`);
  } catch (error) {
    logger.error(`Error syncing multiple users: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const events = {
  MESSAGE_RECEIVED: [
    async ({ runtime, message, callback }: MessageReceivedHandlerParams) => {
      logger.info("**** MESSAGE_RECEIVED");
      await messageReceivedHandler({
        runtime,
        message,
        callback,
      });
    },
  ],
  VOICE_MESSAGE_RECEIVED: [
    async ({ runtime, message, callback }: MessageReceivedHandlerParams) => {
      logger.info("**** VOICE_MESSAGE_RECEIVED");
      await messageReceivedHandler({
        runtime,
        message,
        callback,
      });
    },
  ],
  REACTION_RECEIVED: [reactionReceivedHandler],
  
  // New events for entity syncing
  SERVER_JOINED: [
    async ({ runtime, server, source }: ServerJoinedParams) => {
      await syncServerUsers(runtime, server, source);
    },
  ],
  SERVER_CONNECTED: [
    async ({ runtime, server, source }: ServerConnectedParams) => {
      await syncServerUsers(runtime, server, source);
    }
  ],
  USER_JOINED: [
    async ({ runtime, user, serverId, channelId, source }: UserJoinedParams) => {
      await syncSingleUser(runtime, user, serverId, channelId, source);
    }
  ],
};

export const bootstrapPlugin: Plugin = {
  name: "bootstrap",
  description: "Agent bootstrap with basic actions and evaluators",
  actions: [
    followRoomAction,
    unfollowRoomAction,
    ignoreAction,
    noneAction,
    muteRoomAction,
    unmuteRoomAction,
    cancelTaskAction,
    confirmTaskAction,
  ],
  events,
  evaluators: [factEvaluator, goalEvaluator],
  providers: [timeProvider, factsProvider, confirmationTasksProvider],
};

export default bootstrapPlugin;
