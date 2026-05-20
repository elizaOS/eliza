/**
 * Agent Chat Service
 *
 * Provides coordinator-dispatch execution of agent chat.
 * Used by the DISPATCH_TO_AGENT action so the coordinator can
 * invoke a child agent on the user's behalf without going through
 * the HTTP layer.
 *
 * Design notes:
 * - broadcastChatMessage is injected as broadcastFn to avoid importing
 *   @babylon/api from packages/agents (architectural separation)
 * - Only handles team-chat mode (coordinator dispatch always targets a team chat)
 * - Always uses ModelType.TEXT_SMALL (free tier = 0 pts cost)
 * - Max 4 iterations (vs 5 in the coordinator) to stay within latency budget
 *
 * Efficiency optimizations (refactor/coordinator-efficiency):
 * - composeState() called only on first iteration; subsequent iterations
 *   reuse the state object (providers return identical data within a request)
 * - Summary phase reuses last decision state instead of re-composing
 * - Parse retries use format reinforcement hints + lower temperature (0.3)
 * - All dispatches instrumented with action-type and timing telemetry
 */

import { db, eq, messages, userAgentConfigs } from '@babylon/db';
import type { MessageMetadata, MessageTag } from '@babylon/shared';
import { checkUserInput, logger } from '@babylon/shared';
import {
  composePromptFromState,
  type Memory,
  ModelType,
  parseKeyValueXml,
  type State,
} from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import { getEventBus } from '../communication/EventBus';
import { AuthorizationError } from '../errors';
import { generateSnowflakeId } from '../shared/snowflake';
import { agentService } from './AgentService';
import { notifyTeamChatMessage } from './team-chat-notifications';

// =============================================================================
// Types
// =============================================================================

/** Minimal broadcast function signature matching broadcastChatMessage from @babylon/api */
export type BroadcastFn = (
  chatId: string,
  message: {
    id: string;
    content: string;
    chatId: string;
    senderId: string;
    type?: string;
    createdAt: string;
    metadata?: MessageMetadata | null;
  }
) => Promise<void>;

export interface CoordinatorDispatchParams {
  agentId: string;
  ownerId: string;
  /** The command/instruction to send to the agent */
  message: string;
  teamChatId: string;
  ownerName?: string;
  ownerUsername?: string;
  /** Injected from route layer — avoids importing @babylon/api in packages/agents */
  broadcastFn: BroadcastFn;
}

export interface CoordinatorDispatchResult {
  success: boolean;
  response: string;
  agentId: string;
  agentUsername?: string;
  actionsExecuted: number;
  isLLMFailure: boolean;
  /** Set on ownership / not-found failures */
  error?: string;
}

// =============================================================================
// Decision + Summary Templates
// =============================================================================

const dispatchDecisionTemplate = `{{agentContext}}

---

# Your Character
{{system}}

{{#if personality}}
## Personality
{{personality}}
{{/if}}

{{#if tradingStrategy}}
## Trading Strategy
{{tradingStrategy}}
{{/if}}

---

# Your Identity in This Chat
You are **{{agentName}}** (@{{agentUsername}}) — an AI agent in the Agents team chat.
The chat is owned by **{{ownerName}}**. The coordinator has routed this instruction to you on their behalf.
**Your response will be posted as your message in the team chat, visible to the owner.**
Write in your own voice as if speaking directly to the team.

---

# Conversation History
{{recentMessages}}

---

# Instruction from {{ownerName}} (via Coordinator)
{{currentMessage}}

---

# Execution Context
Step {{iterationCount}} of {{maxIterations}} | Actions this round: {{actionCount}}

---

{{actionsWithParams}}

---

# Actions Completed This Round
{{#if actionCount}}
{{actionResults}}
**Use this data. Do NOT repeat these actions.**
{{else}}
No actions taken yet.
{{/if}}

---

# Decision Guide
- **Need to execute something?** → Use the appropriate action from the list above
- **Request complete?** → Set isFinish: true and leave action as ""
- **NEVER repeat the same action with same parameters**
- **Trades execute ONCE** — don't repeat buy/sell
- **You are an agent, not the coordinator** — do NOT dispatch to other agents

<keys>
"thought" Your reasoning: what was asked? what have you done? what's next?
"action" Action name or "" if done
"parameters" JSON params or {}
"isFinish" true when request is satisfied
</keys>

YOUR FINAL OUTPUT MUST BE IN THIS XML FORMAT:
<output>
<response>
  <thought>Step {{iterationCount}}/{{maxIterations}}. Actions this round: {{actionCount}}. [Your reasoning]</thought>
  <action>ACTION_NAME or ""</action>
  <parameters>
    {
      "param1": "value1"
    }
  </parameters>
  <isFinish>true | false</isFinish>
</response>
</output>`;

