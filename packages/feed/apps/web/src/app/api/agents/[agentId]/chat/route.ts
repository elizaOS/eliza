/**
 * Agent Chat Interaction API
 *
 * @route POST /api/agents/[agentId]/chat - Send message to agent
 * @route GET /api/agents/[agentId]/chat - Get chat history
 * @access Authenticated (owner only)
 *
 * @description
 * Real-time chat interface with autonomous agents using multi-step execution.
 * Uses runtime.composeState() for providers and runtime.processActions() for execution.
 */

import {
  type ActionResult,
  composePromptFromState,
  type Memory,
  ModelType,
  parseKeyValueXml,
  type State,
} from "@elizaos/core";
import {
  agentRuntimeManager,
  agentService,
  notifyTeamChatMessage,
  teamChatService,
} from "@feed/agents";
import {
  authenticateUser,
  broadcastChatMessage,
  checkProgress,
  withErrorHandling,
} from "@feed/api";
import { db, eq, messages, userAgentConfigs, users } from "@feed/db";
import {
  checkUserInput,
  GROQ_MODELS,
  generateSnowflakeId,
  logger,
  type MessageMetadata,
  type MessageTag,
  toISO,
} from "@feed/shared";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { cleanupRuntimeStateCache } from "@/lib/agents/runtime-state-cache";
import { MODEL_TIER_POINTS_COST } from "@/lib/constants";
import { trackServerEvent } from "@/lib/posthog/server";

// =============================================================================
// Multi-Step Decision Template
// =============================================================================

const multiStepDecisionTemplate = `{{agentContext}}

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

{{#if isTeamChatMode}}
# Team Chat Context
You are **{{agentName}}** (@{{agentUsername}}) in team chat owned by **{{teamChatOwnerName}}**.
Other agents may respond too. Focus on YOUR contribution.

## Team Members
{{teamMembers}}
{{else}}
# Your Owner
You were created by **{{ownerName}}**{{#if ownerUsername}} (@{{ownerUsername}}){{/if}}. You are chatting with them.
{{/if}}

---

# Conversation History
{{recentMessages}}

---

# Current Message from {{ownerName}}
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
- **Need data?** → Use an action
- **Request complete?** → Set isFinish: true
- **Conversational?** → No action, isFinish: true
- **NEVER repeat the same action with same parameters**
- **Trades execute ONCE** - don't repeat buy/sell

<keys>
"thought" Your reasoning: what did user ask? what have you done? what's next?
"action" Action name or "" if done
"parameters" JSON params or {}
"isFinish" true when request is satisfied
</keys>

CRITICAL CHECKS:
- What step am I on? ({{iterationCount}}/{{maxIterations}})
- How many actions have I taken THIS round? ({{actionCount}})
- What TYPE of request is this? (Specific/Multi-part/Conversational)
- If > 0 actions: Have I adequately addressed the request?
- Am I about to execute the EXACT SAME action with EXACT SAME parameters? If YES → STOP

# IMPORTANT
YOUR FINAL OUTPUT MUST BE IN THIS XML FORMAT:
<output>
<response>
  <thought>Step {{iterationCount}}/{{maxIterations}}. Actions this round: {{actionCount}}. [Your reasoning]</thought>
  <action>ACTION_NAME or ""</action>
  <parameters>
    {
      "param1": "value1",
      "param2": "value2"
    }
  </parameters>
  <isFinish>true | false</isFinish>
</response>
</output>`;

const multiStepSummaryTemplate = `# Your Character
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

{{#if isTeamChatMode}}
# Team Chat Context
You are **{{agentName}}** (@{{agentUsername}}) in the **Agents** team chat owned by **{{teamChatOwnerName}}**{{#if teamChatOwnerUsername}} (@{{teamChatOwnerUsername}}){{/if}}.
Other agents may also be responding. Focus on YOUR findings and contribution.

## Team Members
{{teamMembers}}
{{else}}
# Your Creator/Owner
You were created by **{{ownerName}}**{{#if ownerUsername}} (@{{ownerUsername}}){{/if}}. You are chatting with them now.
{{/if}}

---

# Conversation History
{{recentMessages}}

---

{{actionsWithDescriptions}}

---

# Current Message from {{ownerName}}
{{currentMessage}}

---

# Actions You Completed
{{actionResults}}

---

# Your Task
Reply to the user **in character**: your tone, voice, and wording must match the Character and Personality above. Do not sound generic, polite, or like a default assistant—sound like THIS agent.

Then, in that same character voice:
- Summarize what you did and the results (if any actions were taken)
- Include specific numbers, names, or data from the action results when relevant
- Reference the conversation when it fits

Output ONLY this XML with your actual response (not examples or placeholders):

<response>
<thought>Brief reasoning: what to say and how to say it in character</thought>
<text>Your reply in character, with any relevant details from the actions</text>
</response>`;

