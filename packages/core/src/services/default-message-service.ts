import { v4 } from 'uuid';
import type { IAgentRuntime } from '../types/runtime';
import type { Memory } from '../types/memory';
import type { Content, UUID, Media, MentionContext } from '../types/primitives';
import type { State } from '../types/state';
import type { HandlerCallback } from '../types/components';
import type { Room } from '../types/environment';
import {
  type IMessageService,
  type MessageProcessingOptions,
  type MessageProcessingResult,
  type ResponseDecision,
} from './message-service';
import {
  ChannelType,
  EventType,
  ModelType,
  ContentType,
  Role,
  asUUID,
  createUniqueUuid,
  composePromptFromState,
  imageDescriptionTemplate,
  messageHandlerTemplate,
  shouldRespondTemplate,
  multiStepDecisionTemplate,
  multiStepSummaryTemplate,
  parseKeyValueXml,
  parseBooleanFromText,
  truncateToCompleteSentence,
  getLocalServerUrl,
  logger,
} from '../index';

/**
 * Multi-step workflow execution result
 */
interface MultiStepActionResult {
  data: { actionName: string };
  success: boolean;
  text?: string;
  error?: string | Error;
  values?: Record<string, any>;
}

/**
 * Multi-step workflow state
 */
interface MultiStepState extends State {
  data: {
    actionResults: MultiStepActionResult[];
    [key: string]: any;
  };
}

/**
 * Strategy mode for response generation
 */
type StrategyMode = 'simple' | 'actions' | 'none';

/**
 * Strategy result from core processing
 */
interface StrategyResult {
  responseContent: Content | null;
  responseMessages: Memory[];
  state: any;
  mode: StrategyMode;
}

/**
 * Tracks the latest response ID per agent+room to handle message superseding
 */
const latestResponseIds = new Map<string, Map<string, string>>();

/**
 * Default implementation of the MessageService interface.
 * This service handles the complete message processing pipeline including:
 * - Message validation and memory creation
 * - Smart response decision (shouldRespond)
 * - Single-shot or multi-step processing strategies
 * - Action execution and evaluation
 * - Attachment processing
 * - Message deletion and channel clearing
 *
 * This is the standard message handler used by ElizaOS and can be replaced
 * with custom implementations via the IMessageService interface.
 */
