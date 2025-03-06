import {
  type Action,
  ChannelType,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  ModelTypes,
  RoleName,
  ServiceTypes,
  type State,
  composeContext,
  createUniqueUuid,
  getUserServerRole,
  getWorldSettings,
  logger
} from "@elizaos/core";
import { TwitterService } from "@elizaos/plugin-twitter";

// Define Twitter service type constant
const TWITTER_SERVICE = "twitter";

const tweetGenerationTemplate = `# Task: Create a post in the style and voice of {{agentName}}.
{{system}}

About {{agentName}}:
{{bio}}

{{topics}}

{{characterPostExamples}}

Recent Context:
{{recentMessages}}

# Instructions: Write a tweet that captures the essence of what {{agentName}} wants to share. The tweet should be:
- Under 280 characters
- In {{agentName}}'s authentic voice and style
- Related to the ongoing conversation or context
- Not include hashtags unless specifically requested
- Natural and conversational in tone

Return only the tweet text, no additional commentary.`;

// Required Twitter configuration fields that must be present
const REQUIRED_TWITTER_FIELDS = [
  "TWITTER_USERNAME",
  "TWITTER_EMAIL",
  "TWITTER_PASSWORD",
];

/**
 * Validates that all required Twitter configuration fields are present and non-null
 */
async function validateTwitterConfig(
  runtime: IAgentRuntime,
  serverId: string
): Promise<{ isValid: boolean; error?: string }> {
  try {
    const worldSettings = await getWorldSettings(runtime, serverId);

    if (!worldSettings) {
      return {
        isValid: false,
        error: "No settings state found for this server",
      };
    }

    // Check required fields
    for (const field of REQUIRED_TWITTER_FIELDS) {
      if (!worldSettings[field] || worldSettings[field].value === null) {
        return {
          isValid: false,
          error: `Missing required Twitter configuration: ${field}`,
        };
      }
    }

    return { isValid: true };
  } catch (error) {
    logger.error("Error validating Twitter config:", error);
    return {
      isValid: false,
      error: "Error validating Twitter configuration",
    };
  }
}

/**
 * Ensures a Twitter client exists for the given server and agent
 */
async function ensureTwitterClient(
  runtime: IAgentRuntime,
  serverId: string,
  worldSettings: { [key: string]: string | boolean | number | null }
) {
  const manager = runtime.getService(TWITTER_SERVICE) as TwitterService;
  if (!manager) {
    throw new Error("Twitter client manager not found");
  }

  let client = manager.getService(serverId, runtime.agentId);

  if (!client) {
    logger.info("Creating new Twitter client for server", serverId);
    client = await manager.createClient(runtime, serverId, worldSettings);
    if (!client) {
      throw new Error("Failed to create Twitter client");
    }
  }

  return client;
}

