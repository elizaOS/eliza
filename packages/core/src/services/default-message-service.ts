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
  asUUID,
  createUniqueUuid,
  composePromptFromState,
  imageDescriptionTemplate,
  messageHandlerTemplate,
  shouldRespondTemplate,
  type RunEventPayload,
  multiStepDecisionTemplate,
  multiStepSummaryTemplate,
  parseKeyValueXml,
  parseBooleanFromText,
  truncateToCompleteSentence,
  getLocalServerUrl,
  logger,
} from '../index';
import {
  ResponseStreamExtractor,
  XmlTagExtractor,
  createStreamingContext,
} from '../utils/streaming';
import { runWithStreamingContext, getStreamingContext } from '../streaming-context';

/**
 * Image description response from the model
 */
interface ImageDescriptionResponse {
  description: string;
  title?: string;
}

/**
 * Resolved message options with defaults applied.
 * Required numeric options + optional streaming callback.
 */
type ResolvedMessageOptions = {
  maxRetries: number;
  timeoutDuration: number;
  useMultiStep: boolean;
  maxMultiStepIterations: number;
  onStreamChunk?: (chunk: string, messageId?: UUID) => Promise<void>;
};

/**
 * Multi-step workflow execution result
 */
interface MultiStepActionResult {
  data: { actionName: string };
  success: boolean;
  text?: string;
  error?: string | Error;
  values?: Record<string, unknown>;
}

/**
 * Multi-step workflow state
 */
interface MultiStepState extends State {
  data: {
    actionResults: MultiStepActionResult[];
    [key: string]: unknown;
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
  state: State;
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
        options?.useMultiStep ??
        parseBooleanFromText(String(runtime.getSetting('USE_MULTI_STEP') || '')),
      maxMultiStepIterations:
        options?.maxMultiStepIterations ??
        parseInt(String(runtime.getSetting('MAX_MULTISTEP_ITERATIONS') || '6')),
      onStreamChunk: options?.onStreamChunk,
    };

    // Set up timeout monitoring
    let timeoutId: NodeJS.Timeout | undefined = undefined;
    // Single ID used for tracking, streaming, and the final message
    const responseId = asUUID(v4());

