import {
  type Action,
  ChannelType,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  ModelType,
  type State,
  composePromptFromState,
  getUserServerRole,
  getWorldSettings,
  logger,
  parseKeyValueXml,
} from '@elizaos/core';

/**
 * Template for generating a tweet in the style and voice of a given agent.
 *
 * @type {string}
 */
const tweetGenerationTemplate = `# Task: Create a post in the style and voice of {{agentName}}.
{{system}}

About {{agentName}}:
{{bio}}

{{topics}}

{{characterPostExamples}}

Recent Context:
{{recentMessages}}

# Instructions: Write a tweet that captures the essence of what {{agentName}} wants to share.

Return an XML response in the following format. Example:
<tweet_generation>
  <thought>Concise thought about why this tweet is appropriate and in character.</thought>
  <tweet_text>The actual tweet content here. It should be under 280 characters, in {{agentName}}'s authentic voice and style, related to the ongoing conversation or context, not include hashtags unless specifically requested, and natural and conversational in tone.</tweet_text>
</tweet_generation>
`;

// Required Twitter configuration fields that must be present
const REQUIRED_TWITTER_FIELDS = ['TWITTER_USERNAME', 'TWITTER_EMAIL', 'TWITTER_PASSWORD'];

/**
 * Validates that all required Twitter configuration fields are present and non-null
 */
