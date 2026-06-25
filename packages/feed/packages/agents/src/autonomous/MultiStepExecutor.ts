/**
 * Multi-Step Executor for Autonomous Agent Ticks
 *
 * Implements an iterative decision loop where the LLM decides what action to take
 * based on current state and previous actions taken this tick.
 *
 * Key design: Services are "dumb executors" - all LLM reasoning happens HERE.
 * This eliminates double LLM calls and makes execution faster.
 */

import type { IAgentRuntime } from "@elizaos/core";
import {
  actorState,
  agentLogs,
  and,
  chats,
  db,
  desc,
  eq,
  gte,
  npcTrades,
  questions,
  users,
} from "@feed/db";
import {
  generateWorldContext,
  StaticDataRegistry,
  WalletService,
} from "@feed/engine";
import type { JsonValue } from "@feed/shared";
import { callAgentLLM } from "../llm/agent-llm";
import { getNpcGameContext } from "../plugins/feed/providers/npc-game-context";
import { ensureTrajectoryStep } from "../plugins/plugin-trajectory-logger/src/action-interceptor";
import { agentService } from "../services/AgentService";
import { getAgentConfig, getAutonomousFeatures } from "../shared/agent-config";
import { logger } from "../shared/logger";
import { normalizeDecisionAction } from "./action-normalization";
import {
  executeDirectComment,
  executeDirectCreateGroup,
  executeDirectFollow,
  executeDirectInviteToGroup,
  executeDirectKickFromGroup,
  executeDirectLeaveGroup,
  executeDirectLike,
  executeDirectMessage,
  executeDirectPost,
  executeDirectRepost,
  executeDirectSendMoney,
  executeDirectTrade,
  executeDirectUnfollow,
} from "./DirectExecutors";
import { extractFirstJsonObject } from "./decision-json";
import {
  executeDirectRequestPayment,
  executeDirectShareInformation,
} from "./intel-payment-executors";
import { normalizeSocialDecisionParameters } from "./social-parameter-normalization";
import { topicDiversityService } from "./TopicDiversityService";
import {
  Actions,
  type ActionTraceResult,
  type AgentTickContext,
  buildMultiStepDecisionPrompt,
  Features,
  getRequiredFeature,
  type MultiStepDecision,
  type WorldEventContext,
} from "./templates/multi-step-decision";
import { trackAgentTradeExecuted } from "./track-agent-trade";
import { normalizeTradeDecisionParameters } from "./trade-parameter-normalization";

// Import utilities
import {
  gatherPendingChatMessages,
  gatherPendingCommentReplies,
  getAgentGroupChats,
  getAgentMemory,
  getAgentOwnPosts,
  getAgentPositions,
  getAgentSocialGraph,
  getAgentTradeHistory,
  getGroupChatIntel,
  getMarketTrends,
  getMoodState,
  getPerpMarkets,
  getPredictionMarkets,
  getRecentPosts,
  getRelationships,
  getWorldEventsContext,
} from "./utils";

// =============================================================================
// Helpers
// =============================================================================

/**
 * Build event-market signal connections from world events.
 * Maps events that have a `relatedQuestion` to show which events may affect
 * which markets. Does NOT include directional signals (YES/NO) for user agents —
 * that's stripped at the gatherer level (pointsToward is undefined for non-NPCs).
 */
function buildEventSignals(events: WorldEventContext[]): string {
  const signals = events.filter((e) => e.relatedQuestion != null);
  if (signals.length === 0) return "";

  return signals
    .map((e) => {
      const direction = e.pointsToward
        ? ` (signals toward ${e.pointsToward})`
        : "";
      return `- "${e.description.slice(0, 80)}" → may affect Market Q#${e.relatedQuestion}${direction}`;
    })
    .join("\n");
}

// =============================================================================
// Types
// =============================================================================

export interface MultiStepExecutorResult {
  success: boolean;
  actionsExecuted: {
    trades: number;
    posts: number;
    comments: number;
    messages: number;
    engagements: number;
  };
  iterations: number;
  trace: ActionTraceResult[];
  duration: number;
}

// =============================================================================
// Multi-Step Executor
// =============================================================================

export class MultiStepExecutor {
  /** NPCs get more iterations to chain actions (trade + post + engage) */
  private readonly npcMaxIterations: number;

  constructor(_maxIterations = 5, npcMaxIterations = 12) {
    this.npcMaxIterations = npcMaxIterations;
  }

  private coerceParameterText(value: unknown): string {
    if (typeof value === "string") {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(Math.trunc(value));
    }
    if (typeof value === "bigint") {
      return value.toString();
    }

    return "";
  }

  private buildFallbackDecision(
    context: AgentTickContext,
    enabledFeatures: string[],
    agentUserId: string,
  ): MultiStepDecision | null {
    const fallbackReply =
      "Watching this closely. I am keeping risk tight and will adjust if the signal changes.";
    const fallbackComment =
      "Watching this closely. The catalyst matters more than the hype.";
    const fallbackDm =
      "Saw your signal. I am watching this closely and keeping risk tight.";
    const fallbackGroupMessage =
      "Watching this setup closely and managing risk.";

    if (
      enabledFeatures.includes(Features.COMMENTING) &&
      context.pendingCommentReplies.length > 0
    ) {
      const target = context.pendingCommentReplies[0];
      if (!target) {
        return null;
      }
      return {
        action: Actions.REPLY_COMMENT,
        isFinish: false,
        thought:
          "Parser fallback selected the first pending comment reply to avoid wasting the tick.",
        parameters: {
          commentId: target.id,
          postId: target.postId,
          content: fallbackReply,
        },
      };
    }

    if (enabledFeatures.includes(Features.COMMENTING)) {
      const targetPost =
        context.recentPosts.find(
          (post) => post.authorId !== agentUserId && !post.agentComment,
        ) ?? context.recentPosts.find((post) => post.authorId !== agentUserId);
      if (targetPost) {
        return {
          action: Actions.COMMENT,
          isFinish: false,
          thought:
            "Parser fallback selected a fresh recent post to avoid wasting the tick.",
          parameters: {
            postId: targetPost.id,
            content: fallbackComment,
          },
        };
      }
    }

    if (enabledFeatures.includes(Features.ENGAGING)) {
      const likeTarget =
        context.recentPosts.find(
          (post) => post.authorId !== agentUserId && !post.agentLiked,
        ) ?? context.recentPosts.find((post) => post.authorId !== agentUserId);
      if (likeTarget) {
        return {
          action: Actions.LIKE,
          isFinish: false,
          thought:
            "Parser fallback selected a simple engagement action to avoid wasting the tick.",
          parameters: {
            postId: likeTarget.id,
          },
        };
      }
    }

    if (enabledFeatures.includes(Features.DMS)) {
      const recipient = context.recentPosts.find(
        (post) =>
          post.authorId !== agentUserId && post.authorCanContact === true,
      )?.authorId;
      if (recipient) {
        return {
          action: Actions.DM,
          isFinish: false,
          thought:
            "Parser fallback selected a direct message to avoid wasting the tick.",
          parameters: {
            recipientId: recipient,
            content: fallbackDm,
          },
        };
      }
    }

    if (
      enabledFeatures.includes(Features.GROUP_CHATS) &&
      (context.groupChats?.length ?? 0) > 0
    ) {
      const targetGroupChat = context.groupChats?.[0];
      if (!targetGroupChat?.id) {
        return null;
      }
      return {
        action: Actions.GROUP_MESSAGE,
        isFinish: false,
        thought:
          "Parser fallback selected an available group chat to avoid wasting the tick.",
        parameters: {
          chatId: targetGroupChat.id,
          content: fallbackGroupMessage,
        },
      };
    }

    return null;
  }

