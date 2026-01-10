import {
  type ActionEventPayload,
  asUUID,
  ChannelType,
  composePromptFromState,
  type Content,
  ContentType,
  createUniqueUuid,
  type EntityPayload,
  type EvaluatorEventPayload,
  type EventPayload,
  EventType,
  type IAgentRuntime,
  imageDescriptionTemplate,
  type InvokePayload,
  logger,
  type Media,
  type Memory,
  messageHandlerTemplate,
  type MessagePayload,
  type MessageReceivedHandlerParams,
  ModelType,
  parseKeyValueXml,
  postCreationTemplate,
  Role,
  type Room,
  shouldRespondTemplate,
  truncateToCompleteSentence,
  type UUID,
  type WorldPayload,
} from '@elizaos/core';
import { v4 } from 'uuid';

/**
 * Represents media data containing a buffer of data and the media type.
 * @typedef {Object} MediaData
 * @property {Buffer} data - The buffer of data.
 * @property {string} mediaType - The type of media.
 */
type MediaData = {
  data: Buffer;
  mediaType: string;
};

const latestResponseIds = new Map<string, Map<string, string>>();

/**
 * Escapes special characters in a string to make it JSON-safe.
 */
/* // Removing JSON specific helpers
function escapeForJson(input: string): string {
  return input
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/```/g, '\\`\\`\\`');
}

function sanitizeJson(rawJson: string): string {
  try {
    // Try parsing directly
    JSON.parse(rawJson);
    return rawJson; // Already valid
  } catch {
    // Continue to sanitization
  }

  // first, replace all newlines with \n
  const sanitized = rawJson
    .replace(/\n/g, '\\n')

    // then, replace all backticks with \\\`
    .replace(/`/g, '\\\`');

  // Regex to find and escape the "text" field
  const fixed = sanitized.replace(/"text"\s*:\s*"([\s\S]*?)"\s*,\s*"simple"/, (_match, group) => {
    const escapedText = escapeForJson(group);
    return `"text": "${escapedText}", "simple"`;
  });

  // Validate that the result is actually parseable
  try {
    JSON.parse(fixed);
    return fixed;
  } catch (e) {
    throw new Error(`Failed to sanitize JSON: ${e.message}`);
  }
}
*/

/**
 * Fetches media data from a list of attachments, supporting both HTTP URLs and local file paths.
 *
 * @param attachments Array of Media objects containing URLs or file paths to fetch media from
 * @returns Promise that resolves with an array of MediaData objects containing the fetched media data and content type
 */
/**
 * Fetches media data from given attachments.
 * @param {Media[]} attachments - Array of Media objects to fetch data from.
 * @returns {Promise<MediaData[]>} - A Promise that resolves with an array of MediaData objects.
 */
export async function fetchMediaData(attachments: Media[]): Promise<MediaData[]> {
  return Promise.all(
    attachments.map(async (attachment: Media) => {
      if (/^(http|https):\/\//.test(attachment.url)) {
        // Handle HTTP URLs
        const response = await fetch(attachment.url);
        if (!response.ok) {
          throw new Error(`Failed to fetch file: ${attachment.url}`);
        }
        const mediaBuffer = Buffer.from(await response.arrayBuffer());
        const mediaType = attachment.contentType || 'image/png';
        return { data: mediaBuffer, mediaType };
      }
      // if (fs.existsSync(attachment.url)) {
      //   // Handle local file paths
      //   const mediaBuffer = await fs.promises.readFile(path.resolve(attachment.url));
      //   const mediaType = attachment.contentType || 'image/png';
      //   return { data: mediaBuffer, mediaType };
      // }
      throw new Error(`File not found: ${attachment.url}. Make sure the path is correct.`);
    })
  );
}

/**
 * Processes attachments by generating descriptions for supported media types.
 * Currently supports image description generation.
 *
 * @param {Media[]} attachments - Array of attachments to process
 * @param {IAgentRuntime} runtime - The agent runtime for accessing AI models
 * @returns {Promise<Media[]>} - Returns a new array of processed attachments with added description, title, and text properties
 */