export class DefaultMessageService implements IMessageService {
  /**
   * Main message handling entry point
   */
  async handleMessage(
    runtime: IAgentRuntime,
    message: Memory,
    callback?: HandlerCallback,
    options?: MessageProcessingOptions
  ): Promise<MessageProcessingResult> {
    const opts = {
      maxRetries: options?.maxRetries ?? 3,
      timeoutDuration: options?.timeoutDuration ?? 60 * 60 * 1000, // 1 hour
      useMultiStep:
        options?.useMultiStep ?? parseBooleanFromText(runtime.getSetting('USE_MULTI_STEP')),
      maxMultiStepIterations:
        options?.maxMultiStepIterations ??
        parseInt(runtime.getSetting('MAX_MULTISTEP_ITERATIONS') || '6'),
    };

    // Set up timeout monitoring
    let timeoutId: NodeJS.Timeout | undefined = undefined;
    const responseId = v4();

    try {
      runtime.logger.info(
        `[MessageService] Message received from ${message.entityId} in room ${message.roomId}`
      );

      // Track this response ID
      if (!latestResponseIds.has(runtime.agentId)) {
        latestResponseIds.set(runtime.agentId, new Map<string, string>());
      }
      const agentResponses = latestResponseIds.get(runtime.agentId);
      if (!agentResponses) throw new Error('Agent responses map not found');

      const previousResponseId = agentResponses.get(message.roomId);
      if (previousResponseId) {
        logger.warn(
          `[MessageService] Updating response ID for room ${message.roomId} from ${previousResponseId} to ${responseId}`
        );
      }
      agentResponses.set(message.roomId, responseId);

      // Start run tracking
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
        metadata: message.content,
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
            error: 'Run exceeded timeout',
            source: 'messageHandler',
          });
          reject(new Error('Run exceeded timeout'));
        }, opts.timeoutDuration);
      });

      const processingPromise = this.processMessage(
        runtime,
        message,
        callback,
        responseId,
        runId,
        startTime,
        opts
      );

      const result = await Promise.race([processingPromise, timeoutPromise]);

      // Clean up timeout
      clearTimeout(timeoutId);

      return result;
    } catch (error: any) {
      clearTimeout(timeoutId);
      runtime.logger.error({ error }, '[MessageService] Error in handleMessage:');
      throw error;
    }
  }

  /**
   * Internal message processing implementation
   */
  private async processMessage(
    runtime: IAgentRuntime,
    message: Memory,
    callback: HandlerCallback | undefined,
    responseId: string,
    runId: UUID,
    startTime: number,
    opts: Required<MessageProcessingOptions>
  ): Promise<MessageProcessingResult> {
    try {
      const agentResponses = latestResponseIds.get(runtime.agentId);
      if (!agentResponses) throw new Error('Agent responses map not found');

      // Skip messages from self
      if (message.entityId === runtime.agentId) {
        runtime.logger.debug(`[MessageService] Skipping message from self (${runtime.agentId})`);
        await this.emitRunEnded(runtime, runId, message, startTime, 'self');
        return {
          didRespond: false,
          responseContent: null,
          responseMessages: [],
          state: {} as any,
          mode: 'none',
        };
      }

      runtime.logger.debug(
        `[MessageService] Processing message: ${truncateToCompleteSentence(message.content.text || '', 50)}...`
      );

      // Save the incoming message to memory
      runtime.logger.debug('[MessageService] Saving message to memory and queueing embeddings');
      let memoryToQueue: Memory;

      if (message.id) {
        const existingMemory = await runtime.getMemoryById(message.id);
        if (existingMemory) {
          runtime.logger.debug('[MessageService] Memory already exists, skipping creation');
          memoryToQueue = existingMemory;
        } else {
          const createdMemoryId = await runtime.createMemory(message, 'messages');
          memoryToQueue = { ...message, id: createdMemoryId };
        }
        await runtime.queueEmbeddingGeneration(memoryToQueue, 'high');
      } else {
        const memoryId = await runtime.createMemory(message, 'messages');
        message.id = memoryId;
        memoryToQueue = { ...message, id: memoryId };
        await runtime.queueEmbeddingGeneration(memoryToQueue, 'normal');
      }

      // Check if LLM is off by default
      const agentUserState = await runtime.getParticipantUserState(message.roomId, runtime.agentId);
      const defLllmOff = parseBooleanFromText(runtime.getSetting('BOOTSTRAP_DEFLLMOFF'));

      if (defLllmOff && agentUserState === null) {
        runtime.logger.debug('[MessageService] LLM is off by default');
        await this.emitRunEnded(runtime, runId, message, startTime, 'off');
        return {
          didRespond: false,
          responseContent: null,
          responseMessages: [],
          state: {} as any,
          mode: 'none',
        };
      }

      // Check if room is muted
      if (
        agentUserState === 'MUTED' &&
        !message.content.text?.toLowerCase().includes(runtime.character.name.toLowerCase())
      ) {
        runtime.logger.debug(`[MessageService] Ignoring muted room ${message.roomId}`);
        await this.emitRunEnded(runtime, runId, message, startTime, 'muted');
        return {
          didRespond: false,
          responseContent: null,
          responseMessages: [],
          state: {} as any,
          mode: 'none',
        };
      }

      // Compose initial state
      let state = await runtime.composeState(
        message,
        ['ANXIETY', 'ENTITIES', 'CHARACTER', 'RECENT_MESSAGES', 'ACTIONS'],
        true
      );

      // Get room and mention context
      const mentionContext = message.content.mentionContext;
      const room = await runtime.getRoom(message.roomId);

      // Process attachments before deciding to respond
      if (message.content.attachments && message.content.attachments.length > 0) {
        message.content.attachments = await this.processAttachments(
          runtime,
          message.content.attachments
        );
        if (message.id) {
          await runtime.updateMemory({ id: message.id, content: message.content });
        }
      }

      // Determine if we should respond
      const responseDecision = this.shouldRespond(
        runtime,
        message,
        room ?? undefined,
        mentionContext
      );

      runtime.logger.debug(
        `[MessageService] Response decision: ${JSON.stringify(responseDecision)}`
      );

      let shouldRespondToMessage = true;

      // If we can skip the evaluation, use the decision directly
      if (responseDecision.skipEvaluation) {
        runtime.logger.debug(
          `[MessageService] Skipping evaluation for ${runtime.character.name} (${responseDecision.reason})`
        );
        shouldRespondToMessage = responseDecision.shouldRespond;
      } else {
        // Need LLM evaluation for ambiguous case
        const shouldRespondPrompt = composePromptFromState({
          state,
          template: runtime.character.templates?.shouldRespondTemplate || shouldRespondTemplate,
        });

        runtime.logger.debug(
          `[MessageService] Using LLM evaluation for ${runtime.character.name} (${responseDecision.reason})`
        );

        const response = await runtime.useModel(ModelType.TEXT_SMALL, {
          prompt: shouldRespondPrompt,
        });

        runtime.logger.debug(`[MessageService] LLM evaluation result:\n${response}`);

        const responseObject = parseKeyValueXml(response);
        runtime.logger.debug({ responseObject }, '[MessageService] Parsed evaluation result:');

        // If an action is provided, the agent intends to respond in some way
        const nonResponseActions = ['IGNORE', 'NONE'];
        shouldRespondToMessage =
          responseObject?.action &&
          !nonResponseActions.includes(responseObject.action.toUpperCase());
      }

      let responseContent: Content | null = null;
      let responseMessages: Memory[] = [];
      let mode: StrategyMode = 'none';

      if (shouldRespondToMessage) {
        const result = opts.useMultiStep
          ? await this.runMultiStepCore(runtime, message, state, callback, opts)
          : await this.runSingleShotCore(runtime, message, state, opts);

        responseContent = result.responseContent;
        responseMessages = result.responseMessages;
        state = result.state;
        mode = result.mode;

        // Race check before we send anything
        const currentResponseId = agentResponses.get(message.roomId);
        if (currentResponseId !== responseId) {
          runtime.logger.info(
            `Response discarded - newer message being processed for agent: ${runtime.agentId}, room: ${message.roomId}`
          );
          return {
            didRespond: false,
            responseContent: null,
            responseMessages: [],
            state,
            mode: 'none',
          };
        }

        if (responseContent && message.id) {
          responseContent.inReplyTo = createUniqueUuid(runtime, message.id);
        }

        if (responseContent?.providers?.length && responseContent.providers.length > 0) {
          state = await runtime.composeState(message, responseContent.providers || []);
        }

        if (responseContent) {
          if (mode === 'simple') {
            // Log provider usage for simple responses
            if (responseContent.providers && responseContent.providers.length > 0) {
              runtime.logger.debug(
                { providers: responseContent.providers },
                '[MessageService] Simple response used providers'
              );
            }
            if (callback) {
              await callback(responseContent);
            }
          } else if (mode === 'actions') {
            await runtime.processActions(message, responseMessages, state, async (content) => {
              runtime.logger.debug({ content }, 'action callback');
              responseContent!.actionCallbacks = content;
              if (callback) {
                return callback(content);
              }
              return [];
            });
          }
        }
      } else {
        // Agent decided not to respond
        runtime.logger.debug(
          '[MessageService] Agent decided not to respond (shouldRespond is false).'
        );

        // Check if we still have the latest response ID
        const currentResponseId = agentResponses.get(message.roomId);
        const keepResp = parseBooleanFromText(runtime.getSetting('BOOTSTRAP_KEEP_RESP'));

        if (currentResponseId !== responseId && !keepResp) {
          runtime.logger.info(
            `Ignore response discarded - newer message being processed for agent: ${runtime.agentId}, room: ${message.roomId}`
          );
          await this.emitRunEnded(runtime, runId, message, startTime, 'replaced');
          return {
            didRespond: false,
            responseContent: null,
            responseMessages: [],
            state,
            mode: 'none',
          };
        }

        if (!message.id) {
          runtime.logger.error(
            '[MessageService] Message ID is missing, cannot create ignore response.'
          );
          await this.emitRunEnded(runtime, runId, message, startTime, 'noMessageId');
          return {
            didRespond: false,
            responseContent: null,
            responseMessages: [],
            state,
            mode: 'none',
          };
        }

        // Construct a minimal content object indicating ignore
        const ignoreContent: Content = {
          thought: 'Agent decided not to respond to this message.',
          actions: ['IGNORE'],
          simple: true,
          inReplyTo: createUniqueUuid(runtime, message.id),
        };

        // Call the callback with the ignore content
        if (callback) {
          await callback(ignoreContent);
        }

        // Save this ignore action/thought to memory
        const ignoreMemory: Memory = {
          id: asUUID(v4()),
          entityId: runtime.agentId,
          agentId: runtime.agentId,
          content: ignoreContent,
          roomId: message.roomId,
          createdAt: Date.now(),
        };
        await runtime.createMemory(ignoreMemory, 'messages');
        runtime.logger.debug(
          '[MessageService] Saved ignore response to memory',
          `memoryId: ${ignoreMemory.id}`
        );
      }

      // Clean up the response ID
      agentResponses.delete(message.roomId);
      if (agentResponses.size === 0) {
        latestResponseIds.delete(runtime.agentId);
      }

      // Run evaluators
      await runtime.evaluate(
        message,
        state,
        shouldRespondToMessage,
        async (content) => {
          runtime.logger.debug({ content }, 'evaluate callback');
          if (responseContent) {
            responseContent.evalCallbacks = content;
          }
          if (callback) {
            return callback(content);
          }
          return [];
        },
        responseMessages
      );

      // Collect metadata for logging
      let entityName = 'noname';
      if (message.metadata && 'entityName' in message.metadata) {
        entityName = (message.metadata as any).entityName;
      }

      const isDM = message.content?.channelType === ChannelType.DM;
      let roomName = entityName;

      if (!isDM) {
        const roomDatas = await runtime.getRoomsByIds([message.roomId]);
        if (roomDatas?.length) {
          const roomData = roomDatas[0];
          if (roomData.name) {
            roomName = roomData.name;
          }
          if (roomData.worldId) {
            const worldData = await runtime.getWorld(roomData.worldId);
            if (worldData) {
              roomName = worldData.name + '-' + roomName;
            }
          }
        }
      }

      const date = new Date();
      const availableActions = state.data?.providers?.ACTIONS?.data?.actionsData?.map(
        (a: any) => a.name
      ) || [-1];

      const logData = {
        at: date.toString(),
        timestamp: parseInt('' + date.getTime() / 1000),
        messageId: message.id,
        userEntityId: message.entityId,
        input: message.content.text,
        thought: responseContent?.thought,
        simple: responseContent?.simple,
        availableActions,
        actions: responseContent?.actions,
        providers: responseContent?.providers,
        irt: responseContent?.inReplyTo,
        output: responseContent?.text,
        entityName,
        source: message.content.source,
        channelType: message.content.channelType,
        roomName,
      };

      // Emit run ended event
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
        entityName,
        responseContent,
        metadata: logData,
      });

      return {
        didRespond: shouldRespondToMessage,
        responseContent,
        responseMessages,
        state,
        mode,
      };
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
      throw error;
    }
  }

  /**
   * Determines whether the agent should respond to a message.
   * Uses simple rules for obvious cases (DM, mentions) and defers to LLM for ambiguous cases.
   */
  shouldRespond(
    runtime: IAgentRuntime,
    message: Memory,
    room?: Room,
    mentionContext?: MentionContext
  ): ResponseDecision {
    if (!room) {
      return { shouldRespond: false, skipEvaluation: true, reason: 'no room context' };
    }

    function normalizeEnvList(value: unknown): string[] {
      if (!value || typeof value !== 'string') return [];
      const cleaned = value.trim().replace(/^\[|\]$/g, '');
      return cleaned
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
    }

    // Channel types that always trigger a response (private channels)
    const alwaysRespondChannels = [
      ChannelType.DM,
      ChannelType.VOICE_DM,
      ChannelType.SELF,
      ChannelType.API,
    ];

    // Sources that always trigger a response
    const alwaysRespondSources = ['client_chat'];

    // Support runtime-configurable overrides via env settings
    const customChannels = normalizeEnvList(
      runtime.getSetting('ALWAYS_RESPOND_CHANNELS') ||
        runtime.getSetting('SHOULD_RESPOND_BYPASS_TYPES')
    );
    const customSources = normalizeEnvList(
      runtime.getSetting('ALWAYS_RESPOND_SOURCES') ||
        runtime.getSetting('SHOULD_RESPOND_BYPASS_SOURCES')
    );

    const respondChannels = new Set(
      [...alwaysRespondChannels.map((t) => t.toString()), ...customChannels].map((s: string) =>
        s.trim().toLowerCase()
      )
    );

    const respondSources = [...alwaysRespondSources, ...customSources].map((s: string) =>
      s.trim().toLowerCase()
    );

    const roomType = room.type?.toString().toLowerCase();
    const sourceStr = message.content.source?.toLowerCase() || '';

    // 1. DM/VOICE_DM/API channels: always respond (private channels)
    if (respondChannels.has(roomType)) {
      return { shouldRespond: true, skipEvaluation: true, reason: `private channel: ${roomType}` };
    }

    // 2. Specific sources (e.g., client_chat): always respond
    if (respondSources.some((pattern) => sourceStr.includes(pattern))) {
      return {
        shouldRespond: true,
        skipEvaluation: true,
        reason: `whitelisted source: ${sourceStr}`,
      };
    }

    // 3. Platform mentions and replies: always respond
    const hasPlatformMention = !!(mentionContext?.isMention || mentionContext?.isReply);
    if (hasPlatformMention) {
      const mentionType = mentionContext?.isMention ? 'mention' : 'reply';
      return { shouldRespond: true, skipEvaluation: true, reason: `platform ${mentionType}` };
    }

    // 4. All other cases: let the LLM decide
    return { shouldRespond: false, skipEvaluation: false, reason: 'needs LLM evaluation' };
  }

  /**
   * Processes attachments by generating descriptions for supported media types.
   */
  async processAttachments(runtime: IAgentRuntime, attachments: Media[]): Promise<Media[]> {
    if (!attachments || attachments.length === 0) {
      return [];
    }
    runtime.logger.debug(`[MessageService] Processing ${attachments.length} attachment(s)`);

    const processedAttachments: Media[] = [];

    for (const attachment of attachments) {
      try {
        const processedAttachment: Media = { ...attachment };

        const isRemote = /^(http|https):\/\//.test(attachment.url);
        const url = isRemote ? attachment.url : getLocalServerUrl(attachment.url);

        // Only process images that don't already have descriptions
        if (attachment.contentType === ContentType.IMAGE && !attachment.description) {
          runtime.logger.debug(
            `[MessageService] Generating description for image: ${attachment.url}`
          );

          let imageUrl = url;

          if (!isRemote) {
            // Convert local/internal media to base64
            const res = await fetch(url);
            if (!res.ok) throw new Error(`Failed to fetch image: ${res.statusText}`);

            const arrayBuffer = await res.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            const contentType = res.headers.get('content-type') || 'application/octet-stream';
            imageUrl = `data:${contentType};base64,${buffer.toString('base64')}`;
          }

          try {
            const response = await runtime.useModel(ModelType.IMAGE_DESCRIPTION, {
              prompt: imageDescriptionTemplate,
              imageUrl,
            });

            if (typeof response === 'string') {
              const parsedXml = parseKeyValueXml(response);

              if (parsedXml && (parsedXml.description || parsedXml.text)) {
                processedAttachment.description = parsedXml.description || '';
                processedAttachment.title = parsedXml.title || 'Image';
                processedAttachment.text = parsedXml.text || parsedXml.description || '';

                runtime.logger.debug(
                  `[MessageService] Generated description: ${processedAttachment.description?.substring(0, 100)}...`
                );
              } else {
                // Fallback: Try simple regex parsing
                const responseStr = response as string;
                const titleMatch = responseStr.match(/<title>([^<]+)<\/title>/);
                const descMatch = responseStr.match(/<description>([^<]+)<\/description>/);
                const textMatch = responseStr.match(/<text>([^<]+)<\/text>/);

                if (titleMatch || descMatch || textMatch) {
                  processedAttachment.title = titleMatch?.[1] || 'Image';
                  processedAttachment.description = descMatch?.[1] || '';
                  processedAttachment.text = textMatch?.[1] || descMatch?.[1] || '';

                  runtime.logger.debug(
                    `[MessageService] Used fallback XML parsing - description: ${processedAttachment.description?.substring(0, 100)}...`
                  );
                } else {
                  runtime.logger.warn(
                    `[MessageService] Failed to parse XML response for image description`
                  );
                }
              }
            } else if (response && typeof response === 'object' && 'description' in response) {
              // Handle object responses for backwards compatibility
              processedAttachment.description = response.description;
              processedAttachment.title = response.title || 'Image';
              processedAttachment.text = response.description;

              runtime.logger.debug(
                `[MessageService] Generated description: ${processedAttachment.description?.substring(0, 100)}...`
              );
            } else {
              runtime.logger.warn(
                `[MessageService] Unexpected response format for image description`
              );
            }
          } catch (error) {
            runtime.logger.error({ error }, `[MessageService] Error generating image description:`);
          }
        } else if (attachment.contentType === ContentType.DOCUMENT && !attachment.text) {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`Failed to fetch document: ${res.statusText}`);

          const contentType = res.headers.get('content-type') || '';
          const isPlainText = contentType.startsWith('text/plain');

          if (isPlainText) {
            runtime.logger.debug(
              `[MessageService] Processing plain text document: ${attachment.url}`
            );

            const textContent = await res.text();
            processedAttachment.text = textContent;
            processedAttachment.title = processedAttachment.title || 'Text File';

            runtime.logger.debug(
              `[MessageService] Extracted text content (first 100 chars): ${processedAttachment.text?.substring(0, 100)}...`
            );
          } else {
            runtime.logger.warn(
              `[MessageService] Skipping non-plain-text document: ${contentType}`
            );
          }
        }

        processedAttachments.push(processedAttachment);
      } catch (error) {
        runtime.logger.error(
          { error, attachmentUrl: attachment.url },
          `[MessageService] Failed to process attachment ${attachment.url}:`
        );
        processedAttachments.push(attachment);
      }
    }

    return processedAttachments;
  }

  /**
   * Single-shot strategy: one LLM call to generate response
   */
  private async runSingleShotCore(
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    opts: Required<MessageProcessingOptions>
  ): Promise<StrategyResult> {
    state = await runtime.composeState(message, ['ACTIONS']);

    if (!state.values?.actionNames) {
      runtime.logger.warn('actionNames data missing from state, even though it was requested');
    }

    const prompt = composePromptFromState({
      state,
      template: runtime.character.templates?.messageHandlerTemplate || messageHandlerTemplate,
    });

    let responseContent: Content | null = null;

    // Retry if missing required fields
    let retries = 0;

    while (retries < opts.maxRetries && (!responseContent?.thought || !responseContent?.actions)) {
      const response = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });

      runtime.logger.debug({ response }, '[MessageService] *** Raw LLM Response ***');

      const parsedXml = parseKeyValueXml(response);
      runtime.logger.debug({ parsedXml }, '[MessageService] *** Parsed XML Content ***');

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
        runtime.logger.warn(
          { response, parsedXml, responseContent },
          '[MessageService] *** Missing required fields (thought or actions), retrying... ***'
        );
      }
    }

    if (!responseContent) {
      return { responseContent: null, responseMessages: [], state, mode: 'none' };
    }

    // LLM IGNORE/REPLY ambiguity handling
    if (responseContent.actions && responseContent.actions.length > 1) {
      const isIgnore = (a: unknown) => typeof a === 'string' && a.toUpperCase() === 'IGNORE';
      const hasIgnore = responseContent.actions.some(isIgnore);

      if (hasIgnore) {
        if (!responseContent.text || responseContent.text.trim() === '') {
          responseContent.actions = ['IGNORE'];
        } else {
          const filtered = responseContent.actions.filter((a) => !isIgnore(a));
          responseContent.actions = filtered.length ? filtered : ['REPLY'];
        }
      }
    }

    // Automatically determine if response is simple
    const isSimple =
      responseContent.actions?.length === 1 &&
      typeof responseContent.actions[0] === 'string' &&
      responseContent.actions[0].toUpperCase() === 'REPLY' &&
      (!responseContent.providers || responseContent.providers.length === 0);

    responseContent.simple = isSimple;

    const responseMessages: Memory[] = [
      {
        id: asUUID(v4()),
        entityId: runtime.agentId,
        agentId: runtime.agentId,
        content: responseContent,
        roomId: message.roomId,
        createdAt: Date.now(),
      },
    ];

    return {
      responseContent,
      responseMessages,
      state,
      mode: isSimple && responseContent.text ? 'simple' : 'actions',
    };
  }

  /**
   * Multi-step strategy: iterative action execution with final summary
   */
  private async runMultiStepCore(
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    callback: HandlerCallback | undefined,
    opts: Required<MessageProcessingOptions>
  ): Promise<StrategyResult> {
    const traceActionResult: MultiStepActionResult[] = [];
    let accumulatedState: MultiStepState = state as MultiStepState;
    let iterationCount = 0;

    while (iterationCount < opts.maxMultiStepIterations) {
      iterationCount++;
      runtime.logger.debug(
        `[MultiStep] Starting iteration ${iterationCount}/${opts.maxMultiStepIterations}`
      );

      accumulatedState = (await runtime.composeState(message, [
        'RECENT_MESSAGES',
        'ACTION_STATE',
      ])) as MultiStepState;
      accumulatedState.data.actionResults = traceActionResult;

      const prompt = composePromptFromState({
        state: accumulatedState,
        template:
          runtime.character.templates?.multiStepDecisionTemplate || multiStepDecisionTemplate,
      });

      const stepResultRaw = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });
      const parsedStep = parseKeyValueXml(stepResultRaw);

      if (!parsedStep) {
        runtime.logger.warn(
          `[MultiStep] Failed to parse step result at iteration ${iterationCount}`
        );
        traceActionResult.push({
          data: { actionName: 'parse_error' },
          success: false,
          error: 'Failed to parse step result',
        });
        break;
      }

      const { thought, providers = [], action, isFinish } = parsedStep;

      // Check for completion condition
      if (isFinish === 'true' || isFinish === true) {
        runtime.logger.info(`[MultiStep] Task marked as complete at iteration ${iterationCount}`);
        if (callback) {
          await callback({
            text: '',
            thought: thought ?? '',
          });
        }
        break;
      }

      // Validate that we have something to do
      if ((!providers || providers.length === 0) && !action) {
        runtime.logger.warn(
          `[MultiStep] No providers or action specified at iteration ${iterationCount}, forcing completion`
        );
        break;
      }

      try {
        for (const providerName of providers) {
          const provider = runtime.providers.find((p: any) => p.name === providerName);
          if (!provider) {
            runtime.logger.warn(`[MultiStep] Provider not found: ${providerName}`);
            traceActionResult.push({
              data: { actionName: providerName },
              success: false,
              error: `Provider not found: ${providerName}`,
            });
            continue;
          }

          const providerResult = await provider.get(runtime, message, state);
          if (!providerResult) {
            runtime.logger.warn(`[MultiStep] Provider returned no result: ${providerName}`);
            traceActionResult.push({
              data: { actionName: providerName },
              success: false,
              error: `Provider returned no result`,
            });
            continue;
          }

          const success = !!providerResult.text;

          traceActionResult.push({
            data: { actionName: providerName },
            success,
            text: success ? providerResult.text : undefined,
            error: success ? undefined : 'Provider returned no result',
          });

          if (callback) {
            await callback({
              text: `🔎 Provider executed: ${providerName}`,
              actions: [providerName],
              thought: thought ?? '',
            });
          }
        }

        if (action) {
          const actionContent = {
            text: `🔎 Executing action: ${action}`,
            actions: [action],
            thought: thought ?? '',
          };

          await runtime.processActions(
            message,
            [
              {
                id: v4() as UUID,
                entityId: runtime.agentId,
                roomId: message.roomId,
                createdAt: Date.now(),
                content: actionContent,
              },
            ],
            state,
            async () => {
              return [];
            }
          );

          // Get cached action results from runtime
          const cachedState = runtime.stateCache?.get(`${message.id}_action_results`);
          const actionResults = cachedState?.values?.actionResults || [];
          const result = actionResults.length > 0 ? actionResults[0] : null;
          const success = result?.success ?? false;

          traceActionResult.push({
            data: { actionName: action },
            success,
            text: result?.text,
            values: result?.values,
            error: success ? undefined : result?.text,
          });
        }
      } catch (err) {
        runtime.logger.error({ err }, '[MultiStep] Error executing step');
        traceActionResult.push({
          data: { actionName: action || 'unknown' },
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (iterationCount >= opts.maxMultiStepIterations) {
      runtime.logger.warn(
        `[MultiStep] Reached maximum iterations (${opts.maxMultiStepIterations}), forcing completion`
      );
    }

    accumulatedState = (await runtime.composeState(message, [
      'RECENT_MESSAGES',
      'ACTION_STATE',
    ])) as MultiStepState;
    const summaryPrompt = composePromptFromState({
      state: accumulatedState,
      template: runtime.character.templates?.multiStepSummaryTemplate || multiStepSummaryTemplate,
    });

    const finalOutput = await runtime.useModel(ModelType.TEXT_LARGE, { prompt: summaryPrompt });
    const summary = parseKeyValueXml(finalOutput);

    let responseContent: Content | null = null;
    if (summary?.text) {
      responseContent = {
        actions: ['MULTI_STEP_SUMMARY'],
        text: summary.text,
        thought: summary.thought || 'Final user-facing message after task completion.',
        simple: true,
      };
    }

    const responseMessages: Memory[] = responseContent
      ? [
          {
            id: asUUID(v4()),
            entityId: runtime.agentId,
            agentId: runtime.agentId,
            content: responseContent,
            roomId: message.roomId,
            createdAt: Date.now(),
          },
        ]
      : [];

    return {
      responseContent,
      responseMessages,
      state: accumulatedState,
      mode: responseContent ? 'simple' : 'none',
    };
  }

  /**
   * Helper to emit run ended events
   */
  private async emitRunEnded(
    runtime: IAgentRuntime,
    runId: UUID,
    message: Memory,
    startTime: number,
    status: string
  ): Promise<void> {
    await runtime.emitEvent(EventType.RUN_ENDED, {
      runtime,
      runId,
      messageId: message.id,
      roomId: message.roomId,
      entityId: message.entityId,
      startTime,
      status,
      endTime: Date.now(),
      duration: Date.now() - startTime,
      source: 'messageHandler',
    });
  }

  /**
   * Deletes a message from the agent's memory.
   * This method handles the actual deletion logic that was previously in event handlers.
   *
   * @param runtime - The agent runtime instance
   * @param message - The message memory to delete
   * @returns Promise resolving when deletion is complete
   */
  async deleteMessage(runtime: IAgentRuntime, message: Memory): Promise<void> {
    try {
      if (!message.id) {
        runtime.logger.error('[MessageService] Cannot delete memory: message ID is missing');
        return;
      }

      runtime.logger.info(
        '[MessageService] Deleting memory for message',
        message.id,
        'from room',
        message.roomId
      );
      await runtime.deleteMemory(message.id);
      runtime.logger.debug(
        { messageId: message.id },
        '[MessageService] Successfully deleted memory for message'
      );
    } catch (error: unknown) {
      runtime.logger.error({ error }, '[MessageService] Error in deleteMessage:');
      throw error;
    }
  }

  /**
   * Clears all messages from a channel/room.
   * This method handles bulk deletion of all message memories in a room.
   *
   * @param runtime - The agent runtime instance
   * @param roomId - The room ID to clear messages from
   * @param channelId - The original channel ID (for logging)
   * @returns Promise resolving when channel is cleared
   */
  async clearChannel(runtime: IAgentRuntime, roomId: UUID, channelId: string): Promise<void> {
    try {
      runtime.logger.info(
        `[MessageService] Clearing message memories from channel ${channelId} -> room ${roomId}`
      );

      // Get all message memories for this room
      const memories = await runtime.getMemoriesByRoomIds({
        tableName: 'messages',
        roomIds: [roomId],
      });

      runtime.logger.info(
        `[MessageService] Found ${memories.length} message memories to delete from channel ${channelId}`
      );

      // Delete each message memory
      let deletedCount = 0;
      for (const memory of memories) {
        if (memory.id) {
          try {
            await runtime.deleteMemory(memory.id);
            deletedCount++;
          } catch (error) {
            runtime.logger.warn(
              { error, memoryId: memory.id },
              `[MessageService] Failed to delete message memory ${memory.id}:`
            );
          }
        }
      }

      runtime.logger.info(
        `[MessageService] Successfully cleared ${deletedCount}/${memories.length} message memories from channel ${channelId}`
      );
    } catch (error: unknown) {
      runtime.logger.error({ error }, '[MessageService] Error in clearChannel:');
      throw error;
    }
  }
}