const dispatchSummaryTemplate = `# Your Character
{{system}}

{{#if personality}}
## Personality
{{personality}}
{{/if}}

{{#if tradingStrategy}}
## Trading Strategy
{{tradingStrategy}}
{{/if}}

---

# Your Identity in This Chat
You are **{{agentName}}** (@{{agentUsername}}) in the Agents team chat owned by **{{ownerName}}**.
You were dispatched by the coordinator to handle: "{{currentMessage}}"

**IMPORTANT: The text you write below IS your team chat message.**
It will be posted under your name (@{{agentUsername}}) and seen by {{ownerName}}.
Write in first person, in character, as if speaking directly to the team.
Do NOT address "the coordinator" or refer to yourself in third person.

---

# Actions You Completed
{{actionResults}}

---

# Your Task
Craft your team chat message **in character** — your tone, voice, and wording must match your Character and Personality.

- Speak directly as yourself, to {{ownerName}} and the team
- Report what you did and the concrete results (numbers, names, statuses)
- Be vivid and on-brand — this is your message, not a status report to the coordinator
- Be concise

Output ONLY this XML:

<response>
<thought>Brief reasoning: what I did, key data to include, how to phrase it in my voice</thought>
<text>Your team chat message in character — direct, specific, and in your own voice</text>
</response>`;

/** Format hint appended to the prompt on parse retries. */
const DECISION_XML_FORMAT_HINT =
  '\n\nYour previous response could not be parsed. Output ONLY this exact XML structure with no text outside the tags:\n<response>\n  <thought>reasoning</thought>\n  <action>ACTION_NAME or ""</action>\n  <parameters>{}</parameters>\n  <isFinish>true or false</isFinish>\n</response>';

const SUMMARY_XML_FORMAT_HINT =
  '\n\nYour previous response could not be parsed. Output ONLY this exact XML structure with no text outside the tags:\n<response>\n  <thought>reasoning</thought>\n  <text>Your response</text>\n</response>';

type ActionTraceResult = {
  actionType: string;
  success: boolean;
  text: string;
  error?: string;
  values?: Record<string, unknown>;
  parameters?: Record<string, unknown>;
  timestamp: number;
  durationMs?: number;
  tag?: MessageTag;
};

function formatTraceResults(results: ActionTraceResult[]): string {
  if (results.length === 0) return 'No actions taken yet in this request.';

  return results
    .map((result, index) => {
      const status = result.success ? '✓ Success' : '✗ Failed';
      let output = `${index + 1}. **${result.actionType}** - ${status}`;

      if (result.text) {
        output += `\n   Summary: ${result.text}`;
      }

      if (result.error) {
        output += `\n   Error: ${result.error}`;
      }

      if (result.values && Object.keys(result.values).length > 0) {
        const valuesStr = Object.entries(result.values)
          .map(([key, value]) => `   - ${key}: ${JSON.stringify(value)}`)
          .join('\n');
        output += `\n   Values:\n${valuesStr}`;
      }

      return output;
    })
    .join('\n\n');
}

// =============================================================================
// Core Dispatch Function
// =============================================================================

/**
 * Execute an agent chat session on behalf of the coordinator.
 *
 * Called by the DISPATCH_TO_AGENT action handler in plugin-user-core.
 * Runs the full multi-step LLM loop for the target agent and writes
 * the response to the shared team chat (same teamChatId as the coordinator).
 */