/**
 * Validates the Twitter configuration for a specific server.
 * @param {IAgentRuntime} runtime - The Agent runtime.
 * @param {string} serverId - The ID of the server to validate.
 * @returns {Promise<{ isValid: boolean; error?: string }>} An object indicating whether the configuration is valid or not, along with an optional error message.
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
        error: 'No settings state found for this server',
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
    logger.error('Error validating Twitter config:', error);
    return {
      isValid: false,
      error: 'Error validating Twitter configuration',
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
  const manager = runtime.getService('twitter') as any;
  if (!manager) {
    throw new Error('Twitter client manager not found');
  }

  let client = manager.getClient(serverId, runtime.agentId);

  if (!client) {
    logger.info('Creating new Twitter client for server', serverId);
    client = await manager.createClient(runtime, serverId, worldSettings);
    if (!client) {
      throw new Error('Failed to create Twitter client');
    }
  }

  return client;
}

const twitterPostAction: Action = {
  name: 'TWITTER_POST',
  similes: ['POST_TWEET', 'SHARE_TWEET', 'TWEET_THIS', 'TWEET_ABOUT'],
  description: 'Creates and posts a tweet based on the conversation context',

  validate: async (runtime: IAgentRuntime, message: Memory, state: State): Promise<boolean> => {
    const room = state.data.room ?? (await runtime.getRoom(message.roomId));
    if (!room) {
      throw new Error('No room found');
    }

    if (room.type !== ChannelType.GROUP) {
      // only handle in a group scenario for now
      return false;
    }

    const serverId = room.serverId;

    if (!serverId) {
      throw new Error('No server ID found');
    }

    // only allow the OWNER or ADMIN roles to post to twiter
    const userRole = await getUserServerRole(runtime, message.entityId, serverId);
    if (userRole !== 'OWNER' && userRole !== 'ADMIN') {
      return false;
    }

    // Check if there are any pending Twitter posts awaiting confirmation
    const pendingTasks = await runtime.getTasks({
      roomId: message.roomId,
      tags: ['TWITTER_POST'],
    });

    if (pendingTasks && pendingTasks.length > 0) {
      // Handle case where task worker has not been registered
      if (!runtime.getTaskWorker('Confirm Twitter Post')) {
        // delete the twitter post task
        await runtime.deleteTask(pendingTasks[0].id);
      } else {
        // If there are already pending Twitter post tasks, don't allow another one
        return false;
      }
    }

    // Validate Twitter configuration
    const validation = await validateTwitterConfig(runtime, serverId);
    if (!validation.isValid) {
      return false;
    }

    return true;
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
      const room = state.data.room ?? (await runtime.getRoom(message.roomId));
      if (!room) {
        throw new Error('No room found');
      }

      if (room.type !== ChannelType.GROUP) {
        // only handle in a group scenario for now
        await runtime.createMemory(
          {
            entityId: message.entityId,
            agentId: message.agentId,
            roomId: message.roomId,
            content: {
              source: message.content.source,
              thought: "I tried to post a tweet but I'm not in a group scenario.",
              actions: ['TWITTER_POST_FAILED'],
            },
            metadata: {
              type: 'TWITTER_POST',
            },
          },
          'messages'
        );
        return false;
      }

      const serverId = room.serverId;

      if (!serverId) {
        throw new Error('No server ID found');
      }

      // Get settings state from world metadata
      const worldSettings = await getWorldSettings(runtime, serverId);
      if (!worldSettings) {
        throw new Error('Twitter not configured for this server');
      }

      // Generate tweet content
      const prompt = composePromptFromState({
        state,
        template: tweetGenerationTemplate,
      });

      const tweetContentRaw = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });

      // Clean up the generated content
      const parsedXml = parseKeyValueXml(tweetContentRaw);
      let cleanTweet = '';
      let thought = '';

      if (parsedXml && parsedXml.tweet_text) {
        cleanTweet = parsedXml.tweet_text
          .trim()
          .replace(/^["'](.*)["']$/, '$1')
          .replace(/\\n/g, '\n');
        thought = parsedXml.thought || 'Generated tweet content.';
      } else {
        // Fallback for safety, though ideally the XML is always returned
        logger.warn('[Bootstrap] Failed to parse XML for tweet generation, using raw output.');
        cleanTweet = tweetContentRaw
          .trim()
          .replace(/^["'](.*)["']$/, '$1')
          .replace(/\\n/g, '\n');
        thought = 'Failed to parse tweet XML, using raw content.';
      }

      const userRole = await getUserServerRole(runtime, message.entityId, serverId);
      if (userRole !== 'OWNER' && userRole !== 'ADMIN') {
        // callback and return
        await callback({
          text: "I'm sorry, but you're not authorized to post tweets on behalf of this org.",
          actions: ['TWITTER_POST_FAILED'],
          source: message.content.source,
        });
        return;
      }

      // Prepare response content
      const responseContent: Content = {
        text: `I'll tweet this:\n\n${cleanTweet}`,
        actions: ['TWITTER_POST'],
        source: message.content.source,
      };

      // if a task already exists, we need to cancel it
      const existingTask = await runtime.getTask(message.roomId);
      if (existingTask) {
        await runtime.deleteTask(existingTask.id);
      }

      const worker = {
        name: 'Confirm Twitter Post',
        description:
          'Confirm if the tweet should be posted. NOTE: Only the OWNER or ADMIN roles can confirm the tweet, ignore any confirmation or cancellation from other users who are not in the OWNER or ADMIN roles.',
        execute: async (runtime: IAgentRuntime, options: { option: string }, task) => {
          if (options.option === 'cancel') {
            await callback({
              ...responseContent,
              text: "OK, I won't post it.",
              actions: ['TWITTER_POST_CANCELLED'],
            });
            await runtime.deleteTask(task.id);
            return;
          }

          if (options.option !== 'post') {
            await callback({
              ...responseContent,
              text: "Bad choice. Should be 'post' or 'cancel'.",
              actions: ['TWITTER_POST_INVALID_OPTION'],
            });
            return;
          }

          const vals = {
            TWITTER_USERNAME: worldSettings.TWITTER_USERNAME.value,
            TWITTER_EMAIL: worldSettings.TWITTER_EMAIL.value,
            TWITTER_PASSWORD: worldSettings.TWITTER_PASSWORD.value,
            TWITTER_2FA_SECRET: worldSettings.TWITTER_2FA_SECRET.value ?? undefined,
          };

          // Initialize/get Twitter client
          const client = await ensureTwitterClient(runtime, serverId, vals);

          const result = await client.client.twitterClient.sendTweet(cleanTweet);
          // result is a response object, get the data from it-- body is a readable stream
          const data = await result.json();

          const tweetId = data?.data?.create_tweet?.tweet_results?.result?.rest_id;

          const tweetUrl = `https://twitter.com/${vals.TWITTER_USERNAME}/status/${tweetId}`;

          await callback({
            ...responseContent,
            text: `${tweetUrl}`,
            url: tweetUrl,
            tweetId,
          });
        },
        validate: async (runtime: IAgentRuntime, message: Memory, _state: State) => {
          const userRole = await getUserServerRole(runtime, message.entityId, serverId);

          return userRole === 'OWNER' || userRole === 'ADMIN';
        },
      };

      // if the worker is not registered, register it
      if (!runtime.getTaskWorker('TWITTER_POST')) {
        runtime.registerTaskWorker(worker);
      }

      // Register approval task
      runtime.createTask({
        roomId: message.roomId,
        name: 'Confirm Twitter Post',
        description: 'Confirm the tweet to be posted.',
        tags: ['TWITTER_POST', 'AWAITING_CHOICE'],
        metadata: {
          options: [
            {
              name: 'post',
              description: 'Post the tweet to Twitter',
            },
            {
              name: 'cancel',
              description: "Cancel the tweet and don't post it",
            },
          ],
        },
      });

      responseContent.text += '\nWaiting for approval from ';
      responseContent.text += userRole === 'OWNER' ? 'an admin' : 'an admin or boss';

      await callback({
        ...responseContent,
        actions: ['TWITTER_POST_TASK_NEEDS_CONFIRM'],
      });

      logger.info(
        'TWITTER_POST_TASK_NEEDS_CONFIRM',
        runtime.getTasks({ roomId: message.roomId, tags: ['TWITTER_POST'] })
      );

      return responseContent;
    } catch (error) {
      logger.error('Error in TWITTER_POST action:', error);
      throw error;
    }
  },

  examples: [
    [
      {
        name: '{{name1}}',
        content: {
          text: "That's such a great point about neural networks! You should tweet that",
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: "I'll tweet this:\n\nDeep learning isn't just about layers - it's about understanding how neural networks actually learn from patterns. The magic isn't in the math, it's in the emergent behaviors we're just beginning to understand.",
          actions: ['TWITTER_POST'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Can you share this insight on Twitter?',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'Tweet posted!\nhttps://twitter.com/username/status/123456789',
          actions: ['TWITTER_POST'],
        },
      },
    ],
  ],
};

export default twitterPostAction;