  /**
   * Execute a multi-step autonomous tick for an agent
   *
   * The LLM decides what action to take at each step, seeing the results
   * of previous actions to make informed decisions.
   *
   * @param agentUserId - User ID for USER_CONTROLLED agents, or agentId for NPCs
   * @param runtime - Agent runtime
   * @param isNpc - Whether this is an NPC agent (skips User table lookup)
   */
  async execute(
    agentUserId: string,
    runtime: IAgentRuntime,
    isNpc = false,
  ): Promise<MultiStepExecutorResult> {
    const startTime = Date.now();
    const trace: ActionTraceResult[] = [];

    logger.info(
      `[MultiStep] Starting multi-step execution for agent ${agentUserId}`,
      undefined,
      "MultiStepExecutor",
    );

    // Get agent info (for USER_CONTROLLED agents)
    let agent: typeof users.$inferSelect | undefined;
    if (!isNpc) {
      const [userAgent] = await db
        .select()
        .from(users)
        .where(eq(users.id, agentUserId))
        .limit(1);

      if (!userAgent) {
        throw new Error("Agent not found");
      }
      agent = userAgent;
    }

    // Get agent config (may be null for NPCs)
    const config = await getAgentConfig(agentUserId);
    const baseSystemPrompt =
      config?.systemPrompt ?? "You are an autonomous trading agent on Feed.";

    // Determine enabled features - NPCs use per-character autonomy flags if available
    // For USER_CONTROLLED agents: trading defaults to true, others default to false
    let enabledFeatures: string[] = [];
    if (isNpc) {
      // Read per-character autonomy flags from PackActor feed metadata
      const autonomy = (runtime.character as Record<string, unknown>)
        ?.feed
        ? (
            (runtime.character as Record<string, unknown>).feed as {
              autonomy?: {
                trading: boolean;
                posting: boolean;
                commenting: boolean;
                dms: boolean;
                groups: boolean;
              };
            }
          )?.autonomy
        : undefined;

      if (autonomy) {
        // Use per-character feature flags from pack definition
        if (autonomy.trading) enabledFeatures.push(Features.TRADING);
        if (autonomy.posting) enabledFeatures.push(Features.POSTING);
        if (autonomy.commenting) enabledFeatures.push(Features.COMMENTING);
        enabledFeatures.push(Features.ENGAGING); // always on
        if (autonomy.dms) enabledFeatures.push(Features.DMS);
        if (autonomy.groups) enabledFeatures.push(Features.GROUP_CHATS);
      } else {
        // Fallback: enable everything (backward compat)
        enabledFeatures.push(
          Features.TRADING,
          Features.POSTING,
          Features.COMMENTING,
          Features.ENGAGING,
          Features.DMS,
          Features.GROUP_CHATS,
        );
      }
    } else {
      const features = getAutonomousFeatures(config);
      if (features.trading) enabledFeatures.push(Features.TRADING);
      if (features.posting) enabledFeatures.push(Features.POSTING);
      if (features.commenting) enabledFeatures.push(Features.COMMENTING);
      enabledFeatures.push(Features.ENGAGING); // always on
      if (features.dms) enabledFeatures.push(Features.DMS);
      if (features.groupChats) enabledFeatures.push(Features.GROUP_CHATS);
      if (features.transfers) enabledFeatures.push(Features.TRANSFERS);
    }

    // Add entropy by randomly disabling some non-essential features (15% chance each)
    // TRADING is never disabled (agents need to exit positions)
    // At least one social feature is kept enabled
    const ENTROPY_DISABLE_CHANCE = 0.15;
    const socialFeatures: string[] = [
      Features.POSTING,
      Features.COMMENTING,
      Features.ENGAGING,
      Features.DMS,
      Features.GROUP_CHATS,
    ];
    const featuresToMaybeDisable = enabledFeatures.filter(
      (f) =>
        socialFeatures.includes(f) && Math.random() < ENTROPY_DISABLE_CHANCE,
    );
    // Ensure at least one social feature remains if agent had any
    const enabledSocialFeatures = enabledFeatures.filter((f) =>
      socialFeatures.includes(f),
    );
    if (featuresToMaybeDisable.length > 0 && enabledSocialFeatures.length > 0) {
      // If all social features were selected for disabling, keep one random one
      if (featuresToMaybeDisable.length >= enabledSocialFeatures.length) {
        const keepIndex = Math.floor(
          Math.random() * featuresToMaybeDisable.length,
        );
        featuresToMaybeDisable.splice(keepIndex, 1);
      }
      if (featuresToMaybeDisable.length > 0) {
        enabledFeatures = enabledFeatures.filter(
          (f) => !featuresToMaybeDisable.includes(f),
        );
        logger.debug(
          `[Entropy] Temporarily disabled features for tick: ${featuresToMaybeDisable.join(", ")}`,
          { agentUserId },
          "MultiStepExecutor",
        );
      }
    }

    const balanceGuidance =
      "Trading guidance: If your balance is low or $0 but you have open positions, you can still sell/close positions to free balance. Do not assume trading is impossible; check your open positions and consider trimming or closing to unlock funds before switching to social-only actions.";
    const systemPrompt = enabledFeatures.includes(Features.TRADING)
      ? `${baseSystemPrompt}\n\n${balanceGuidance}`
      : baseSystemPrompt;

    // Get NPC game context ONCE before loop (arc awareness, world events)
    // Graceful degradation: if context fetch fails, continue without it
    let npcGameContext = "";
    if (isNpc) {
      try {
        npcGameContext = await getNpcGameContext(agentUserId);
      } catch (error) {
        logger.warn(
          "Failed to get NPC game context, continuing without it",
          {
            agentUserId,
            error: error instanceof Error ? error.message : String(error),
          },
          "MultiStepExecutor",
        );
      }
    }

    const contextRefreshSummary =
      await this.getLatestContextRefreshSummary(agentUserId);

    // All agents get the same iteration budget (7 by default)
    const effectiveMaxIterations = this.npcMaxIterations;
    for (let iteration = 1; iteration <= effectiveMaxIterations; iteration++) {
      const iterationStartTime = Date.now();
      const iterationTimings: Record<string, number> = {};

      logger.info(
        `[MultiStep] Iteration ${iteration}/${effectiveMaxIterations}`,
        { agentUserId, actionsCompleted: trace.length },
        "MultiStepExecutor",
      );

      // Compute per-iteration effectiveFeatures based on current trace
      // This enforces one-POST-per-tick: if we've already posted, remove 'posting'
      const hasPostedThisTick = trace.some(
        (r) => r.actionType === Actions.POST && r.success,
      );
      const effectiveFeatures = hasPostedThisTick
        ? enabledFeatures.filter((f) => f !== Features.POSTING)
        : enabledFeatures;

      // Gather fresh context (state refreshes after each action)
      const contextStartTime = Date.now();
      const context = await this.gatherContext(
        agentUserId,
        effectiveFeatures,
        isNpc,
        contextRefreshSummary,
      );
      iterationTimings.gatherContext = Date.now() - contextStartTime;

      const actionability = this.getActionabilitySummary(context);

      // Build decision prompt (systemPrompt passed separately to LLM system role)
      // For NPCs, prefer character name, fall back to StaticDataRegistry; for users, use displayName
      const agentName = isNpc
        ? (runtime.character?.name ??
          StaticDataRegistry.getActor(agentUserId)?.name ??
          agentUserId)
        : (agent?.displayName ?? agentUserId);

      // Extract character voice/style for prompt injection
      const characterStyle = (
        runtime.character as Record<string, unknown>
      )?.style as { post?: string[] } | undefined;
      const characterPostExamples = (
        runtime.character as Record<string, unknown>
      )?.postExamples as string[] | undefined;

      const { prompt, tokenBreakdown } = buildMultiStepDecisionPrompt({
        agentName,
        iterationCount: iteration,
        maxIterations: effectiveMaxIterations,
        traceActionResults: trace,
        context,
        isNpc,
        npcGameContext,
        characterStyle: characterStyle?.post,
        characterPostExamples,
      });
      iterationTimings.promptTokens = tokenBreakdown.total;

      // Get LLM decision
      const llmStartTime = Date.now();
      let decisionResult: {
        decision: MultiStepDecision;
        rawResponse: string;
      } | null = null;
      let normalizedAction = "";
      let normalizedParameters: Record<string, unknown> = {};
      let validationFeedback: string | undefined;

      for (let decisionAttempt = 1; decisionAttempt <= 2; decisionAttempt++) {
        const candidateDecision = await this.getDecision(
          prompt,
          runtime,
          iteration,
          systemPrompt,
          {
            requireConcreteAction: trace.length === 0 && actionability.hasAny,
            feedback: validationFeedback,
          },
        );

        if (!candidateDecision) {
          decisionResult = null;
          break;
        }

        normalizedAction = normalizeDecisionAction(
          candidateDecision.decision.action,
        );
        normalizedParameters =
          normalizedAction === Actions.TRADE
            ? normalizeTradeDecisionParameters(
                candidateDecision.decision.parameters,
                context,
              )
            : normalizeSocialDecisionParameters(
                normalizedAction,
                candidateDecision.decision.parameters,
                context,
                agentUserId,
              );

        if (normalizedParameters !== candidateDecision.decision.parameters) {
          candidateDecision.decision.parameters = normalizedParameters;
        }
        if (normalizedAction === Actions.FINISH) {
          candidateDecision.decision.isFinish = true;
        }

        const validationError = this.getDecisionValidationError(
          normalizedAction,
          normalizedParameters,
          context,
        );
        if (
          validationError &&
          normalizedAction !== Actions.FINISH &&
          normalizedAction !== Actions.WAIT
        ) {
          if (decisionAttempt < 2) {
            logger.warn(
              `[MultiStep] Rejected invalid decision after normalization`,
              {
                action: normalizedAction || "(empty)",
                parameters: normalizedParameters,
                validationError,
              },
              "MultiStepExecutor",
            );
            validationFeedback = validationError;
            continue;
          }

          logger.warn(
            `[MultiStep] Exhausted retries for invalid decision, finishing iteration`,
            {
              action: normalizedAction || "(empty)",
              parameters: normalizedParameters,
              validationError,
            },
            "MultiStepExecutor",
          );
          const fallbackDecision =
            trace.length === 0 && actionability.hasAny
              ? this.buildFallbackDecision(
                  context,
                  effectiveFeatures,
                  agentUserId,
                )
              : null;
          if (fallbackDecision) {
            logger.warn(
              `[MultiStep] Using deterministic fallback after invalid first action`,
              {
                fallbackAction: fallbackDecision.action,
                fallbackParameters: fallbackDecision.parameters,
              },
              "MultiStepExecutor",
            );
            candidateDecision.decision = fallbackDecision;
            normalizedAction = fallbackDecision.action;
            normalizedParameters = fallbackDecision.parameters;
            decisionResult = candidateDecision;
            break;
          }
          candidateDecision.decision.action = Actions.FINISH;
          candidateDecision.decision.isFinish = true;
          candidateDecision.decision.parameters = {};
          normalizedAction = Actions.FINISH;
          normalizedParameters = {};
        }

        decisionResult = candidateDecision;
        break;
      }
      iterationTimings.llmDecision = Date.now() - llmStartTime;

      if (!decisionResult) {
        const fallbackDecision =
          trace.length === 0 && actionability.hasAny
            ? this.buildFallbackDecision(
                context,
                effectiveFeatures,
                agentUserId,
              )
            : null;
        if (fallbackDecision) {
          logger.warn(
            `[MultiStep] Using deterministic fallback after parse failure`,
            {
              fallbackAction: fallbackDecision.action,
              fallbackParameters: fallbackDecision.parameters,
            },
            "MultiStepExecutor",
          );
          decisionResult = {
            decision: fallbackDecision,
            rawResponse: "__deterministic_fallback__",
          };
          normalizedAction = fallbackDecision.action;
          normalizedParameters = fallbackDecision.parameters;
        }
      }

      if (!decisionResult) {
        iterationTimings.total = Date.now() - iterationStartTime;
        logger.warn(
          `[MultiStep] Failed to parse decision at iteration ${iteration}, finishing`,
          { iterationTimings },
          "MultiStepExecutor",
        );
        break;
      }

      const { decision, rawResponse } = decisionResult;
      decision.parameters = normalizedParameters;
      if (normalizedAction === Actions.FINISH) {
        decision.isFinish = true;
      }

      logger.info(
        `[MultiStep] Decision: ${decision.action || "FINISH"}`,
        {
          thought: decision.thought.substring(0, 100),
          isFinish: decision.isFinish,
          llmTimeMs: iterationTimings.llmDecision,
        },
        "MultiStepExecutor",
      );

      // Check if we should finish
      if (
        decision.isFinish ||
        !decision.action ||
        normalizedAction === Actions.FINISH
      ) {
        iterationTimings.total = Date.now() - iterationStartTime;
        if (trace.length === 0 && actionability.hasAny) {
          logger.warn(
            `[MultiStep] Finished without actions despite actionable context`,
            { agentUserId, actionability, iterationTimings },
            "MultiStepExecutor",
          );
        }
        logger.info(
          `[MultiStep] Agent decided to finish at iteration ${iteration}`,
          { thought: decision.thought, iterationTimings },
          "MultiStepExecutor",
        );
        break;
      }

      // Execute the chosen action with parameters (pass effectiveFeatures for enforcement)
      const actionStartTime = Date.now();
      const actionResult = await this.executeAction(
        agentUserId,
        normalizedAction,
        normalizedParameters,
        effectiveFeatures,
        runtime,
        isNpc,
        { prompt, completion: rawResponse, thought: decision.thought },
        agent?.managedBy ?? agentUserId,
      );
      await this.recordTrajectoryStep(runtime, decision, actionResult);
      iterationTimings.actionExecution = Date.now() - actionStartTime;
      iterationTimings.total = Date.now() - iterationStartTime;

      trace.push(actionResult);

      // Log iteration timing summary - warn if iteration took more than 30s
      const iterLogLevel = iterationTimings.total > 30000 ? "warn" : "info";
      logger[iterLogLevel](
        `[MultiStep] Iteration ${iteration} completed in ${iterationTimings.total}ms`,
        {
          agentUserId,
          action: decision.action,
          actionSuccess: actionResult.success,
          timings: iterationTimings,
        },
        "MultiStepExecutor",
      );

      // Small delay between iterations (reduced since no double LLM calls)
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    // Aggregate results
    const result = this.aggregateResults(trace, startTime);

    logger.info(
      `[MultiStep] Completed in ${result.duration}ms with ${result.iterations} iterations`,
      {
        trades: result.actionsExecuted.trades,
        posts: result.actionsExecuted.posts,
        comments: result.actionsExecuted.comments,
        messages: result.actionsExecuted.messages,
      },
      "MultiStepExecutor",
    );

    return result;
  }

  /**
   * Gather current context for decision making
   * Uses utility functions for individual data fetching
   */
  private async gatherContext(
    agentUserId: string,
    enabledFeatures: string[],
    isNpc: boolean,
    contextRefreshSummary?: string,
  ): Promise<AgentTickContext> {
    const contextStartTime = Date.now();
    const timings: Record<string, number> = {};

    // Get balance and PnL
    let balance = 0;
    let pnl = 0;
    let creator: { name: string; username?: string } | undefined;

    const balanceStart = Date.now();
    if (isNpc) {
      const [actor] = await db
        .select({ tradingBalance: actorState.tradingBalance })
        .from(actorState)
        .where(eq(actorState.id, agentUserId))
        .limit(1);

      if (!actor) {
        throw new Error(
          `NPC ${agentUserId} has no actorState record. Run NPC bootstrap to create it.`,
        );
      }

      balance = Number(actor.tradingBalance);
      pnl = 0;
    } else {
      const walletBalance = await WalletService.getBalance(agentUserId);
      balance = walletBalance.balance;
      pnl = walletBalance.lifetimePnL;

      // Fetch creator info for user-controlled agents
      const [agentUser] = await db
        .select({ managedBy: users.managedBy })
        .from(users)
        .where(eq(users.id, agentUserId))
        .limit(1);

      if (agentUser?.managedBy) {
        const [creatorUser] = await db
          .select({
            displayName: users.displayName,
            username: users.username,
          })
          .from(users)
          .where(eq(users.id, agentUser.managedBy))
          .limit(1);

        if (creatorUser) {
          creator = {
            name: creatorUser.displayName || creatorUser.username || "Unknown",
            username: creatorUser.username || undefined,
          };
        }
      }
    }
    timings.balance = Date.now() - balanceStart;

    // Only fetch data for enabled features (saves DB queries and tokens)
    const canTrade = enabledFeatures.includes(Features.TRADING);
    const canComment = enabledFeatures.includes(Features.COMMENTING);
    const canRespondDMs = enabledFeatures.includes(Features.DMS);
    const canGroupChat = enabledFeatures.includes(Features.GROUP_CHATS);
    const canPost = enabledFeatures.includes(Features.POSTING);

    // Gather context in parallel using utility functions with individual timing
    const parallelStart = Date.now();
    const [
      predictionMarketsResult,
      perpMarketsResult,
      agentPositionsResult,
      recentPostsResult,
      pendingCommentRepliesResult,
      pendingChatMessagesResult,
      agentGroupChatsResult,
      agentOwnPostsResult,
      groupChatIntelResult,
      // Engine-grade context (Phase 1: unified NPC pipeline)
      marketTrendsResult,
      relationshipsResult,
      worldEventsResult,
      moodStateResult,
      // Agent trade history (user-controlled agents only)
      agentTradeHistoryResult,
      // NPC-only narrative context (insider knowledge)
      resolvedQuestionsResult,
      recentNpcTradesResult,
      // Social graph for user-controlled agents
      socialGraphResult,
      // Agent memory for user-controlled agents
      agentMemoryResult,
    ] = await Promise.all([
      canTrade
        ? this.timedOperation("predictionMarkets", () => getPredictionMarkets())
        : Promise.resolve({ data: [], duration: 0 }),
      canTrade
        ? this.timedOperation("perpMarkets", () => getPerpMarkets())
        : Promise.resolve({ data: [], duration: 0 }),
      this.timedOperation("agentPositions", () =>
        getAgentPositions(agentUserId),
      ),
      // Feed is needed for commenting, engaging (like/repost/follow), and DMs
      this.timedOperation("recentPosts", () => getRecentPosts(agentUserId)),
      canComment
        ? this.timedOperation("pendingCommentReplies", () =>
            gatherPendingCommentReplies(agentUserId),
          )
        : Promise.resolve({ data: [], duration: 0 }),
      canRespondDMs || canGroupChat
        ? this.timedOperation("pendingChatMessages", () =>
            gatherPendingChatMessages(agentUserId),
          )
        : Promise.resolve({ data: [], duration: 0 }),
      canGroupChat
        ? this.timedOperation("agentGroupChats", () =>
            getAgentGroupChats(agentUserId),
          )
        : Promise.resolve({ data: [], duration: 0 }),
      canPost
        ? this.timedOperation("agentOwnPosts", () =>
            getAgentOwnPosts(agentUserId),
          )
        : Promise.resolve({ data: [], duration: 0 }),
      // Fetch group chat intel (summaries + facts) for trading context
      this.timedOperation("groupChatIntel", () =>
        getGroupChatIntel(agentUserId),
      ),
      // Engine-grade context: market trends with volatility
      canTrade
        ? this.timedOperation("marketTrends", () => getMarketTrends())
        : Promise.resolve({ data: [], duration: 0 }),
      // Relationships (friends/enemies) for NPCs
      isNpc
        ? this.timedOperation("relationships", () =>
            getRelationships(agentUserId),
          )
        : Promise.resolve({ data: [], duration: 0 }),
      // World events for narrative awareness (all agent types)
      // NPCs get all events + signal direction; user agents get public events only
      this.timedOperation("worldEvents", () =>
        getWorldEventsContext(agentUserId, isNpc),
      ),
      // Mood/state for NPCs
      isNpc
        ? this.timedOperation("moodState", () => getMoodState(agentUserId))
        : Promise.resolve({ data: null, duration: 0 }),
      // Trade history for user-controlled agents (NPCs get this via NPC trading pipeline)
      !isNpc
        ? this.timedOperation("agentTradeHistory", () =>
            getAgentTradeHistory(agentUserId),
          )
        : Promise.resolve({ data: [], duration: 0 }),
      // Resolved questions — NPC insider knowledge (outcomes of resolved markets)
      isNpc
        ? this.timedOperation("resolvedQuestions", () =>
            db
              .select()
              .from(questions)
              .where(eq(questions.status, "resolved"))
              .orderBy(desc(questions.resolutionDate))
              .limit(10),
          )
        : Promise.resolve({ data: [], duration: 0 }),
      // Recent NPC trades — NPC insider knowledge (what other NPCs are doing)
      isNpc
        ? this.timedOperation("recentNpcTrades", () => {
            const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
            return db
              .select()
              .from(npcTrades)
              .where(gte(npcTrades.executedAt, oneDayAgo))
              .orderBy(desc(npcTrades.executedAt))
              .limit(20);
          })
        : Promise.resolve({ data: [], duration: 0 }),
      // Social graph for user-controlled agents (NPCs use actorRelationships)
      !isNpc
        ? this.timedOperation("socialGraph", () =>
            getAgentSocialGraph(agentUserId),
          )
        : Promise.resolve({ data: [], duration: 0 }),
      // Memory for user-controlled agents (NPCs have NpcMemoryService)
      !isNpc
        ? this.timedOperation("agentMemory", () =>
            getAgentMemory(agentUserId, ["trade"]),
          )
        : Promise.resolve({ data: [], duration: 0 }),
    ]);
    timings.parallelTotal = Date.now() - parallelStart;

    // Extract data and individual timings
    const predictionMarkets = predictionMarketsResult.data;
    const perpMarkets = perpMarketsResult.data;
    const agentPositions = agentPositionsResult.data;
    const recentPosts = recentPostsResult.data;
    const pendingCommentRepliesRaw = pendingCommentRepliesResult.data;
    const pendingChatMessagesRaw = pendingChatMessagesResult.data;
    const agentGroupChats = agentGroupChatsResult.data;
    const agentOwnPosts = agentOwnPostsResult.data;
    const groupChatIntel = groupChatIntelResult.data;
    const marketTrends = marketTrendsResult.data;
    const relationships = relationshipsResult.data;
    const worldEventsData = worldEventsResult.data;
    const moodState = moodStateResult.data;
    const agentTradeHistory = agentTradeHistoryResult.data;
    const resolvedQsRows = resolvedQuestionsResult.data;
    const recentNpcTradesRows = recentNpcTradesResult.data;
    const socialGraph = socialGraphResult.data;
    const agentMemory = agentMemoryResult.data;

    // Collect individual operation timings
    timings.predictionMarkets = predictionMarketsResult.duration;
    timings.perpMarkets = perpMarketsResult.duration;
    timings.agentPositions = agentPositionsResult.duration;
    timings.recentPosts = recentPostsResult.duration;
    timings.pendingCommentReplies = pendingCommentRepliesResult.duration;
    timings.pendingChatMessages = pendingChatMessagesResult.duration;
    timings.agentGroupChats = agentGroupChatsResult.duration;
    timings.agentOwnPosts = agentOwnPostsResult.duration;
    timings.groupChatIntel = groupChatIntelResult.duration;
    timings.marketTrends = marketTrendsResult.duration;
    timings.relationships = relationshipsResult.duration;
    timings.worldEvents = worldEventsResult.duration;
    timings.moodState = moodStateResult.duration;
    timings.agentTradeHistory = agentTradeHistoryResult.duration;
    timings.resolvedQuestions = resolvedQuestionsResult.duration;
    timings.recentNpcTrades = recentNpcTradesResult.duration;
    timings.socialGraph = socialGraphResult.duration;
    timings.agentMemory = agentMemoryResult.duration;

    // Filter chat messages based on DMs vs group chats feature
    const pendingChatMessages = pendingChatMessagesRaw.filter((m) =>
      m.isGroupChat ? canGroupChat : canRespondDMs,
    );

    // Get topic diversity guidance for this agent
    const diversityInstructions =
      topicDiversityService.getDiversityInstructions(agentUserId);
    const assignment = topicDiversityService.getAgentAssignment(agentUserId);

    timings.total = Date.now() - contextStartTime;

    // Log timing summary - warn if total exceeds 5 seconds
    const logLevel = timings.total > 5000 ? "warn" : "debug";
    logger[logLevel](
      `[MultiStep] Context gathered in ${timings.total}ms`,
      {
        agentUserId,
        timings,
        counts: {
          predictionMarkets: predictionMarkets.length,
          perpMarkets: perpMarkets.length,
          positions:
            agentPositions.predictions.length + agentPositions.perps.length,
          recentPosts: recentPosts.length,
          pendingCommentReplies: pendingCommentRepliesRaw.length,
          pendingChatMessages: pendingChatMessages.length,
          pendingChatMessagesRaw: pendingChatMessagesRaw.length,
          groupChats: agentGroupChats.length,
          groupChatIntel: groupChatIntel.length,
          ownPosts: agentOwnPosts.length,
          hasContextRefreshSummary: Boolean(contextRefreshSummary),
        },
      },
      "MultiStepExecutor",
    );

    // Fetch world context for reality grounding (parody names, world state)
    const worldCtx = await generateWorldContext({
      includeActors: true,
      includeMarkets: false,
      includePredictions: false,
      includeTrades: false,
      realityGroundingLevel: "concise",
      maxActors: 30,
    });

    // Format narrative context from parallel-fetched results (NPC-only data).
    // Resolved question outcomes and NPC trade details are insider knowledge.
    // User agents must not see: (1) how markets resolved (YES/NO outcomes),
    // (2) what NPCs are trading (names, directions, amounts), or
    // (3) which events link to which markets (relatedQuestion mapping).
    // User agents learn about the world through public events, the feed, and
    // price movements — not by directly observing ground truth or NPC behavior.
    const resolvedQuestionsText = resolvedQsRows
      .filter((q) => q.resolvedOutcome != null)
      .map((q) => `- "${q.text}" → ${q.resolvedOutcome ? "YES" : "NO"}`)
      .join("\n");

    const recentTradesText = recentNpcTradesRows
      .map((t) => {
        const symbol = t.ticker || `Q${t.marketId}`;
        const name =
          StaticDataRegistry.getActor(t.npcActorId)?.name ?? t.npcActorId;
        return `- ${name}: ${t.action} ${symbol} $${t.amount.toFixed(0)}`;
      })
      .join("\n");

    return {
      balance,
      pnl,
      openPositions:
        agentPositions.predictions.length + agentPositions.perps.length,
      pendingCommentReplies: pendingCommentRepliesRaw.slice(0, 3),
      pendingChatMessages: pendingChatMessages.slice(0, 3),
      enabledFeatures,
      predictionMarkets,
      perpMarkets,
      recentPosts,
      agentPositions,
      groupChats: agentGroupChats,
      groupChatIntel: groupChatIntel.length > 0 ? groupChatIntel : undefined,
      diversityInstructions,
      assignedMarketId: assignment?.marketId,
      personality: assignment?.personality,
      postStyle: assignment?.postStyle,
      agentOwnPosts,
      creator,
      contextRefreshSummary,
      worldContext: {
        realityGrounding: worldCtx.realityGrounding,
        worldActors: worldCtx.worldActors,
      },
      narrativeContext: {
        resolvedQuestions: resolvedQuestionsText,
        recentTrades: recentTradesText,
        // Event-market connections are insider knowledge (relatedQuestion mapping).
        // Only NPCs get to see which events affect which markets directly.
        eventSignals: isNpc ? buildEventSignals(worldEventsData) : "",
      },
      agentTradeHistory:
        agentTradeHistory.length > 0 ? agentTradeHistory : undefined,
      socialGraph: socialGraph.length > 0 ? socialGraph : undefined,
      recentMemory: agentMemory.length > 0 ? agentMemory : undefined,
      // Engine-grade context (Phase 1: unified NPC pipeline)
      marketTrends: marketTrends.length > 0 ? marketTrends : undefined,
      relationships: relationships.length > 0 ? relationships : undefined,
      worldEvents: worldEventsData.length > 0 ? worldEventsData : undefined,
      moodState,
    };
  }

  /**
   * Helper to time an async operation
   */
  private async timedOperation<T>(
    _name: string,
    operation: () => Promise<T>,
  ): Promise<{ data: T; duration: number }> {
    const start = Date.now();
    const data = await operation();
    return { data, duration: Date.now() - start };
  }

  private async getLatestContextRefreshSummary(
    agentUserId: string,
  ): Promise<string | undefined> {
    const recentSystemLogs = await db
      .select({
        createdAt: agentLogs.createdAt,
        metadata: agentLogs.metadata,
      })
      .from(agentLogs)
      .where(
        and(
          eq(agentLogs.agentUserId, agentUserId),
          eq(agentLogs.type, "system"),
        ),
      )
      .orderBy(desc(agentLogs.createdAt))
      .limit(10);

    for (const log of recentSystemLogs) {
      const metadata =
        log.metadata && typeof log.metadata === "object" ? log.metadata : null;
      const event =
        metadata && "event" in metadata ? metadata.event : undefined;
      const summary =
        metadata && "summary" in metadata ? metadata.summary : undefined;

      if (event !== "context_refresh" || typeof summary !== "string") {
        continue;
      }

      if (!(log.createdAt instanceof Date)) {
        return summary;
      }

      return `${summary} [recorded ${log.createdAt.toISOString()}]`;
    }

    return undefined;
  }

  private getActionabilitySummary(context: AgentTickContext): {
    predictionMarkets: number;
    perpMarkets: number;
    openPositions: number;
    recentPosts: number;
    pendingCommentReplies: number;
    pendingChatMessages: number;
    groupChats: number;
    actionableTotal: number;
    hasAny: boolean;
  } {
    const predictionMarkets = context.predictionMarkets.length;
    const perpMarkets = context.perpMarkets.length;
    const openPositions = context.openPositions;
    const recentPosts = context.recentPosts.length;
    const pendingCommentReplies = context.pendingCommentReplies.length;
    const pendingChatMessages = context.pendingChatMessages.length;
    const groupChats = context.groupChats?.length ?? 0;
    const actionableTotal =
      predictionMarkets +
      perpMarkets +
      openPositions +
      recentPosts +
      pendingCommentReplies +
      pendingChatMessages +
      groupChats;

    return {
      predictionMarkets,
      perpMarkets,
      openPositions,
      recentPosts,
      pendingCommentReplies,
      pendingChatMessages,
      groupChats,
      actionableTotal,
      hasAny: actionableTotal > 0,
    };
  }

  /**
   * Get LLM decision with retry logic
   */
  private async getDecision(
    prompt: string,
    runtime: IAgentRuntime,
    _iteration: number,
    systemPrompt?: string,
    options?: { requireConcreteAction?: boolean; feedback?: string },
  ): Promise<{ decision: MultiStepDecision; rawResponse: string } | null> {
    const maxRetries = 3;

    const system = systemPrompt
      ? `${systemPrompt}\n\nIMPORTANT: Output valid JSON only. No markdown, no explanations, and no <think> tags. The first character of your reply must be "{" and the last character must be "}".`
      : 'You are a decision-making agent. Output valid JSON only. No markdown, no explanations, and no <think> tags. The first character of your reply must be "{" and the last character must be "}".';
    let retryFeedback = "";

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const promptSegments = [prompt];
      if (options?.requireConcreteAction) {
        promptSegments.push(
          "CRITICAL: You MUST choose exactly one concrete non-FINISH, non-WAIT action in valid JSON. Do not return FINISH, WAIT, or an empty action on this turn.",
        );
      }
      if (options?.feedback) {
        promptSegments.push(options.feedback);
      }
      if (retryFeedback) {
        promptSegments.push(retryFeedback);
      }
      const promptWithConstraints = promptSegments.join("\n\n");
      const response = await callAgentLLM({
        prompt: promptWithConstraints,
        system,
        runtime,
        temperature:
          attempt > 1
            ? 0.2
            : ((
                (runtime.character as Record<string, unknown>)
                  ?.settings as { temperature?: number } | undefined
              )?.temperature ?? 0.7),
        maxTokens: 1000,
        actionType: "multi_step_decision",
        purpose: "action",
      });

      const jsonText = extractFirstJsonObject(response);
      if (!jsonText) {
        retryFeedback =
          "Your previous response was invalid because it did not contain a parseable JSON object. Return exactly one JSON object only. Do not include <think> tags, prose, or code fences.";
        logger.warn(
          `[MultiStep] No JSON found in response (attempt ${attempt})`,
          { responsePreview: response.substring(0, 200) },
          "MultiStepExecutor",
        );
        continue;
      }

      try {
        const parsed = JSON.parse(jsonText) as MultiStepDecision;
        const rawIsFinish = parsed.isFinish;
        parsed.isFinish =
          typeof rawIsFinish === "boolean" ? rawIsFinish : false;
        if (!parsed.action) {
          parsed.action = "";
        }
        if (!parsed.parameters) {
          parsed.parameters = {};
        }
        if (!parsed.thought) {
          parsed.thought = "";
        }
        if (
          typeof parsed.parameters !== "object" ||
          parsed.parameters === null ||
          Array.isArray(parsed.parameters)
        ) {
          parsed.parameters = {};
        }

        const normalizedAction = normalizeDecisionAction(parsed.action);
        parsed.action = normalizedAction;
        parsed.isFinish = !!(
          normalizedAction === Actions.FINISH ||
          normalizedAction === Actions.WAIT
        );

        if (
          options?.requireConcreteAction &&
          (!normalizedAction ||
            normalizedAction === Actions.FINISH ||
            normalizedAction === Actions.WAIT ||
            parsed.isFinish)
        ) {
          logger.warn(
            `[MultiStep] Rejected non-concrete decision (attempt ${attempt})`,
            {
              action: normalizedAction || "(empty)",
              isFinish: parsed.isFinish,
            },
            "MultiStepExecutor",
          );
          retryFeedback =
            "Your previous JSON chose FINISH, WAIT, or an empty action when a real action was required. Return one concrete action with valid parameters from the provided IDs.";
          continue;
        }

        return { decision: parsed, rawResponse: response };
      } catch {
        retryFeedback =
          "Your previous response contained malformed JSON. Return a single valid JSON object with double-quoted keys and strings only.";
        logger.warn(
          `[MultiStep] Failed to parse JSON (attempt ${attempt})`,
          { json: jsonText.substring(0, 200) },
          "MultiStepExecutor",
        );
      }
    }

    return null;
  }

