import {
  asUUID,
  composePromptFromState,
  createUniqueUuid,
  EventType,
  type IAgentRuntime,
  logger,
  type Memory,
  type MessagePayload,
  ModelType,
  type Plugin,
  type UUID,
  parseKeyValueXml,
  type State,
  type HandlerCallback,
  type RunEventPayload,
} from '@elizaos/core';
import { v4 } from 'uuid';
import { providersProvider } from './providers/providers';
import { actionsProvider } from './providers/actions';
import { characterProvider } from './providers/character';
import { generateImageAction } from './actions/image-generation';
import { actionStateProvider } from './providers/actionState';
import { listeners } from './events/listeners';
import { recentMessagesProvider } from './providers/recent-messages';

// Constants
const MAX_RESPONSE_RETRIES = 3;
const EVALUATOR_TIMEOUT_MS = 120000;

// Mode types
type AssistantMode = 'default' | 'actions' | 'rag_knowledge';

const ASSISTANT_MODE = {
  DEFAULT: 'default' as const,
  ACTIONS: 'actions' as const,
  RAG_KNOWLEDGE: 'rag_knowledge' as const,
};

// Types
interface MessageReceivedHandlerParams {
  runtime: IAgentRuntime;
  message: Memory;
  callback: HandlerCallback;
}

interface ParsedPlan {
  canRespondNow?: string;
  thought?: string;
  text?: string;
  providers?: string | string[];
  actions?: string | string[];
}

interface ParsedResponse {
  thought?: string;
  text?: string;
}

const systemPrompt = `
# Character Identity
{{system}}
{{bio}}
{{messageDirections}}
{{characterLore}}

## Planning Phase Rules
When analyzing user messages, follow this decision tree:

### Option 1 - Immediate Response (1 LLM call)
Use ONLY when ALL conditions are met:
- Simple greeting, thanks, or social interaction
- General knowledge question answerable from character expertise
- NO actions needed (no image generation, no tools, no external operations)
- NO providers needed (no document lookup, no data retrieval)
- Complete answer possible with existing context alone

### Option 2 - Tool/Provider Usage (2+ LLM calls)
Use when ANY of these apply:
- User requests an action (generate image, search, calculate, etc.)
- Need to check documents, knowledge base, or user data
- Need specific providers for context
- Any tool or external operation required

CRITICAL: If listing actions or providers, MUST set canRespondNow to NO.

# Response Generation Rules
- Keep responses focused and relevant to the user's specific question
- Don't repeat earlier replies unless explicitly asked
- Cite specific sources when referencing documents
- Include actionable advice with clear steps
- Balance detail with clarity - avoid overwhelming beginners

# Output Format Requirements
## Planning Phase Output
Always output ALL fields. Leave fields empty when not needed:

<plan>
  <thought>Reasoning about approach</thought>
  <canRespondNow>YES or NO</canRespondNow>
  <text>Response text if YES, empty if NO</text>
  <providers>KNOWLEDGE if needed, empty otherwise</providers>
  <actions>GENERATE_IMAGE if needed, empty otherwise</actions>
</plan>
`;

const defaultSystemPrompt = `
# Character Identity
{{system}}
{{bio}}
{{messageDirections}}
{{characterLore}}

<instructions>
Respond to the user's message naturally and helpfully.
Be concise, clear, and friendly.
Use the provided context and memories to personalize your response.
</instructions>

<output>
Respond using XML format like this:
<response>
  <thought>Your internal reasoning about how to respond</thought>
  <text>Your response text here</text>
</response>

Your response must ONLY include the <response></response> XML block.
</output>
`;

/**
 * Planning template - decides if we can respond immediately and generates response if possible
 */
export const planningTemplate = `
{{receivedMessage}}
{{compressedHistory}}
{{recentMessages}}
{{longTermMemories}}
{{availableDocuments}}
{{dynamicProviders}}
{{actionsWithDescriptions}}
`;

/**
 * Default mode template - single shot response without planning
 */
export const defaultTemplate = `
{{receivedMessage}}
{{compressedHistory}}
{{recentMessages}}
{{longTermMemories}}
{{characterLore}}
`;

