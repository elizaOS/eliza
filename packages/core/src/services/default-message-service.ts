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
import { ResponseStreamExtractor } from '../utils/streaming';
import { runWithStreamingContext } from '../streaming-context';

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
      let streamingContext:
        | { onStreamChunk: (chunk: string, messageId?: UUID) => Promise<void>; messageId?: UUID }
        | undefined;
      if (opts.onStreamChunk) {
        const extractor = new ResponseStreamExtractor();
        streamingContext = {
          onStreamChunk: async (chunk: string, msgId?: UUID) => {
            if (extractor.done) return;
            const textToStream = extractor.push(chunk);
            if (textToStream) {
              await opts.onStreamChunk!(textToStream, msgId);
            }
          },
          messageId: responseId,
        };
      }

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

    while (iterationCount < opts.maxMultiStepIterations) {
      iterationCount++;
      runtime.logger.debug(
        {
          src: 'service:message',
          iteration: iterationCount,
          maxIterations: opts.maxMultiStepIterations,
        },
        'Starting multi-step iteration'
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
          { src: 'service:message', iteration: iterationCount },
          'Failed to parse multi-step result'
        );
        traceActionResult.push({
          data: { actionName: 'parse_error' },
          success: false,
          error: 'Failed to parse step result',
        });
        break;
      }

      const thought = typeof parsedStep.thought === 'string' ? parsedStep.thought : undefined;
      const providers = Array.isArray(parsedStep.providers) ? parsedStep.providers : [];
      const action = typeof parsedStep.action === 'string' ? parsedStep.action : undefined;
      const isFinish = parsedStep.isFinish;

      // Check for completion condition
      if (isFinish === 'true' || isFinish === true) {
        runtime.logger.info(
          { src: 'service:message', agentId: runtime.agentId, iteration: iterationCount },
          'Multi-step task completed'
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

      const providerPromises = providersArray
        .filter((name): name is string => typeof name === 'string')
        .map(async (providerName) => {
          const provider = runtime.providers.find((p) => p.name === providerName);
          if (!provider) {
            runtime.logger.warn({ src: 'service:message', providerName }, 'Provider not found');
            completedProviders.add(providerName);
            return { providerName, success: false, error: `Provider not found: ${providerName}` };
          }

          try {
            const providerResult = await provider.get(runtime, message, state);
            completedProviders.add(providerName);

            if (!providerResult) {
              runtime.logger.warn(
                { src: 'service:message', providerName },
                'Provider returned no result'
              );
              return { providerName, success: false, error: 'Provider returned no result' };
            }

            const success = !!providerResult.text;
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
              { src: 'service:message', providerName, error: errorMsg },
              'Provider execution failed'
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
            src: 'service:message',
            timeoutMs: PROVIDERS_TOTAL_TIMEOUT_MS,
            pendingProviders,
            completedProviders: Array.from(completedProviders),
          },
          `Providers took too long (>${PROVIDERS_TOTAL_TIMEOUT_MS}ms) - slow providers: ${pendingProviders.join(', ')}`
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
          state,
          async () => {
            return [];
          }
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

        traceActionResult.push({
          data: { actionName: typeof action === 'string' ? action : 'unknown' },
          success,
          text:
            result && 'text' in result && typeof result.text === 'string' ? result.text : undefined,
          values:
            result &&
            'values' in result &&
            typeof result.values === 'object' &&
            result.values !== null
              ? result.values
              : undefined,
          error: success
            ? undefined
            : result && 'text' in result && typeof result.text === 'string'
              ? result.text
              : undefined,
        });
      }
    }

    if (iterationCount >= opts.maxMultiStepIterations) {
      runtime.logger.warn(
        { src: 'service:message', maxIterations: opts.maxMultiStepIterations },
        'Reached maximum iterations, forcing completion'
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

    const finalOutput = await runtime.useModel(ModelType.TEXT_LARGE, {
      prompt: summaryPrompt,
    });
    const summary = parseKeyValueXml(finalOutput);

    let responseContent: Content | null = null;
    const summaryText = summary?.text;
    if (typeof summaryText === 'string' && summaryText) {
      responseContent = {
        actions: ['MULTI_STEP_SUMMARY'],
        text: summaryText,
        thought:
          (typeof summary.thought === 'string'
            ? summary.thought
            : 'Final user-facing message after task completion.') ||
          'Final user-facing message after task completion.',
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