  private getDecisionValidationError(
    action: string,
    parameters: Record<string, unknown>,
    context: AgentTickContext,
  ): string | undefined {
    const content =
      typeof parameters.content === "string" ? parameters.content.trim() : "";
    const marketId = this.coerceParameterText(parameters.marketId);
    const side =
      typeof parameters.side === "string" ? parameters.side.trim() : "";
    const postId = this.coerceParameterText(parameters.postId);
    const commentId = this.coerceParameterText(parameters.commentId);
    const chatId = this.coerceParameterText(parameters.chatId);
    const userId = this.coerceParameterText(parameters.userId);
    const recipientId = this.coerceParameterText(parameters.recipientId);

    switch (action) {
      case Actions.TRADE: {
        if (!marketId || !side) {
          return "Your TRADE was invalid because it did not include a valid marketId and side from the provided markets or positions. Choose a valid trade or a different action.";
        }

        if (
          parameters.marketType !== "prediction" &&
          parameters.marketType !== "perp"
        ) {
          return 'Your TRADE was invalid because marketType must be exactly "prediction" or "perp". Choose a valid market from the provided context and return the corrected trade.';
        }

        if (parameters.marketType === "prediction") {
          const knownPredictionMarketIds = new Set([
            ...context.predictionMarkets.map((market) => market.id),
            ...context.agentPositions.predictions.map(
              (position) => position.marketId,
            ),
          ]);
          if (!knownPredictionMarketIds.has(marketId)) {
            return `Your TRADE used prediction marketId ${marketId}, but that market is not in the current context. Choose an exact marketId from Available Prediction Markets or your open positions.`;
          }
        }

        if (parameters.marketType === "perp") {
          const knownPerpTickers = new Set([
            ...context.perpMarkets.map((market) => market.ticker),
            ...context.agentPositions.perps.map((position) => position.ticker),
          ]);
          if (!knownPerpTickers.has(marketId)) {
            return `Your TRADE used perp marketId ${marketId}, but that ticker is not in the current context. Choose an exact ticker from Available Perp Markets or your open positions.`;
          }
        }

        if (
          parameters.marketType === "prediction" &&
          side.startsWith("sell_")
        ) {
          const expectedSide = side === "sell_yes" ? "YES" : "NO";
          const heldPrediction = context.agentPositions.predictions.find(
            (position) =>
              position.marketId === marketId && position.side === expectedSide,
          );
          if (!heldPrediction) {
            return `Your TRADE tried to sell ${expectedSide} on prediction market ${marketId}, but you do not hold a ${expectedSide} position on that market. Choose a market and side you actually hold to sell, or use buy_yes/buy_no instead.`;
          }
        }

        if (parameters.marketType === "perp" && side === "close_position") {
          const heldPerp = context.agentPositions.perps.find(
            (position) => position.ticker === marketId,
          );
          if (!heldPerp) {
            return `Your TRADE tried to close perp ${marketId}, but you do not currently hold that perp. Choose an open perp position or use open_long/open_short instead.`;
          }
        }

        return undefined;
      }

      case Actions.COMMENT:
        if (!postId || !content) {
          return context.recentPosts.length > 0
            ? "Your COMMENT was invalid because it requires both a valid postId from Recent Posts and non-empty content. Choose a valid comment target or a different action."
            : "Your COMMENT was invalid because there are no recent posts available to comment on right now. Choose a different valid action.";
        }
        if (commentId) {
          return "Your COMMENT was invalid because replies must use REPLY_COMMENT, not COMMENT. Choose REPLY_COMMENT with a valid pending comment target or use COMMENT without commentId.";
        }
        {
          const targetPost = context.recentPosts.find(
            (post) => post.id === postId,
          );
          if (targetPost?.agentComment) {
            return `Your COMMENT targeted post ${postId}, but you already made a top-level comment there. Choose a different post or use REPLY_COMMENT if there is a pending reply target.`;
          }
        }
        return undefined;

      case Actions.REPLY_COMMENT:
        if (!commentId || !postId || !content) {
          return context.pendingCommentReplies.length > 0
            ? "Your REPLY_COMMENT was invalid because it requires commentId, postId, and content from Pending Comment Replies. Choose a valid reply target or a different action."
            : "Your REPLY_COMMENT was invalid because there are no pending comment replies available right now. Choose a different valid action.";
        }
        if (
          !context.pendingCommentReplies.some(
            (reply) => reply.id === commentId && reply.postId === postId,
          )
        ) {
          return `Your REPLY_COMMENT targeted comment ${commentId} on post ${postId}, but that pending reply target is not currently available. Choose an exact commentId/postId pair from Pending Comment Replies.`;
        }
        return undefined;

      case Actions.LIKE:
        if (!postId) {
          return context.recentPosts.length > 0
            ? `Your ${action} was invalid because it requires a valid postId from Recent Posts. Choose a valid target or a different action.`
            : `Your ${action} was invalid because there are no recent posts available right now. Choose a different valid action.`;
        }
        {
          const targetPost = context.recentPosts.find(
            (post) => post.id === postId,
          );
          if (targetPost?.agentLiked) {
            return `Your LIKE targeted post ${postId}, but you already liked that post. Choose a different post.`;
          }
        }
        return undefined;

      case Actions.REPOST:
        if (!postId) {
          return context.recentPosts.length > 0
            ? `Your ${action} was invalid because it requires a valid postId from Recent Posts. Choose a valid target or a different action.`
            : `Your ${action} was invalid because there are no recent posts available right now. Choose a different valid action.`;
        }
        {
          const targetPost = context.recentPosts.find(
            (post) => post.id === postId,
          );
          if (targetPost?.agentReposted) {
            return `Your REPOST targeted post ${postId}, but you already reposted that post. Choose a different post.`;
          }
        }
        return undefined;

      case Actions.FOLLOW:
      case Actions.UNFOLLOW:
        if (!userId) {
          return `Your ${action} was invalid because it requires a valid userId from the visible social context. Choose a valid target or a different action.`;
        }
        return undefined;

      case Actions.DM:
        if (!recipientId || !content) {
          return "Your DM was invalid because it requires a valid recipientId and message content. Choose a valid DM target or a different action.";
        }
        return undefined;

      case Actions.REPLY_CHAT:
        if (!chatId || !content) {
          return context.pendingChatMessages.length > 0
            ? "Your REPLY_CHAT was invalid because it requires a valid chatId from Pending Chat Messages and message content. Choose a valid chat target or a different action."
            : "Your REPLY_CHAT was invalid because there are no pending chat messages available right now. Choose a different valid action.";
        }
        return undefined;

      case Actions.GROUP_MESSAGE:
        if (!chatId || !content) {
          return (context.groupChats?.length ?? 0) > 0
            ? "Your GROUP_MESSAGE was invalid because it requires a valid chatId from Your Group Chats and message content. Choose a valid group chat or a different action."
            : "Your GROUP_MESSAGE was invalid because you have no available group chats right now. Choose a different valid action.";
        }
        return undefined;

      case Actions.CREATE_GROUP: {
        const groupName =
          typeof parameters.name === "string" ? parameters.name.trim() : "";
        if (!groupName || groupName.length < 2) {
          return "Your CREATE_GROUP was invalid because it requires a name of at least 2 characters.";
        }
        return undefined;
      }

      case Actions.INVITE_TO_GROUP: {
        const groupId2 = this.coerceParameterText(parameters.groupId);
        if (!groupId2 || !userId) {
          return "Your INVITE_TO_GROUP was invalid because it requires both a groupId and userId.";
        }
        return undefined;
      }

      case Actions.KICK_FROM_GROUP: {
        const groupId3 = this.coerceParameterText(parameters.groupId);
        if (!groupId3 || !userId) {
          return "Your KICK_FROM_GROUP was invalid because it requires both a groupId and userId.";
        }
        return undefined;
      }

      case Actions.LEAVE_GROUP: {
        const groupId4 = this.coerceParameterText(parameters.groupId);
        if (!groupId4) {
          return "Your LEAVE_GROUP was invalid because it requires a groupId.";
        }
        return undefined;
      }

      case Actions.SEND_MONEY: {
        const sendAmount = Number(parameters.amount);
        if (!recipientId || !Number.isFinite(sendAmount) || sendAmount <= 0) {
          return "Your SEND_MONEY was invalid because it requires a valid recipientId and a positive amount. Choose a valid recipient from the visible social context.";
        }
        return undefined;
      }

      default:
        return undefined;
    }
  }