const finalMessageSystemPrompt = `
# Character Identity
{{system}}
{{bio}}
{{messageDirections}}
{{characterLore}}

<instructions>
Respond to the user's message thoroughly and helpfully.
Be concise, clear, and friendly.
Use the provided context and memories to personalize your response.

</instructions>

<keys>
"text" should be the text of the next message for {{agentName}} which they will send to the conversation.
</keys>

<output>
Respond using XML format like this:
<response>
  <thought>Your internal reasoning</thought>
  <text>Your response text here</text>
</response>

Your response must ONLY include the <response></response> XML block.
</output>
`;

/**
 * Final response template - generates the actual response
 */
export const messageHandlerTemplate = `
{{compressedHistory}}

{{recentMessages}}

{{longTermMemories}}

{{fullActionState}}

{{knowledge}}

{{focusInstruction}}
`;

// Helper functions for response ID tracking
async function getLatestResponseId(runtime: IAgentRuntime, roomId: string): Promise<string | null> {
  const key = buildResponseCacheKey(runtime.agentId, roomId);
  return (await runtime.getCache<string>(key)) ?? null;
}

async function setLatestResponseId(
  runtime: IAgentRuntime,
  roomId: string,
  responseId: string
): Promise<void> {
  if (!responseId || typeof responseId !== 'string') {
    logger.error('[setLatestResponseId] Invalid responseId:', responseId);
    throw new Error(`Invalid responseId: ${responseId}`);
  }

  const key = buildResponseCacheKey(runtime.agentId, roomId);
  logger.debug(
    `[setLatestResponseId] Setting cache: ${key}, responseId: ${responseId.substring(0, 8)}`
  );

  try {
    await runtime.setCache(key, responseId);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`[setLatestResponseId] Error setting cache: ${errorMessage}`);
    throw error;
  }
}

async function clearLatestResponseId(runtime: IAgentRuntime, roomId: string): Promise<void> {
  const key = buildResponseCacheKey(runtime.agentId, roomId);
  logger.debug(`[clearLatestResponseId] Deleting cache key: ${key}`);
  await runtime.deleteCache(key);
}

/**
 * Build cache key for response tracking
 */
function buildResponseCacheKey(agentId: UUID, roomId: string): string {
  return `response_id:${agentId}:${roomId}`;
}

/**
 * Parse planned items (providers or actions) from XML response
 * Handles both array and comma-separated string formats
 */
function parsePlannedItems(items: string | string[] | undefined): string[] {
  if (!items) return [];

  const itemArray = Array.isArray(items) ? items : items.split(',').map((item) => item.trim());

  return itemArray.filter((item) => item && item !== '');
}

/**
 * Check if plan indicates immediate response capability
 */
function canRespondImmediately(plan: ParsedPlan | null): boolean {
  return plan?.canRespondNow?.toUpperCase() === 'YES' || plan?.canRespondNow === 'true';
}

/**
 * Extract attachments from action results
 */
function extractAttachments(
  actionResults: Array<{ data?: { attachments?: unknown[] } }>
): unknown[] {
  return actionResults.flatMap((result) => result.data?.attachments ?? []).filter(Boolean);
}

/**
 * Execute planned providers and update state
 */
async function executeProviders(
  runtime: IAgentRuntime,
  message: Memory,
  plannedProviders: string[],
  currentState: State
): Promise<State> {
  if (plannedProviders.length === 0) {
    return currentState;
  }

  logger.debug('[ElizaAssistant] Executing providers:', JSON.stringify(plannedProviders));
  const providerState = await runtime.composeState(message, [...plannedProviders, 'CHARACTER']);

  return { ...currentState, ...providerState };
}

/**
 * Execute planned actions and update state
 */
async function executeActions(
  runtime: IAgentRuntime,
  message: Memory,
  plannedActions: string[],
  plan: ParsedPlan | null,
  currentState: State,
  callback: HandlerCallback
): Promise<State> {
  if (plannedActions.length === 0) {
    return currentState;
  }

  logger.debug('[ElizaAssistant] Executing actions:', JSON.stringify(plannedActions));

  const actionResponse: Memory = {
    id: createUniqueUuid(runtime, v4() as UUID),
    entityId: runtime.agentId,
    roomId: message.roomId,
    worldId: message.worldId,
    content: {
      text: plan?.thought || 'Executing actions',
      actions: plannedActions,
      source: 'agent',
    },
  };

  await runtime.processActions(message, [actionResponse], currentState, callback);

  // Refresh state to get action results
  const actionState = await runtime.composeState(message, ['ACTION_STATE']);
  return { ...currentState, ...actionState };
}

