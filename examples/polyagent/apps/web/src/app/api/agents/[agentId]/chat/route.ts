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
import { agentRuntimeManager, agentService } from "@polyagent/agents";
import { authenticateUser, withErrorHandling } from "@polyagent/api";
import { db, eq, userAgentConfigs } from "@polyagent/db";
import { checkUserInput, GROQ_MODELS, logger } from "@polyagent/shared";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { MODEL_TIER_POINTS_COST } from "@/lib/constants";

// =============================================================================
// Multi-Step Decision Template
// =============================================================================

const multiStepDecisionTemplate = `<task>
Determine the next step to take in this conversation.
</task>

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

# Conversation History
{{recentMessages}}

---

# Current User Message
{{currentMessage}}

---

# Execution Context
Step {{iterationCount}} of {{maxIterations}}
Actions taken this round: {{actionCount}}
{{#if actionCount}}
You have ALREADY taken {{actionCount}} action(s) in this round. Review them carefully before deciding.
{{else}}
This is your FIRST decision step - no actions have been taken yet.
{{/if}}

---

{{actionsWithParams}}

---

# Actions Completed This Round
{{#if actionCount}}
{{actionResults}}
**IMPORTANT**: Use IDs/data from these results for follow-up actions. Do NOT repeat these actions.
{{else}}
No actions taken yet.
{{/if}}

---

# REDUNDANCY RULES (CRITICAL)
**AVOID REDUNDANCY** - These are DUPLICATES, DO NOT repeat:
- ❌ Executing the SAME action with the SAME parameters you just executed
- ❌ Buying/selling the same asset multiple times unless explicitly asked
- ❌ Checking the same data twice in a row

**ENCOURAGE COMPLEMENTARITY** - These ADD VALUE:
- ✅ Different actions that provide different information
- ✅ Sequential steps (check balance → then trade)
- ✅ Using results from one action as input to another

**Decision Logic**:
- After executing an action, ask: "Did this COMPLETE the user's request?"
- If YES → Set isFinish: true immediately
- If NO and user asked for multiple things → Continue to next action
- If about to repeat same action → STOP, set isFinish: true

---

# Request Type Classification
1. **SPECIFIC REQUEST** (e.g., "sell 100 shares", "check my balance", "enable auto-trading"):
   - Execute the ONE action needed
   - Set isFinish: true IMMEDIATELY after
   
2. **MULTI-PART REQUEST** (e.g., "check predictions AND buy the best one"):
   - Execute each distinct action in sequence
   - Set isFinish: true only when ALL parts are complete

3. **CONVERSATIONAL** (e.g., "hello", "thanks", questions without actions):
   - Set action to "" and isFinish: true

---

# Decision Rules
1. **Classify the request type FIRST** - Is it Specific, Multi-part, or Conversational?
2. **Check what you've already done** - Review Actions Completed This Round
3. **Before ANY action, ask**: "Have I already done THIS EXACT action?" If YES → STOP
4. **For trades (buy/sell)**: Execute ONCE, then STOP. Do not repeat.
5. **Use results from prior actions** - IDs, data from completed actions inform next parameters
6. **When in doubt** → Set isFinish: true (better to under-execute than over-execute)

<keys>
"thought"
  START WITH: "Step {{iterationCount}}/{{maxIterations}}. Actions this round: {{actionCount}}."
  THEN: Quote the user's request.
  THEN: Classify request type (Specific/Multi-part/Conversational).
  THEN: If actions > 0, state "I have already completed: [list actions]. Checking if request is satisfied."
  THEN: Explain your decision:
    - If finishing: "The request is fulfilled. Setting isFinish: true."
    - If continuing: "Next action: [action name] because [reason]."
"action" Name of the action to execute (empty string "" if setting isFinish: true or if no action needed)
"parameters" JSON object with exact parameter names. Empty object {} if action has no parameters.
"isFinish" Set to true when the user's request is satisfied (see Decision Rules)
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

const multiStepSummaryTemplate = `You are responding to a user after completing actions. Generate a helpful response.

# Your Character
{{system}}