  /**
   * Execute a single action using DIRECT executors (no LLM calls)
   */
  private async executeAction(
    agentUserId: string,
    action: string,
    parameters: Record<string, unknown>,
    enabledFeatures: string[],
    _runtime: IAgentRuntime,
    _isNpc: boolean,
    logContext?: { prompt: string; completion: string; thought: string },
    ownerId: string = agentUserId,
  ): Promise<ActionTraceResult> {
    const normalizedAction = normalizeDecisionAction(action);

    if (normalizedAction !== action.trim().toUpperCase()) {
      logger.info(
        `[MultiStep] Normalized action "${action}" -> "${normalizedAction}"`,
        undefined,
        "MultiStepExecutor",
      );
    }

    logger.info(
      `[MultiStep] Executing action: ${normalizedAction}`,
      { parameters, enabledFeatures },
      "MultiStepExecutor",
    );

    // Enforce enabled features
    const requiredFeature = getRequiredFeature(normalizedAction);
    if (requiredFeature && !enabledFeatures.includes(requiredFeature)) {
      logger.warn(
        `[MultiStep] Action ${normalizedAction} blocked - ${requiredFeature} not enabled`,
        { agentUserId, enabledFeatures },
        "MultiStepExecutor",
      );
      return {
        actionType: normalizedAction,
        success: false,
        summary: `Action blocked: ${requiredFeature} is not enabled for this agent`,
        error: `Feature "${requiredFeature}" is disabled`,
        parameters,
        timestamp: Date.now(),
      };
    }

    switch (normalizedAction) {
      case Actions.TRADE:
        return this.executeTrade(agentUserId, parameters, ownerId);

      case Actions.POST:
        return this.executePost(agentUserId, parameters, logContext);

      case Actions.COMMENT:
        return this.executeComment(agentUserId, parameters, logContext);

      case Actions.LIKE:
        return this.executeLike(agentUserId, parameters);

      case Actions.REPOST:
        return this.executeRepost(agentUserId, parameters);

      case Actions.FOLLOW:
        return this.executeFollow(agentUserId, parameters);

      case Actions.UNFOLLOW:
        return this.executeUnfollow(agentUserId, parameters);

      case Actions.REPLY_COMMENT:
        return this.executeReplyComment(agentUserId, parameters, logContext);

      case Actions.REPLY_CHAT:
        // Special validation: REPLY_CHAT needs either DMs or groupChats based on chat type
        return this.executeReplyChat(
          agentUserId,
          parameters,
          enabledFeatures,
          logContext,
        );

      case Actions.DM:
        return this.executeDM(agentUserId, parameters, logContext);

      case Actions.GROUP_MESSAGE:
        return this.executeGroupMessage(agentUserId, parameters, logContext);

      case Actions.CREATE_GROUP:
        return this.executeCreateGroup(agentUserId, parameters, logContext);

      case Actions.INVITE_TO_GROUP:
        return this.executeInviteToGroup(agentUserId, parameters, logContext);

      case Actions.KICK_FROM_GROUP:
        return this.executeKickFromGroup(agentUserId, parameters, logContext);

      case Actions.LEAVE_GROUP:
        return this.executeLeaveGroup(agentUserId, parameters, logContext);

      case Actions.SEND_MONEY:
        return this.executeSendMoney(agentUserId, parameters);

      case Actions.SHARE_INFORMATION:
        return this.executeShareInformation(agentUserId, parameters);

      case Actions.REQUEST_PAYMENT:
        return this.executeRequestPayment(agentUserId, parameters);

      case Actions.WAIT:
      case Actions.FINISH:
      case "":
        return {
          actionType: normalizedAction || Actions.WAIT,
          success: true,
          summary:
            normalizedAction === Actions.FINISH
              ? "Agent decided to finish"
              : "Agent decided to wait",
          parameters,
          timestamp: Date.now(),
        };

      default:
        logger.warn(
          `[MultiStep] Unknown action: ${normalizedAction}`,
          undefined,
          "MultiStepExecutor",
        );
        return {
          actionType: normalizedAction,
          success: false,
          summary: `Unknown action: ${normalizedAction}`,
          error: `Action "${normalizedAction}" is not recognized`,
          parameters,
          timestamp: Date.now(),
        };
    }
  }

