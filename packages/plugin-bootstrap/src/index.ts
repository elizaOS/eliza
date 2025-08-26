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
  type Plugin,
  PluginEvents,
  postCreationTemplate,
  parseBooleanFromText,
  Role,
  type Room,
  shouldRespondTemplate,
  truncateToCompleteSentence,
  type UUID,
  type WorldPayload,
  getLocalServerUrl,
} from '@elizaos/core';
import { v4 } from 'uuid';

// import * as actions from './actions/index.ts';
// import * as evaluators from './evaluators/index.ts';
import * as providers from './providers/index.ts';

import { TaskService } from './services/task.ts';

export * from './actions/index.ts';
export * from './evaluators/index.ts';
export * from './providers/index.ts';

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
  runtime.logger.debug(`[Bootstrap] Processing ${attachments.length} attachment(s)`);

  const processedAttachments: Media[] = [];

  for (const attachment of attachments) {
    try {
      // Start with the original attachment
      const processedAttachment: Media = { ...attachment };

      const isRemote = /^(http|https):\/\//.test(attachment.url);
      const url = isRemote ? attachment.url : getLocalServerUrl(attachment.url);
      // Only process images that don't already have descriptions
      if (attachment.contentType === ContentType.IMAGE && !attachment.description) {
        runtime.logger.debug(`[Bootstrap] Generating description for image: ${attachment.url}`);

        let imageUrl = url;

        if (!isRemote) {
          // Only convert local/internal media to base64
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
            // Parse XML response
            const parsedXml = parseKeyValueXml(response);

            if (parsedXml && (parsedXml.description || parsedXml.text)) {
              processedAttachment.description = parsedXml.description || '';
              processedAttachment.title = parsedXml.title || 'Image';
              processedAttachment.text = parsedXml.text || parsedXml.description || '';

              runtime.logger.debug(
                `[Bootstrap] Generated description: ${processedAttachment.description?.substring(0, 100)}...`
              );
            } else {
              // Fallback: Try simple regex parsing if parseKeyValueXml fails
              const responseStr = response as string;
              const titleMatch = responseStr.match(/<title>([^<]+)<\/title>/);
              const descMatch = responseStr.match(/<description>([^<]+)<\/description>/);
              const textMatch = responseStr.match(/<text>([^<]+)<\/text>/);

              if (titleMatch || descMatch || textMatch) {
                processedAttachment.title = titleMatch?.[1] || 'Image';
                processedAttachment.description = descMatch?.[1] || '';
                processedAttachment.text = textMatch?.[1] || descMatch?.[1] || '';

                runtime.logger.debug(
                  `[Bootstrap] Used fallback XML parsing - description: ${processedAttachment.description?.substring(0, 100)}...`
                );
              } else {
                runtime.logger.warn(
                  `[Bootstrap] Failed to parse XML response for image description`
                );
              }
            }
          } else if (response && typeof response === 'object' && 'description' in response) {
            // Handle object responses for backwards compatibility
            processedAttachment.description = response.description;
            processedAttachment.title = response.title || 'Image';
            processedAttachment.text = response.description;

            runtime.logger.debug(
              `[Bootstrap] Generated description: ${processedAttachment.description?.substring(0, 100)}...`
            );
          } else {
            runtime.logger.warn(`[Bootstrap] Unexpected response format for image description`);
          }
        } catch (error) {
          runtime.logger.error({ error }, `[Bootstrap] Error generating image description:`);
          // Continue processing without description
        }
      } else if (attachment.contentType === ContentType.DOCUMENT && !attachment.text) {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Failed to fetch document: ${res.statusText}`);

        const contentType = res.headers.get('content-type') || '';
        const isPlainText = contentType.startsWith('text/plain');

        if (isPlainText) {
          runtime.logger.debug(`[Bootstrap] Processing plain text document: ${attachment.url}`);

          const textContent = await res.text();
          processedAttachment.text = textContent;
          processedAttachment.title = processedAttachment.title || 'Text File';

          runtime.logger.debug(
            `[Bootstrap] Extracted text content (first 100 chars): ${processedAttachment.text?.substring(0, 100)}...`
          );
        } else {
          runtime.logger.warn(`[Bootstrap] Skipping non-plain-text document: ${contentType}`);
        }
      }

      processedAttachments.push(processedAttachment);
    } catch (error) {
      runtime.logger.error(
        { error, attachmentUrl: attachment.url },
        `[Bootstrap] Failed to process attachment ${attachment.url}:`
      );
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

// Hardcoded setup to simplify testing

const useMultiStep = true;

const loopingTemplate = `<task>
Determine the next action the assistant should take to help the customer achieve their goal.
</task>

{{recentMessages}}

# Role & Context
You are a customer service representative for an online retail company. You can execute actions (tools) to help customers with their requests.

# Critical Authentication & Authorization Rules
1. **Authentication Required**: ALWAYS verify customer identity BEFORE any action:
  - Check 'recentMessages' AND 'Previous Action Results' for authentication status
  - A user is authenticated ONLY if a successful 'FIND_USER_ID_BY_EMAIL' or 'FIND_USER_ID_BY_NAME_ZIP' was executed
  - If the user is NOT authenticated:
    - Return 'finish' and request EITHER:
      - Their **email address** (preferred method), OR
      - Their **first name + last name + zip code** (fallback method)
    - Do NOT attempt authentication actions unless the required input is present

2. **Post-Authentication**: When authentication is JUST completed:
   - Return 'finish' immediately after successful authentication
   - Let the final summary ask the customer how they want to proceed
   - Do NOT continue with other actions until customer responds

3. **CRITICAL - Authorization Required**: For ANY backend changes (address update, refund, cancellation, modification, etc.):
   - **NEVER execute write operations without explicit user confirmation**
   - Clearly explain EXACTLY what will be changed with ALL details
   - Request explicit confirmation ("yes") from customer
   - Only proceed after receiving clear "yes" confirmation
   - If user says anything other than "yes", do NOT proceed with the action

4. **User ID Requirement**:
  - If an action requires a 'user_id' (e.g. 'EXCHANGE_DELIVERED_ORDER_ITEMS'), you must include the correct 'user_id' in the action parameters
  - If an action returns "authentication required" or "user_id missing", and the 'user_id' is not known:
    - Attempt 'FIND_USER_ID_BY_EMAIL' (if email is present)
    - If email is not present, request email OR fallback to 'FIND_USER_ID_BY_NAME_ZIP' if name and zip are provided
  - This reasoning must be explicitly explained in your 'thought' field, including:
    - Whether 'user_id' is known
    - Which authentication method you will use to retrieve it (if needed)

# Action Execution Guidelines
1. **One Action at a Time**: Execute exactly one action per step. Never combine multiple actions.

2. **Action Selection**:
   - Only use actions from the **Available Actions** list below
   - Never repeat an action already executed (see **Previous Action Results**)
   - Never invent or hallucinate action names
   - Include action parameters in your thought process

3. **Decision Making**:
   - Analyze what information is missing or what needs to be done
   - Think step-by-step and justify your reasoning
   - Do not make up information not provided by the customer or actions

4. **Completion Criteria**:
   - Return 'finish' when:
     * Authentication was JUST successfully completed (needs customer's next request)
     * The customer's request is FULLY resolved
     * No further actions are required
     * All necessary confirmations have been received

{{actionsWithDescriptions}}

# Previous Action Results
These actions have already been executed. Do NOT repeat them:
{{actionResults}}

# Authentication Status Check
Look for these indicators in Previous Action Results:
- FIND_USER_ID_BY_EMAIL with success: true → User is authenticated
- FIND_USER_ID_BY_NAME_ZIP with success: true → User is authenticated
- Any action returning "authenticated: true" → User is authenticated

# Decision Process
Analyze the conversation and previous results, then choose ONE of:
1. **Execute Action**: If data is needed or an operation must be performed
   - For READ operations (getting info): Execute immediately
   - For WRITE operations (modify/cancel/update): Only execute if user has explicitly confirmed with "yes"
   - If write operation needs confirmation and user hasn't confirmed yet: Return 'finish' to ask for confirmation
2. **Finish**: If authentication just completed OR task is complete OR confirmation needed for write operations

<output>
<response>
  <thought>
    Explain your reasoning for the next step. Include:
    - Current authentication status
    - What the customer needs
    - Why this specific action helps (or why finishing)
    - What parameters you're using (if executing an action)
    Example: "Authentication just completed successfully. I should finish here and ask the customer how they want to proceed with their request."
  </thought>
  <nextStepType>action | finish</nextStepType>
  <actionName>(Required only if nextStepType is 'action')</actionName>
</response>
</output>`;

const finalSummaryTemplate = (lastThought?: string) => `
<task>
Summarize what the assistant has done so far and provide a final response to the user based on the completed steps.
</task>

# Context Information
{{bio}}

---

{{system}}

---

{{messageDirections}}

# Conversation Summary
Below is the user’s original request and conversation so far:
{{recentMessages}}

# Execution Trace
Here are the actions taken by the assistant to fulfill the request:
{{actionResults}}

# Assistant’s Last Reasoning Step
${lastThought || 'No final reasoning step was recorded.'}

# Authentication & Response Rules
1. **Authentication Check**: Review the execution trace for authentication status:
   - FIND_USER_ID_BY_EMAIL or FIND_USER_ID_BY_NAME_ZIP with success: true = Authenticated
   - If authentication JUST completed, acknowledge it and ask how to help
   - If authentication failed, explain the issue and ask for correct information
   - If not authenticated yet, request authentication credentials

2. **Post-Authentication Response**: When authentication was the ONLY action taken:
   - Thank the customer for verifying their identity
   - Reference their original request/concern from the conversation
   - Ask specifically how you can help them proceed
   - DO NOT assume next steps - wait for customer direction

3. **Task Completion**: When actions beyond authentication were completed:
   - Summarize what was done
   - Provide relevant results or information
   - Confirm any pending authorizations if needed

4. **CRITICAL - Backend Changes & Confirmation Protocol**: 
   - **NEVER make ANY write operations without explicit user confirmation**
   - For ANY action that modifies, cancels, updates, returns, exchanges, or changes data:
     * First clearly explain EXACTLY what will be changed
     * List ALL specific details (items, amounts, addresses, etc.)
     * Ask the user to explicitly confirm with "yes" 
     * DO NOT proceed until you receive clear confirmation
     * If user says anything other than "yes", do NOT proceed
   - Examples of actions requiring confirmation:
     * Canceling orders, modifying orders, returning items
     * Changing addresses, payment methods, user information
     * Any database write operation or state change
   - **This is mandatory for ALL consequential actions - no exceptions**

# Exchange Option Formatting Rules
When presenting exchange options from GET_PRODUCT_DETAILS results:
- ALWAYS include the item_id for each option
- Format each option with ALL details for clarity
- Example format:
  "Option 1 - Item ID: 1234567890
   • Color: Blue, Size: M
   • Price: $45.99
   • Available: Yes"
- Ask customer to confirm by specifying the item_id they want

# Instructions
1. Identify what phase we're in:
   - Just authenticated → Welcome and ask how to proceed
   - Mid-task → Provide results and next steps
   - Task complete → Wrap up with summary

2. Review the execution trace and last reasoning step carefully

3. Compose an appropriate response based on the phase:
   - Post-authentication: "Thank you for verifying your identity, [Name]. I see you mentioned [original concern]. How would you like me to help you with that?"
   - Task progress: Provide results and guide next steps
   - Completion: Summarize what was accomplished
   - Exchange options: Present all variants with item_ids and ask for confirmation
   - **BEFORE ANY WRITE OPERATION**: Clearly explain what will change and ask "Do you want me to proceed with this? Please confirm with 'yes'"

4. Your final output MUST be in this XML format:
<output>
<response>
  <thought>Your thought here</thought>
  <text>Your final message to the user</text>
</response>
</output>
`;

/**
 * Handles incoming messages and generates responses based on the provided runtime and message information.
 *
 * @param {MessageReceivedHandlerParams} params - The parameters needed for message handling, including runtime, message, and callback.
 * @returns {Promise<void>} - A promise that resolves once the message handling and response generation is complete.
 */
type StrategyMode = 'simple' | 'actions' | 'none';
type StrategyResult = {
  responseContent: Content | null;
  responseMessages: Memory[];
  state: any; // whatever composeState returns in your codebase
  mode: StrategyMode;
};

async function runSingleShotCore({ runtime, message, state }): Promise<StrategyResult> {
  // Single-shot unique logic (was inside handleSingleShotResponse -> shouldRespond branch)
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
  const maxRetries = 3;

  while (retries < maxRetries && (!responseContent?.thought || !responseContent?.actions)) {
    const response = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });

    runtime.logger.debug({ response }, '[Bootstrap] *** Raw LLM Response ***');

    const parsedXml = parseKeyValueXml(response);
    runtime.logger.debug({ parsedXml }, '[Bootstrap] *** Parsed XML Content ***');

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
        '[Bootstrap] *** Missing required fields (thought or actions), retrying... ***'
      );
    }
  }

  if (!responseContent) {
    return { responseContent: null, responseMessages: [], state, mode: 'none' };
  }

  // IGNORE/REPLY ambiguity handling
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

async function runMultiStepCore({ runtime, message, state, callback }): Promise<StrategyResult> {
  // Multi-step unique logic (was inside handleMultiStepResponse -> shouldRespond branch)
  const traceActionResult: any[] = [];
  let continueLoop = true;
  let accumulatedState: any = state;
  let finalThought;

  while (continueLoop) {
    accumulatedState = await runtime.composeState(message, ['RECENT_MESSAGES', 'ACTION_STATE']);
    accumulatedState.data.actionResults = traceActionResult;

    console.log('### accumulatedState.data.actionResults', accumulatedState.data.actionResults);

    const prompt = composePromptFromState({
      state: accumulatedState,
      template: loopingTemplate,
    });
    console.log('[@@@ MultiStep Prompt @@@]', prompt);

    const stepResultRaw = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });
    const parsedStep = parseKeyValueXml(stepResultRaw);
    console.log('### Iterative Step Decision', { parsedStep });

    if (!parsedStep || parsedStep.nextStepType === 'finish') {
      continueLoop = false;
      finalThought = parsedStep?.thought;
      break;
    }

    try {
      let executionResult: any;
      let success = true;

      if (parsedStep.nextStepType === 'action') {
        const actionContent = {
          actions: [parsedStep.actionName],
          text: '',
          thought: parsedStep.thought,
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
            await callback({
              text: `🔎 Executing action: ${parsedStep.actionName}`,
              thought: parsedStep.thought,
              stepType: parsedStep.nextStepType,
            });
            return [];
          }
        );

        const cachedState = runtime.stateCache.get(`${message.id}_action_results`);
        if (cachedState) {
          const actionResults = cachedState.values.actionResults;
          success = actionResults[0].success;
          executionResult = actionResults[0].text;
        }
      } else if (parsedStep.nextStepType === 'provider') {
        const provider = runtime.providers.find((p) => p.name === parsedStep.stepName);
        executionResult = await provider?.get(runtime, message, state);
      }

      traceActionResult.push({
        data: {
          actionName: parsedStep.actionName,
        },
        success,
        text: success ? executionResult : undefined,
        error: success ? undefined : executionResult,
      });
    } catch (err) {
      runtime.logger.error({ err }, '[MultiStep] Error executing step');
      traceActionResult.push({
        data: { actionName: parsedStep.actionName },
        success: 'failed',
        error: err,
      });
    }
  }

  const summaryTemplate = finalSummaryTemplate(finalThought);
  const summaryPrompt = composePromptFromState({
    state: accumulatedState,
    template: summaryTemplate,
  });

  const finalOutput = await runtime.useModel(ModelType.TEXT_LARGE, { prompt: summaryPrompt });
  const summary = parseKeyValueXml(finalOutput);

  let responseContent: Content | null = null;
  if (summary?.text) {
    responseContent = {
      actions: ['REPLY'],
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

// --- REFACTORED: Consolidated handler with all the shared scaffolding ---

const messageReceivedHandler = async ({
  runtime,
  message,
  callback,
  onComplete,
}: MessageReceivedHandlerParams): Promise<void> => {
  // Timeout setup (shared)
  const timeoutDuration = 60 * 60 * 1000; // 1 hour
  let timeoutId: NodeJS.Timeout | undefined = undefined;

  try {
    runtime.logger.info(
      `[Bootstrap] Message received from ${message.entityId} in room ${message.roomId}`
    );

    // --- responseId bookkeeping (shared) ---
    const responseId = v4();
    if (!latestResponseIds.has(runtime.agentId)) {
      latestResponseIds.set(runtime.agentId, new Map<string, string>());
    }
    const agentResponses = latestResponseIds.get(runtime.agentId);
    if (!agentResponses) throw new Error('Agent responses map not found');

    const previousResponseId = agentResponses.get(message.roomId);
    if (previousResponseId) {
      logger.warn(
        `[Bootstrap] Updating response ID for room ${message.roomId} from ${previousResponseId} to ${responseId} - this may discard in-progress responses`
      );
    }
    agentResponses.set(message.roomId, responseId);

    // --- Run tracking (shared) ---
    const runId = runtime.startRun();
    const startTime = Date.now();

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
          error: 'Run exceeded 60 minute timeout',
          source: 'messageHandler',
        });
        reject(new Error('Run exceeded 60 minute timeout'));
      }, timeoutDuration);
    });

    const processingPromise = (async () => {
      try {
        // --- shared: ignore self ---
        if (message.entityId === runtime.agentId) {
          runtime.logger.debug(`[Bootstrap] Skipping message from self (${runtime.agentId})`);
          throw new Error('Message is from the agent itself');
        }

        runtime.logger.debug(
          `[Bootstrap] Processing message: ${truncateToCompleteSentence(message.content.text || '', 50)}...`
        );

        // --- shared: persist message & embeddings ---
        runtime.logger.debug('[Bootstrap] Saving message to memory and embeddings');
        if (message.id) {
          const existingMemory = await runtime.getMemoryById(message.id);
          if (existingMemory) {
            runtime.logger.debug('[Bootstrap] Memory already exists, skipping creation');
            await runtime.addEmbeddingToMemory(message);
          } else {
            await Promise.all([
              runtime.addEmbeddingToMemory(message),
              runtime.createMemory(message, 'messages'),
            ]);
          }
        } else {
          await Promise.all([
            runtime.addEmbeddingToMemory(message),
            runtime.createMemory(message, 'messages'),
          ]);
        }

        // --- shared: default LLM off check ---
        const agentUserState = await runtime.getParticipantUserState(
          message.roomId,
          runtime.agentId
        );
        const defLllmOff = parseBooleanFromText(runtime.getSetting('BOOTSTRAP_DEFLLMOFF'));
        if (defLllmOff && agentUserState === null) {
          runtime.logger.debug('bootstrap - LLM is off by default');
          await runtime.emitEvent(EventType.RUN_ENDED, {
            runtime,
            runId,
            messageId: message.id,
            roomId: message.roomId,
            entityId: message.entityId,
            startTime,
            status: 'off',
            endTime: Date.now(),
            duration: Date.now() - startTime,
            source: 'messageHandler',
          });
          return;
        }

        // --- shared: muted check ---
        if (
          agentUserState === 'MUTED' &&
          !message.content.text?.toLowerCase().includes(runtime.character.name.toLowerCase())
        ) {
          runtime.logger.debug(`[Bootstrap] Ignoring muted room ${message.roomId}`);
          await runtime.emitEvent(EventType.RUN_ENDED, {
            runtime,
            runId,
            messageId: message.id,
            roomId: message.roomId,
            entityId: message.entityId,
            startTime,
            status: 'muted',
            endTime: Date.now(),
            duration: Date.now() - startTime,
            source: 'messageHandler',
          });
          return;
        }

        // --- shared: initial state & shouldRespond gate ---
        let state = await runtime.composeState(
          message,
          ['ANXIETY', 'SHOULD_RESPOND', 'ENTITIES', 'CHARACTER', 'RECENT_MESSAGES', 'ACTIONS'],
          true
        );

        const room = await runtime.getRoom(message.roomId);
        const shouldSkipShouldRespond = shouldBypassShouldRespond(
          runtime,
          room ?? undefined,
          message.content.source
        );

        // attachments
        if (message.content.attachments && message.content.attachments.length > 0) {
          message.content.attachments = await processAttachments(
            message.content.attachments,
            runtime
          );
          if (message.id) {
            await runtime.updateMemory({ id: message.id, content: message.content });
          }
        }

        let shouldRespond = true;
        if (!shouldSkipShouldRespond) {
          const shouldRespondPrompt = composePromptFromState({
            state,
            template: runtime.character.templates?.shouldRespondTemplate || shouldRespondTemplate,
          });

          runtime.logger.debug(
            `[Bootstrap] Evaluating response for ${runtime.character.name}\nPrompt: ${shouldRespondPrompt}`
          );

          const response = await runtime.useModel(ModelType.TEXT_SMALL, {
            prompt: shouldRespondPrompt,
          });
          runtime.logger.debug(
            `[Bootstrap] Response evaluation for ${runtime.character.name}:\n${response}`
          );

          const responseObject = parseKeyValueXml(response);
          runtime.logger.debug({ responseObject }, '[Bootstrap] Parsed response:');

          const nonResponseActions = ['IGNORE', 'NONE'];
          shouldRespond =
            responseObject?.action &&
            !nonResponseActions.includes(responseObject.action.toUpperCase());
        } else {
          runtime.logger.debug(
            `[Bootstrap] Skipping shouldRespond check for ${runtime.character.name} because ${room?.type} ${room?.source}`
          );
          shouldRespond = true;
        }

        // --- shared: strategy dispatch & centralized completion ---
        let responseContent: Content | null = null;
        let responseMessages: Memory[] = [];

        if (shouldRespond) {
          const result = useMultiStep
            ? await runMultiStepCore({ runtime, message, state, callback })
            : await runSingleShotCore({ runtime, message, state });

          responseContent = result.responseContent;
          responseMessages = result.responseMessages;
          state = result.state;

          // Race check before we send anything
          const currentResponseId = agentResponses.get(message.roomId);
          if (currentResponseId !== responseId) {
            runtime.logger.info(
              `Response discarded - newer message being processed for agent: ${runtime.agentId}, room: ${message.roomId}`
            );
            return;
          }

          if (responseContent && message.id) {
            responseContent.inReplyTo = createUniqueUuid(runtime, message.id);
          }

          // If providers were used, refresh state with those providers (shared)
          if (responseContent?.providers?.length && responseContent.providers.length > 0) {
            state = await runtime.composeState(message, responseContent.providers || []);
          }

          // Send response based on mode (shared)
          if (responseContent) {
            const mode = useMultiStep ? 'simple' : (result.mode ?? ('actions' as StrategyMode));

            if (mode === 'simple') {
              if (responseContent.providers && responseContent.providers.length > 0) {
                runtime.logger.debug(
                  { providers: responseContent.providers },
                  '[Bootstrap] Simple response used providers'
                );
              }
              await callback(responseContent);
            } else if (mode === 'actions') {
              await runtime.processActions(message, responseMessages, state, async (content) => {
                runtime.logger.debug({ content }, 'action callback');
                responseContent!.actionCallbacks = content;
                return callback(content);
              });
            }
          }
        } else {
          // IGNORE branch (shared)
          const currentResponseId = agentResponses.get(message.roomId);
          const keepResp = parseBooleanFromText(runtime.getSetting('BOOTSTRAP_KEEP_RESP'));
          if (currentResponseId !== responseId && !keepResp) {
            runtime.logger.info(
              `Ignore response discarded - newer message being processed for agent: ${runtime.agentId}, room: ${message.roomId}`
            );
            await runtime.emitEvent(EventType.RUN_ENDED, {
              runtime,
              runId,
              messageId: message.id,
              roomId: message.roomId,
              entityId: message.entityId,
              startTime,
              status: 'replaced',
              endTime: Date.now(),
              duration: Date.now() - startTime,
              source: 'messageHandler',
            });
            return;
          }

          if (!message.id) {
            runtime.logger.error(
              '[Bootstrap] Message ID is missing, cannot create ignore response.'
            );
            await runtime.emitEvent(EventType.RUN_ENDED, {
              runtime,
              runId,
              messageId: message.id,
              roomId: message.roomId,
              entityId: message.entityId,
              startTime,
              status: 'noMessageId',
              endTime: Date.now(),
              duration: Date.now() - startTime,
              source: 'messageHandler',
            });
            return;
          }

          const ignoreContent: Content = {
            thought: 'Agent decided not to respond to this message.',
            actions: ['IGNORE'],
            simple: true,
            inReplyTo: createUniqueUuid(runtime, message.id),
          };

          await callback(ignoreContent);

          const ignoreMemory: Memory = {
            id: asUUID(v4()),
            entityId: runtime.agentId,
            agentId: runtime.agentId,
            content: ignoreContent,
            roomId: message.roomId,
            createdAt: Date.now(),
          };
          await runtime.createMemory(ignoreMemory, 'messages');
          runtime.logger.debug('[Bootstrap] Saved ignore response to memory', {
            memoryId: ignoreMemory.id,
          });
        }

        // Cleanup the response ID (shared)
        agentResponses.delete(message.roomId);
        if (agentResponses.size === 0) {
          latestResponseIds.delete(runtime.agentId);
        }

        // Evaluation (shared)
        await runtime.evaluate(
          message,
          state,
          shouldRespond,
          async (content) => {
            runtime.logger.debug({ content }, 'evaluate callback');
            if (responseContent) {
              responseContent.evalCallbacks = content;
            }
            return callback(content);
          },
          responseMessages
        );

        // --- shared: final RUN_ENDED + metadata ---
        let entityName = 'noname';
        if (message.metadata && 'entityName' in message.metadata) {
          entityName = (message.metadata as any).entityName;
        }

        const isDM = message.content?.channelType?.toUpperCase() === 'DM';
        let roomName = entityName;
        if (!isDM) {
          const roomDatas = await runtime.getRoomsByIds([message.roomId]);
          if (roomDatas?.length) {
            const roomData = roomDatas[0];
            if (roomData.name) roomName = roomData.name;
            if (roomData.worldId) {
              const worldData = await runtime.getWorld(roomData.worldId);
              if (worldData) roomName = worldData.name + '-' + roomName;
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
      } catch (error: any) {
        console.error('error is', error);
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
      runtime.logger.warn('[Bootstrap] Duplicate reaction memory, skipping');
      return;
    }
    runtime.logger.error({ error }, '[Bootstrap] Error in reaction handler:');
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
      runtime.logger.error('[Bootstrap] Cannot delete memory: message ID is missing');
      return;
    }

    runtime.logger.info(
      '[Bootstrap] Deleting memory for message',
      message.id,
      'from room',
      message.roomId
    );
    await runtime.deleteMemory(message.id);
    runtime.logger.debug(
      { messageId: message.id },
      '[Bootstrap] Successfully deleted memory for message'
    );
  } catch (error: unknown) {
    runtime.logger.error({ error }, '[Bootstrap] Error in message deleted handler:');
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
    runtime.logger.info(
      `[Bootstrap] Clearing ${memoryCount} message memories from channel ${channelId} -> room ${roomId}`
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
          runtime.logger.warn(
            { error, memoryId: memory.id },
            `[Bootstrap] Failed to delete message memory ${memory.id}:`
          );
        }
      }
    }

    runtime.logger.info(
      `[Bootstrap] Successfully cleared ${deletedCount}/${memories.length} message memories from channel ${channelId}`
    );
  } catch (error: unknown) {
    runtime.logger.error({ error }, '[Bootstrap] Error in channel cleared handler:');
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
  runtime.logger.info('[Bootstrap] Generating new post...');
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
      runtime.logger.warn(
        '[Bootstrap] *** Missing required fields, retrying... ***\n',
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
    runtime.logger.error(
      '[Bootstrap] Failed to parse XML response for post creation. Raw response:',
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
  // 		runtime.logger.error("Error fetching media for tweet:", error);
  // 	}
  // }

  // have we posted it before?
  const RM = state.providerData?.find((pd) => pd.providerName === 'RECENT_MESSAGES');
  if (RM) {
    for (const m of RM.data.recentMessages) {
      if (cleanedText === m.content.text) {
        runtime.logger.info({ cleanedText }, '[Bootstrap] Already recently posted that, retrying');
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
    runtime.logger.info({ cleanedText }, '[Bootstrap] Got prompt moderation refusal, retrying');
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
    runtime.logger.info(`[Bootstrap] Syncing user: ${entity?.metadata?.username || entityId}`);

    // Ensure we're not using WORLD type and that we have a valid channelId
    if (!channelId) {
      runtime.logger.warn(`[Bootstrap] Cannot sync user ${entity?.id} without a valid channelId`);
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

    runtime.logger.info(
      `[Bootstrap] syncSingleUser - type: ${type}, isDM: ${type === ChannelType.DM}, worldMetadata: ${JSON.stringify(worldMetadata)}`
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
      runtime.logger.info(
        `[Bootstrap] Created world check - ID: ${worldId}, metadata: ${JSON.stringify(createdWorld?.metadata)}`
      );
    } catch (error) {
      runtime.logger.error(`[Bootstrap] Failed to verify created world: ${error}`);
    }

    runtime.logger.success(`[Bootstrap] Successfully synced user: ${entity?.id}`);
  } catch (error) {
    runtime.logger.error(
      `[Bootstrap] Error syncing user: ${error instanceof Error ? error.message : String(error)}`
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
  runtime.logger.debug(`[Bootstrap] Handling server sync event for server: ${world.name}`);
  try {
    await runtime.ensureConnections(entities, rooms, source, world);
    runtime.logger.debug(`Successfully synced standardized world structure for ${world.name}`);
    onComplete?.();
  } catch (error) {
    runtime.logger.error(
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
    runtime.logger.debug(
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

        runtime.logger.debug(
          `[controlMessageHandler] Control message ${message.payload.action} sent successfully`
        );
      } else {
        runtime.logger.error(
          '[controlMessageHandler] WebSocket service does not have sendMessage method'
        );
      }
    } else {
      runtime.logger.error(
        '[controlMessageHandler] No WebSocket service found to send control message'
      );
    }
  } catch (error) {
    runtime.logger.error(`[controlMessageHandler] Error processing control message: ${error}`);
  }
};

const events = {
  [EventType.MESSAGE_RECEIVED]: [
    async (payload: MessagePayload) => {
      if (!payload.callback) {
        payload.runtime.logger.error('No callback provided for message');
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
        payload.runtime.logger.error('No callback provided for voice message');
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
      payload.runtime.logger.debug(`[Bootstrap] Message sent: ${payload.message.content.text}`);
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
      payload.runtime.logger.debug(
        `[Bootstrap] ENTITY_JOINED event received for entity ${payload.entityId}`
      );

      if (!payload.worldId) {
        payload.runtime.logger.error('[Bootstrap] No worldId provided for entity joined');
        return;
      }
      if (!payload.roomId) {
        payload.runtime.logger.error('[Bootstrap] No roomId provided for entity joined');
        return;
      }
      if (!payload.metadata?.type) {
        payload.runtime.logger.error('[Bootstrap] No type provided for entity joined');
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
        payload.runtime.logger.info(
          `[Bootstrap] User ${payload.entityId} left world ${payload.worldId}`
        );
      } catch (error: any) {
        payload.runtime.logger.error(`[Bootstrap] Error handling user left: ${error.message}`);
      }
    },
  ],

  [EventType.ACTION_STARTED]: [
    async (payload: ActionEventPayload) => {
      logger.debug(`[Bootstrap] Action started: ${payload.actionName} (${payload.actionId})`);
    },
  ],

  [EventType.ACTION_COMPLETED]: [
    async (payload: ActionEventPayload) => {
      const status = payload.error ? `failed: ${payload.error.message}` : 'completed';
      logger.debug(`[Bootstrap] Action ${status}: ${payload.actionName} (${payload.actionId})`);
    },
  ],

  [EventType.EVALUATOR_STARTED]: [
    async (payload: EvaluatorEventPayload) => {
      logger.debug(
        `[Bootstrap] Evaluator started: ${payload.evaluatorName} (${payload.evaluatorId})`
      );
    },
  ],

  [EventType.EVALUATOR_COMPLETED]: [
    async (payload: EvaluatorEventPayload) => {
      const status = payload.error ? `failed: ${payload.error.message}` : 'completed';
      logger.debug(
        `[Bootstrap] Evaluator ${status}: ${payload.evaluatorName} (${payload.evaluatorId})`
      );
    },
  ],

  CONTROL_MESSAGE: [controlMessageHandler],
};

export const bootstrapPlugin: Plugin = {
  name: 'bootstrap',
  description: 'Agent bootstrap with basic actions and evaluators',
  actions: [
    // actions.replyAction,
    // actions.followRoomAction,
    // actions.unfollowRoomAction,
    // actions.ignoreAction,
    // actions.noneAction,
    // actions.muteRoomAction,
    // actions.unmuteRoomAction,
    // actions.sendMessageAction,
    // actions.updateEntityAction,
    // actions.choiceAction,
    // actions.updateRoleAction,
    // actions.updateSettingsAction,
    // actions.generateImageAction,
  ],
  // this is jank, these events are not valid
  events: events as any as PluginEvents,
  // evaluators: [evaluators.reflectionEvaluator],
  providers: [
    // providers.evaluatorsProvider,
    providers.anxietyProvider,
    // providers.timeProvider,
    // providers.entitiesProvider,
    // providers.relationshipsProvider,
    // providers.choiceProvider,
    // providers.factsProvider,
    // providers.roleProvider,
    // providers.settingsProvider,
    // providers.capabilitiesProvider,
    // providers.attachmentsProvider,
    providers.providersProvider,
    providers.actionsProvider,
    providers.actionStateProvider,
    providers.characterProvider,
    providers.recentMessagesProvider,
    // providers.worldProvider,
  ],
  services: [TaskService],
};

export default bootstrapPlugin;