{{#if personality}}
Personality: {{personality}}
{{/if}}

# User's Message
{{currentMessage}}

# Actions You Completed
{{actionResults}}

# Your Task
Write a natural response to the user that:
- Summarizes what you did and the results
- Includes specific numbers, names, or data from the action results
- Stays in character with your personality

Output ONLY this XML with your actual response (not examples or placeholders):

<response>
<thought>Brief reasoning about what to tell the user</thought>
<text>Your helpful response with specific details from the actions</text>
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

    const body = (await req.json()) as { message: string; usePro?: boolean };
    const message = body.message;
    const usePro = body.usePro ?? false;

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

    // Only deduct points for pro mode (from virtualBalance)
    let newBalance = Number(agentWithConfig.virtualBalance ?? 0);
    if (pointsCost > 0) {
      newBalance = await agentService.deductPoints(
        agentId,
        pointsCost,
        `Chat message (pro mode)`,
        undefined,
      );
    }

    // Get runtime
    const runtime = await agentRuntimeManager.getRuntime(agentId);

    // Create message object for ElizaOS
    const elizaMessage: Memory = {
      id: uuidv4() as `${string}-${string}-${string}-${string}-${string}`,
      entityId: user.id as `${string}-${string}-${string}-${string}-${string}`,
      roomId: agentId as `${string}-${string}-${string}-${string}-${string}`,
      content: { text: message },
      createdAt: Date.now(),
    };

    // Multi-step execution
    const MAX_ITERATIONS = 6;
    // Store action results with metadata for tracking
    const traceActionResults: Array<
      ActionResult & {
        actionType: string;
        parameters?: Record<string, unknown>;
        timestamp: number;
      }
    > = [];
    let finalResponse: string | null = null;

    for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
      logger.info(
        `[MultiStep] Iteration ${iteration}/${MAX_ITERATIONS}`,
        { agentId, actionsCompleted: traceActionResults.length },
        "AgentChat",
      );

      // Compose state with providers
      // Use strict filtering (3rd param = true) to ONLY run the specified providers
      // This prevents all Polyagent A2A providers from running unnecessarily
      const state: State = await runtime.composeState(
        elizaMessage,
        ["RECENT_MESSAGES", "ACTION_STATE", "ACTIONS"],
        true,
      );

      // Add custom values to state
      state.values = {
        ...state.values,
        agentId, // Pass agentId for actions that need it
        system: agentConfig?.systemPrompt ?? "You are a helpful AI assistant.",
        personality: agentConfig?.personality ?? "",
        tradingStrategy: agentConfig?.tradingStrategy ?? "",
        currentMessage: message,
        iterationCount: iteration,
        maxIterations: MAX_ITERATIONS,
        actionCount: traceActionResults.length,
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
              };
            }> | null;
            if (resultsArray && resultsArray.length > 0) {
              const firstResult = resultsArray[0];
              if (firstResult) {
                actionResult = {
                  success: firstResult.content?.success ?? true,
                  text:
                    typeof firstResult.content?.text === "string"
                      ? firstResult.content.text
                      : undefined,
                  values: firstResult.content?.values,
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

        const success = actionResult?.success ?? true;

        traceActionResults.push({
          actionType: action,
          success,
          text: actionResult?.text || `${action} executed`,
          error: success ? undefined : actionResult?.text,
          values: actionResult?.values,
          parameters: actionParams,
          timestamp: Date.now(),
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
      const state = await runtime.composeState(
        elizaMessage,
        ["RECENT_MESSAGES", "ACTION_STATE"],
        true,
      );
      state.values = {
        ...state.values,
        agentId, // Pass agentId for actions that need it
        system: agentConfig?.systemPrompt ?? "You are a helpful AI assistant.",
        personality: agentConfig?.personality ?? "",
        tradingStrategy: agentConfig?.tradingStrategy ?? "",
        currentMessage: message,
      };
      state.data = {
        ...state.data,
        actionResults: traceActionResults,
      };

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

    // Save messages
    const userMessageId = uuidv4();
    const assistantMessageId = uuidv4();
    const userMessageTime = new Date();
    const assistantMessageTime = new Date(userMessageTime.getTime() + 1);

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
          id: assistantMessageId,
          agentUserId: agentId,
          role: "assistant",
          content: responseText,
          modelUsed,
          pointsCost,
          createdAt: assistantMessageTime,
          metadata: {
            multiStep: true,
            actionsExecuted: traceActionResults.length,
            actions: traceActionResults.map((a) => ({
              type: a.actionType,
              success: a.success,
            })),
          },
        },
      ],
    });

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
        level: "info",
        message: "Chat interaction completed",
        prompt: message,
        completion: responseText,
        metadata: {
          usePro,
          pointsCost,
          modelUsed,
          multiStep: true,
          actionsExecuted: traceActionResults.length,
        },
      },
    });

    logger.info(
      `Chat completed for agent ${agentId}`,
      { actionsExecuted: traceActionResults.length },
      "AgentsAPI",
    );

    return NextResponse.json({
      success: true,
      messageId: assistantMessageId,
      response: responseText,
      pointsCost,
      modelUsed,
      balanceAfter: newBalance,
      multiStep: {
        actionsExecuted: traceActionResults.length,
        actions: traceActionResults.map((a) => ({
          type: a.actionType,
          success: a.success,
          text: a.text,
        })),
      },
    });
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
        createdAt: msg.createdAt.toISOString(),
      })),
      pagination: {
        hasMore,
        nextCursor,
      },
    });
  },
);