// =============================================================================
// POST Handler
// =============================================================================

export const POST = withErrorHandling(
  async (
    req: NextRequest,
    { params }: { params: Promise<{ agentId: string }> },
  ) => {
    const { agentId } = await params;
    logger.info("Agent chat endpoint hit", { agentId }, "AgentChat");

    const body = (await req.json()) as {
      message: string;
      usePro?: boolean;
      /** Optional team chat ID - if provided, agent response goes to the shared team chat */
      teamChatId?: string;
      /** Owner display name for team chat context */
      teamChatOwnerName?: string;
      /** Owner username for team chat context */
      teamChatOwnerUsername?: string;
    };
    const message = body.message;
    const usePro = body.usePro ?? false;
    const teamChatId = body.teamChatId;
    const teamChatOwnerName = body.teamChatOwnerName;
    const teamChatOwnerUsername = body.teamChatOwnerUsername;
    const isTeamChatMode = !!teamChatId;

    // Get abort signal from request for cancellation support
    const { signal } = req;

    // Helper to check if request was cancelled
    const checkCancelled = () => {
      if (signal.aborted) {
        logger.info("Request cancelled by client", { agentId }, "AgentChat");
        return true;
      }
      return false;
    };

    // Validate input
    const inputCheck = checkUserInput(message);
    if (!inputCheck.safe) {
      logger.warn(
        "Unsafe user input blocked",
        { agentId, reason: inputCheck.reason, category: inputCheck.category },
        "AgentChat",
      );
      return NextResponse.json(
        { success: false, error: inputCheck.reason || "Invalid input" },
        { status: 400 },
      );
    }

    const user = await authenticateUser(req);

    // Validate team chat ownership (security check)
    // Prevents users from writing to other users' team chats
    if (teamChatId) {
      const isValidTeamChat = await teamChatService.validateTeamChatOwnership(
        user.id,
        teamChatId,
      );
      if (!isValidTeamChat) {
        logger.warn(
          "Invalid team chat ID - user does not own this chat",
          { userId: user.id, teamChatId, agentId },
          "AgentChat",
        );
        return NextResponse.json(
          { success: false, error: "Invalid team chat" },
          { status: 403 },
        );
      }
    }

    // Verify ownership
    const agentWithConfig = await agentService.getAgentWithConfig(
      agentId,
      user.id,
    );
    if (!agentWithConfig) {
      return NextResponse.json(
        { success: false, error: "Agent not found" },
        { status: 404 },
      );
    }
    const agentConfig = agentWithConfig.agentConfig;

    const pointsCost = usePro
      ? MODEL_TIER_POINTS_COST.pro
      : MODEL_TIER_POINTS_COST.free;
    const modelType = usePro ? ModelType.TEXT_LARGE : ModelType.TEXT_SMALL;
    const modelUsed = usePro
      ? GROQ_MODELS.PRO.displayName
      : GROQ_MODELS.FREE.displayName;

    // Check balance BEFORE processing (to return clear error upfront)
    // Points will be deducted AFTER successful response generation
    let newBalance = Number(agentWithConfig.virtualBalance ?? 0);
    if (pointsCost > 0 && newBalance < pointsCost) {
      return NextResponse.json(
        {
          success: false,
          error: `Insufficient balance. Have: ${newBalance.toFixed(2)}, Need: ${pointsCost.toFixed(2)}`,
        },
        { status: 402 },
      );
    }

    // Get runtime
    const runtime = await agentRuntimeManager.getRuntime(agentId);

    // Fetch owner info for personalized conversation
    const [ownerProfile] = await db
      .select({ displayName: users.displayName, username: users.username })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);
    const ownerName =
      ownerProfile?.displayName || ownerProfile?.username || "User";
    const ownerUsername = ownerProfile?.username || undefined;

    // Create message object for ElizaOS
    const elizaMessage: Memory = {
      id: uuidv4() as `${string}-${string}-${string}-${string}-${string}`,
      entityId: user.id as `${string}-${string}-${string}-${string}-${string}`,
      roomId: agentId as `${string}-${string}-${string}-${string}-${string}`,
      content: { text: message },
      createdAt: Date.now(),
    };

    try {
      // Multi-step execution
      const MAX_ITERATIONS = 6;
      // Store action results with metadata for tracking
      const traceActionResults: Array<
        ActionResult & {
          actionType: string;
          parameters?: Record<string, unknown>;
          timestamp: number;
          tag?: MessageTag;
        }
      > = [];
      let finalResponse: string | null = null;
      // Track if response is due to LLM failure (don't charge points)
      let isLLMFailure = false;

      for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
        // Check if client cancelled the request
        if (checkCancelled()) {
          return NextResponse.json(
            { success: false, cancelled: true, error: "Request cancelled" },
            { status: 499 }, // Client Closed Request
          );
        }

        logger.info(
          `[MultiStep] Iteration ${iteration}/${MAX_ITERATIONS}`,
          { agentId, actionsCompleted: traceActionResults.length },
          "AgentChat",
        );

        // Compose state with providers
        // Use strict filtering (3rd param = true) to ONLY run the specified providers
        // This prevents all Feed A2A providers from running unnecessarily
        // Include TEAM_MEMBERS provider when in team chat mode
        const providers = isTeamChatMode
          ? [
              "AGENT_CONTEXT",
              "RECENT_MESSAGES",
              "ACTION_STATE",
              "ACTIONS",
              "TEAM_MEMBERS",
            ]
          : ["AGENT_CONTEXT", "RECENT_MESSAGES", "ACTION_STATE", "ACTIONS"];
        const state: State = await runtime.composeState(
          elizaMessage,
          providers,
          true,
        );

        // Add custom values to state
        state.values = {
          ...state.values,
          agentId, // Pass agentId for actions that need it
          system:
            agentConfig?.systemPrompt ?? "You are a helpful AI assistant.",
          personality: agentConfig?.personality ?? "",
          tradingStrategy: agentConfig?.tradingStrategy ?? "",
          currentMessage: message,
          iterationCount: iteration,
          maxIterations: MAX_ITERATIONS,
          actionCount: traceActionResults.length,
          // Owner info for personalized conversation
          ownerId: user.id, // For RECENT_MESSAGES provider to filter team chat messages
          ownerName,
          ownerUsername,
          // Team chat context
          isTeamChatMode,
          teamChatId,
          teamChatOwnerName: teamChatOwnerName || ownerName,
          teamChatOwnerUsername: teamChatOwnerUsername || ownerUsername,
          agentName: agentWithConfig.displayName || "Agent",
          agentUsername: agentWithConfig.username || "",
        };

        // Add action results to state data
        state.data = {
          ...state.data,
          actionResults: traceActionResults,
        };

        // Build prompt from template
        const prompt = composePromptFromState({
          state,
          template: multiStepDecisionTemplate,
        });

        // Get LLM decision with retry
        const MAX_PARSE_RETRIES = 3;
        let parsedStep: Record<string, unknown> | null = null;

        for (let attempt = 1; attempt <= MAX_PARSE_RETRIES; attempt++) {
          const response = await runtime.useModel(modelType, {
            prompt,
            temperature: attempt > 1 ? 0.5 : 0.7,
          });

          // Check cancellation after LLM call
          if (checkCancelled()) {
            return NextResponse.json(
              { success: false, cancelled: true, error: "Request cancelled" },
              { status: 499 },
            );
          }

          parsedStep = parseKeyValueXml(response);

          if (parsedStep) {
            logger.debug(
              `[MultiStep] Parsed decision on attempt ${attempt}`,
              { action: parsedStep.action, isFinish: parsedStep.isFinish },
              "AgentChat",
            );
            break;
          }

          logger.warn(
            `[MultiStep] Failed to parse decision (attempt ${attempt})`,
            { preview: response.substring(0, 200) },
            "AgentChat",
          );
        }

        if (!parsedStep) {
          finalResponse =
            "I'm having trouble processing your request. Could you try rephrasing?";
          isLLMFailure = true; // Don't charge points for LLM parse failures
          break;
        }

        const thought = (parsedStep.thought as string) ?? "";
        const action = (parsedStep.action as string) ?? "";
        const parameters = parsedStep.parameters;
        const isFinish = parsedStep.isFinish;

        // No action - go to summary phase
        if (!action || action === "") {
          break;
        }

        // Check cancellation before action execution
        if (checkCancelled()) {
          return NextResponse.json(
            { success: false, cancelled: true, error: "Request cancelled" },
            { status: 499 },
          );
        }

        // Execute action via runtime.processActions
        logger.info(
          `[MultiStep] Executing action: ${action}`,
          { parameters },
          "AgentChat",
        );

        // Parse parameters
        let actionParams = {};
        if (parameters) {
          if (typeof parameters === "string") {
            try {
              actionParams = JSON.parse(parameters);
            } catch {
              logger.warn(
                `[MultiStep] Failed to parse parameters: ${parameters}`,
              );
            }
          } else if (typeof parameters === "object") {
            actionParams = parameters;
          }
        }

        // Store params in state for action handler
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

        // Build action content for processActions
        const actionContent = {
          text: `Executing action: ${action}`,
          actions: [action],
          thought: thought ?? "",
        };

        const actionMessage: Memory = {
          id: uuidv4() as `${string}-${string}-${string}-${string}-${string}`,
          entityId: runtime.agentId,
          roomId: elizaMessage.roomId,
          createdAt: Date.now(),
          content: actionContent,
        };

        try {
          // Use runtime.processActions - adapter.createMemory is now stubbed
          // Capture result through callback
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
              // Capture the first result from callback
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
                      typeof firstResult.content?.text === "string"
                        ? firstResult.content.text
                        : undefined,
                    values: firstResult.content?.values,
                    tag: firstResult.content?.tag,
                  };
                }
              }
              return [];
            },
          );

          // Fallback to state cache if callback didn't capture
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
            const actionResultsFromCache =
              cachedState?.values?.actionResults || [];
            actionResult =
              actionResultsFromCache.length > 0
                ? (actionResultsFromCache[0] ?? null)
                : null;
          }

          const success = actionResult?.success ?? false;

          traceActionResults.push({
            actionType: action,
            success,
            text: actionResult?.text || `${action} executed`,
            error: success ? undefined : actionResult?.text,
            values: actionResult?.values as ActionResult["values"],
            parameters: actionParams,
            timestamp: Date.now(),
            tag: actionResult?.tag,
          });
        } catch (error) {
          const errorMsg =
            error instanceof Error ? error.message : "Unknown error";
          traceActionResults.push({
            actionType: action,
            success: false,
            text: `Action failed: ${errorMsg}`,
            error: errorMsg,
            parameters: actionParams,
            timestamp: Date.now(),
          });
        }

        // Check if done - always go to summary phase for proper response
        if (isFinish === "true" || isFinish === true) {
          break;
        }
      }

      // Generate summary/response - always run to get proper user-facing message
      {
        // Include TEAM_MEMBERS provider when in team chat mode
        const summaryProviders = isTeamChatMode
          ? ["AGENT_CONTEXT", "RECENT_MESSAGES", "ACTION_STATE", "TEAM_MEMBERS"]
          : ["AGENT_CONTEXT", "RECENT_MESSAGES", "ACTION_STATE"];
        const state = await runtime.composeState(
          elizaMessage,
          summaryProviders,
          true,
        );
        state.values = {
          ...state.values,
          agentId, // Pass agentId for actions that need it
          system:
            agentConfig?.systemPrompt ?? "You are a helpful AI assistant.",
          personality: agentConfig?.personality ?? "",
          tradingStrategy: agentConfig?.tradingStrategy ?? "",
          currentMessage: message,
          // Owner info for personalized conversation
          ownerId: user.id, // For RECENT_MESSAGES provider to filter team chat messages
          ownerName,
          ownerUsername,
          // Team chat context
          isTeamChatMode,
          teamChatId,
          teamChatOwnerName: teamChatOwnerName || ownerName,
          teamChatOwnerUsername: teamChatOwnerUsername || ownerUsername,
          agentName: agentWithConfig.displayName || "Agent",
          agentUsername: agentWithConfig.username || "",
        };
        state.data = {
          ...state.data,
          actionResults: traceActionResults,
        };

        // Check cancellation before summary generation
        if (checkCancelled()) {
          return NextResponse.json(
            { success: false, cancelled: true, error: "Request cancelled" },
            { status: 499 },
          );
        }

        const summaryPrompt = composePromptFromState({
          state,
          template: multiStepSummaryTemplate,
        });

        // Get summary with retry
        const SUMMARY_RETRIES = 3;
        let extractedText: string | undefined;

        for (let attempt = 1; attempt <= SUMMARY_RETRIES; attempt++) {
          const summaryResponse = await runtime.useModel(modelType, {
            prompt: summaryPrompt,
            temperature: attempt > 1 ? 0.5 : 0.7,
          });

          const summary = parseKeyValueXml(summaryResponse);
          extractedText = summary?.text as string | undefined;

          // Fallback: Try regex if parseKeyValueXml fails
          if (!extractedText) {
            const textMatch = summaryResponse.match(/<?\/?text>([^<]+)/i);
            if (textMatch?.[1]) {
              extractedText = textMatch[1].trim();
            }
          }

          if (extractedText) {
            logger.debug(
              `[MultiStep] Parsed summary on attempt ${attempt}`,
              { preview: extractedText.substring(0, 50) },
              "AgentChat",
            );
            break;
          }

          logger.warn(
            `[MultiStep] Failed to parse summary (attempt ${attempt})`,
            { preview: summaryResponse.substring(0, 200) },
            "AgentChat",
          );
        }

        finalResponse =
          extractedText ||
          (traceActionResults.length > 0
            ? "Actions completed."
            : "I'm here to help!");
      }

      // Ensure finalResponse is never null
      const responseText = finalResponse ?? "I'm here to help!";

      // Calculate actual points cost early - skip charging for LLM failures
      // This needs to happen before DB writes so stored pointsCost is accurate
      const actualPointsCost = isLLMFailure ? 0 : pointsCost;

      const userMessageTime = new Date();
      const assistantMessageTime = new Date(userMessageTime.getTime() + 1);
      let responseMessageId: string;

      // Collect tags from successful action results
      const tags: MessageTag[] = traceActionResults
        .filter((r) => r.success && r.tag)
        .map((r) => r.tag as MessageTag);

      // Build metadata if we have tags
      const messageMetadata: MessageMetadata | null =
        tags.length > 0 ? { tags } : null;

      if (isTeamChatMode && teamChatId) {
        // Team chat mode: Write only to messages table (not agentMessages)
        // User message is written by frontend (once) before calling multiple agents
        responseMessageId = await generateSnowflakeId();

        // Write agent response to team chat
        await db.insert(messages).values({
          id: responseMessageId,
          chatId: teamChatId,
          senderId: agentId,
          content: responseText,
          createdAt: assistantMessageTime,
          metadata: messageMetadata,
        });

        void notifyTeamChatMessage({
          chatId: teamChatId,
          messageId: responseMessageId,
          senderId: agentId,
          messagePreview: responseText,
        });

        // Broadcast agent response to team chat
        broadcastChatMessage(teamChatId, {
          id: responseMessageId,
          content: responseText,
          chatId: teamChatId,
          senderId: agentId,
          type: "user",
          createdAt: assistantMessageTime.toISOString(),
          metadata: messageMetadata,
        }).catch((err) => {
          logger.warn(
            `Failed to broadcast agent message to team chat: ${err}`,
            { teamChatId, agentId },
            "AgentChat",
          );
        });

        logger.info(
          `Agent response written to team chat ${teamChatId}`,
          { agentMessageId: responseMessageId, agentId },
          "AgentChat",
        );
      } else {
        // Legacy DM mode: Write to agentMessages table
        const userMessageId = uuidv4();
        responseMessageId = uuidv4();

        await db.agentMessage.createMany({
          data: [
            {
              id: userMessageId,
              agentUserId: agentId,
              role: "user",
              content: message,
              pointsCost: 0,
              metadata: {},
              createdAt: userMessageTime,
            },
            {
              id: responseMessageId,
              agentUserId: agentId,
              role: "assistant",
              content: responseText,
              modelUsed,
              pointsCost: actualPointsCost, // Use actual cost (0 for LLM failures)
              createdAt: assistantMessageTime,
              metadata: {
                multiStep: true,
                actionsExecuted: traceActionResults.length,
                actions: traceActionResults.map((a) => ({
                  type: a.actionType,
                  success: a.success,
                })),
                isLLMFailure, // Track if this was a fallback response
                // Note: tags are not included in legacy DM mode as it uses a different schema
              },
            },
          ],
        });
      }

      // Update lastChatAt
      await db
        .update(userAgentConfigs)
        .set({ lastChatAt: new Date(), updatedAt: new Date() })
        .where(eq(userAgentConfigs.userId, agentId));

      await db.agentLog.create({
        data: {
          id: uuidv4(),
          agentUserId: agentId,
          type: "chat",
          level: isLLMFailure ? "warn" : "info",
          message: isLLMFailure
            ? "Chat interaction completed with LLM failure"
            : "Chat interaction completed",
          prompt: message,
          completion: responseText,
          metadata: {
            usePro,
            pointsCost: actualPointsCost,
            modelUsed,
            multiStep: true,
            actionsExecuted: traceActionResults.length,
            isLLMFailure,
          },
        },
      });

      // Deduct points ONLY after successful response generation and DB save
      // This ensures users don't lose points on failed/cancelled requests
      if (actualPointsCost > 0) {
        try {
          newBalance = await agentService.deductPoints(
            agentId,
            actualPointsCost,
            `Chat message (${usePro ? "pro" : "free"} mode)`,
            undefined,
          );
        } catch (err) {
          // Log but don't fail - response already saved, points can be reconciled
          logger.error(
            "Failed to deduct points after successful response",
            { agentId, pointsCost: actualPointsCost, error: err },
            "AgentChat",
          );
          // Keep original balance in response (will be slightly incorrect but safe)
        }
      }

      logger.info(
        `Chat completed for agent ${agentId}`,
        { actionsExecuted: traceActionResults.length },
        "AgentsAPI",
      );

      trackServerEvent(user.id, "agent_message_sent", {
        agent_id: agentId,
        message_id: responseMessageId,
        use_pro: usePro,
        points_cost: actualPointsCost,
        model_used: modelUsed,
      }).catch((err) => {
        logger.warn(
          "Failed to track agent_message_sent",
          { error: err },
          "AgentChat",
        );
      });

      void checkProgress(user.userId, { type: "agent_message_sent" });

      return NextResponse.json({
        success: true,
        messageId: responseMessageId,
        response: responseText,
        pointsCost: actualPointsCost,
        modelUsed,
        balanceAfter: newBalance,
        isLLMFailure, // Let frontend know if this was a fallback response
        metadata: messageMetadata, // Include tags in response for immediate UI update
        multiStep: {
          actionsExecuted: traceActionResults.length,
          actions: traceActionResults.map((a) => ({
            type: a.actionType,
            success: a.success,
            text: a.text,
          })),
        },
      });
    } finally {
      cleanupRuntimeStateCache(runtime, elizaMessage.id);
    }
  },
);

// =============================================================================
// GET Handler
// =============================================================================

export const GET = withErrorHandling(
  async (
    req: NextRequest,
    { params }: { params: Promise<{ agentId: string }> },
  ) => {
    const user = await authenticateUser(req);
    const { agentId } = await params;

    const agent = await agentService.getAgent(agentId, user.id);
    if (!agent) {
      return NextResponse.json(
        { success: false, error: "Agent not found" },
        { status: 404 },
      );
    }

    const { searchParams } = new URL(req.url);
    const limit = Number.parseInt(searchParams.get("limit") || "50", 10);
    const cursor = searchParams.get("cursor") || undefined;

    const { messages, hasMore, nextCursor } = await agentService.getChatHistory(
      agentId,
      limit,
      cursor,
    );

    return NextResponse.json({
      success: true,
      messages: messages.map((msg) => ({
        id: msg.id,
        role: msg.role,
        content: msg.content,
        modelUsed: msg.modelUsed,
        pointsCost: msg.pointsCost,
        createdAt: toISO(msg.createdAt),
      })),
      pagination: {
        hasMore,
        nextCursor,
      },
    });
  },
);