/**
 * Generate response with retry logic
 */
async function generateResponseWithRetry(
  runtime: IAgentRuntime,
  prompt: string
): Promise<{ text: string; thought: string }> {
  let retries = 0;
  let responseContent = '';
  let thought = '';

  while (retries < MAX_RESPONSE_RETRIES && !responseContent) {
    const response = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });

    logger.debug('*** RAW LLM RESPONSE ***\n', response);

    const parsedResponse = parseKeyValueXml(response) as ParsedResponse | null;

    if (!parsedResponse?.text) {
      logger.warn('*** Missing response text, retrying... ***');
      retries++;
    } else {
      responseContent = parsedResponse.text;
      thought = parsedResponse.thought || '';
      break;
    }
  }

  return { text: responseContent, thought };
}

/**
 * Run evaluators with timeout to prevent hanging
 */
async function runEvaluatorsWithTimeout(
  runtime: IAgentRuntime,
  message: Memory,
  state: State,
  responseMemory: Memory,
  callback: HandlerCallback
): Promise<void> {
  if (typeof runtime.evaluate !== 'function') {
    logger.debug('[ElizaAssistant] runtime.evaluate not available - skipping evaluators');
    return;
  }

  logger.debug('[ElizaAssistant] Running evaluators');

  try {
    await Promise.race([
      runtime.evaluate(
        message,
        { ...state },
        true, // shouldRespondToMessage
        async (content) => {
          logger.debug('[ElizaAssistant] Evaluator callback:', JSON.stringify(content));
          return callback ? callback(content) : [];
        },
        [responseMemory]
      ),
      new Promise<void>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Evaluators timed out after ${EVALUATOR_TIMEOUT_MS}ms`));
        }, EVALUATOR_TIMEOUT_MS);
      }),
    ]);
    logger.debug('[ElizaAssistant] Evaluators completed successfully');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`[ElizaAssistant] Error in evaluators: ${errorMessage}`);
  }
}

/**
 * Handles incoming messages using single-shot approach with planning
 */
const messageReceivedHandler = async ({
  runtime,
  message,
  callback,
}: MessageReceivedHandlerParams): Promise<void> => {
  // TODO: Add mode selection logic here
  // For now, hardcoded to DEFAULT mode
  const mode: AssistantMode = ASSISTANT_MODE.DEFAULT;

  logger.info(`[ElizaAssistant] Using mode: ${mode}`);

  if (mode === ASSISTANT_MODE.DEFAULT) {
    return handleDefaultMode({ runtime, message, callback });
  } else if (mode === ASSISTANT_MODE.ACTIONS) {
    return handleActionsMode({ runtime, message, callback });
  } else if (mode === ASSISTANT_MODE.RAG_KNOWLEDGE) {
    return handleRagKnowledgeMode({ runtime, message, callback });
  } else {
    throw new Error(`Unknown assistant mode: ${mode}`);
  }
};

/**
 * DEFAULT MODE: Single-shot LLM call without planning
 * - Compose basic state with memory providers
 * - Make single LLM call for thought + text
 * - Callback immediately
 * - Run evaluators in background
 */
const handleDefaultMode = async ({
  runtime,
  message,
  callback,
}: MessageReceivedHandlerParams): Promise<void> => {
  const responseId = v4();
  const runId = asUUID(v4());
  const startTime = Date.now();

  logger.debug(`[DefaultMode] Generated response ID: ${responseId.substring(0, 8)}`);
  logger.debug(`[DefaultMode] Generated run ID: ${runId.substring(0, 8)}`);
  logger.debug(`[DefaultMode] MESSAGE RECEIVED:`, JSON.stringify(message));

  await setLatestResponseId(runtime, message.roomId, responseId);

  // Emit run started event
  await runtime.emitEvent(EventType.RUN_STARTED, {
    runtime,
    source: 'messageHandler',
    runId,
    messageId: message.id as UUID,
    roomId: message.roomId,
    entityId: message.entityId,
    startTime,
    status: 'started',
  } as RunEventPayload);

  try {
    if (message.entityId === runtime.agentId) {
      throw new Error('Message is from the agent itself');
    }

    // Save the incoming message
    logger.debug('[DefaultMode] Saving message to memory');
    await runtime.createMemory(message, 'messages');

    // Compose state with basic providers (no actions, no dynamic providers)
    logger.info(
      `[DefaultMode] Processing message for character: ${runtime.character.name} (ID: ${runtime.character.id})`
    );
    logger.debug('[DefaultMode] Composing state with basic providers');
    const state = await runtime.composeState(message, [
      'RECENT_CONVERSATION_SUMMARY', // Conversation history + current message
      'LONG_TERM_MEMORY', // User facts and knowledge
      'CHARACTER',
      'CHARACTER_LORE',
    ]);

    logger.debug('*** DEFAULT MODE STATE ***', JSON.stringify(state));

    // Compose system prompt
    const originalSystemPrompt = runtime.character.system;
    const composedSystemPrompt = composePromptFromState({
      state,
      template: defaultSystemPrompt,
    });
    runtime.character.system = composedSystemPrompt;

    // Compose user prompt
    const prompt = composePromptFromState({
      state,
      template: runtime.character.templates?.defaultTemplate || defaultTemplate,
    });

    logger.debug('*** DEFAULT SYSTEM PROMPT ***\n', runtime.character.system);
    logger.debug('*** DEFAULT PROMPT ***\n', prompt);

    // Single LLM call to get response
    const response = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });
    logger.debug('*** DEFAULT RESPONSE ***\n', response);

    const parsedResponse = parseKeyValueXml(response) as ParsedResponse | null;

    if (!parsedResponse?.text) {
      throw new Error('Failed to generate valid response');
    }

    const responseContent = parsedResponse.text;
    const thought = parsedResponse.thought || '';

    // Restore original system prompt
    runtime.character.system = originalSystemPrompt;

    // Check if this is still the latest response ID for this room
    const currentResponseId = await getLatestResponseId(runtime, message.roomId);
    if (currentResponseId !== responseId) {
      logger.info(
        `Response discarded - newer message being processed for agent: ${runtime.agentId}, room: ${message.roomId}`
      );
      return;
    }

    // Clean up the response ID
    await clearLatestResponseId(runtime, message.roomId);

    // Create response memory
    const responseMemory: Memory = {
      id: createUniqueUuid(runtime, (message.id ?? v4()) as UUID),
      entityId: runtime.agentId,
      roomId: message.roomId,
      worldId: message.worldId,
      content: {
        text: responseContent,
        thought,
        source: 'agent',
        inReplyTo: message.id,
      },
    };

    // Save response
    logger.debug('[DefaultMode] Saving response to memory');
    await runtime.createMemory(responseMemory, 'messages');

    // Trigger callback immediately with response (don't wait for evaluators)
    if (callback) {
      await callback({ text: responseContent });
    }

    // Run evaluators asynchronously in background
    await runEvaluatorsWithTimeout(runtime, message, state, responseMemory, callback);

    logger.info(`[DefaultMode] Run ${runId.substring(0, 8)} completed successfully`);

    const endTime = Date.now();
    await runtime.emitEvent(EventType.RUN_ENDED, {
      runtime,
      source: 'messageHandler',
      runId,
      messageId: message.id as UUID,
      roomId: message.roomId,
      entityId: message.entityId,
      startTime,
      status: 'completed',
      endTime,
      duration: endTime - startTime,
    } as RunEventPayload);
  } catch (error) {
    // Emit run ended event with error
    await runtime.emitEvent(EventType.RUN_ENDED, {
      runtime,
      source: 'messageHandler',
      runId,
      messageId: message.id as UUID,
      roomId: message.roomId,
      entityId: message.entityId,
      startTime,
      status: 'completed',
      endTime: Date.now(),
      duration: Date.now() - startTime,
      error: error instanceof Error ? error.message : String(error),
    } as RunEventPayload);
    throw error;
  }
};

/**
 * ACTIONS MODE: Planning-based approach with action execution
 * - Plan which actions to use
 * - Execute actions
 * - Generate final response with action results
 */
const handleActionsMode = async ({
  runtime,
  message,
  callback,
}: MessageReceivedHandlerParams): Promise<void> => {
  const responseId = v4();
  const runId = asUUID(v4());
  const startTime = Date.now();

  logger.debug(`[ActionsMode] Generated response ID: ${responseId.substring(0, 8)}`);
  logger.debug(`[ActionsMode] Generated run ID: ${runId.substring(0, 8)}`);
  logger.debug(`[ActionsMode] MESSAGE RECEIVED:`, JSON.stringify(message));

  await setLatestResponseId(runtime, message.roomId, responseId);

  // Emit run started event
  await runtime.emitEvent(EventType.RUN_STARTED, {
    runtime,
    source: 'messageHandler',
    runId,
    messageId: message.id as UUID,
    roomId: message.roomId,
    entityId: message.entityId,
    startTime,
    status: 'started',
  } as RunEventPayload);

  try {
    if (message.entityId === runtime.agentId) {
      throw new Error('Message is from the agent itself');
    }

    // Save the incoming message
    logger.debug('[ActionsMode] Saving message to memory');
    await runtime.createMemory(message, 'messages');

    // PHASE 1: Compose initial state with memory providers
    logger.info(
      `[ActionsMode] Processing message for character: ${runtime.character.name} (ID: ${runtime.character.id})`
    );
    logger.debug('[ActionsMode] Composing state with memory providers');
    const initialState = await runtime.composeState(message, [
      'RECENT_CONTEXT',
      'LONG_TERM_MEMORY',
      'AVAILABLE_DOCUMENTS',
      'PROVIDERS',
      'ACTIONS',
      'CHARACTER',
      'CHARACTER_LORE',
    ]);

    logger.debug('*** ACTIONS MODE INITIAL STATE ***', JSON.stringify(initialState));

    // PHASE 2: Planning - Determine which actions to use
    logger.info('[ActionsMode] Phase 1: Planning');
    const planningPrompt = composePromptFromState({
      state: initialState,
      template: runtime.character.templates?.planningTemplate || planningTemplate,
    });

    const originalSystemPrompt = runtime.character.system;
    const composedSystemPrompt = composePromptFromState({
      state: initialState,
      template: systemPrompt,
    });
    runtime.character.system = composedSystemPrompt;

    logger.debug('*** ACTIONS MODE SYSTEM PROMPT ***\n', runtime.character.system);
    logger.debug('*** ACTIONS MODE PLANNING PROMPT ***\n', planningPrompt);

    const planningResponse = await runtime.useModel(ModelType.TEXT_LARGE, {
      prompt: planningPrompt,
    });

    // Reset the system prompt
    runtime.character.system = originalSystemPrompt;

    logger.debug('*** ACTIONS MODE PLANNING RESPONSE ***\n', planningResponse);

    const plan = parseKeyValueXml(planningResponse) as ParsedPlan | null;
    const shouldRespondNow = canRespondImmediately(plan);

    logger.info(
      `[ActionsMode] Plan - canRespondNow: ${shouldRespondNow}, thought: ${plan?.thought}`
    );

    let responseContent = '';
    let thought = '';

    // Check if can respond immediately (optimization)
    if (shouldRespondNow && plan?.text) {
      logger.info('[ActionsMode] ⚡ Single-call optimization: Using response from planning phase');
      responseContent = plan.text;
      thought = plan.thought || '';
    } else {
      // PHASE 3: Execute planned actions
      let updatedState = { ...initialState };

      if (!shouldRespondNow) {
        logger.info('[ActionsMode] Phase 2: Executing providers and actions');
        logger.debug(`[ActionsMode] Providers: ${plan?.providers}, Actions: ${plan?.actions}`);

        const plannedProviders = parsePlannedItems(plan?.providers);
        const plannedActions = parsePlannedItems(plan?.actions);

        updatedState = await executeProviders(runtime, message, plannedProviders, updatedState);
        updatedState = await executeActions(
          runtime,
          message,
          plannedActions,
          plan,
          updatedState,
          callback
        );
      }

      // PHASE 4: Generate final response with action results
      logger.info('[ActionsMode] Phase 3: Generating final response');

      const finalSystemPrompt = composePromptFromState({
        state: updatedState,
        template: finalMessageSystemPrompt,
      });
      runtime.character.system = finalSystemPrompt;

      const responsePrompt = composePromptFromState({
        state: updatedState,
        template: runtime.character.templates?.messageHandlerTemplate || messageHandlerTemplate,
      });

      logger.debug('*** ACTIONS MODE FINAL SYSTEM PROMPT ***\n', runtime.character.system);
      logger.debug('*** ACTIONS MODE RESPONSE PROMPT ***\n', responsePrompt);

      const responseResult = await generateResponseWithRetry(runtime, responsePrompt);
      responseContent = responseResult.text;
      thought = responseResult.thought;
    }

    // Restore original system prompt
    runtime.character.system = originalSystemPrompt;

    // Check if this is still the latest response ID
    const currentResponseId = await getLatestResponseId(runtime, message.roomId);
    if (currentResponseId !== responseId) {
      logger.info(
        `Response discarded - newer message being processed for agent: ${runtime.agentId}, room: ${message.roomId}`
      );
      return;
    }

    // Clean up the response ID
    await clearLatestResponseId(runtime, message.roomId);

    // Extract attachments from action results
    const actionResults = await runtime.getActionResults(message.id as UUID);
    const attachments = extractAttachments(actionResults);

    logger.info(`[ActionsMode] Action results: ${JSON.stringify(actionResults)}`);

    // Create response memory with attachments
    const content: Record<string, unknown> = {
      text: responseContent,
      thought,
      source: 'agent',
      inReplyTo: message.id,
    };

    if (attachments.length > 0) {
      content.attachments = attachments;
      logger.info(`[ActionsMode] Including ${attachments.length} attachment(s) in response`);
    }

    const responseMemory: Memory = {
      id: createUniqueUuid(runtime, (message.id ?? v4()) as UUID),
      entityId: runtime.agentId,
      roomId: message.roomId,
      worldId: message.worldId,
      content: content as Memory['content'],
    };

    // Save response
    logger.debug('[ActionsMode] Saving response to memory');
    await runtime.createMemory(responseMemory, 'messages');

    // Trigger callback immediately
    if (callback) {
      const callbackContent = {
        text: responseContent,
        ...(attachments.length > 0 && { attachments: attachments as never }),
      };
      await callback(callbackContent);
    }

    // Run evaluators asynchronously
    await runEvaluatorsWithTimeout(runtime, message, initialState, responseMemory, callback);

    logger.info(`[ActionsMode] Run ${runId.substring(0, 8)} completed successfully`);

    const endTime = Date.now();
    await runtime.emitEvent(EventType.RUN_ENDED, {
      runtime,
      source: 'messageHandler',
      runId,
      messageId: message.id as UUID,
      roomId: message.roomId,
      entityId: message.entityId,
      startTime,
      status: 'completed',
      endTime,
      duration: endTime - startTime,
    } as RunEventPayload);
  } catch (error) {
    // Emit run ended event with error
    await runtime.emitEvent(EventType.RUN_ENDED, {
      runtime,
      source: 'messageHandler',
      runId,
      messageId: message.id as UUID,
      roomId: message.roomId,
      entityId: message.entityId,
      startTime,
      status: 'completed',
      endTime: Date.now(),
      duration: Date.now() - startTime,
      error: error instanceof Error ? error.message : String(error),
    } as RunEventPayload);
    throw error;
  }
};

/**
 * RAG KNOWLEDGE MODE: Single-shot with hardcoded knowledge provider
 * - Compose state with KNOWLEDGE provider
 * - Make single LLM call for response
 * - Callback immediately
 * - Run evaluators in background
 */
const handleRagKnowledgeMode = async ({
  runtime,
  message,
  callback,
}: MessageReceivedHandlerParams): Promise<void> => {
  const responseId = v4();
  const runId = asUUID(v4());
  const startTime = Date.now();

  logger.debug(`[RagMode] Generated response ID: ${responseId.substring(0, 8)}`);
  logger.debug(`[RagMode] Generated run ID: ${runId.substring(0, 8)}`);
  logger.debug(`[RagMode] MESSAGE RECEIVED:`, JSON.stringify(message));

  await setLatestResponseId(runtime, message.roomId, responseId);

  // Emit run started event
  await runtime.emitEvent(EventType.RUN_STARTED, {
    runtime,
    source: 'messageHandler',
    runId,
    messageId: message.id as UUID,
    roomId: message.roomId,
    entityId: message.entityId,
    startTime,
    status: 'started',
  } as RunEventPayload);

  try {
    if (message.entityId === runtime.agentId) {
      throw new Error('Message is from the agent itself');
    }

    // Save the incoming message
    logger.debug('[RagMode] Saving message to memory');
    await runtime.createMemory(message, 'messages');

    // Compose state with KNOWLEDGE provider hardcoded
    logger.info(
      `[RagMode] Processing message for character: ${runtime.character.name} (ID: ${runtime.character.id})`
    );
    logger.debug('[RagMode] Composing state with KNOWLEDGE provider');
    const state = await runtime.composeState(message, [
      'RECENT_CONTEXT',
      'LONG_TERM_MEMORY',
      'CHARACTER',
      'CHARACTER_LORE',
      'KNOWLEDGE', // Hardcoded knowledge provider for RAG
    ]);

    logger.debug('*** RAG MODE STATE ***', JSON.stringify(state));

    // Compose system prompt
    const originalSystemPrompt = runtime.character.system;
    const composedSystemPrompt = composePromptFromState({
      state,
      template: defaultSystemPrompt,
    });
    runtime.character.system = composedSystemPrompt;

    // Compose user prompt
    const prompt = composePromptFromState({
      state,
      template: runtime.character.templates?.defaultTemplate || defaultTemplate,
    });

    logger.debug('*** RAG MODE SYSTEM PROMPT ***\n', runtime.character.system);
    logger.debug('*** RAG MODE PROMPT ***\n', prompt);

    // Single LLM call to get response with knowledge context
    const response = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });
    logger.debug('*** RAG MODE RESPONSE ***\n', response);

    const parsedResponse = parseKeyValueXml(response) as ParsedResponse | null;

    if (!parsedResponse?.text) {
      throw new Error('Failed to generate valid response');
    }

    const responseContent = parsedResponse.text;
    const thought = parsedResponse.thought || '';

    // Restore original system prompt
    runtime.character.system = originalSystemPrompt;

    // Check if this is still the latest response ID for this room
    const currentResponseId = await getLatestResponseId(runtime, message.roomId);
    if (currentResponseId !== responseId) {
      logger.info(
        `Response discarded - newer message being processed for agent: ${runtime.agentId}, room: ${message.roomId}`
      );
      return;
    }

    // Clean up the response ID
    await clearLatestResponseId(runtime, message.roomId);

    // Create response memory
    const responseMemory: Memory = {
      id: createUniqueUuid(runtime, (message.id ?? v4()) as UUID),
      entityId: runtime.agentId,
      roomId: message.roomId,
      worldId: message.worldId,
      content: {
        text: responseContent,
        thought,
        source: 'agent',
        inReplyTo: message.id,
      },
    };

    // Save response
    logger.debug('[RagMode] Saving response to memory');
    await runtime.createMemory(responseMemory, 'messages');

    // Trigger callback immediately with response
    if (callback) {
      await callback({ text: responseContent });
    }

    // Run evaluators asynchronously in background
    await runEvaluatorsWithTimeout(runtime, message, state, responseMemory, callback);

    logger.info(`[RagMode] Run ${runId.substring(0, 8)} completed successfully`);

    const endTime = Date.now();
    await runtime.emitEvent(EventType.RUN_ENDED, {
      runtime,
      source: 'messageHandler',
      runId,
      messageId: message.id as UUID,
      roomId: message.roomId,
      entityId: message.entityId,
      startTime,
      status: 'completed',
      endTime,
      duration: endTime - startTime,
    } as RunEventPayload);
  } catch (error) {
    // Emit run ended event with error
    await runtime.emitEvent(EventType.RUN_ENDED, {
      runtime,
      source: 'messageHandler',
      runId,
      messageId: message.id as UUID,
      roomId: message.roomId,
      entityId: message.entityId,
      startTime,
      status: 'completed',
      endTime: Date.now(),
      duration: Date.now() - startTime,
      error: error instanceof Error ? error.message : String(error),
    } as RunEventPayload);
    throw error;
  }
};

const cloudEvents = {
  [EventType.MESSAGE_RECEIVED]: [
    async (payload: MessagePayload) => {
      if (payload.callback) {
        await messageReceivedHandler({
          runtime: payload.runtime,
          message: payload.message,
          callback: payload.callback,
        });
      }
    },
  ],

  [EventType.MESSAGE_SENT]: [
    async (payload: MessagePayload) => {
      logger.debug(`Message sent: ${payload.message.content.text}`);
    },
  ],
};

export const assistantPlugin: Plugin = {
  name: 'eliza-assistant',
  description: 'Core assistant plugin with message handling and context',
  events: { ...cloudEvents, ...listeners },
  providers: [
    providersProvider,
    actionsProvider,
    characterProvider,
    actionStateProvider,
    recentMessagesProvider,
  ],
  actions: [generateImageAction],
  services: [],
};

export default assistantPlugin;