export async function processAttachments(
  attachments: Media[],
  runtime: IAgentRuntime
): Promise<Media[]> {
  if (!attachments || attachments.length === 0) {
    return [];
  }
  logger.debug(`[Message Handling] Processing ${attachments.length} attachment(s)`);

  const processedAttachments: Media[] = [];

  for (const attachment of attachments) {
    try {
      // Start with the original attachment
      const processedAttachment: Media = { ...attachment };

      // Only process images that don't already have descriptions
      if (attachment.contentType === ContentType.IMAGE && !attachment.description) {
        logger.debug(`[Message Handling] Generating description for image: ${attachment.url}`);

        try {
          const response = await runtime.useModel(ModelType.IMAGE_DESCRIPTION, {
            prompt: imageDescriptionTemplate,
            imageUrl: attachment.url,
          });

          if (typeof response === 'string') {
            // Parse XML response
            const parsedXml = parseKeyValueXml(response);

            if (parsedXml?.description && parsedXml?.text) {
              processedAttachment.description = parsedXml.description;
              processedAttachment.title = parsedXml.title || 'Image';
              processedAttachment.text = parsedXml.text;

              logger.debug(
                `[Message Handling] Generated description: ${processedAttachment.description?.substring(0, 100)}...`
              );
            } else {
              logger.warn(`[Message Handling] Failed to parse XML response for image description`);
            }
          } else if (response && typeof response === 'object' && 'description' in response) {
            // Handle object responses for backwards compatibility
            processedAttachment.description = response.description;
            processedAttachment.title = response.title || 'Image';
            processedAttachment.text = response.description;

            logger.debug(
              `[Message Handling] Generated description: ${processedAttachment.description?.substring(0, 100)}...`
            );
          } else {
            logger.warn(`[Message Handling] Unexpected response format for image description`);
          }
        } catch (error) {
          logger.error(`[Message Handling] Error generating image description:`, error);
          // Continue processing without description
        }
      }

      processedAttachments.push(processedAttachment);
    } catch (error) {
      logger.error(`[Message Handling] Failed to process attachment ${attachment.url}:`, error);
      // Add the original attachment if processing fails
      processedAttachments.push(attachment);
    }
  }

  return processedAttachments;
}

/**
 * Determines whether to skip the shouldRespond logic based on room type and message source.
 * Supports both default values and runtime-configurable overrides via env settings.
 */
export function shouldBypassShouldRespond(
  runtime: IAgentRuntime,
  room?: Room,
  source?: string
): boolean {
  if (!room) return false;

  function normalizeEnvList(value: unknown): string[] {
    if (!value || typeof value !== 'string') return [];

    const cleaned = value.trim().replace(/^\[|\]$/g, '');
    return cleaned
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
  }

  const defaultBypassTypes = [
    ChannelType.DM,
    ChannelType.VOICE_DM,
    ChannelType.SELF,
    ChannelType.API,
  ];

  const defaultBypassSources = ['client_chat'];

  const bypassTypesSetting = normalizeEnvList(runtime.getSetting('SHOULD_RESPOND_BYPASS_TYPES'));
  const bypassSourcesSetting = normalizeEnvList(
    runtime.getSetting('SHOULD_RESPOND_BYPASS_SOURCES')
  );

  const bypassTypes = new Set(
    [...defaultBypassTypes.map((t) => t.toString()), ...bypassTypesSetting].map((s: string) =>
      s.trim().toLowerCase()
    )
  );

  const bypassSources = [...defaultBypassSources, ...bypassSourcesSetting].map((s: string) =>
    s.trim().toLowerCase()
  );

  const roomType = room.type?.toString().toLowerCase();
  const sourceStr = source?.toLowerCase() || '';

  return bypassTypes.has(roomType) || bypassSources.some((pattern) => sourceStr.includes(pattern));
}

/**
 * Handles incoming messages and generates responses based on the provided runtime and message information.
 *
 * @param {MessageReceivedHandlerParams} params - The parameters needed for message handling, including runtime, message, and callback.
 * @returns {Promise<void>} - A promise that resolves once the message handling and response generation is complete.
 */