const twitterPostAction: Action = {
  name: "TWITTER_POST",
  similes: ["POST_TWEET", "SHARE_TWEET", "TWEET_THIS", "TWEET_ABOUT"],
  description: "Creates and posts a tweet based on the conversation context",

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State
  ): Promise<boolean> => {
    const room = await runtime.databaseAdapter.getRoom(message.roomId);
    if (!room) {
      throw new Error("No room found");
    }

    if (room.type !== ChannelType.GROUP) {
      // only handle in a group scenario for now
      return false;
    }

    const serverId = room.serverId;

    if (!serverId) {
      throw new Error("No server ID found");
    }

    // Check if there are any pending Twitter posts awaiting confirmation
    const pendingTasks = await runtime.databaseAdapter.getTasks({
      roomId: message.roomId,
      tags: ["TWITTER_POST"],
    });

    if (pendingTasks && pendingTasks.length > 0) {
      // If there are already pending Twitter post tasks, don't allow another one
      return false;
    }

    // Validate Twitter configuration
    const validation = await validateTwitterConfig(runtime, serverId);
    if (!validation.isValid) {
      return false;
    }

    // Check user authorization
    const userRole = await getUserServerRole(runtime, message.userId, serverId);
    
    // Get the world to check roles directly
    const worldId = createUniqueUuid(runtime, serverId);
    const world = await runtime.databaseAdapter.getWorld(worldId);
    
    // Check if user is authorized by role
    let isAuthorized = userRole === RoleName.OWNER || userRole === RoleName.ADMIN;
    
    // Additional role check directly from world metadata
    if (world && world.metadata?.roles) {
      // Check if user ID is directly in roles
      if (world.metadata.roles[message.userId] === RoleName.OWNER || 
          world.metadata.roles[message.userId] === RoleName.ADMIN) {
        isAuthorized = true;
      }
      
      // Check if user is the server owner
      if (world.metadata.ownership?.ownerId === message.userId) {
        isAuthorized = true;
      }
    }
    
    return isAuthorized;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    _options: any,
    callback: HandlerCallback,
    _responses: Memory[]
  ) => {
    try {
      const room = await runtime.databaseAdapter.getRoom(message.roomId);
      if (!room) {
        throw new Error("No room found");
      }

      if (room.type !== ChannelType.GROUP) {
        // only handle in a group scenario for now
        return false;
      }

      const serverId = room.serverId;

      if (!serverId) {
        throw new Error("No server ID found");
      }

      // Get settings state from world metadata
      const worldSettings = await getWorldSettings(runtime, serverId);
      if (!worldSettings) {
        throw new Error("Twitter not configured for this server");
      }

      // Generate tweet content
      const context = composeContext({
        state,
        template: tweetGenerationTemplate,
      });

      const tweetContent = await runtime.useModel(ModelTypes.TEXT_SMALL, {
        context,
      });

      // Clean up the generated content
      const cleanTweet = tweetContent
        .trim()
        .replace(/^["'](.*)["']$/, "$1")
        .replace(/\\n/g, "\n");

      // Check user authorization
      const userRole = await getUserServerRole(runtime, message.userId, serverId);
      
      // Get the world to check roles directly
      const worldId = createUniqueUuid(runtime, serverId);
      const world = await runtime.databaseAdapter.getWorld(worldId);
      
      // Check if user is authorized by role
      let isAuthorized = userRole === RoleName.OWNER || userRole === RoleName.ADMIN;
      
      // Additional role check directly from world metadata
      if (world && world.metadata?.roles) {
        // Check if user ID is directly in roles
        if (world.metadata.roles[message.userId] === RoleName.OWNER || 
            world.metadata.roles[message.userId] === RoleName.ADMIN) {
          isAuthorized = true;
        }
        
        // Check if user is the server owner
        if (world.metadata.ownership?.ownerId === message.userId) {
          isAuthorized = true;
        }
      }
      
      if (!isAuthorized) {
        // callback and return
        await callback({
          text: "I'm sorry, but you're not authorized to post tweets on behalf of this org.",
          action: "TWITTER_POST_FAILED",
          source: message.content.source,
        });
        return;
      }

      // Prepare response content
      const responseContent: Content = {
        text: `I'll tweet this:\n\n${cleanTweet}`,
        action: "TWITTER_POST",
        source: message.content.source,
      };

      // if a task already exists, we need to cancel it
      const existingTask = await runtime.databaseAdapter.getTask(message.roomId);
      if (existingTask) {
        await runtime.databaseAdapter.deleteTask(existingTask.id);
      }

      const worker = {
        name: "Confirm Twitter Post",
        execute: async (
          runtime: IAgentRuntime,
          options: { option?: string; selectedOption?: string; tweetContent?: string; [key: string]: any }
        ) => {
          logger.info(`[TWITTER_DEBUG] Worker execute called with options: ${JSON.stringify(options)}`);
          
          // Handle different option formats
          let optionValue: string | undefined;
          
          if (typeof options === 'string') {
            // Direct string option
            optionValue = options;
            logger.info(`[TWITTER_DEBUG] Option provided as string: ${optionValue}`);
          } else if (options && typeof options === 'object') {
            // Object with option property
            if (typeof options.option === 'string') {
              optionValue = options.option;
              logger.info(`[TWITTER_DEBUG] Option provided in options.option: ${optionValue}`);
            } else if (options.selectedOption && typeof options.selectedOption === 'string') {
              // From CHOOSE_OPTION action
              optionValue = options.selectedOption;
              logger.info(`[TWITTER_DEBUG] Option provided in options.selectedOption: ${optionValue}`);
            } else {
              // When called from task service, default to post
              optionValue = "post";
              logger.info(`[TWITTER_DEBUG] No option provided, defaulting to: ${optionValue}`);
            }
          }
          
          if (optionValue === "cancel") {
            await callback({
              ...responseContent,
              text: "Tweet cancelled. I won't post it.",
              action: "TWITTER_POST_CANCELLED"
            });
            return;
          }

          if(optionValue !== "post") {
            await callback({
              ...responseContent,
              text: "Invalid option. Should be 'post' or 'cancel'.",
              action: "TWITTER_POST_INVALID_OPTION"
            });
            return;
          }
          
          try {
            // Get tweet content from options or task metadata
            let tweetContent = cleanTweet;
            if (options && typeof options === 'object' && options.tweetContent) {
              tweetContent = options.tweetContent as string;
              logger.info(`[TWITTER_DEBUG] Using tweet content from options: ${tweetContent}`);
            }
            
            // Real implementation
            const vals = {
              TWITTER_USERNAME: worldSettings.TWITTER_USERNAME.value,
              TWITTER_EMAIL: worldSettings.TWITTER_EMAIL.value,
              TWITTER_PASSWORD: worldSettings.TWITTER_PASSWORD.value,
              TWITTER_2FA_SECRET:
                worldSettings.TWITTER_2FA_SECRET.value ?? undefined,
            };

            // Initialize/get Twitter client
            const client = await ensureTwitterClient(runtime, serverId, vals);
            
            if (!client || !client.client || !client.client.twitterClient) {
              await callback({
                ...responseContent,
                text: "I couldn't post the tweet because I couldn't connect to Twitter. Please check your Twitter configuration.",
                action: "TWITTER_POST_FAILED"
              });
              return;
            }

            const result = await client.client.twitterClient.sendTweet(
              tweetContent
            );
            // result is a response object, get the data from it-- body is a readable stream
            const data = await result.json();

            const tweetId =
              data?.data?.create_tweet?.tweet_results?.result?.rest_id;

            if (!tweetId) {
              await callback({
                ...responseContent,
                text: "I encountered an error while trying to post your tweet. Please try again later.",
                action: "TWITTER_POST_FAILED"
              });
              return;
            }

            const tweetUrl = `https://twitter.com/${vals.TWITTER_USERNAME}/status/${tweetId}`;

            await callback({
              ...responseContent,
              text: `Tweet posted: '${tweetContent}'\n${tweetUrl}`,
              url: tweetUrl,
              tweetId,
            });
          } catch (error) {
            logger.error(`Error posting tweet: ${error}`);
            await callback({
              ...responseContent,
              text: "I encountered an error while trying to post your tweet. Please try again later.",
              action: "TWITTER_POST_FAILED"
            });
          }
        },
        validate: async (
          runtime: IAgentRuntime,
          message: Memory,
          _state: State
        ) => {
          // If message is undefined or doesn't have userId, this is being called from the task service
          if (!message || !message.userId) {
            logger.info(`[TWITTER_DEBUG] Worker validate called from task service, allowing execution`);
            return true;
          }
          
          // Check user authorization
          const userRole = await getUserServerRole(runtime, message.userId, serverId);
          
          // Add debug logging for role detection
          logger.info(`[TWITTER_DEBUG] Worker validate - User ${message.userId} role for server ${serverId}: ${userRole}`);
          
          // Check if user is in world metadata roles directly
          const worldId = createUniqueUuid(runtime, serverId);
          const world = await runtime.databaseAdapter.getWorld(worldId);
          
          let isAuthorized = userRole === RoleName.OWNER || userRole === RoleName.ADMIN;
          
          // Additional role check directly from world metadata
          if (world && world.metadata?.roles) {
            // Check if user ID is directly in roles
            if (world.metadata.roles[message.userId] === RoleName.OWNER || 
                world.metadata.roles[message.userId] === RoleName.ADMIN) {
              logger.info(`[TWITTER_DEBUG] Worker validate - User found directly in roles as: ${world.metadata.roles[message.userId]}`);
              isAuthorized = true;
            }
            
            // Check if user is the server owner
            if (world.metadata.ownership?.ownerId === message.userId) {
              logger.info(`[TWITTER_DEBUG] Worker validate - User is the server owner`);
              isAuthorized = true;
            }
          }
          
          return isAuthorized;
        },
      }

      // if the worker is not registered, register it
      if (!runtime.getTaskWorker("Confirm Twitter Post")) {
        logger.info(`[TWITTER_DEBUG] Registering Confirm Twitter Post worker`);
        runtime.registerTaskWorker(worker);
      } else {
        logger.info(`[TWITTER_DEBUG] Confirm Twitter Post worker already registered`);
      }

      // Register approval task
      runtime.databaseAdapter.createTask({
        roomId: message.roomId,
        name: "Confirm Twitter Post",
        description: "Confirm the tweet to be posted.",
        tags: ["TWITTER_POST", "AWAITING_CHOICE", "queue"],
        metadata: {
          options: [
            {
              name: "post",
              description: "Post the tweet to Twitter",
            },
            {
              name: "cancel",
              description: "Cancel the tweet and don't post it",
            },
          ],
          updatedAt: Date.now(),
          tweetContent: cleanTweet,
        },
      });

      responseContent.text += "\nWaiting for approval from an admin or boss";

      await callback({
        ...responseContent,
        action: "TWITTER_POST_TASK_NEEDS_CONFIRM",
      });

      logger.info("TWITTER_POST_TASK_NEEDS_CONFIRM", runtime.databaseAdapter.getTasks({roomId: message.roomId, tags: ["TWITTER_POST"]}));
      
      return responseContent;
    } catch (error) {
      logger.error("Error in TWITTER_POST action:", error);
      throw error;
    }
  },

  examples: [
    [
      {
        user: "{{user1}}",
        content: {
          text: "That's such a great point about neural networks! You should tweet that",
        },
      },
      {
        user: "{{user2}}",
        content: {
          text: "I'll tweet this:\n\nDeep learning isn't just about layers - it's about understanding how neural networks actually learn from patterns. The magic isn't in the math, it's in the emergent behaviors we're just beginning to understand.",
          action: "TWITTER_POST",
        },
      },
    ],
    [
      {
        user: "{{user1}}",
        content: {
          text: "Can you share this insight on Twitter?",
        },
      },
      {
        user: "{{user2}}",
        content: {
          text: "Tweet posted!\nhttps://twitter.com/username/status/123456789",
          action: "TWITTER_POST",
        },
      },
    ],
  ],
};

export default twitterPostAction;