  private async recordTrajectoryStep(
    runtime: IAgentRuntime,
    decision: MultiStepDecision,
    actionResult: ActionTraceResult,
  ): Promise<void> {
    const activeStep = await ensureTrajectoryStep(runtime);
    if (!activeStep) {
      return;
    }

    // Set counterparty context on the step BEFORE completing it.
    // This is how the reward system knows who the agent was interacting with.
    const params = actionResult.parameters ?? {};
    const counterpartyId =
      (params.recipientId as string) ??
      (params.userId as string) ??
      (params.targetUserId as string) ??
      (params.targetAgentId as string) ??
      (params.counterpartyId as string);

    if (counterpartyId) {
      const identityMap = (
        runtime as {
          _agentIdentityMap?: Map<
            string,
            { team: string; alignment: string; instanceId: string }
          >;
        }
      )._agentIdentityMap;

      if (identityMap) {
        const identity = identityMap.get(counterpartyId);
        if (identity) {
          const agentTeam = (runtime as { _agentTeam?: string })._agentTeam;
          const sameTeam = agentTeam === identity.team;
          // setCounterpartyContext may not exist on all logger implementations
          if ("setCounterpartyContext" in activeStep.logger) {
            (
              activeStep.logger as {
                setCounterpartyContext: (...args: unknown[]) => void;
              }
            ).setCounterpartyContext(
              activeStep.trajectoryId,
              activeStep.stepId,
              {
                counterpartyId,
                counterpartyAlignment: identity.alignment as
                  | "good"
                  | "neutral"
                  | "evil",
                counterpartyTeam: identity.team as "red" | "blue" | "gray",
                senderRole: sameTeam ? "team" : "none",
                interactionIntent:
                  identity.team === "red"
                    ? "attack"
                    : identity.team === "blue"
                      ? "legitimate"
                      : "neutral",
              },
            );
          }
        }
      }
    }

    const parameterReasoning = this.getParameterReasoning(decision.parameters);
    activeStep.logger.completeStep(
      activeStep.trajectoryId,
      activeStep.stepId,
      {
        actionType: actionResult.actionType,
        actionName: actionResult.actionType,
        parameters: this.toJsonRecord(actionResult.parameters),
        success: actionResult.success,
        result: this.toJsonRecord(actionResult.result),
        error: actionResult.error,
        reasoning: parameterReasoning ?? decision.thought,
      },
      {
        reward: actionResult.success ? 0.1 : -0.1,
      },
    );
  }