export async function dispatchAgentChat(
  params: CoordinatorDispatchParams
): Promise<CoordinatorDispatchResult> {
  const dispatchStartMs = Date.now();

  const {
    agentId,
    ownerId,
    message,
    teamChatId,
    ownerName = 'User',
    ownerUsername,
    broadcastFn,
  } = params;

  // --- Input validation (defense-in-depth: command is LLM-generated from user input) ---
  const inputCheck = checkUserInput(message);
  if (!inputCheck.safe) {
    logger.warn(
      '[AgentChatService] Unsafe command blocked before dispatch',
      { agentId, reason: inputCheck.reason },
      'AgentChatService'
    );
    return {
      success: false,
      response: '',
      agentId,
      actionsExecuted: 0,
      isLLMFailure: false,
      error: inputCheck.reason ?? 'Invalid command content',
    };
  }

  // --- Ownership verification (with fuzzy name fallback) ---
  let agentWithConfig;
  let resolvedAgentId = agentId;
  try {
    agentWithConfig = await agentService.getAgentWithConfig(agentId, ownerId);

    // Fallback: if not found by ID, try resolving by username or displayName.
    // The LLM often passes a username, display name, or partial name instead of
    // the UUID. We try progressively fuzzier matching to maximize resolution:
    //   1. Exact match on username or displayName (case-insensitive)
    //   2. Normalized match (strip spaces, punctuation)
    //   3. Partial match (needle contained in name or vice versa)
    //   4. Single-agent fallback (if only 1 agent, use it regardless of name)
    if (!agentWithConfig) {
      const ownerAgents = await agentService.listUserAgents(ownerId);
      const needle = agentId.toLowerCase().trim();
      const normalizeAgentName = (value: string | null | undefined): string =>
        value?.toLowerCase().replace(/[\s\-_.]+/g, '') ?? '';
      const needleNormalized = normalizeAgentName(needle);
      const isGenericSingleAgentReference = new Set([
        'agent',
        'agents',
        'myagent',
        'myagents',
        'theagent',
      ]).has(needleNormalized);

      // 1. Exact match on username or displayName
      let match = ownerAgents.find(
        (a) =>
          a.username?.toLowerCase() === needle ||
          a.displayName?.toLowerCase() === needle
      );

      // 2. Normalized match (strip spaces/punctuation for "larry david" vs "larrydavid")
      if (!match) {
        match = ownerAgents.find((a) => {
          const uNorm = normalizeAgentName(a.username);
          const dNorm = normalizeAgentName(a.displayName);
          return uNorm === needleNormalized || dNorm === needleNormalized;
        });
      }

      // 3. Partial match (needle contained in name or name contained in needle).
      // Only accept unambiguous matches to avoid dispatching to the wrong agent.
      if (!match) {
        const partialMatches = ownerAgents.filter((a) => {
          const uLower = a.username?.toLowerCase() ?? '';
          const dLower = a.displayName?.toLowerCase() ?? '';
          return (
            (uLower && (uLower.includes(needle) || needle.includes(uLower))) ||
            (dLower && (dLower.includes(needle) || needle.includes(dLower)))
          );
        });
        if (partialMatches.length === 1) {
          match = partialMatches[0];
        } else if (partialMatches.length > 1) {
          logger.warn(
            '[AgentChatService] Agent resolution failed — ambiguous partial match',
            {
              input: agentId,
              partialMatches: partialMatches.map(
                (a) => a.displayName ?? a.username ?? a.id
              ),
            },
            'AgentChatService'
          );
        }
      }

      // 4. Single-agent fallback only for generic references like "my agent".
      if (!match && ownerAgents.length === 1 && isGenericSingleAgentReference) {
        match = ownerAgents[0];
        logger.info(
          '[AgentChatService] Single-agent fallback used',
          {
            input: agentId,
            resolvedId: match!.id,
            resolvedName: match!.displayName ?? match!.username,
          },
          'AgentChatService'
        );
      }

      if (match) {
        resolvedAgentId = match.id;
        agentWithConfig = await agentService.getAgentWithConfig(
          resolvedAgentId,
          ownerId
        );
        logger.info(
          '[AgentChatService] Resolved agent by name fallback',
          {
            input: agentId,
            resolvedId: resolvedAgentId,
            resolvedName: match.displayName ?? match.username,
          },
          'AgentChatService'
        );
      } else {
        // Log available agents for debugging failed resolution
        const available = ownerAgents.map(
          (a) => `${a.displayName ?? a.username ?? 'unnamed'} (${a.id})`
        );
        logger.warn(
          '[AgentChatService] Agent resolution failed — no match found',
          { input: agentId, availableAgents: available },
          'AgentChatService'
        );
      }
    }
  } catch (err) {
    const errorMsg =
      err instanceof AuthorizationError
        ? 'You do not have permission to access this agent.'
        : err instanceof Error
          ? err.message
          : 'Unknown authorization error';
    logger.warn(
      '[AgentChatService] Ownership check failed',
      { agentId: resolvedAgentId, ownerId, error: errorMsg },
      'AgentChatService'
    );
    return {
      success: false,
      response: '',
      agentId: resolvedAgentId,
      actionsExecuted: 0,
      isLLMFailure: false,
      error: errorMsg,
    };
  }

  if (!agentWithConfig) {
    // List available agents in the error so the coordinator can retry with correct ID
    let availableHint = '';
    try {
      const ownerAgents = await agentService.listUserAgents(ownerId);
      if (ownerAgents.length > 0) {
        const names = ownerAgents
          .map((a) => `@${a.username ?? a.displayName ?? a.id}`)
          .join(', ');
        availableHint = `. Available agents: ${names}`;
      }
    } catch {
      // Best-effort — don't let hint lookup mask the real error
    }
    return {
      success: false,
      response: '',
      agentId: resolvedAgentId,
      actionsExecuted: 0,
      isLLMFailure: false,
      error: `Agent "${agentId}" not found${availableHint}`,
    };
  }

  const agentConfig = agentWithConfig.agentConfig;
  const agentUsername = agentWithConfig.username ?? undefined;
  const agentName =
    agentWithConfig.displayName ?? agentWithConfig.username ?? 'Agent';

  // Always free tier for coordinator-dispatched calls
  const modelType = ModelType.TEXT_SMALL;

  // --- Get agent runtime ---
  // Dynamic import breaks the circular dep: AgentRuntimeManager → plugin-user-core → dispatch-to-agent → AgentChatService
  const { agentRuntimeManager } = await import(
    '../runtime/AgentRuntimeManager'
  );
  const runtime = await agentRuntimeManager.getRuntime(resolvedAgentId);

  const elizaMessage: Memory = {
    id: uuidv4() as `${string}-${string}-${string}-${string}-${string}`,
    entityId: ownerId as `${string}-${string}-${string}-${string}-${string}`,
    roomId:
      resolvedAgentId as `${string}-${string}-${string}-${string}-${string}`,
    content: { text: message },
    createdAt: Date.now(),
  };

  // --- Multi-step execution loop (max 2 iterations) ---
  // Reduced from 4: dispatched agents almost always finish in 1 iteration
  // (single action + finish). 2nd iteration covers edge cases like retries.
  // coordinator ≈ 3s + dispatch ≈ 4s (2 iters × 2s) + summary ≈ 2s = ~9s
  const MAX_ITERATIONS = 2;
  const traceActionResults: ActionTraceResult[] = [];
  let finalResponse: string | null = null;
  let isLLMFailure = false;
  let totalParseRetries = 0;
  let iterationsRan = 0;

  // State reuse: compose once on first iteration, reuse on subsequent.
  // Agent providers (AGENT_CONTEXT, RECENT_MESSAGES, TEAM_MEMBERS) return
  // identical data within a single dispatch. ACTION_STATE reads from the
  // local traceActionResults we update manually.
  let lastState: State | null = null;

  const agentProviders = [
    'AGENT_CONTEXT',
    'RECENT_MESSAGES',
    'ACTION_STATE',
    'ACTIONS',
    'TEAM_MEMBERS',
  ];

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    iterationsRan = iteration;

    logger.info(
      `[AgentChatService] Iteration ${iteration}/${MAX_ITERATIONS}`,
      { agentId: resolvedAgentId, actionsCompleted: traceActionResults.length },
      'AgentChatService'
    );

    let state: State;

    if (iteration === 1) {
      // First iteration: full composeState (2 DB queries — TEAM_MEMBERS, RECENT_MESSAGES)
      state = await runtime.composeState(elizaMessage, agentProviders, true);
    } else {
      // Subsequent iterations: reuse state, skip redundant DB queries
      state = lastState!;
    }

    state.values = {
      ...state.values,
      agentId: resolvedAgentId,
      system: agentConfig?.systemPrompt ?? 'You are a helpful AI assistant.',
      personality: agentConfig?.personality ?? '',
      tradingStrategy: agentConfig?.tradingStrategy ?? '',
      currentMessage: message,
      iterationCount: iteration,
      maxIterations: MAX_ITERATIONS,
      actionCount: traceActionResults.length,
      ownerId,
      ownerName,
      ownerUsername,
      isTeamChatMode: true,
      teamChatId,
      teamChatOwnerName: ownerName,
      teamChatOwnerUsername: ownerUsername,
      agentName,
      agentUsername: agentUsername ?? '',
    };

    state.data = {
      ...state.data,
      // Cast: Babylon ActionTraceResult is a superset of elizaos ActionResult
      actionResults:
        traceActionResults as unknown as typeof state.data.actionResults,
    };
    state.values = {
      ...state.values,
      actionResults: formatTraceResults(traceActionResults),
      hasActionResults: traceActionResults.length > 0,
    };

    lastState = state;

    const prompt = composePromptFromState({
      state,
      template: dispatchDecisionTemplate,
    });

    const MAX_PARSE_RETRIES = 3;
    let parsedStep: Record<string, unknown> | null = null;

    for (let attempt = 1; attempt <= MAX_PARSE_RETRIES; attempt++) {
      const response = await runtime.useModel(modelType, {
        prompt: attempt > 1 ? prompt + DECISION_XML_FORMAT_HINT : prompt,
        temperature: attempt > 1 ? 0.3 : 0.7,
      });

      parsedStep = parseKeyValueXml(response);

      if (parsedStep) break;

      totalParseRetries++;
      logger.warn(
        `[AgentChatService] Failed to parse decision (attempt ${attempt})`,
        { preview: response.substring(0, 200) },
        'AgentChatService'
      );
    }

    if (!parsedStep) {
      finalResponse =
        "I'm having trouble processing this request. Please try again.";
      isLLMFailure = true;
      break;
    }

    const action = ((parsedStep.action as string) ?? '').trim();
    const parameters = parsedStep.parameters;
    const isFinish = parsedStep.isFinish;

    if (!action || action === '') {
      break;
    }

    // Parse action parameters
    const actionStartMs = Date.now();
    let actionParams: Record<string, unknown> = {};
    if (parameters) {
      if (typeof parameters === 'string') {
        try {
          const parsed: unknown = JSON.parse(parameters);
          if (
            typeof parsed === 'object' &&
            parsed !== null &&
            !Array.isArray(parsed)
          ) {
            actionParams = parsed as Record<string, unknown>;
          }
        } catch {
          logger.warn(
            `[AgentChatService] Failed to parse action params: ${parameters}`
          );
        }
      } else if (typeof parameters === 'object' && !Array.isArray(parameters)) {
        actionParams = parameters as Record<string, unknown>;
      }
    }

    state.data = {
      ...state.data,
      actionParams,
    };

    // Persist actionParams to stateCache so processActions' internal
    // composeState() preserves them (it re-composes from cache, discarding
    // any local state.data modifications).
    const stateCache = (
      runtime as unknown as {
        stateCache?: Map<
          string,
          {
            values?: Record<string, unknown>;
            data?: Record<string, unknown>;
            text?: string;
          }
        >;
      }
    ).stateCache;
    if (stateCache && elizaMessage.id) {
      const cached = stateCache.get(elizaMessage.id);
      if (cached) {
        cached.data = { ...cached.data, actionParams };
      }
    }

    const actionContent = {
      text: `Executing action: ${action}`,
      actions: [action],
    };

    const actionMessage: Memory = {
      id: uuidv4() as `${string}-${string}-${string}-${string}-${string}`,
      entityId: runtime.agentId,
      roomId: elizaMessage.roomId,
      createdAt: Date.now(),
      content: actionContent,
    };

    try {
      let actionResult: {
        success?: boolean;
        text?: string;
        values?: Record<string, unknown>;
        tag?: MessageTag;
      } | null = null;

      await runtime.processActions(
        elizaMessage,
        [actionMessage],
        state,
        async (results: unknown) => {
          const resultsArray = results as Array<{
            content?: {
              success?: boolean;
              text?: string;
              values?: Record<string, unknown>;
              tag?: MessageTag;
            };
          }> | null;
          if (resultsArray && resultsArray.length > 0) {
            const firstResult = resultsArray[0];
            if (firstResult) {
              actionResult = {
                success: firstResult.content?.success ?? false,
                text:
                  typeof firstResult.content?.text === 'string'
                    ? firstResult.content.text
                    : undefined,
                values: firstResult.content?.values,
                tag: firstResult.content?.tag,
              };
            }
          }
          return [];
        }
      );

      // Fallback: check stateCache if callback didn't fire
      if (!actionResult) {
        const cachedState = (
          runtime as unknown as { stateCache?: Map<string, unknown> }
        ).stateCache?.get(`${elizaMessage.id}_action_results`) as
          | {
              values?: {
                actionResults?: Array<{
                  success?: boolean;
                  text?: string;
                  values?: Record<string, unknown>;
                }>;
              };
            }
          | undefined;
        const cached = cachedState?.values?.actionResults || [];
        actionResult = cached.length > 0 ? (cached[0] ?? null) : null;
      }

      const success = actionResult?.success ?? false;

      traceActionResults.push({
        actionType: action,
        success,
        text: actionResult?.text || `${action} executed`,
        error: success ? undefined : actionResult?.text,
        values: actionResult?.values,
        parameters: actionParams,
        timestamp: Date.now(),
        durationMs: Date.now() - actionStartMs,
        tag: actionResult?.tag,
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      traceActionResults.push({
        actionType: action,
        success: false,
        text: `Action failed: ${errorMsg}`,
        error: errorMsg,
        parameters: actionParams,
        timestamp: Date.now(),
        durationMs: Date.now() - actionStartMs,
      });
    }

    if (isFinish === 'true' || isFinish === true) {
      break;
    }
  }

  // Log decision loop completion with telemetry (Phase 0 instrumentation)
  logger.info(
    '[AgentChatService] Decision loop completed',
    {
      agentId: resolvedAgentId,
      iterations: iterationsRan,
      actionsExecuted: traceActionResults.length,
      actionTypes: traceActionResults.map((r) => r.actionType),
      isLLMFailure,
      totalParseRetries,
      decisionLoopMs: Date.now() - dispatchStartMs,
    },
    'AgentChatService'
  );

  // --- Generate summary response ---
  // Reuse the last decision state instead of calling composeState() again.
  // This saves 2 DB queries (TEAM_MEMBERS, RECENT_MESSAGES) per dispatch.
  if (!finalResponse) {
    const summaryState =
      lastState ??
      (await runtime.composeState(elizaMessage, agentProviders, true));

    summaryState.values = {
      ...summaryState.values,
      agentId: resolvedAgentId,
      system: agentConfig?.systemPrompt ?? 'You are a helpful AI assistant.',
      personality: agentConfig?.personality ?? '',
      tradingStrategy: agentConfig?.tradingStrategy ?? '',
      currentMessage: message,
      ownerId,
      ownerName,
      ownerUsername,
      isTeamChatMode: true,
      teamChatId,
      teamChatOwnerName: ownerName,
      teamChatOwnerUsername: ownerUsername,
      agentName,
      agentUsername: agentUsername ?? '',
      actionCount: traceActionResults.length,
      actionResults: formatTraceResults(traceActionResults),
      hasActionResults: traceActionResults.length > 0,
    };
    summaryState.data = {
      ...summaryState.data,
      // Cast: Babylon ActionTraceResult is a superset of elizaos ActionResult
      actionResults:
        traceActionResults as unknown as typeof summaryState.data.actionResults,
    };

    const summaryPrompt = composePromptFromState({
      state: summaryState,
      template: dispatchSummaryTemplate,
    });

    const SUMMARY_RETRIES = 3;
    let extractedText: string | undefined;

    for (let attempt = 1; attempt <= SUMMARY_RETRIES; attempt++) {
      const summaryResponse = await runtime.useModel(modelType, {
        prompt:
          attempt > 1 ? summaryPrompt + SUMMARY_XML_FORMAT_HINT : summaryPrompt,
        temperature: attempt > 1 ? 0.3 : 0.7,
      });

      const summary = parseKeyValueXml(summaryResponse);
      extractedText = summary?.text as string | undefined;

      if (!extractedText) {
        const textMatch = summaryResponse.match(
          /<text\b[^>]*?>([\s\S]*?)<\/text>/i
        );
        if (textMatch?.[1]) {
          extractedText = textMatch[1].trim();
        }
      }

      if (extractedText) break;

      totalParseRetries++;
      logger.warn(
        `[AgentChatService] Failed to parse summary (attempt ${attempt})`,
        { preview: summaryResponse.substring(0, 200) },
        'AgentChatService'
      );
    }

    finalResponse =
      extractedText ||
      (traceActionResults.length > 0
        ? 'Task completed.'
        : "I'm ready to help!");
  }

  const responseText = finalResponse ?? "I'm here to help!";

  // --- Collect rich tags for metadata ---
  const tags: MessageTag[] = traceActionResults
    .filter((r) => r.success && r.tag)
    .map((r) => r.tag as MessageTag);
  const messageMetadata: MessageMetadata | null =
    tags.length > 0 ? { tags } : null;

  // --- Write agent response to team chat messages table ---
  const responseMessageId = await generateSnowflakeId();
  const responseTime = new Date();

  await db.insert(messages).values({
    id: responseMessageId,
    chatId: teamChatId,
    senderId: resolvedAgentId,
    content: responseText,
    createdAt: responseTime,
    metadata: messageMetadata,
  });

  void notifyTeamChatMessage({
    chatId: teamChatId,
    messageId: responseMessageId,
    senderId: resolvedAgentId,
    messagePreview: responseText,
  });

  // Update agent's lastChatAt
  await db
    .update(userAgentConfigs)
    .set({ lastChatAt: new Date(), updatedAt: new Date() })
    .where(eq(userAgentConfigs.userId, resolvedAgentId));

  // --- Broadcast so SSE clients see the agent response immediately ---
  broadcastFn(teamChatId, {
    id: responseMessageId,
    content: responseText,
    chatId: teamChatId,
    senderId: resolvedAgentId,
    type: 'user',
    createdAt: responseTime.toISOString(),
    metadata: messageMetadata,
  }).catch((err) => {
    logger.warn(
      `[AgentChatService] Failed to broadcast agent message`,
      { teamChatId, agentId: resolvedAgentId, error: err },
      'AgentChatService'
    );
  });

  // Full dispatch telemetry (Phase 0 instrumentation)
  const totalDurationMs = Date.now() - dispatchStartMs;
  logger.info(
    '[AgentChatService] Dispatch completed',
    {
      agentId: resolvedAgentId,
      iterations: iterationsRan,
      actionsExecuted: traceActionResults.length,
      actionTypes: traceActionResults.map((r) => r.actionType),
      isLLMFailure,
      totalParseRetries,
      totalDurationMs,
    },
    'AgentChatService'
  );

  // Publish dispatch result to EventBus for inter-agent awareness.
  // Other agents or services can subscribe to 'agent.dispatch.result' events
  // to build contextual awareness of what's happening across the team.
  const eventBus = getEventBus();
  eventBus.publish(
    'agent.dispatch.result',
    {
      agentId: resolvedAgentId,
      agentUsername: agentUsername ?? null,
      command: params.message,
      response: responseText.slice(0, 500),
      actionsExecuted: traceActionResults.length,
      success: true,
      timestamp: new Date().toISOString(),
    },
    resolvedAgentId
  );

  return {
    success: true,
    response: responseText,
    agentId: resolvedAgentId,
    agentUsername,
    actionsExecuted: traceActionResults.length,
    isLLMFailure,
  };
}