const messageReceivedHandler = async ({
  runtime,
  message,
  callback,
  onComplete,
}: MessageReceivedHandlerParams): Promise<void> => {
  // Set up timeout monitoring
  const timeoutDuration = 60 * 60 * 1000; // 1 hour
  let timeoutId: NodeJS.Timeout | undefined = undefined;

  try {
    logger.info(
      `[Message Handling] Message received from ${message.entityId} in room ${message.roomId}`
    );
    // Generate a new response ID
    const responseId = v4();
    // Get or create the agent-specific map
    if (!latestResponseIds.has(runtime.agentId)) {
      latestResponseIds.set(runtime.agentId, new Map<string, string>());
    }
    const agentResponses = latestResponseIds.get(runtime.agentId);
    if (!agentResponses) {
      throw new Error('Agent responses map not found');
    }

    // Set this as the latest response ID for this agent+room
    agentResponses.set(message.roomId, responseId);

    // Use runtime's run tracking for this message processing
    const runId = runtime.startRun();
    const startTime = Date.now();

    // Emit run started event
    await runtime.emitEvent(EventType.RUN_STARTED, {
      runtime,
      runId,
      messageId: message.id,
      roomId: message.roomId,
      entityId: message.entityId,
      startTime,
      status: 'started',
      source: 'messageHandler',
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(async () => {
        await runtime.emitEvent(EventType.RUN_TIMEOUT, {
          runtime,
          runId,
          messageId: message.id,
          roomId: message.roomId,
          entityId: message.entityId,
          startTime,
          status: 'timeout',
          endTime: Date.now(),
          duration: Date.now() - startTime,
          error: 'Run exceeded 60 minute timeout',
          source: 'messageHandler',
        });
        reject(new Error('Run exceeded 60 minute timeout'));
      }, timeoutDuration);
    });

    const processingPromise = (async () => {
      try {
        if (message.entityId === runtime.agentId) {
          logger.debug(`[Message Handling] Skipping message from self (${runtime.agentId})`);
          throw new Error('Message is from the agent itself');
        }

        logger.debug(
          `[Message Handling] Processing message: ${truncateToCompleteSentence(message.content.text || '', 50)}...`
        );

        // First, save the incoming message
        logger.debug('[Message Handling] Saving message to memory and embeddings');
        await Promise.all([
          runtime.addEmbeddingToMemory(message),
          runtime.createMemory(message, 'messages'),
        ]);

        const agentUserState = await runtime.getParticipantUserState(
          message.roomId,
          runtime.agentId
        );

        if (
          agentUserState === 'MUTED' &&
          !message.content.text?.toLowerCase().includes(runtime.character.name.toLowerCase())
        ) {
          logger.debug(`[Message Handling] Ignoring muted room ${message.roomId}`);
          return;
        }

        let state = await runtime.composeState(
          message,
          ['ANXIETY', 'SHOULD_RESPOND', 'ENTITIES', 'CHARACTER', 'RECENT_MESSAGES', 'ACTIONS'],
          true
        );

        // Skip shouldRespond check for DM and VOICE_DM channels
        const room = await runtime.getRoom(message.roomId);

        const shouldSkipShouldRespond = shouldBypassShouldRespond(
          runtime,
          room ?? undefined,
          message.content.source
        );

        if (message.content.attachments && message.content.attachments.length > 0) {
          message.content.attachments = await processAttachments(
            message.content.attachments,
            runtime
          );
        }

        let shouldRespond = true;

        // Handle shouldRespond
        if (!shouldSkipShouldRespond) {
          const shouldRespondPrompt = composePromptFromState({
            state,
            template: runtime.character.templates?.shouldRespondTemplate || shouldRespondTemplate,
          });

          logger.debug(
            `[Message Handling] Evaluating response for ${runtime.character.name}\nPrompt: ${shouldRespondPrompt}`
          );

          const response = await runtime.useModel(ModelType.TEXT_SMALL, {
            prompt: shouldRespondPrompt,
          });

          logger.debug(
            `[Message Handling] Response evaluation for ${runtime.character.name}:\n${response}`
          );
          logger.debug(`[Message Handling] Response type: ${typeof response}`);

          // Try to preprocess response by removing code blocks markers if present
          // let processedResponse = response.replace('```json', '').replaceAll('```', '').trim(); // No longer needed for XML

          const responseObject = parseKeyValueXml(response);
          logger.debug('[Message Handling] Parsed response:', responseObject);

          // If an action is provided, the agent intends to respond in some way
          // Only exclude explicit non-response actions
          const nonResponseActions = ['IGNORE', 'NONE'];
          shouldRespond =
            responseObject?.action &&
            !nonResponseActions.includes(responseObject.action.toUpperCase());
        } else {
          logger.debug(
            `[Message Handling] Skipping shouldRespond check for ${runtime.character.name} because ${room?.type} ${room?.source}`
          );
          shouldRespond = true;
        }

        let responseMessages: Memory[] = [];

        console.log('shouldRespond is', shouldRespond);
        console.log('shouldSkipShouldRespond', shouldSkipShouldRespond);

        if (shouldRespond) {
          state = await runtime.composeState(message, ['ACTIONS']);
          if (!state.values.actionNames) {
            logger.warn('actionNames data missing from state, even though it was requested');
          }

          const prompt = composePromptFromState({
            state,
            template: runtime.character.templates?.messageHandlerTemplate || messageHandlerTemplate,
          });

          let responseContent: Content | null = null;

          // Retry if missing required fields
          let retries = 0;
          const maxRetries = 3;

          while (retries < maxRetries && (!responseContent?.thought || !responseContent?.actions)) {
            let response = await runtime.useModel(ModelType.TEXT_LARGE, {
              prompt,
            });

            logger.debug('[Message Handling] *** Raw LLM Response ***\n', response);

            // Attempt to parse the XML response
            const parsedXml = parseKeyValueXml(response);
            logger.debug('[Message Handling] *** Parsed XML Content ***\n', parsedXml);

            // Map parsed XML to Content type, handling potential missing fields
            if (parsedXml) {
              responseContent = {
                ...parsedXml,
                thought: parsedXml.thought || '',
                actions: parsedXml.actions || ['IGNORE'],
                providers: parsedXml.providers || [],
                text: parsedXml.text || '',
                simple: parsedXml.simple || false,
              };
            } else {
              responseContent = null;
            }

            retries++;
            if (!responseContent?.thought || !responseContent?.actions) {
              logger.warn(
                '[Message Handling] *** Missing required fields (thought or actions), retrying... ***\n',
                response,
                parsedXml,
                responseContent
              );
            }
          }

          // Check if this is still the latest response ID for this agent+room
          const currentResponseId = agentResponses.get(message.roomId);
          if (currentResponseId !== responseId) {
            logger.info(
              `Response discarded - newer message being processed for agent: ${runtime.agentId}, room: ${message.roomId}`
            );
            return;
          }

          if (responseContent && message.id) {
            responseContent.inReplyTo = createUniqueUuid(runtime, message.id);

            // Automatically determine if response is simple based on providers and actions
            // Simple = REPLY action with no providers used
            const isSimple =
              responseContent.actions?.length === 1 &&
              responseContent.actions[0].toUpperCase() === 'REPLY' &&
              (!responseContent.providers || responseContent.providers.length === 0);

            responseContent.simple = isSimple;

            const responseMessage = {
              id: asUUID(v4()),
              entityId: runtime.agentId,
              agentId: runtime.agentId,
              content: responseContent,
              roomId: message.roomId,
              createdAt: Date.now(),
            };

            responseMessages = [responseMessage];
          }

          // Clean up the response ID
          agentResponses.delete(message.roomId);
          if (agentResponses.size === 0) {
            latestResponseIds.delete(runtime.agentId);
          }

          if (responseContent?.providers?.length && responseContent?.providers?.length > 0) {
            state = await runtime.composeState(message, responseContent?.providers || []);
          }

          if (responseContent && responseContent.simple && responseContent.text) {
            // Log provider usage for simple responses
            if (responseContent.providers && responseContent.providers.length > 0) {
              logger.debug(
                '[Message Handling] Simple response used providers',
                responseContent.providers
              );
            }

            // without actions there can't be more than one message
            await callback(responseContent);
          } else {
            await runtime.processActions(message, responseMessages, state, callback);
          }
          await runtime.evaluate(message, state, shouldRespond, callback, responseMessages);
        } else {
          // Handle the case where the agent decided not to respond
          logger.debug('[Message Handling] Agent decided not to respond (shouldRespond is false).');

          // Check if we still have the latest response ID
          const currentResponseId = agentResponses.get(message.roomId);
          if (currentResponseId !== responseId) {
            logger.info(
              `Ignore response discarded - newer message being processed for agent: ${runtime.agentId}, room: ${message.roomId}`
            );
            return; // Stop processing if a newer message took over
          }

          if (!message.id) {
            logger.error(
              '[Message Handling] Message ID is missing, cannot create ignore response.'
            );
            return;
          }

          // Construct a minimal content object indicating ignore, include a generic thought
          const ignoreContent: Content = {
            thought: 'Agent decided not to respond to this message.',
            actions: ['IGNORE'],
            simple: true, // Treat it as simple for callback purposes
            inReplyTo: createUniqueUuid(runtime, message.id), // Reference original message
          };

          // Call the callback directly with the ignore content
          await callback(ignoreContent);

          // Also save this ignore action/thought to memory
          const ignoreMemory = {
            id: asUUID(v4()),
            entityId: runtime.agentId,
            agentId: runtime.agentId,
            content: ignoreContent,
            roomId: message.roomId,
            createdAt: Date.now(),
          };
          await runtime.createMemory(ignoreMemory, 'messages');
          logger.debug('[Message Handling] Saved ignore response to memory', {
            memoryId: ignoreMemory.id,
          });

          // Clean up the response ID since we handled it
          agentResponses.delete(message.roomId);
          if (agentResponses.size === 0) {
            latestResponseIds.delete(runtime.agentId);
          }

          // Optionally, evaluate the decision to ignore (if relevant evaluators exist)
          // await runtime.evaluate(message, state, shouldRespond, callback, []);
        }

        // Emit run ended event on successful completion
        await runtime.emitEvent(EventType.RUN_ENDED, {
          runtime,
          runId,
          messageId: message.id,
          roomId: message.roomId,
          entityId: message.entityId,
          startTime,
          status: 'completed',
          endTime: Date.now(),
          duration: Date.now() - startTime,
          source: 'messageHandler',
        });
      } catch (error: any) {
        console.error('error is', error);
        // Emit run ended event with error
        await runtime.emitEvent(EventType.RUN_ENDED, {
          runtime,
          runId,
          messageId: message.id,
          roomId: message.roomId,
          entityId: message.entityId,
          startTime,
          status: 'error',
          endTime: Date.now(),
          duration: Date.now() - startTime,
          error: error.message,
          source: 'messageHandler',
        });
      }
    })();

    await Promise.race([processingPromise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
    onComplete?.();
  }
};

/**
 * Handles the receipt of a reaction message and creates a memory in the designated memory manager.
 *
 * @param {Object} params - The parameters for the function.
 * @param {IAgentRuntime} params.runtime - The agent runtime object.
 * @param {Memory} params.message - The reaction message to be stored in memory.
 * @returns {void}
 */
const reactionReceivedHandler = async ({
  runtime,
  message,
}: {
  runtime: IAgentRuntime;
  message: Memory;
}) => {
  try {
    await runtime.createMemory(message, 'messages');
  } catch (error: any) {
    if (error.code === '23505') {
      logger.warn('[Message Handling] Duplicate reaction memory, skipping');
      return;
    }
    logger.error('[Message Handling] Error in reaction handler:', error);
  }
};

/**
 * Handles message deletion events by removing the corresponding memory from the agent's memory store.
 *
 * @param {Object} params - The parameters for the function.
 * @param {IAgentRuntime} params.runtime - The agent runtime object.
 * @param {Memory} params.message - The message memory that was deleted.
 * @returns {void}
 */
const messageDeletedHandler = async ({
  runtime,
  message,
}: {
  runtime: IAgentRuntime;
  message: Memory;
}) => {
  try {
    if (!message.id) {
      logger.error('[Message Handling] Cannot delete memory: message ID is missing');
      return;
    }

    logger.info(
      '[Message Handling] Deleting memory for message',
      message.id,
      'from room',
      message.roomId
    );
    await runtime.deleteMemory(message.id);
    logger.debug('[Message Handling] Successfully deleted memory for message', message.id);
  } catch (error: unknown) {
    logger.error('[Message Handling] Error in message deleted handler:', error);
  }
};

/**
 * Handles channel cleared events by removing all message memories from the specified room.
 *
 * @param {Object} params - The parameters for the function.
 * @param {IAgentRuntime} params.runtime - The agent runtime object.
 * @param {UUID} params.roomId - The room ID to clear message memories from.
 * @param {string} params.channelId - The original channel ID.
 * @param {number} params.memoryCount - Number of memories found.
 * @returns {void}
 */
const channelClearedHandler = async ({
  runtime,
  roomId,
  channelId,
  memoryCount,
}: {
  runtime: IAgentRuntime;
  roomId: UUID;
  channelId: string;
  memoryCount: number;
}) => {
  try {
    logger.info(
      `[Message Handling] Clearing ${memoryCount} message memories from channel ${channelId} -> room ${roomId}`
    );

    // Get all message memories for this room
    const memories = await runtime.getMemoriesByRoomIds({
      tableName: 'messages',
      roomIds: [roomId],
    });

    // Delete each message memory
    let deletedCount = 0;
    for (const memory of memories) {
      if (memory.id) {
        try {
          await runtime.deleteMemory(memory.id);
          deletedCount++;
        } catch (error) {
          logger.warn(`[Message Handling] Failed to delete message memory ${memory.id}:`, error);
        }
      }
    }

    logger.info(
      `[Message Handling] Successfully cleared ${deletedCount}/${memories.length} message memories from channel ${channelId}`
    );
  } catch (error: unknown) {
    logger.error('[Message Handling] Error in channel cleared handler:', error);
  }
};

/**
 * Handles the generation of a post (like a Tweet) and creates a memory for it.
 *
 * @param {Object} params - The parameters for the function.
 * @param {IAgentRuntime} params.runtime - The agent runtime object.
 * @param {Memory} params.message - The post message to be processed.
 * @param {HandlerCallback} params.callback - The callback function to execute after processing.
 * @returns {Promise<void>}
 */
const postGeneratedHandler = async ({
  runtime,
  callback,
  worldId,
  userId,
  roomId,
  source,
}: InvokePayload) => {
  logger.info('[Message Handling] Generating new post...');
  // Ensure world exists first
  await runtime.ensureWorldExists({
    id: worldId,
    name: `${runtime.character.name}'s Feed`,
    agentId: runtime.agentId,
    serverId: userId,
  });

  // Ensure timeline room exists
  await runtime.ensureRoomExists({
    id: roomId,
    name: `${runtime.character.name}'s Feed`,
    source,
    type: ChannelType.FEED,
    channelId: `${userId}-home`,
    serverId: userId,
    worldId: worldId,
  });

  const message = {
    id: createUniqueUuid(runtime, `tweet-${Date.now()}`) as UUID,
    entityId: runtime.agentId,
    agentId: runtime.agentId,
    roomId: roomId,
    content: {},
    metadata: {
      entityName: runtime.character.name,
      type: 'message',
    },
  };

  // generate thought of which providers to use using messageHandlerTemplate

  // Compose state with relevant context for tweet generation
  let state = await runtime.composeState(message, [
    'PROVIDERS',
    'CHARACTER',
    'RECENT_MESSAGES',
    'ENTITIES',
  ]);

  // get twitterUserName
  const entity = await runtime.getEntityById(runtime.agentId);
  if ((entity?.metadata?.twitter as any)?.userName || entity?.metadata?.userName) {
    state.values.twitterUserName =
      (entity?.metadata?.twitter as any)?.userName || entity?.metadata?.userName;
  }

  const prompt = composePromptFromState({
    state,
    template: runtime.character.templates?.messageHandlerTemplate || messageHandlerTemplate,
  });

  let responseContent: Content | null = null;

  // Retry if missing required fields
  let retries = 0;
  const maxRetries = 3;
  while (retries < maxRetries && (!responseContent?.thought || !responseContent?.actions)) {
    const response = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
    });

    console.log('prompt is', prompt);
    console.log('response is', response);

    // Parse XML
    const parsedXml = parseKeyValueXml(response);
    if (parsedXml) {
      responseContent = {
        thought: parsedXml.thought || '',
        actions: parsedXml.actions || ['IGNORE'],
        providers: parsedXml.providers || [],
        text: parsedXml.text || '',
        simple: parsedXml.simple || false,
      };
    } else {
      responseContent = null;
    }

    retries++;
    if (!responseContent?.thought || !responseContent?.actions) {
      logger.warn(
        '[Message Handling] *** Missing required fields, retrying... ***\n',
        response,
        parsedXml,
        responseContent
      );
    }
  }

  // update stats with correct providers
  state = await runtime.composeState(message, responseContent?.providers);

  // Generate prompt for tweet content
  const postPrompt = composePromptFromState({
    state,
    template: runtime.character.templates?.postCreationTemplate || postCreationTemplate,
  });

  // Use TEXT_LARGE model as we expect structured XML text, not a JSON object
  const xmlResponseText = await runtime.useModel(ModelType.TEXT_LARGE, {
    prompt: postPrompt,
  });

  // Parse the XML response
  const parsedXmlResponse = parseKeyValueXml(xmlResponseText);

  if (!parsedXmlResponse) {
    logger.error(
      '[Message Handling] Failed to parse XML response for post creation. Raw response:',
      xmlResponseText
    );
    // Handle the error appropriately, maybe retry or return an error state
    return;
  }

  /**
   * Cleans up a tweet text by removing quotes and fixing newlines
   */
  function cleanupPostText(text: string): string {
    // Remove quotes
    let cleanedText = text.replace(/^['"](.*)['"]$/, '$1');
    // Fix newlines
    cleanedText = cleanedText.replaceAll(/\\n/g, '\n\n');
    cleanedText = cleanedText.replace(/([^\n])\n([^\n])/g, '$1\n\n$2');

    return cleanedText;
  }

  // Cleanup the tweet text
  const cleanedText = cleanupPostText(parsedXmlResponse.post || '');

  // Prepare media if included
  // const mediaData: MediaData[] = [];
  // if (jsonResponse.imagePrompt) {
  // 	const images = await runtime.useModel(ModelType.IMAGE, {
  // 		prompt: jsonResponse.imagePrompt,
  // 		output: "no-schema",
  // 	});
  // 	try {
  // 		// Convert image prompt to Media format for fetchMediaData
  // 		const imagePromptMedia: any[] = images

  // 		// Fetch media using the utility function
  // 		const fetchedMedia = await fetchMediaData(imagePromptMedia);
  // 		mediaData.push(...fetchedMedia);
  // 	} catch (error) {
  // 		logger.error("Error fetching media for tweet:", error);
  // 	}
  // }

  // have we posted it before?
  const RM = state.providerData?.find((pd) => pd.providerName === 'RECENT_MESSAGES');
  if (RM) {
    for (const m of RM.data.recentMessages) {
      if (cleanedText === m.content.text) {
        logger.log('[Message Handling] Already recently posted that, retrying', cleanedText);
        postGeneratedHandler({
          runtime,
          callback,
          worldId,
          userId,
          roomId,
          source,
        });
        return; // don't call callbacks
      }
    }
  }

  // GPT 3.5/4: /(i\s+do\s+not|i'?m\s+not)\s+(feel\s+)?comfortable\s+generating\s+that\s+type\s+of\s+content|(inappropriate|explicit|offensive|communicate\s+respectfully|aim\s+to\s+(be\s+)?helpful)/i
  const oaiRefusalRegex =
    /((i\s+do\s+not|i'm\s+not)\s+(feel\s+)?comfortable\s+generating\s+that\s+type\s+of\s+content)|(inappropriate|explicit|respectful|offensive|guidelines|aim\s+to\s+(be\s+)?helpful|communicate\s+respectfully)/i;
  const anthropicRefusalRegex =
    /(i'?m\s+unable\s+to\s+help\s+with\s+that\s+request|due\s+to\s+safety\s+concerns|that\s+may\s+violate\s+(our\s+)?guidelines|provide\s+helpful\s+and\s+safe\s+responses|let'?s\s+try\s+a\s+different\s+direction|goes\s+against\s+(our\s+)?use\s+case\s+policies|ensure\s+safe\s+and\s+responsible\s+use)/i;
  const googleRefusalRegex =
    /(i\s+can'?t\s+help\s+with\s+that|that\s+goes\s+against\s+(our\s+)?(policy|policies)|i'?m\s+still\s+learning|response\s+must\s+follow\s+(usage|safety)\s+policies|i'?ve\s+been\s+designed\s+to\s+avoid\s+that)/i;
  //const cohereRefusalRegex = /(request\s+cannot\s+be\s+processed|violates\s+(our\s+)?content\s+policy|not\s+permitted\s+by\s+usage\s+restrictions)/i
  const generalRefusalRegex =
    /(response\s+was\s+withheld|content\s+was\s+filtered|this\s+request\s+cannot\s+be\s+completed|violates\s+our\s+safety\s+policy|content\s+is\s+not\s+available)/i;

  if (
    oaiRefusalRegex.test(cleanedText) ||
    anthropicRefusalRegex.test(cleanedText) ||
    googleRefusalRegex.test(cleanedText) ||
    generalRefusalRegex.test(cleanedText)
  ) {
    logger.log('[Message Handling] Got prompt moderation refusal, retrying', cleanedText);
    postGeneratedHandler({
      runtime,
      callback,
      worldId,
      userId,
      roomId,
      source,
    });
    return; // don't call callbacks
  }

  // Create the response memory
  const responseMessages = [
    {
      id: v4() as UUID,
      entityId: runtime.agentId,
      agentId: runtime.agentId,
      content: {
        text: cleanedText,
        source,
        channelType: ChannelType.FEED,
        thought: parsedXmlResponse.thought || '',
        type: 'post',
      },
      roomId: message.roomId,
      createdAt: Date.now(),
    },
  ];

  for (const message of responseMessages) {
    await callback?.(message.content);
  }

  // Process the actions and execute the callback
  // await runtime.processActions(message, responseMessages, state, callback);

  // // Run any configured evaluators
  // await runtime.evaluate(
  // 	message,
  // 	state,
  // 	true, // Post generation is always a "responding" scenario
  // 	callback,
  // 	responseMessages,
  // );
};

/**
 * Syncs a single user into an entity
 */
/**
 * Asynchronously sync a single user with the specified parameters.
 *
 * @param {UUID} entityId - The unique identifier for the entity.
 * @param {IAgentRuntime} runtime - The runtime environment for the agent.
 * @param {any} user - The user object to sync.
 * @param {string} serverId - The unique identifier for the server.
 * @param {string} channelId - The unique identifier for the channel.
 * @param {ChannelType} type - The type of channel.
 * @param {string} source - The source of the user data.
 * @returns {Promise<void>} A promise that resolves once the user is synced.
 */
const syncSingleUser = async (
  entityId: UUID,
  runtime: IAgentRuntime,
  serverId: string,
  channelId: string,
  type: ChannelType,
  source: string
) => {
  try {
    const entity = await runtime.getEntityById(entityId);
    logger.info(`[Message Handling] Syncing user: ${entity?.metadata?.username || entityId}`);

    // Ensure we're not using WORLD type and that we have a valid channelId
    if (!channelId) {
      logger.warn(`[Message Handling] Cannot sync user ${entity?.id} without a valid channelId`);
      return;
    }

    const roomId = createUniqueUuid(runtime, channelId);
    const worldId = createUniqueUuid(runtime, serverId);

    // Create world with ownership metadata for DM connections (onboarding)
    const worldMetadata =
      type === ChannelType.DM
        ? {
            ownership: {
              ownerId: entityId,
            },
            roles: {
              [entityId]: Role.OWNER,
            },
            settings: {}, // Initialize empty settings for onboarding
          }
        : undefined;

    logger.info(
      `[Message Handling] syncSingleUser - type: ${type}, isDM: ${type === ChannelType.DM}, worldMetadata: ${JSON.stringify(worldMetadata)}`
    );

    await runtime.ensureConnection({
      entityId,
      roomId,
      name: (entity?.metadata?.name || entity?.metadata?.username || `User${entityId}`) as
        | undefined
        | string,
      source,
      channelId,
      serverId,
      type,
      worldId,
      metadata: worldMetadata,
    });

    // Verify the world was created with proper metadata
    try {
      const createdWorld = await runtime.getWorld(worldId);
      logger.info(
        `[Message Handling] Created world check - ID: ${worldId}, metadata: ${JSON.stringify(createdWorld?.metadata)}`
      );
    } catch (error) {
      logger.error(`[Message Handling] Failed to verify created world: ${error}`);
    }

    logger.success(`[Message Handling] Successfully synced user: ${entity?.id}`);
  } catch (error) {
    logger.error(
      `[Message Handling] Error syncing user: ${error instanceof Error ? error.message : String(error)}`
    );
  }
};

/**
 * Handles standardized server data for both WORLD_JOINED and WORLD_CONNECTED events
 */
const handleServerSync = async ({
  runtime,
  world,
  rooms,
  entities,
  source,
  onComplete,
}: WorldPayload) => {
  logger.debug(`[Message Handling] Handling server sync event for server: ${world.name}`);
  try {
    await runtime.ensureConnections(entities, rooms, source, world);
    logger.debug(`Successfully synced standardized world structure for ${world.name}`);
    onComplete?.();
  } catch (error) {
    logger.error(
      `Error processing standardized server data: ${error instanceof Error ? error.message : String(error)}`
    );
  }
};

/**
 * Handles control messages for enabling or disabling UI elements in the frontend
 * @param {Object} params - Parameters for the handler
 * @param {IAgentRuntime} params.runtime - The runtime instance
 * @param {Object} params.message - The control message
 * @param {string} params.source - Source of the message
 */
const controlMessageHandler = async ({
  runtime,
  message,
  source,
}: {
  runtime: IAgentRuntime;
  message: {
    type: 'control';
    payload: {
      action: 'enable_input' | 'disable_input';
      target?: string;
    };
    roomId: UUID;
  };
  source: string;
}) => {
  try {
    logger.debug(
      `[controlMessageHandler] Processing control message: ${message.payload.action} for room ${message.roomId}`
    );

    // Here we would use a WebSocket service to send the control message to the frontend
    // This would typically be handled by a registered service with sendMessage capability

    // Get any registered WebSocket service
    const serviceNames = Array.from(runtime.getAllServices().keys()) as string[];
    const websocketServiceName = serviceNames.find(
      (name: string) =>
        name.toLowerCase().includes('websocket') || name.toLowerCase().includes('socket')
    );

    if (websocketServiceName) {
      const websocketService = runtime.getService(websocketServiceName);
      if (websocketService && 'sendMessage' in websocketService) {
        // Send the control message through the WebSocket service
        await (websocketService as any).sendMessage({
          type: 'controlMessage',
          payload: {
            action: message.payload.action,
            target: message.payload.target,
            roomId: message.roomId,
          },
        });

        logger.debug(
          `[controlMessageHandler] Control message ${message.payload.action} sent successfully`
        );
      } else {
        logger.error('[controlMessageHandler] WebSocket service does not have sendMessage method');
      }
    } else {
      logger.error('[controlMessageHandler] No WebSocket service found to send control message');
    }
  } catch (error) {
    logger.error(`[controlMessageHandler] Error processing control message: ${error}`);
  }
};

export const events = {
  [EventType.MESSAGE_RECEIVED]: [
    async (payload: MessagePayload) => {
      if (!payload.callback) {
        logger.error('No callback provided for message');
        return;
      }
      await messageReceivedHandler({
        runtime: payload.runtime,
        message: payload.message,
        callback: payload.callback,
        onComplete: payload.onComplete,
      });
    },
  ],

  [EventType.VOICE_MESSAGE_RECEIVED]: [
    async (payload: MessagePayload) => {
      if (!payload.callback) {
        logger.error('No callback provided for voice message');
        return;
      }
      await messageReceivedHandler({
        runtime: payload.runtime,
        message: payload.message,
        callback: payload.callback,
        onComplete: payload.onComplete,
      });
    },
  ],

  [EventType.REACTION_RECEIVED]: [
    async (payload: MessagePayload) => {
      await reactionReceivedHandler({
        runtime: payload.runtime,
        message: payload.message,
      });
    },
  ],

  [EventType.POST_GENERATED]: [
    async (payload: InvokePayload) => {
      await postGeneratedHandler(payload);
    },
  ],

  [EventType.MESSAGE_SENT]: [
    async (payload: MessagePayload) => {
      logger.debug(`[Message Handling] Message sent: ${payload.message.content.text}`);
    },
  ],

  [EventType.MESSAGE_DELETED]: [
    async (payload: MessagePayload) => {
      await messageDeletedHandler({
        runtime: payload.runtime,
        message: payload.message,
      });
    },
  ],

  [EventType.CHANNEL_CLEARED]: [
    async (payload: EventPayload & { roomId: UUID; channelId: string; memoryCount: number }) => {
      await channelClearedHandler({
        runtime: payload.runtime,
        roomId: payload.roomId,
        channelId: payload.channelId,
        memoryCount: payload.memoryCount,
      });
    },
  ],

  [EventType.WORLD_JOINED]: [
    async (payload: WorldPayload) => {
      await handleServerSync(payload);
    },
  ],

  [EventType.WORLD_CONNECTED]: [
    async (payload: WorldPayload) => {
      await handleServerSync(payload);
    },
  ],

  [EventType.ENTITY_JOINED]: [
    async (payload: EntityPayload) => {
      logger.debug(
        `[Message Handling] ENTITY_JOINED event received for entity ${payload.entityId}`
      );

      if (!payload.worldId) {
        logger.error('[Message Handling] No worldId provided for entity joined');
        return;
      }
      if (!payload.roomId) {
        logger.error('[Message Handling] No roomId provided for entity joined');
        return;
      }
      if (!payload.metadata?.type) {
        logger.error('[Message Handling] No type provided for entity joined');
        return;
      }

      await syncSingleUser(
        payload.entityId,
        payload.runtime,
        payload.worldId,
        payload.roomId,
        payload.metadata.type,
        payload.source
      );
    },
  ],

  [EventType.ENTITY_LEFT]: [
    async (payload: EntityPayload) => {
      try {
        // Update entity to inactive
        const entity = await payload.runtime.getEntityById(payload.entityId);
        if (entity) {
          entity.metadata = {
            ...entity.metadata,
            status: 'INACTIVE',
            leftAt: Date.now(),
          };
          await payload.runtime.updateEntity(entity);
        }
        logger.info(`[Message Handling] User ${payload.entityId} left world ${payload.worldId}`);
      } catch (error: any) {
        logger.error(`[Message Handling] Error handling user left: ${error.message}`);
      }
    },
  ],

  [EventType.ACTION_STARTED]: [
    async (payload: ActionEventPayload) => {
      logger.debug(
        `[Message Handling] Action started: ${payload.actionName} (${payload.actionId})`
      );
    },
  ],

  [EventType.ACTION_COMPLETED]: [
    async (payload: ActionEventPayload) => {
      const status = payload.error ? `failed: ${payload.error.message}` : 'completed';
      logger.debug(
        `[Message Handling] Action ${status}: ${payload.actionName} (${payload.actionId})`
      );
    },
  ],

  [EventType.EVALUATOR_STARTED]: [
    async (payload: EvaluatorEventPayload) => {
      logger.debug(
        `[Message Handling] Evaluator started: ${payload.evaluatorName} (${payload.evaluatorId})`
      );
    },
  ],

  [EventType.EVALUATOR_COMPLETED]: [
    async (payload: EvaluatorEventPayload) => {
      const status = payload.error ? `failed: ${payload.error.message}` : 'completed';
      logger.debug(
        `[Message Handling] Evaluator ${status}: ${payload.evaluatorName} (${payload.evaluatorId})`
      );
    },
  ],

  CONTROL_MESSAGE: [controlMessageHandler],
};