    try {
      runtime.logger.info(
        {
          src: 'service:message',
          agentId: runtime.agentId,
          entityId: message.entityId,
          roomId: message.roomId,
        },
        'Message received'
      );

      // Track this response ID
      if (!latestResponseIds.has(runtime.agentId)) {
        latestResponseIds.set(runtime.agentId, new Map<string, string>());
      }
      const agentResponses = latestResponseIds.get(runtime.agentId);
      if (!agentResponses) throw new Error('Agent responses map not found');

      const previousResponseId = agentResponses.get(message.roomId);
      if (previousResponseId) {
        logger.debug(
          { src: 'service:message', roomId: message.roomId, previousResponseId, responseId },
          'Updating response ID'
        );
      }
      agentResponses.set(message.roomId, responseId);

      // Start run tracking with roomId for proper log association
      const runId: UUID = runtime.startRun(message.roomId)!;
      const startTime = Date.now();

      // Emit run started event
      await runtime.emitEvent(EventType.RUN_STARTED, {
        runtime,
        source: 'messageHandler',
        runId,
        messageId: message.id,
        roomId: message.roomId,
        entityId: message.entityId,
        startTime,
        status: 'started',
      } as RunEventPayload);

      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(async () => {
          await runtime.emitEvent(EventType.RUN_TIMEOUT, {
            runtime,
            source: 'messageHandler',
            runId,
            messageId: message.id,
            roomId: message.roomId,
            entityId: message.entityId,
            startTime,
            status: 'timeout',
            endTime: Date.now(),
            duration: Date.now() - startTime,
            error: 'Run exceeded timeout',
          } as RunEventPayload);
          reject(new Error('Run exceeded timeout'));
        }, opts.timeoutDuration);
      });

      // Wrap processing with streaming context for automatic streaming in useModel calls
      // Use ResponseStreamExtractor to filter XML and only stream <text> (if REPLY) or <message>
      // NOTE: Multi-step mode handles its own streaming contexts per-phase (decision, action, summary)
      // so we only set up the top-level streaming context for single-shot mode
      const useMultiStep =
        opts.useMultiStep ??
        parseBooleanFromText(String(runtime.getSetting('USE_MULTI_STEP') || ''));

      // Single-shot mode: use top-level streaming context with single extractor
      const streamingContext =
        opts.onStreamChunk && !useMultiStep
          ? createStreamingContext(new ResponseStreamExtractor(), opts.onStreamChunk, responseId)
          : undefined;
      // Multi-step mode: streaming is handled per-phase in runMultiStepCore
      // (action execution and summary generation each get their own streaming context)

      const processingPromise = runWithStreamingContext(streamingContext, () =>
        this.processMessage(runtime, message, callback, responseId, runId, startTime, opts)
      );

      const result = await Promise.race([processingPromise, timeoutPromise]);

      // Clean up timeout
      clearTimeout(timeoutId);

      return result;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Internal message processing implementation
   */
  private async processMessage(
    runtime: IAgentRuntime,
    message: Memory,
    callback: HandlerCallback | undefined,
    responseId: UUID,
    runId: UUID,
    startTime: number,
    opts: ResolvedMessageOptions
  ): Promise<MessageProcessingResult> {
    try {
      const agentResponses = latestResponseIds.get(runtime.agentId);
      if (!agentResponses) throw new Error('Agent responses map not found');

      // Skip messages from self
      if (message.entityId === runtime.agentId) {
        runtime.logger.debug(
          { src: 'service:message', agentId: runtime.agentId },
          'Skipping message from self'
        );
        await this.emitRunEnded(runtime, runId, message, startTime, 'self');
        return {
          didRespond: false,
          responseContent: null,
          responseMessages: [],
          state: { values: {}, data: {}, text: '' } as State,
          mode: 'none',
        };
      }

      runtime.logger.debug(
        {
          src: 'service:message',
          messagePreview: truncateToCompleteSentence(message.content.text || '', 50),
        },
        'Processing message'
      );

      // Save the incoming message to memory
      runtime.logger.debug({ src: 'service:message' }, 'Saving message to memory');
      let memoryToQueue: Memory;

      if (message.id) {
        const existingMemory = await runtime.getMemoryById(message.id);
        if (existingMemory) {
          runtime.logger.debug(
            { src: 'service:message' },
            'Memory already exists, skipping creation'
          );
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
      const defLllmOff = parseBooleanFromText(
        String(runtime.getSetting('BOOTSTRAP_DEFLLMOFF') || '')
      );

      if (defLllmOff && agentUserState === null) {
        runtime.logger.debug({ src: 'service:message' }, 'LLM is off by default');
        await this.emitRunEnded(runtime, runId, message, startTime, 'off');
        return {
          didRespond: false,
          responseContent: null,
          responseMessages: [],
          state: { values: {}, data: {}, text: '' } as State,
          mode: 'none',
        };
      }

      // Check if room is muted
      if (
        agentUserState === 'MUTED' &&
        !message.content.text?.toLowerCase().includes(runtime.character.name.toLowerCase())
      ) {
        runtime.logger.debug(
          { src: 'service:message', roomId: message.roomId },
          'Ignoring muted room'
        );
        await this.emitRunEnded(runtime, runId, message, startTime, 'muted');
        return {
          didRespond: false,
          responseContent: null,
          responseMessages: [],
          state: { values: {}, data: {}, text: '' } as State,
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

      runtime.logger.debug({ src: 'service:message', responseDecision }, 'Response decision');

      let shouldRespondToMessage = true;

      // If we can skip the evaluation, use the decision directly
      if (responseDecision.skipEvaluation) {
        runtime.logger.debug(
          {
            src: 'service:message',
            agentName: runtime.character.name,
            reason: responseDecision.reason,
          },
          'Skipping LLM evaluation'
        );
        shouldRespondToMessage = responseDecision.shouldRespond;
      } else {
        // Need LLM evaluation for ambiguous case
        const shouldRespondPrompt = composePromptFromState({
          state,
          template: runtime.character.templates?.shouldRespondTemplate || shouldRespondTemplate,
        });

        runtime.logger.debug(
          {
            src: 'service:message',
            agentName: runtime.character.name,
            reason: responseDecision.reason,
          },
          'Using LLM evaluation'
        );

        const response = await runtime.useModel(ModelType.TEXT_SMALL, {
          prompt: shouldRespondPrompt,
        });

        runtime.logger.debug({ src: 'service:message', response }, 'LLM evaluation result');

        const responseObject = parseKeyValueXml(response);
        runtime.logger.debug(
          { src: 'service:message', responseObject },
          'Parsed evaluation result'
        );

        // If an action is provided, the agent intends to respond in some way
        const nonResponseActions = ['IGNORE', 'NONE'];
        const actionValue = responseObject?.action;
        shouldRespondToMessage =
          typeof actionValue === 'string' &&
          !nonResponseActions.includes(actionValue.toUpperCase());
      }

      let responseContent: Content | null = null;
      let responseMessages: Memory[] = [];
      let mode: StrategyMode = 'none';

      if (shouldRespondToMessage) {
        const result = opts.useMultiStep
          ? await this.runMultiStepCore(runtime, message, state, callback, opts, responseId)
          : await this.runSingleShotCore(runtime, message, state, opts, responseId);

        responseContent = result.responseContent;
        responseMessages = result.responseMessages;
        state = result.state;
        mode = result.mode;

        // Race check before we send anything
        const currentResponseId = agentResponses.get(message.roomId);
        if (currentResponseId !== responseId) {
          runtime.logger.info(
            { src: 'service:message', agentId: runtime.agentId, roomId: message.roomId },
            'Response discarded - newer message being processed'
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
                { src: 'service:message', providers: responseContent.providers },
                'Simple response used providers'
              );
            }
            if (callback) {
              await callback(responseContent);
            }
          } else if (mode === 'actions') {
            // Pass onStreamChunk to processActions so each action can manage its own streaming context
            await runtime.processActions(
              message,
              responseMessages,
              state,
              async (content) => {
                runtime.logger.debug({ src: 'service:message', content }, 'Action callback');
                responseContent!.actionCallbacks = content;
                if (callback) {
                  return callback(content);
                }
                return [];
              },
              { onStreamChunk: opts.onStreamChunk }
            );
          }
        }
      } else {
        // Agent decided not to respond
        runtime.logger.debug({ src: 'service:message' }, 'Agent decided not to respond');

        // Check if we still have the latest response ID
        const currentResponseId = agentResponses.get(message.roomId);
        const keepResp = parseBooleanFromText(
          String(runtime.getSetting('BOOTSTRAP_KEEP_RESP') || '')
        );

        if (currentResponseId !== responseId && !keepResp) {
          runtime.logger.info(
            { src: 'service:message', agentId: runtime.agentId, roomId: message.roomId },
            'Ignore response discarded - newer message being processed'
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
            { src: 'service:message', agentId: runtime.agentId },
            'Message ID is missing, cannot create ignore response'
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
          { src: 'service:message', memoryId: ignoreMemory.id },
          'Saved ignore response to memory'
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
          runtime.logger.debug({ src: 'service:message', content }, 'Evaluate callback');
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
      if (
        message.metadata &&
        'entityName' in message.metadata &&
        typeof message.metadata.entityName === 'string'
      ) {
        entityName = message.metadata.entityName;
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
      const providersData = state.data?.providers;
      interface ActionsProviderData {
        ACTIONS?: {
          data?: {
            actionsData?: Array<{ name: string }>;
          };
        };
      }
      const actionsProvider =
        typeof providersData === 'object' && providersData !== null && 'ACTIONS' in providersData
          ? (providersData as ActionsProviderData).ACTIONS
          : undefined;
      const actionsData = actionsProvider?.data?.actionsData;
      const availableActions = Array.isArray(actionsData)
        ? actionsData.map((a: { name: string }) => a.name)
        : [-1];

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
        source: 'messageHandler',
        runId,
        messageId: message.id,
        roomId: message.roomId,
        entityId: message.entityId,
        startTime,
        status: 'completed',
        endTime: Date.now(),
        duration: Date.now() - startTime,
      } as RunEventPayload);

      return {
        didRespond: shouldRespondToMessage,
        responseContent,
        responseMessages,
        state,
        mode,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      runtime.logger.error(
        { src: 'service:message', agentId: runtime.agentId, error },
        'Error processing message'
      );
      // Emit run ended event with error
      await runtime.emitEvent(EventType.RUN_ENDED, {
        runtime,
        source: 'messageHandler',
        runId,
        messageId: message.id,
        roomId: message.roomId,
        entityId: message.entityId,
        startTime,
        status: 'completed',
        endTime: Date.now(),
        duration: Date.now() - startTime,
        error: errorMessage,
      } as RunEventPayload);
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
    runtime.logger.debug(
      { src: 'service:message', count: attachments.length },
      'Processing attachments'
    );

    const processedAttachments: Media[] = [];

    for (const attachment of attachments) {
      const processedAttachment: Media = { ...attachment };

      const isRemote = /^(http|https):\/\//.test(attachment.url);
      const url = isRemote ? attachment.url : getLocalServerUrl(attachment.url);

      // Only process images that don't already have descriptions
      if (attachment.contentType === ContentType.IMAGE && !attachment.description) {
        runtime.logger.debug(
          { src: 'service:message', imageUrl: attachment.url },
          'Generating image description'
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

        const response = await runtime.useModel(ModelType.IMAGE_DESCRIPTION, {
          prompt: imageDescriptionTemplate,
          imageUrl,
        });

        if (typeof response === 'string') {
          const parsedXml = parseKeyValueXml(response);

          if (parsedXml && (parsedXml.description || parsedXml.text)) {
            processedAttachment.description =
              (typeof parsedXml.description === 'string' ? parsedXml.description : '') || '';
            processedAttachment.title =
              (typeof parsedXml.title === 'string' ? parsedXml.title : 'Image') || 'Image';
            processedAttachment.text =
              (typeof parsedXml.text === 'string' ? parsedXml.text : '') ||
              (typeof parsedXml.description === 'string' ? parsedXml.description : '') ||
              '';

            runtime.logger.debug(
              {
                src: 'service:message',
                descriptionPreview: processedAttachment.description?.substring(0, 100),
              },
              'Generated image description'
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
                {
                  src: 'service:message',
                  descriptionPreview: processedAttachment.description?.substring(0, 100),
                },
                'Used fallback XML parsing for description'
              );
            } else {
              runtime.logger.warn(
                { src: 'service:message' },
                'Failed to parse XML response for image description'
              );
            }
          }
        } else if (response && typeof response === 'object' && 'description' in response) {
          // Handle object responses for backwards compatibility
          const objResponse = response as ImageDescriptionResponse;
          processedAttachment.description = objResponse.description;
          processedAttachment.title = objResponse.title || 'Image';
          processedAttachment.text = objResponse.description;

          runtime.logger.debug(
            {
              src: 'service:message',
              descriptionPreview: processedAttachment.description?.substring(0, 100),
            },
            'Generated image description'
          );
        } else {
          runtime.logger.warn(
            { src: 'service:message' },
            'Unexpected response format for image description'
          );
        }
      } else if (attachment.contentType === ContentType.DOCUMENT && !attachment.text) {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Failed to fetch document: ${res.statusText}`);

        const contentType = res.headers.get('content-type') || '';
        const isPlainText = contentType.startsWith('text/plain');

        if (isPlainText) {
          runtime.logger.debug(
            { src: 'service:message', documentUrl: attachment.url },
            'Processing plain text document'
          );

          const textContent = await res.text();
          processedAttachment.text = textContent;
          processedAttachment.title = processedAttachment.title || 'Text File';

          runtime.logger.debug(
            { src: 'service:message', textPreview: processedAttachment.text?.substring(0, 100) },
            'Extracted text content'
          );
        } else {
          runtime.logger.warn(
            { src: 'service:message', contentType },
            'Skipping non-plain-text document'
          );
        }
      }

      processedAttachments.push(processedAttachment);
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
    opts: ResolvedMessageOptions,
    responseId: UUID
  ): Promise<StrategyResult> {
    state = await runtime.composeState(message, ['ACTIONS']);

    if (!state.values?.actionNames) {
      runtime.logger.warn({ src: 'service:message' }, 'actionNames data missing from state');
    }

    const prompt = composePromptFromState({
      state,
      template: runtime.character.templates?.messageHandlerTemplate || messageHandlerTemplate,
    });

    let responseContent: Content | null = null;

    // Retry if missing required fields
    let retries = 0;

    while (retries < opts.maxRetries && (!responseContent?.thought || !responseContent?.actions)) {
      // Check if text extraction is already complete - no point in retrying
      const ctx = getStreamingContext();
      if (retries > 0 && ctx?.isComplete?.()) {
        // Text was fully extracted (found </text>) - exit loop to use streamedText
        runtime.logger.info(
          { src: 'service:message', retries },
          'Text extraction complete despite XML parse failure - skipping further retries'
        );
        break;
      }

      // Check if we have partial streamed text - if so, exit to let continuation handle it
      if (retries > 0) {
        const partialText = ctx?.getStreamedText?.() || '';
        if (partialText.length > 0) {
          // Has partial text - exit loop to let continuation logic handle it
          runtime.logger.debug(
            { src: 'service:message', streamedTextLength: partialText.length },
            'Partial text streamed - exiting retry loop for continuation'
          );
          break;
        }
        // No text streamed yet, safe to reset and retry
        ctx?.reset?.();
      }

      const response = await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt,
      });

      runtime.logger.info(
        {
          src: 'service:message',
          responseLength: response.length,
          responsePreview: response.substring(0, 500),
        },
        'Raw LLM response received'
      );

      const parsedXml = parseKeyValueXml(response);
      runtime.logger.info(
        {
          src: 'service:message',
          parsedXml: parsedXml
            ? {
                hasThought: !!parsedXml.thought,
                thoughtPreview:
                  typeof parsedXml.thought === 'string'
                    ? parsedXml.thought.substring(0, 100)
                    : null,
                hasActions: !!parsedXml.actions,
                actions: parsedXml.actions,
                hasText: !!parsedXml.text,
                textPreview:
                  typeof parsedXml.text === 'string' ? parsedXml.text.substring(0, 100) : null,
              }
            : null,
        },
        'Parsed XML content'
      );

      if (parsedXml) {
        const thought = typeof parsedXml.thought === 'string' ? parsedXml.thought : '';
        const actions = Array.isArray(parsedXml.actions)
          ? parsedXml.actions.filter((a): a is string => typeof a === 'string')
          : typeof parsedXml.actions === 'string'
            ? [parsedXml.actions]
            : ['IGNORE'];
        const providers = Array.isArray(parsedXml.providers)
          ? parsedXml.providers.filter((p): p is string => typeof p === 'string')
          : [];
        const text = typeof parsedXml.text === 'string' ? parsedXml.text : '';
        const simple = typeof parsedXml.simple === 'boolean' ? parsedXml.simple : false;

        responseContent = {
          ...parsedXml,
          thought,
          actions,
          providers,
          text,
          simple,
        };
      } else {
        responseContent = null;
        runtime.logger.warn(
          { src: 'service:message', responsePreview: response.substring(0, 300) },
          'parseKeyValueXml returned null - XML parsing failed'
        );
      }

      retries++;
      if (!responseContent?.thought || !responseContent?.actions) {
        runtime.logger.warn(
          {
            src: 'service:message',
            retries,
            maxRetries: opts.maxRetries,
            hasThought: !!responseContent?.thought,
            hasActions: !!responseContent?.actions,
            actionsValue: responseContent?.actions,
          },
          'Missing required fields (thought or actions), retrying'
        );
      }
    }

    // Intelligent streaming retry logic (inspired by Anthropic's partial response recovery)
    const streamingCtx = getStreamingContext();
    const streamedText = streamingCtx?.getStreamedText?.() || '';
    const isTextComplete = streamingCtx?.isComplete?.() ?? false;

    // Case B: XML parsing failed OR response text doesn't match streamed text
    // but <text> extraction is complete - use streamed text as the response
    if (isTextComplete && streamedText && (!responseContent || !responseContent.text)) {
      runtime.logger.info(
        {
          src: 'service:message',
          streamedTextLength: streamedText.length,
          streamedTextPreview: streamedText.substring(0, 100),
          hadResponseContent: !!responseContent,
        },
        'Text extraction complete - using streamed text'
      );

      responseContent = {
        ...(responseContent || {}),
        thought: responseContent?.thought || 'Response generated via streaming',
        actions: responseContent?.actions || ['REPLY'],
        providers: responseContent?.providers || [],
        text: streamedText,
        simple: true,
      };
    } else if (streamedText && !isTextComplete) {
      // Case C: Text was cut mid-stream - retry with continuation prompt
      runtime.logger.debug(
        {
          src: 'service:message',
          streamedTextLength: streamedText.length,
          streamedTextPreview: streamedText.substring(0, 100),
        },
        'Text cut mid-stream - attempting continuation'
      );

      // Reset extractor for fresh streaming of continuation
      streamingCtx?.reset?.();

      // Build continuation prompt with full context
      const continuationPrompt = `${prompt}

[CONTINUATION REQUIRED]
Your previous response was cut off. The user already received this text:
"${streamedText}"

Continue EXACTLY from where you left off. Do NOT repeat what was already said.
Output ONLY the continuation, starting immediately after the last character above.
Wrap your continuation in <text></text> tags.`;

      // Use runWithStreamingContext to ensure continuation is streamed to user
      const continuationResponse = await runWithStreamingContext(streamingCtx, () =>
        runtime.useModel(ModelType.TEXT_LARGE, {
          prompt: continuationPrompt,
        })
      );

      runtime.logger.debug(
        {
          src: 'service:message',
          continuationLength: continuationResponse.length,
          continuationPreview: continuationResponse.substring(0, 200),
        },
        'Continuation response received'
      );

      // Extract continuation text
      const continuationParsed = parseKeyValueXml(continuationResponse);
      const continuationText =
        typeof continuationParsed?.text === 'string' ? continuationParsed.text : '';

      if (continuationText) {
        // Combine original streamed text with continuation
        const fullText = streamedText + continuationText;

        responseContent = {
          ...(responseContent || {}),
          thought: responseContent?.thought || 'Response completed via continuation',
          actions: responseContent?.actions || ['REPLY'],
          providers: responseContent?.providers || [],
          text: fullText,
          simple: true,
        };

        runtime.logger.info(
          {
            src: 'service:message',
            fullTextLength: fullText.length,
          },
          'Continuation successful - combined text'
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
    // Include message ID for streaming coordination (so broadcast uses same ID)
    responseContent.responseId = responseId;

    const responseMessages: Memory[] = [
      {
        id: responseId,
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
    opts: ResolvedMessageOptions,
    responseId: UUID
  ): Promise<StrategyResult> {
    const traceActionResult: MultiStepActionResult[] = [];
    let accumulatedState: MultiStepState = state as MultiStepState;
    let iterationCount = 0;

    runtime.logger.info(
      {
        src: 'service:message:multistep',
        responseId,
        maxIterations: opts.maxMultiStepIterations,
        streamingEnabled: !!opts.onStreamChunk,
      },
      'Starting multi-step processing'
    );

    while (iterationCount < opts.maxMultiStepIterations) {
      iterationCount++;
      runtime.logger.info(
        {
          src: 'service:message:multistep',
          step: iterationCount,
          maxSteps: opts.maxMultiStepIterations,
        },
        `Step ${iterationCount}/${opts.maxMultiStepIterations} - Beginning iteration`
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

      // Retry logic for parsing failures with bounds checking
      const parseRetriesSetting = runtime.getSetting('MULTISTEP_PARSE_RETRIES');
      const rawParseRetries = parseInt(String(parseRetriesSetting ?? '5'), 10);
      // Validate retry count is within reasonable bounds (1-10)
      const maxParseRetries = Math.max(
        1,
        Math.min(10, isNaN(rawParseRetries) ? 5 : rawParseRetries)
      );
      let stepResultRaw: string = '';
      let parsedStep: Record<string, unknown> | null = null;

      for (let parseAttempt = 1; parseAttempt <= maxParseRetries; parseAttempt++) {
        try {
          runtime.logger.debug(
            {
              src: 'service:message',
              attempt: parseAttempt,
              maxAttempts: maxParseRetries,
              iteration: iterationCount,
            },
            'Decision step model call attempt'
          );
          stepResultRaw = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });
          parsedStep = parseKeyValueXml(stepResultRaw);

          if (parsedStep) {
            runtime.logger.debug(
              { src: 'service:message', attempt: parseAttempt, iteration: iterationCount },
              'Successfully parsed decision step'
            );
            break;
          } else {
            runtime.logger.warn(
              {
                src: 'service:message',
                attempt: parseAttempt,
                maxAttempts: maxParseRetries,
                iteration: iterationCount,
                rawResponsePreview: stepResultRaw.substring(0, 200),
              },
              'Failed to parse XML response'
            );

            if (parseAttempt < maxParseRetries) {
              // Exponential backoff: 1s, 2s, 4s, etc. (capped at 8s)
              const backoffMs = Math.min(1000 * Math.pow(2, parseAttempt - 1), 8000);
              await new Promise((resolve) => setTimeout(resolve, backoffMs));
            }
          }
        } catch (error) {
          runtime.logger.error(
            {
              src: 'service:message',
              attempt: parseAttempt,
              maxAttempts: maxParseRetries,
              iteration: iterationCount,
              error: error instanceof Error ? error.message : String(error),
            },
            'Error during model call attempt'
          );
          if (parseAttempt >= maxParseRetries) {
            throw error;
          }
          // Exponential backoff on error
          const backoffMs = Math.min(1000 * Math.pow(2, parseAttempt - 1), 8000);
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
      }

      if (!parsedStep) {
        runtime.logger.warn(
          {
            src: 'service:message',
            iteration: iterationCount,
            maxParseRetries,
          },
          'Failed to parse step result after all retry attempts'
        );
        traceActionResult.push({
          data: { actionName: 'parse_error' },
          success: false,
          error: `Failed to parse step result after ${maxParseRetries} attempts`,
        });
        break;
      }

      const thought = typeof parsedStep.thought === 'string' ? parsedStep.thought : undefined;
      const providers = Array.isArray(parsedStep.providers) ? parsedStep.providers : [];
      // Normalize action: empty string or whitespace-only should be treated as undefined
      const rawAction =
        typeof parsedStep.action === 'string' ? parsedStep.action.trim() : undefined;
      const action = rawAction && rawAction.length > 0 ? rawAction : undefined;
      const isFinish = parsedStep.isFinish;
      const parameters = parsedStep.parameters;

      runtime.logger.info(
        {
          src: 'service:message:multistep',
          step: iterationCount,
          thought: thought ? thought.substring(0, 100) + (thought.length > 100 ? '...' : '') : null,
          action: action || null,
          providers: providers.length > 0 ? providers : null,
          isFinish: isFinish === 'true' || isFinish === true,
        },
        `Step ${iterationCount} - Decision: ${action || 'no action'}${providers.length > 0 ? `, providers: [${providers.join(', ')}]` : ''}`
      );

      // Parse and store parameters if provided
      let actionParams: Record<string, unknown> = {};
      if (parameters) {
        if (typeof parameters === 'string') {
          try {
            const parsed = JSON.parse(parameters);
            // Validate that parsed result is a non-null object (not array, primitive, or null)
            if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
              actionParams = parsed as Record<string, unknown>;
              runtime.logger.debug(
                { src: 'service:message', params: actionParams },
                'Parsed action parameters from string'
              );
            } else {
              runtime.logger.warn(
                {
                  src: 'service:message',
                  rawParams: parameters,
                  parsedType:
                    parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed,
                },
                'Parsed parameters is not a valid object, ignoring'
              );
            }
          } catch (e) {
            runtime.logger.warn(
              {
                src: 'service:message',
                rawParams: parameters,
                error: e instanceof Error ? e.message : String(e),
              },
              'Failed to parse parameters JSON'
            );
          }
        } else if (
          typeof parameters === 'object' &&
          parameters !== null &&
          !Array.isArray(parameters)
        ) {
          actionParams = parameters as Record<string, unknown>;
          runtime.logger.debug(
            { src: 'service:message', params: actionParams },
            'Using parameters object directly'
          );
        } else if (Array.isArray(parameters)) {
          runtime.logger.warn(
            {
              src: 'service:message',
              rawParams: parameters,
            },
            'Parameters is an array, expected object, ignoring'
          );
        }
      }

      // Store parameters in state for action to consume
      if (action && Object.keys(actionParams).length > 0) {
        accumulatedState.data.actionParams = actionParams;

        // Also support action-specific namespaces for backwards compatibility
        const actionKey = action.toLowerCase().replace(/_/g, '');
        accumulatedState.data[actionKey] = {
          ...actionParams,
          // Metadata properties prefixed with underscore to avoid collision with legitimate action parameters
          _source: 'multiStepDecisionTemplate',
          _timestamp: Date.now(),
        };

        runtime.logger.info(
          { src: 'service:message', action, params: actionParams },
          'Stored parameters for action'
        );
      }

      // Check for completion condition
      if (isFinish === 'true' || isFinish === true) {
        runtime.logger.info(
          {
            src: 'service:message:multistep',
            step: iterationCount,
            totalActions: traceActionResult.length,
          },
          `Step ${iterationCount} - Task marked as finished by agent`
        );
        if (callback) {
          await callback({
            text: '',
            thought: typeof thought === 'string' ? thought : '',
          });
        }
        break;
      }

      // Validate that we have something to do
      const providersArray = Array.isArray(providers) ? providers : [];
      if ((!providersArray || providersArray.length === 0) && !action) {
        runtime.logger.warn(
          { src: 'service:message', iteration: iterationCount },
          'No providers or action specified, forcing completion'
        );
        break;
      }

      // Total timeout for all providers running in parallel (configurable via PROVIDERS_TOTAL_TIMEOUT_MS env var)
      // Since providers run in parallel, this is the max wall-clock time allowed
      const PROVIDERS_TOTAL_TIMEOUT_MS = parseInt(
        String(runtime.getSetting('PROVIDERS_TOTAL_TIMEOUT_MS') || '1000')
      );

      // Track which providers have completed (for timeout diagnostics)
      const completedProviders = new Set<string>();

      runtime.logger.info(
        {
          src: 'service:message:multistep',
          step: iterationCount,
          providers: providersArray,
          parallelExecution: true,
        },
        `Step ${iterationCount} - Executing ${providersArray.length} providers in parallel`
      );

      const providerPromises = providersArray
        .filter((name): name is string => typeof name === 'string')
        .map(async (providerName) => {
          runtime.logger.debug(
            { src: 'service:message:multistep', step: iterationCount, provider: providerName },
            `Step ${iterationCount} - Starting provider: ${providerName}`
          );

          const provider = runtime.providers.find((p) => p.name === providerName);
          if (!provider) {
            runtime.logger.warn(
              { src: 'service:message:multistep', step: iterationCount, providerName },
              `Step ${iterationCount} - Provider not found: ${providerName}`
            );
            completedProviders.add(providerName);
            return { providerName, success: false, error: `Provider not found: ${providerName}` };
          }

          try {
            const providerResult = await provider.get(runtime, message, accumulatedState);
            completedProviders.add(providerName);

            if (!providerResult) {
              runtime.logger.warn(
                { src: 'service:message:multistep', step: iterationCount, providerName },
                `Step ${iterationCount} - Provider returned no result: ${providerName}`
              );
              return { providerName, success: false, error: 'Provider returned no result' };
            }

            const success = !!providerResult.text;
            runtime.logger.info(
              {
                src: 'service:message:multistep',
                step: iterationCount,
                provider: providerName,
                success,
                resultLength: providerResult.text?.length || 0,
              },
              `Step ${iterationCount} - Provider completed: ${providerName} (${success ? providerResult.text?.length || 0 : 0} chars)`
            );
            return {
              providerName,
              success,
              text: success ? providerResult.text : undefined,
              error: success ? undefined : 'Provider returned no result',
            };
          } catch (err) {
            completedProviders.add(providerName);
            const errorMsg = err instanceof Error ? err.message : String(err);
            runtime.logger.error(
              {
                src: 'service:message:multistep',
                step: iterationCount,
                providerName,
                error: errorMsg,
              },
              `Step ${iterationCount} - Provider execution failed: ${providerName}`
            );
            return { providerName, success: false, error: errorMsg };
          }
        });

      // Create timeout promise for provider execution (with cleanup)
      let timeoutId: ReturnType<typeof setTimeout>;
      const timeoutPromise = new Promise<'timeout'>((resolve) => {
        timeoutId = setTimeout(() => resolve('timeout'), PROVIDERS_TOTAL_TIMEOUT_MS);
      });

      // Race between all providers completing and timeout
      const allProvidersPromise = Promise.allSettled(providerPromises);
      const raceResult = await Promise.race([allProvidersPromise, timeoutPromise]);

      // Clear timeout if providers completed first
      clearTimeout(timeoutId!);

      // Check if providers took too long - abort pipeline and notify user
      if (raceResult === 'timeout') {
        // Identify which providers were still pending when timeout hit
        const allProviderNames = providersArray.filter(
          (name): name is string => typeof name === 'string'
        );
        const pendingProviders = allProviderNames.filter((name) => !completedProviders.has(name));

        runtime.logger.error(
          {
            src: 'service:message:multistep',
            step: iterationCount,
            timeoutMs: PROVIDERS_TOTAL_TIMEOUT_MS,
            pendingProviders,
            completedProviders: Array.from(completedProviders),
          },
          `Step ${iterationCount} - Provider timeout (>${PROVIDERS_TOTAL_TIMEOUT_MS}ms): ${pendingProviders.join(', ')}`
        );

        if (callback) {
          await callback({
            text: 'Providers took too long to respond. Please optimize your providers or use caching.',
            actions: [],
            thought: 'Provider timeout - pipeline aborted',
          });
        }

        return { responseContent: null, responseMessages: [], state, mode: 'none' };
      }

      // Providers completed in time
      const providerResults = raceResult;

      // Process results and notify via callback
      for (const result of providerResults) {
        if (result.status === 'fulfilled') {
          const { providerName, success, text, error } = result.value;
          traceActionResult.push({
            data: { actionName: providerName },
            success,
            text,
            error,
          });

          if (callback) {
            await callback({
              text: `🔎 Provider executed: ${providerName}`,
              actions: [providerName],
              thought: typeof thought === 'string' ? thought : '',
            });
          }
        } else {
          runtime.logger.error(
            { src: 'service:message', error: result.reason || 'Unknown provider failure' },
            'Unexpected provider promise rejection'
          );
        }
      }

      if (action) {
        runtime.logger.info(
          { src: 'service:message:multistep', step: iterationCount, action },
          `Step ${iterationCount} - Executing action: ${action}`
        );

        const actionContent = {
          text: `🔎 Executing action: ${action}`,
          actions: [action],
          thought: thought || '',
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
          accumulatedState,
          async () => {
            return [];
          },
          // Pass through optional streaming callback for action execution (used by multi-step mode)
          { onStreamChunk: opts.onStreamChunk }
        );

        // Get cached action results from runtime
        const cachedState = runtime.stateCache?.get(`${message.id}_action_results`);
        const actionResults = Array.isArray(cachedState?.values?.actionResults)
          ? cachedState.values.actionResults
          : [];
        const result =
          actionResults.length > 0 &&
          typeof actionResults[0] === 'object' &&
          actionResults[0] !== null
            ? actionResults[0]
            : null;
        const success =
          result && 'success' in result && typeof result.success === 'boolean'
            ? result.success
            : false;

        const actionResultText =
          result && 'text' in result && typeof result.text === 'string' ? result.text : undefined;
        traceActionResult.push({
          data: { actionName: typeof action === 'string' ? action : 'unknown' },
          success,
          text: actionResultText,
          values:
            result &&
            'values' in result &&
            typeof result.values === 'object' &&
            result.values !== null
              ? result.values
              : undefined,
          error: success ? undefined : actionResultText,
        });

        runtime.logger.info(
          {
            src: 'service:message:multistep',
            step: iterationCount,
            action,
            success,
            resultLength: actionResultText?.length || 0,
          },
          `Step ${iterationCount} - Action completed: ${action} (success=${success})`
        );
      }
    }

    if (iterationCount >= opts.maxMultiStepIterations) {
      runtime.logger.warn(
        { src: 'service:message:multistep', maxIterations: opts.maxMultiStepIterations },
        `Reached maximum iterations (${opts.maxMultiStepIterations}), forcing completion`
      );
    }

    runtime.logger.info(
      {
        src: 'service:message:multistep',
        totalSteps: iterationCount,
        actionsExecuted: traceActionResult.length,
        streamingEnabled: !!opts.onStreamChunk,
      },
      `Generating summary (${iterationCount} steps completed, ${traceActionResult.length} actions traced)`
    );

    accumulatedState = (await runtime.composeState(message, [
      'RECENT_MESSAGES',
      'ACTION_STATE',
    ])) as MultiStepState;
    const summaryPrompt = composePromptFromState({
      state: accumulatedState,
      template: runtime.character.templates?.multiStepSummaryTemplate || multiStepSummaryTemplate,
    });

    // Retry logic for summary parsing failures with bounds checking
    const summaryRetriesSetting = runtime.getSetting('MULTISTEP_SUMMARY_PARSE_RETRIES');
    const rawSummaryRetries = parseInt(String(summaryRetriesSetting ?? '5'), 10);
    // Validate retry count is within reasonable bounds (1-10)
    const maxSummaryRetries = Math.max(
      1,
      Math.min(10, isNaN(rawSummaryRetries) ? 5 : rawSummaryRetries)
    );
    let finalOutput: string = '';
    let summary: Record<string, unknown> | null = null;

    // Set up streaming context for summary (uses XmlTagExtractor for <text> extraction)
    const summaryStreamingContext = opts.onStreamChunk
      ? createStreamingContext(new XmlTagExtractor('text'), opts.onStreamChunk, responseId)
      : undefined;

    for (let summaryAttempt = 1; summaryAttempt <= maxSummaryRetries; summaryAttempt++) {
      // Check if text extraction is already complete - no point in retrying
      if (summaryAttempt > 1 && summaryStreamingContext?.isComplete?.()) {
        runtime.logger.info(
          { src: 'service:message:multistep', attempt: summaryAttempt },
          'Summary text extraction complete despite XML parse failure - skipping further retries'
        );
        break;
      }

      try {
        runtime.logger.debug(
          {
            src: 'service:message',
            attempt: summaryAttempt,
            maxAttempts: maxSummaryRetries,
          },
          'Summary generation attempt'
        );

        // Check if we have partial streamed text - if so, exit to let continuation handle it
        if (summaryAttempt > 1 && summaryStreamingContext) {
          const partialText = summaryStreamingContext.getStreamedText?.() || '';
          if (partialText.length > 0) {
            runtime.logger.debug(
              { src: 'service:message:multistep', streamedTextLength: partialText.length },
              'Partial text streamed - exiting retry loop for continuation'
            );
            break;
          }
          // No text streamed yet, safe to reset and retry
          summaryStreamingContext.reset?.();
        }

        if (summaryStreamingContext) {
          // Stream the final summary to the user (extracts <text> content only)
          finalOutput = await runWithStreamingContext(summaryStreamingContext, () =>
            runtime.useModel(ModelType.TEXT_LARGE, {
              prompt: summaryPrompt,
            })
          );
        } else {
          // No streaming: streaming is disabled
          finalOutput = await runtime.useModel(ModelType.TEXT_LARGE, {
            prompt: summaryPrompt,
          });
        }
        summary = parseKeyValueXml(finalOutput);

        if (summary?.text) {
          runtime.logger.debug(
            { src: 'service:message', attempt: summaryAttempt },
            'Successfully parsed summary'
          );
          break;
        } else {
          runtime.logger.warn(
            {
              src: 'service:message',
              attempt: summaryAttempt,
              maxAttempts: maxSummaryRetries,
              rawResponsePreview: finalOutput.substring(0, 200),
              streamedTextLength: summaryStreamingContext?.getStreamedText?.()?.length ?? 0,
            },
            'Failed to parse summary XML'
          );

          if (summaryAttempt < maxSummaryRetries) {
            // Exponential backoff: 1s, 2s, 4s, etc. (capped at 8s)
            const backoffMs = Math.min(1000 * Math.pow(2, summaryAttempt - 1), 8000);
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
          }
        }
      } catch (error) {
        runtime.logger.error(
          {
            src: 'service:message',
            attempt: summaryAttempt,
            maxAttempts: maxSummaryRetries,
            error: error instanceof Error ? error.message : String(error),
          },
          'Error during summary generation attempt'
        );
        if (summaryAttempt >= maxSummaryRetries) {
          runtime.logger.warn(
            { src: 'service:message' },
            'Failed to generate summary after all retries, using fallback'
          );
          break;
        }
        // Exponential backoff on error
        const backoffMs = Math.min(1000 * Math.pow(2, summaryAttempt - 1), 8000);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }

    // Intelligent streaming retry logic for multi-step summary
    const currentStreamedText = summaryStreamingContext?.getStreamedText?.() || '';
    const isTextComplete = summaryStreamingContext?.isComplete?.() ?? false;

    // Case B: XML parsing failed OR summary text doesn't exist
    // but <text> extraction is complete - use streamed text
    if (isTextComplete && currentStreamedText && !summary?.text) {
      runtime.logger.info(
        {
          src: 'service:message:multistep',
          streamedTextLength: currentStreamedText.length,
          streamedTextPreview: currentStreamedText.substring(0, 100),
          hadSummary: !!summary,
        },
        'Summary text extraction complete - using streamed text'
      );

      summary = {
        ...(summary || {}),
        text: currentStreamedText,
        thought: summary?.thought || 'Summary generated via streaming',
      };
    } else if (currentStreamedText && !isTextComplete) {
      // Case C: Text was cut mid-stream - retry with continuation prompt
      runtime.logger.debug(
        {
          src: 'service:message:multistep',
          streamedTextLength: currentStreamedText.length,
          streamedTextPreview: currentStreamedText.substring(0, 100),
        },
        'Summary text cut mid-stream - attempting continuation'
      );

      // Reset extractor for fresh streaming of continuation
      summaryStreamingContext?.reset?.();

      const continuationPrompt = `${summaryPrompt}

[CONTINUATION REQUIRED]
Your previous response was cut off. The user already received this text:
"${currentStreamedText}"

Continue EXACTLY from where you left off. Do NOT repeat what was already said.
Output ONLY the continuation, starting immediately after the last character above.
Wrap your continuation in <text></text> tags.`;

      const continuationResponse = await runWithStreamingContext(summaryStreamingContext, () =>
        runtime.useModel(ModelType.TEXT_LARGE, {
          prompt: continuationPrompt,
        })
      );

      const continuationParsed = parseKeyValueXml(continuationResponse);
      const continuationText =
        typeof continuationParsed?.text === 'string' ? continuationParsed.text : '';

      if (continuationText) {
        const fullText = currentStreamedText + continuationText;
        summary = { text: fullText, thought: 'Summary completed via continuation' };

        runtime.logger.info(
          {
            src: 'service:message:multistep',
            fullTextLength: fullText.length,
          },
          'Summary continuation successful'
        );
      }
    }

    let responseContent: Content | null = null;
    const summaryText = summary?.text;
    if (typeof summaryText === 'string' && summaryText) {
      const summaryThought = summary?.thought;
      responseContent = {
        actions: ['MULTI_STEP_SUMMARY'],
        text: summaryText,
        thought:
          (typeof summaryThought === 'string'
            ? summaryThought
            : 'Final user-facing message after task completion.') ||
          'Final user-facing message after task completion.',
        simple: true,
        responseId,
      };
    } else {
      // Fallback response when summary generation fails
      runtime.logger.warn(
        { src: 'service:message', maxSummaryRetries },
        'No valid summary generated after all attempts, using fallback'
      );
      responseContent = {
        actions: ['MULTI_STEP_SUMMARY'],
        text: 'I completed the requested actions, but encountered an issue generating the summary.',
        thought: 'Summary generation failed after retries.',
        simple: true,
        responseId,
      };
    }

    const responseMessages: Memory[] = responseContent
      ? [
          {
            id: responseId,
            entityId: runtime.agentId,
            agentId: runtime.agentId,
            content: responseContent,
            roomId: message.roomId,
            createdAt: Date.now(),
          },
        ]
      : [];

    runtime.logger.info(
      {
        src: 'service:message:multistep',
        responseId,
        totalSteps: iterationCount,
        actionsExecuted: traceActionResult.length,
        successfulActions: traceActionResult.filter((r) => r.success).length,
        responseLength: responseContent?.text?.length || 0,
      },
      `Complete - ${iterationCount} steps, ${traceActionResult.filter((r) => r.success).length}/${traceActionResult.length} actions succeeded`
    );

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
      source: 'messageHandler',
      runId,
      messageId: message.id,
      roomId: message.roomId,
      entityId: message.entityId,
      startTime,
      status: status as 'completed' | 'timeout',
      endTime: Date.now(),
      duration: Date.now() - startTime,
    } as RunEventPayload);
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
        runtime.logger.error(
          { src: 'service:message', agentId: runtime.agentId },
          'Cannot delete memory: message ID is missing'
        );
        return;
      }

      runtime.logger.info(
        {
          src: 'service:message',
          agentId: runtime.agentId,
          messageId: message.id,
          roomId: message.roomId,
        },
        'Deleting memory'
      );
      await runtime.deleteMemory(message.id);
      runtime.logger.debug(
        { src: 'service:message', messageId: message.id },
        'Successfully deleted memory'
      );
    } catch (error: unknown) {
      runtime.logger.error(
        { src: 'service:message', agentId: runtime.agentId, error },
        'Error in deleteMessage'
      );
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
        { src: 'service:message', agentId: runtime.agentId, channelId, roomId },
        'Clearing message memories from channel'
      );

      // Get all message memories for this room
      const memories = await runtime.getMemoriesByRoomIds({
        tableName: 'messages',
        roomIds: [roomId],
      });

      runtime.logger.debug(
        { src: 'service:message', channelId, count: memories.length },
        'Found message memories to delete'
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
              { src: 'service:message', error, memoryId: memory.id },
              'Failed to delete message memory'
            );
          }
        }
      }

      runtime.logger.info(
        {
          src: 'service:message',
          agentId: runtime.agentId,
          channelId,
          deletedCount,
          totalCount: memories.length,
        },
        'Cleared message memories from channel'
      );
    } catch (error: unknown) {
      runtime.logger.error(
        { src: 'service:message', agentId: runtime.agentId, error },
        'Error in clearChannel'
      );
      throw error;
    }
  }
}