  private toJsonRecord(
    value:
      | ActionTraceResult["parameters"]
      | Record<string, JsonValue>
      | Record<string, string | number | boolean | null | undefined>
      | undefined,
  ): Record<string, JsonValue> {
    if (!value) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [
        key,
        entryValue ?? null,
      ]),
    ) as Record<string, JsonValue>;
  }

  private getParameterReasoning(
    parameters: MultiStepDecision["parameters"],
  ): string | undefined {
    const reasoning = parameters.reasoning;
    return typeof reasoning === "string" ? reasoning : undefined;
  }

  // ===========================================================================
  // Action Executors
  // ===========================================================================

  private async executeTrade(
    agentUserId: string,
    parameters: Record<string, unknown>,
    ownerId: string = agentUserId,
  ): Promise<ActionTraceResult> {
    const marketType = parameters.marketType as "prediction" | "perp";
    const marketId = parameters.marketId as string;
    const side = parameters.side as string;
    const isSell = typeof side === "string" && side.startsWith("sell_");
    const amount =
      isSell && (parameters.amount === 0 || parameters.amount === "0")
        ? 0
        : Number(parameters.amount || 100);
    const reasoning = parameters.reasoning as string | undefined;

    if (!marketId || !side) {
      return {
        actionType: Actions.TRADE,
        success: false,
        summary: "Missing required parameters (marketId, side)",
        error: "Invalid parameters",
        parameters,
        timestamp: Date.now(),
      };
    }

    let tradeResult;
    try {
      tradeResult = await executeDirectTrade({
        agentUserId,
        marketType: marketType || "prediction",
        marketId,
        side: side as
          | "buy_yes"
          | "buy_no"
          | "sell_yes"
          | "sell_no"
          | "open_long"
          | "open_short"
          | "close_position",
        amount,
        reasoning,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(
        `[MultiStep] Trade execution failed: ${message}`,
        { agentUserId, marketType, marketId, side, amount },
        "MultiStepExecutor",
      );
      return {
        actionType: Actions.TRADE,
        success: false,
        summary: `Trade failed: ${message}`,
        error: message,
        parameters,
        timestamp: Date.now(),
      };
    }

    if (tradeResult.success) {
      trackAgentTradeExecuted(agentUserId, {
        agent_id: agentUserId,
        market_type: marketType || "prediction",
        action: side,
        market_id: tradeResult.marketId,
        ticker: tradeResult.ticker,
        side: tradeResult.side,
        amount,
        owner_id: ownerId,
      });
    }

    return {
      actionType: Actions.TRADE,
      success: tradeResult.success,
      summary: tradeResult.success
        ? `Traded ${side} $${amount} on ${tradeResult.marketId || tradeResult.ticker}`
        : `Trade failed: ${tradeResult.error}`,
      result: {
        success: tradeResult.success,
        marketId: tradeResult.marketId,
        ticker: tradeResult.ticker,
        side: tradeResult.side,
        shares: tradeResult.shares,
        error: tradeResult.error,
      },
      parameters,
      timestamp: Date.now(),
    };
  }

  private async executePost(
    agentUserId: string,
    parameters: Record<string, unknown>,
    logContext?: { prompt: string; completion: string; thought: string },
  ): Promise<ActionTraceResult> {
    // Post rate limiting removed — all agents can post freely

    const content = parameters.content as string;

    if (!content) {
      return {
        actionType: Actions.POST,
        success: false,
        summary: "Missing content parameter",
        error: "No content provided",
        parameters,
        timestamp: Date.now(),
      };
    }

    const postResult = await executeDirectPost({ agentUserId, content });

    if (postResult.success && logContext) {
      await agentService.createLog(agentUserId, {
        type: "post",
        level: "info",
        message: `Created post: ${content.substring(0, 100)}${content.length > 100 ? "..." : ""}`,
        prompt: logContext.prompt,
        completion: logContext.completion,
        thinking: logContext.thought,
        metadata: {
          postId: postResult.postId ?? null,
          contentLength: content.length,
        },
      });
    }

    return {
      actionType: Actions.POST,
      success: postResult.success,
      summary: postResult.success
        ? `Created post ${postResult.postId}`
        : `Post failed: ${postResult.error}`,
      result: {
        success: postResult.success,
        postId: postResult.postId,
        error: postResult.error,
      },
      parameters,
      timestamp: Date.now(),
    };
  }

  private async executeComment(
    agentUserId: string,
    parameters: Record<string, unknown>,
    logContext?: { prompt: string; completion: string; thought: string },
  ): Promise<ActionTraceResult> {
    const postId = parameters.postId as string;
    const content = parameters.content as string;
    const parentCommentId = parameters.parentCommentId as string | undefined;

    if (!postId || !content) {
      return {
        actionType: Actions.COMMENT,
        success: false,
        summary: "Missing required parameters (postId, content)",
        error: "Invalid parameters",
        parameters,
        timestamp: Date.now(),
      };
    }

    const commentResult = await executeDirectComment({
      agentUserId,
      postId,
      content,
      parentCommentId,
    });

    if (commentResult.success && logContext) {
      await agentService.createLog(agentUserId, {
        type: "comment",
        level: "info",
        message: `Created comment on post ${postId}${parentCommentId ? ` (reply to ${parentCommentId})` : ""}: ${content.substring(0, 100)}${content.length > 100 ? "..." : ""}`,
        prompt: logContext.prompt,
        completion: logContext.completion,
        thinking: logContext.thought,
        metadata: {
          commentId: commentResult.commentId ?? null,
          postId,
          parentCommentId: parentCommentId ?? null,
          contentLength: content.length,
        },
      });
    }

    return {
      actionType: Actions.COMMENT,
      success: commentResult.success,
      summary: commentResult.success
        ? `Created comment ${commentResult.commentId}`
        : `Comment failed: ${commentResult.error}`,
      result: {
        success: commentResult.success,
        commentId: commentResult.commentId,
        error: commentResult.error,
      },
      parameters,
      timestamp: Date.now(),
    };
  }

  private async executeLike(
    agentUserId: string,
    parameters: Record<string, unknown>,
  ): Promise<ActionTraceResult> {
    const postId = parameters.postId as string;

    if (!postId) {
      return {
        actionType: Actions.LIKE,
        success: false,
        summary: "Missing required parameter (postId)",
        error: "Invalid parameters",
        parameters,
        timestamp: Date.now(),
      };
    }

    const likeResult = await executeDirectLike({ agentUserId, postId });

    await agentService.createLog(agentUserId, {
      type: "like",
      level: likeResult.success ? "info" : "warn",
      message: likeResult.success
        ? `Liked post ${postId}`
        : `Like failed: ${likeResult.error}`,
      metadata: {
        postId,
        success: likeResult.success,
        liked: likeResult.liked ?? false,
        error: likeResult.error ?? null,
      },
    });

    return {
      actionType: Actions.LIKE,
      success: likeResult.success,
      summary: likeResult.success
        ? `Liked post ${postId}`
        : `Like failed: ${likeResult.error}`,
      result: {
        success: likeResult.success,
        liked: likeResult.liked,
        error: likeResult.error,
      },
      parameters,
      timestamp: Date.now(),
    };
  }

  private async executeRepost(
    agentUserId: string,
    parameters: Record<string, unknown>,
  ): Promise<ActionTraceResult> {
    const postId = parameters.postId as string;
    const comment = parameters.comment as string | undefined;

    if (!postId) {
      return {
        actionType: Actions.REPOST,
        success: false,
        summary: "Missing required parameter (postId)",
        error: "Invalid parameters",
        parameters,
        timestamp: Date.now(),
      };
    }

    const repostResult = await executeDirectRepost({
      agentUserId,
      postId,
      comment,
    });

    await agentService.createLog(agentUserId, {
      type: "repost",
      level: repostResult.success ? "info" : "warn",
      message: repostResult.success
        ? `Reposted ${postId}${comment ? " with comment" : ""}`
        : `Repost failed: ${repostResult.error}`,
      metadata: {
        postId,
        success: repostResult.success,
        repostId: repostResult.repostId ?? null,
        quotePostId: repostResult.quotePostId ?? null,
        hasComment: !!comment,
        error: repostResult.error ?? null,
      },
    });

    return {
      actionType: Actions.REPOST,
      success: repostResult.success,
      summary: repostResult.success
        ? `Reposted ${postId}${comment ? " with comment" : ""}`
        : `Repost failed: ${repostResult.error}`,
      result: {
        success: repostResult.success,
        repostId: repostResult.repostId,
        quotePostId: repostResult.quotePostId,
        error: repostResult.error,
      },
      parameters,
      timestamp: Date.now(),
    };
  }

  private async executeFollow(
    agentUserId: string,
    parameters: Record<string, unknown>,
  ): Promise<ActionTraceResult> {
    const targetUserId = (parameters.userId ||
      parameters.targetUserId) as string;

    if (!targetUserId) {
      return {
        actionType: Actions.FOLLOW,
        success: false,
        summary: "Missing required parameter (userId)",
        error: "Invalid parameters",
        parameters,
        timestamp: Date.now(),
      };
    }

    const followResult = await executeDirectFollow({
      agentUserId,
      targetUserId,
    });

    await agentService.createLog(agentUserId, {
      type: "follow",
      level: followResult.success ? "info" : "warn",
      message: followResult.success
        ? followResult.followed
          ? `Now following ${targetUserId}`
          : `Already following ${targetUserId}`
        : `Follow failed: ${followResult.error}`,
      metadata: {
        targetUserId,
        success: followResult.success,
        followed: followResult.followed ?? false,
        alreadyFollowing: followResult.alreadyFollowing ?? false,
        error: followResult.error ?? null,
      },
    });

    return {
      actionType: Actions.FOLLOW,
      success: followResult.success,
      summary: followResult.success
        ? followResult.followed
          ? `Now following ${targetUserId}`
          : `Already following ${targetUserId}`
        : `Follow failed: ${followResult.error}`,
      result: {
        success: followResult.success,
        followed: followResult.followed,
        alreadyFollowing: followResult.alreadyFollowing,
        error: followResult.error,
      },
      parameters,
      timestamp: Date.now(),
    };
  }

  private async executeUnfollow(
    agentUserId: string,
    parameters: Record<string, unknown>,
  ): Promise<ActionTraceResult> {
    const targetUserId = (parameters.userId ||
      parameters.targetUserId) as string;

    if (!targetUserId) {
      return {
        actionType: Actions.UNFOLLOW,
        success: false,
        summary: "Missing required parameter (userId)",
        error: "Invalid parameters",
        parameters,
        timestamp: Date.now(),
      };
    }

    const unfollowResult = await executeDirectUnfollow({
      agentUserId,
      targetUserId,
    });

    await agentService.createLog(agentUserId, {
      type: "follow",
      level: unfollowResult.success ? "info" : "warn",
      message: unfollowResult.success
        ? unfollowResult.unfollowed
          ? `Unfollowed ${targetUserId}`
          : `Was not following ${targetUserId}`
        : `Unfollow failed: ${unfollowResult.error}`,
      metadata: {
        targetUserId,
        success: unfollowResult.success,
        unfollowed: unfollowResult.unfollowed ?? false,
        wasFollowing: unfollowResult.wasFollowing ?? false,
        error: unfollowResult.error ?? null,
      },
    });

    return {
      actionType: Actions.UNFOLLOW,
      success: unfollowResult.success,
      summary: unfollowResult.success
        ? unfollowResult.unfollowed
          ? `Unfollowed ${targetUserId}`
          : `Was not following ${targetUserId}`
        : `Unfollow failed: ${unfollowResult.error}`,
      result: {
        success: unfollowResult.success,
        unfollowed: unfollowResult.unfollowed,
        wasFollowing: unfollowResult.wasFollowing,
        error: unfollowResult.error,
      },
      parameters,
      timestamp: Date.now(),
    };
  }

  private async executeSendMoney(
    agentUserId: string,
    parameters: Record<string, unknown>,
  ): Promise<ActionTraceResult> {
    const recipientId = this.coerceParameterText(parameters.recipientId);
    const amount = Number(parameters.amount);
    const reason = parameters.reason as string | undefined;

    if (!recipientId || !Number.isFinite(amount) || amount <= 0) {
      return {
        actionType: Actions.SEND_MONEY,
        success: false,
        summary: "Missing or invalid parameters (recipientId, amount)",
        error: "Invalid parameters",
        parameters,
        timestamp: Date.now(),
      };
    }

    const sendResult = await executeDirectSendMoney({
      agentUserId,
      recipientId,
      amount,
      reason,
    });

    await agentService.createLog(agentUserId, {
      type: "transfer",
      level: sendResult.success ? "info" : "warn",
      message: sendResult.success
        ? `Sent $${amount} to ${recipientId}`
        : `Send money failed: ${sendResult.error}`,
      metadata: {
        recipientId,
        amount,
        reason: reason ?? null,
        transactionId: sendResult.transactionId ?? null,
        success: sendResult.success,
        error: sendResult.error ?? null,
      },
    });

    return {
      actionType: Actions.SEND_MONEY,
      success: sendResult.success,
      summary: sendResult.success
        ? `Sent $${amount} to ${recipientId}`
        : `Send money failed: ${sendResult.error}`,
      result: {
        success: sendResult.success,
        transactionId: sendResult.transactionId,
        newBalance: sendResult.newBalance,
        error: sendResult.error,
      },
      parameters,
      timestamp: Date.now(),
    };
  }

  private async executeShareInformation(
    agentUserId: string,
    parameters: Record<string, unknown>,
  ): Promise<ActionTraceResult> {
    const recipientId = this.coerceParameterText(parameters.recipientId);
    const rawKeywords = parameters.keywords;
    const keywords: string[] = Array.isArray(rawKeywords)
      ? rawKeywords.map(String).filter(Boolean)
      : typeof rawKeywords === "string"
        ? rawKeywords
            .split(",")
            .map((k) => k.trim())
            .filter(Boolean)
        : [];
    const context = parameters.context as string | undefined;
    const askingPrice = Number(parameters.askingPrice) || 0;

    if (!recipientId || keywords.length === 0) {
      return {
        actionType: Actions.SHARE_INFORMATION,
        success: false,
        summary: "Missing parameters (recipientId, keywords[])",
        error: "Invalid parameters",
        parameters,
        timestamp: Date.now(),
      };
    }

    const result = await executeDirectShareInformation({
      agentUserId,
      recipientId,
      keywords,
      context,
      askingPrice,
    });

    return {
      actionType: Actions.SHARE_INFORMATION,
      success: result.success,
      summary: result.success
        ? `Shared ${result.matchCount} intel matches with ${recipientId}`
        : `Share information failed: ${result.error}`,
      result: {
        matchCount: result.matchCount,
        sharedWithRecipient: result.sharedWithRecipient,
        messageId: result.messageId,
        keywords: keywords.join(","),
      },
      parameters,
      timestamp: Date.now(),
    };
  }

  private async executeRequestPayment(
    agentUserId: string,
    parameters: Record<string, unknown>,
  ): Promise<ActionTraceResult> {
    const recipientId = this.coerceParameterText(parameters.recipientId);
    const amount = Number(parameters.amount);
    const reason = parameters.reason as string | undefined;
    const deadline = Number(parameters.deadline) || 10;

    if (!recipientId || !Number.isFinite(amount) || amount <= 0 || !reason) {
      return {
        actionType: Actions.REQUEST_PAYMENT,
        success: false,
        summary: "Missing parameters (recipientId, amount, reason)",
        error: "Invalid parameters",
        parameters,
        timestamp: Date.now(),
      };
    }

    const result = await executeDirectRequestPayment({
      agentUserId,
      recipientId,
      amount,
      reason,
      deadline,
    });

    return {
      actionType: Actions.REQUEST_PAYMENT,
      success: result.success,
      summary: result.success
        ? `Requested $${amount} from ${recipientId}: ${reason}`
        : `Payment request failed: ${result.error}`,
      result: {
        requestId: result.requestId,
        amount,
        recipientId,
        reason,
      },
      parameters,
      timestamp: Date.now(),
    };
  }

  private async executeReplyComment(
    agentUserId: string,
    parameters: Record<string, unknown>,
    logContext?: { prompt: string; completion: string; thought: string },
  ): Promise<ActionTraceResult> {
    const commentId = parameters.commentId as string;
    const postId = parameters.postId as string;
    const content = parameters.content as string;

    if (!commentId || !postId || !content) {
      return {
        actionType: Actions.REPLY_COMMENT,
        success: false,
        summary: "Missing required parameters (commentId, postId, content)",
        error: "Invalid parameters",
        parameters,
        timestamp: Date.now(),
      };
    }

    const commentResult = await executeDirectComment({
      agentUserId,
      postId,
      content,
      parentCommentId: commentId,
    });

    if (logContext) {
      await agentService.createLog(agentUserId, {
        type: "comment",
        level: commentResult.success ? "info" : "warn",
        message: commentResult.success
          ? `Replied to comment ${commentId}: ${content.substring(0, 100)}${content.length > 100 ? "..." : ""}`
          : `Reply failed: ${commentResult.error}`,
        prompt: logContext.prompt,
        completion: logContext.completion,
        thinking: logContext.thought,
        metadata: {
          commentId: commentResult.commentId ?? null,
          parentCommentId: commentId,
          postId,
          contentLength: content.length,
          error: commentResult.error ?? null,
        },
      });
    }

    return {
      actionType: Actions.REPLY_COMMENT,
      success: commentResult.success,
      summary: commentResult.success
        ? `Replied to comment ${commentId}`
        : `Reply failed: ${commentResult.error}`,
      result: {
        success: commentResult.success,
        commentId: commentResult.commentId,
        error: commentResult.error,
      },
      parameters,
      timestamp: Date.now(),
    };
  }

  private async executeReplyChat(
    agentUserId: string,
    parameters: Record<string, unknown>,
    enabledFeatures: string[],
    logContext?: { prompt: string; completion: string; thought: string },
  ): Promise<ActionTraceResult> {
    const chatId = parameters.chatId as string;
    const content = parameters.content as string;

    if (!chatId || !content) {
      return {
        actionType: Actions.REPLY_CHAT,
        success: false,
        summary: "Missing required parameters (chatId, content)",
        error: "Invalid parameters",
        parameters,
        timestamp: Date.now(),
      };
    }

    // Look up the chat to determine if it's a group chat or DM
    const [chat] = await db
      .select({ isGroup: chats.isGroup })
      .from(chats)
      .where(eq(chats.id, chatId))
      .limit(1);

    if (!chat) {
      return {
        actionType: Actions.REPLY_CHAT,
        success: false,
        summary: "Chat not found",
        error: "Invalid chatId",
        parameters,
        timestamp: Date.now(),
      };
    }

    // Validate feature based on chat type
    const requiredFeature = chat.isGroup ? Features.GROUP_CHATS : Features.DMS;
    if (!enabledFeatures.includes(requiredFeature)) {
      return {
        actionType: Actions.REPLY_CHAT,
        success: false,
        summary: `Cannot reply: ${requiredFeature} feature is not enabled`,
        error: `Feature "${requiredFeature}" is disabled`,
        parameters,
        timestamp: Date.now(),
      };
    }

    const messageResult = await executeDirectMessage({
      agentUserId,
      chatId,
      content,
    });

    if (logContext) {
      await agentService.createLog(agentUserId, {
        type: "chat",
        level: messageResult.success ? "info" : "warn",
        message: messageResult.success
          ? `Replied in chat ${chatId}: ${content.substring(0, 100)}${content.length > 100 ? "..." : ""}`
          : `Chat reply failed: ${messageResult.error}`,
        prompt: logContext.prompt,
        completion: logContext.completion,
        thinking: logContext.thought,
        metadata: {
          messageId: messageResult.messageId ?? null,
          chatId,
          contentLength: content.length,
          error: messageResult.error ?? null,
        },
      });
    }

    return {
      actionType: Actions.REPLY_CHAT,
      success: messageResult.success,
      summary: messageResult.success
        ? `Replied in chat ${chatId}`
        : `Chat reply failed: ${messageResult.error}`,
      result: {
        success: messageResult.success,
        messageId: messageResult.messageId,
        error: messageResult.error,
      },
      parameters,
      timestamp: Date.now(),
    };
  }

  private async executeDM(
    agentUserId: string,
    parameters: Record<string, unknown>,
    logContext?: { prompt: string; completion: string; thought: string },
  ): Promise<ActionTraceResult> {
    const recipientId = parameters.recipientId as string;
    const content = parameters.content as string;

    if (!recipientId || !content) {
      return {
        actionType: Actions.DM,
        success: false,
        summary: "Missing required parameters (recipientId, content)",
        error: "Invalid parameters",
        parameters,
        timestamp: Date.now(),
      };
    }

    if (recipientId === agentUserId) {
      return {
        actionType: Actions.DM,
        success: false,
        summary: "Cannot DM yourself",
        error: "Cannot DM yourself",
        parameters,
        timestamp: Date.now(),
      };
    }

    const messageResult = await executeDirectMessage({
      agentUserId,
      recipientId,
      content,
    });

    if (logContext) {
      await agentService.createLog(agentUserId, {
        type: "dm",
        level: messageResult.success ? "info" : "warn",
        message: messageResult.success
          ? `Sent DM to ${recipientId}: ${content.substring(0, 100)}${content.length > 100 ? "..." : ""}`
          : `Failed to send DM to ${recipientId}: ${messageResult.error}`,
        prompt: logContext.prompt,
        completion: logContext.completion,
        thinking: logContext.thought,
        metadata: {
          messageId: messageResult.messageId ?? null,
          recipientId,
          contentLength: content.length,
          error: messageResult.error ?? null,
        },
      });
    }

    return {
      actionType: Actions.DM,
      success: messageResult.success,
      summary: messageResult.success
        ? `Sent message ${messageResult.messageId} to ${recipientId}`
        : `Message failed: ${messageResult.error}`,
      result: {
        success: messageResult.success,
        messageId: messageResult.messageId,
        error: messageResult.error,
      },
      parameters,
      timestamp: Date.now(),
    };
  }

  private async executeGroupMessage(
    agentUserId: string,
    parameters: Record<string, unknown>,
    logContext?: { prompt: string; completion: string; thought: string },
  ): Promise<ActionTraceResult> {
    const chatId = parameters.chatId as string;
    const content = parameters.content as string;

    if (!chatId || !content) {
      return {
        actionType: Actions.GROUP_MESSAGE,
        success: false,
        summary: "Missing required parameters (chatId, content)",
        error: "Invalid parameters",
        parameters,
        timestamp: Date.now(),
      };
    }

    // Validate that the chat is actually a group chat
    const [chat] = await db
      .select({ isGroup: chats.isGroup })
      .from(chats)
      .where(eq(chats.id, chatId))
      .limit(1);

    if (!chat) {
      return {
        actionType: Actions.GROUP_MESSAGE,
        success: false,
        summary: "Chat not found",
        error: "Invalid chatId",
        parameters,
        timestamp: Date.now(),
      };
    }

    if (!chat.isGroup) {
      return {
        actionType: Actions.GROUP_MESSAGE,
        success: false,
        summary:
          "Cannot use GROUP_MESSAGE on a DM chat - use DM or REPLY_CHAT instead",
        error: "Chat is not a group chat",
        parameters,
        timestamp: Date.now(),
      };
    }

    const groupMessageResult = await executeDirectMessage({
      agentUserId,
      chatId,
      content,
    });

    await agentService.createLog(agentUserId, {
      type: "chat",
      level: groupMessageResult.success ? "info" : "warn",
      message: groupMessageResult.success
        ? `Sent group message to chat ${chatId}: ${content.substring(0, 100)}${content.length > 100 ? "..." : ""}`
        : `Failed to send group message: ${groupMessageResult.error}`,
      prompt: logContext?.prompt ?? undefined,
      completion: logContext?.completion ?? undefined,
      thinking: logContext?.thought ?? undefined,
      metadata: {
        messageId: groupMessageResult.messageId ?? null,
        chatId,
        contentLength: content.length,
        error: groupMessageResult.error ?? null,
      },
    });

    return {
      actionType: Actions.GROUP_MESSAGE,
      success: groupMessageResult.success,
      summary: groupMessageResult.success
        ? `Sent message to group chat ${chatId}`
        : `Group message failed: ${groupMessageResult.error}`,
      result: {
        success: groupMessageResult.success,
        messageId: groupMessageResult.messageId,
        error: groupMessageResult.error,
      },
      parameters,
      timestamp: Date.now(),
    };
  }

  private async executeCreateGroup(
    agentUserId: string,
    parameters: Record<string, unknown>,
    logContext?: { prompt: string; completion: string; thought: string },
  ): Promise<ActionTraceResult> {
    const name =
      typeof parameters.name === "string" ? parameters.name.trim() : "";
    const description =
      typeof parameters.description === "string"
        ? parameters.description.trim()
        : undefined;
    const memberIdsRaw =
      typeof parameters.memberIds === "string"
        ? parameters.memberIds
            .split(",")
            .map((id: string) => id.trim())
            .filter(Boolean)
        : [];

    if (!name) {
      return {
        actionType: Actions.CREATE_GROUP,
        success: false,
        summary: "Missing required parameter: name",
        error: "Invalid parameters",
        parameters,
        timestamp: Date.now(),
      };
    }

    const result = await executeDirectCreateGroup({
      agentUserId,
      name,
      description,
      memberIds: memberIdsRaw,
    });

    await agentService.createLog(agentUserId, {
      type: "chat",
      level: result.success ? "info" : "warn",
      message: result.success
        ? `Created group "${name}" (${result.groupId})`
        : `Failed to create group: ${result.error}`,
      prompt: logContext?.prompt ?? undefined,
      completion: logContext?.completion ?? undefined,
      thinking: logContext?.thought ?? undefined,
      metadata: {
        groupId: result.groupId ?? null,
        chatId: result.chatId ?? null,
        error: result.error ?? null,
      },
    });

    return {
      actionType: Actions.CREATE_GROUP,
      success: result.success,
      summary: result.success
        ? `Created group "${name}"`
        : `Create group failed: ${result.error}`,
      result: {
        success: result.success,
        groupId: result.groupId,
        chatId: result.chatId,
        error: result.error,
      },
      parameters,
      timestamp: Date.now(),
    };
  }

  private async executeInviteToGroup(
    agentUserId: string,
    parameters: Record<string, unknown>,
    logContext?: { prompt: string; completion: string; thought: string },
  ): Promise<ActionTraceResult> {
    const groupId = this.coerceParameterText(parameters.groupId);
    const userId = this.coerceParameterText(parameters.userId);

    if (!groupId || !userId) {
      return {
        actionType: Actions.INVITE_TO_GROUP,
        success: false,
        summary: "Missing required parameters (groupId, userId)",
        error: "Invalid parameters",
        parameters,
        timestamp: Date.now(),
      };
    }

    const result = await executeDirectInviteToGroup({
      agentUserId,
      groupId,
      targetUserId: userId,
    });

    await agentService.createLog(agentUserId, {
      type: "chat",
      level: result.success ? "info" : "warn",
      message: result.success
        ? `Invited ${userId} to group ${groupId}${result.alreadyMember ? " (already member)" : ""}`
        : `Failed to invite to group: ${result.error}`,
      prompt: logContext?.prompt ?? undefined,
      completion: logContext?.completion ?? undefined,
      thinking: logContext?.thought ?? undefined,
      metadata: {
        groupId,
        userId,
        alreadyMember: result.alreadyMember ?? null,
        error: result.error ?? null,
      },
    });

    return {
      actionType: Actions.INVITE_TO_GROUP,
      success: result.success,
      summary: result.success
        ? `Invited user to group${result.alreadyMember ? " (already member)" : ""}`
        : `Invite failed: ${result.error}`,
      result: {
        success: result.success,
        alreadyMember: result.alreadyMember,
        error: result.error,
      },
      parameters,
      timestamp: Date.now(),
    };
  }

  private async executeKickFromGroup(
    agentUserId: string,
    parameters: Record<string, unknown>,
    logContext?: { prompt: string; completion: string; thought: string },
  ): Promise<ActionTraceResult> {
    const groupId = this.coerceParameterText(parameters.groupId);
    const userId = this.coerceParameterText(parameters.userId);
    const reason =
      typeof parameters.reason === "string"
        ? parameters.reason.trim()
        : undefined;

    if (!groupId || !userId) {
      return {
        actionType: Actions.KICK_FROM_GROUP,
        success: false,
        summary: "Missing required parameters (groupId, userId)",
        error: "Invalid parameters",
        parameters,
        timestamp: Date.now(),
      };
    }

    const result = await executeDirectKickFromGroup({
      agentUserId,
      groupId,
      targetUserId: userId,
      reason,
    });

    await agentService.createLog(agentUserId, {
      type: "chat",
      level: result.success ? "info" : "warn",
      message: result.success
        ? `Kicked ${userId} from group ${groupId}`
        : `Failed to kick from group: ${result.error}`,
      prompt: logContext?.prompt ?? undefined,
      completion: logContext?.completion ?? undefined,
      thinking: logContext?.thought ?? undefined,
      metadata: {
        groupId,
        userId,
        reason: reason ?? null,
        error: result.error ?? null,
      },
    });

    return {
      actionType: Actions.KICK_FROM_GROUP,
      success: result.success,
      summary: result.success
        ? `Kicked user from group`
        : `Kick failed: ${result.error}`,
      result: {
        success: result.success,
        error: result.error,
      },
      parameters,
      timestamp: Date.now(),
    };
  }

  private async executeLeaveGroup(
    agentUserId: string,
    parameters: Record<string, unknown>,
    logContext?: { prompt: string; completion: string; thought: string },
  ): Promise<ActionTraceResult> {
    const groupId = this.coerceParameterText(parameters.groupId);

    if (!groupId) {
      return {
        actionType: Actions.LEAVE_GROUP,
        success: false,
        summary: "Missing required parameter: groupId",
        error: "Invalid parameters",
        parameters,
        timestamp: Date.now(),
      };
    }

    const result = await executeDirectLeaveGroup({
      agentUserId,
      groupId,
    });

    await agentService.createLog(agentUserId, {
      type: "chat",
      level: result.success ? "info" : "warn",
      message: result.success
        ? `Left group ${groupId}`
        : `Failed to leave group: ${result.error}`,
      prompt: logContext?.prompt ?? undefined,
      completion: logContext?.completion ?? undefined,
      thinking: logContext?.thought ?? undefined,
      metadata: {
        groupId,
        error: result.error ?? null,
      },
    });

    return {
      actionType: Actions.LEAVE_GROUP,
      success: result.success,
      summary: result.success ? `Left group` : `Leave failed: ${result.error}`,
      result: {
        success: result.success,
        error: result.error,
      },
      parameters,
      timestamp: Date.now(),
    };
  }

  // ===========================================================================
  // Result Aggregation
  // ===========================================================================

  private aggregateResults(
    trace: ActionTraceResult[],
    startTime: number,
  ): MultiStepExecutorResult {
    const counts = {
      trades: 0,
      posts: 0,
      comments: 0,
      messages: 0,
      engagements: 0,
    };

    for (const result of trace) {
      if (!result.success) continue;

      switch (result.actionType) {
        case Actions.TRADE:
        case Actions.SEND_MONEY:
          counts.trades++;
          break;
        case Actions.POST:
          counts.posts++;
          break;
        case Actions.COMMENT:
        case Actions.REPLY_COMMENT:
          counts.comments++;
          break;
        case Actions.DM:
        case Actions.GROUP_MESSAGE:
        case Actions.CREATE_GROUP:
        case Actions.INVITE_TO_GROUP:
        case Actions.KICK_FROM_GROUP:
        case Actions.LEAVE_GROUP:
        case Actions.REPLY_CHAT:
        case Actions.SHARE_INFORMATION:
        case Actions.REQUEST_PAYMENT:
          counts.messages++;
          break;
        case Actions.LIKE:
        case Actions.REPOST:
        case Actions.FOLLOW:
        case Actions.UNFOLLOW:
          counts.engagements++;
          break;
      }
    }

    const hasMeaningfulAttempt = trace.some(
      (r) => r.actionType !== Actions.WAIT && r.actionType !== Actions.FINISH,
    );

    return {
      success: hasMeaningfulAttempt,
      actionsExecuted: counts,
      iterations: trace.length,
      trace,
      duration: Date.now() - startTime,
    };
  }
}

// Export singleton instance
export const multiStepExecutor = new MultiStepExecutor();
