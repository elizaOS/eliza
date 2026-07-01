/**
 * Autonomous Planning Coordinator
 *
 * Orchestrates multi-action planning and execution for autonomous agents.
 * Considers goals, constraints, and opportunities to generate comprehensive action plans.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { countTokensSync, truncateToTokenLimitSync } from "@feed/api";
import type { JsonValue } from "@feed/db";
import {
  agentLogs,
  and,
  db,
  desc,
  eq,
  getDbInstance,
  inArray,
  isNull,
  perpPositions,
  positions,
  users,
} from "@feed/db";
import { StaticDataRegistry, type StaticOrganization } from "@feed/engine";
import { sql } from "drizzle-orm";
import { callGroqDirect } from "../llm/direct-groq";
import { getAgentConfig } from "../shared/agent-config";
import { logger } from "../shared/logger";
import { generateSnowflakeId } from "../shared/snowflake";
import type {
  AgentConstraints,
  AgentDirective,
  AgentGoal,
} from "../types/goals";
import { autonomousBatchResponseService } from "./AutonomousBatchResponseService";
import { autonomousCommentingService } from "./AutonomousCommentingService";
import { autonomousDMService } from "./AutonomousDMService";
import { autonomousPostingService } from "./AutonomousPostingService";
import { autonomousTradingService } from "./AutonomousTradingService";
import type {
  PendingChatMessage,
  PendingCommentReply,
} from "./templates/multi-step-decision";
import {
  gatherPendingChatMessages,
  gatherPendingCommentReplies,
} from "./utils";
import { getPredictionMarketPrices } from "./utils/prediction-pricing";

/**
 * Agent interface for planning
 *
 * Represents agent configuration needed for action planning.
 * Directives are stored as AgentDirective[], constraints as AgentConstraints.
 */
interface PlanningAgent {
  agentSystem?: string;
  displayName: string;
  /** Agent directives stored as JSON array */
  agentDirectives?: AgentDirective[] | JsonValue | null;
  /** Agent constraints stored as JSON object */
  agentConstraints?: AgentConstraints | JsonValue | null;
  agentMaxActionsPerTick?: number;
  agentRiskTolerance?: string;
  autonomousTrading?: boolean;
  autonomousPosting?: boolean;
  autonomousCommenting?: boolean;
  autonomousDMs?: boolean;
}

/**
 * Planned action definition
 */
export interface PlannedAction {
  type: "trade" | "post" | "comment" | "message" | "respond";
  priority: number; // 1-10
  reasoning: string;
  goalId?: string; // Which goal does this serve?
  estimatedImpact: number; // Expected progress toward goal (0-1)
  params: Record<string, JsonValue>;
  constraints?: string[]; // Which constraints apply
}

/**
 * Complete action plan
 */
export interface ActionPlan {
  actions: PlannedAction[];
  totalActions: number;
  reasoning: string;
  goalsAddressed: string[];
  estimatedCost: number; // Expected points cost
}

/**
 * Planning context (all info needed for decision making)
 */
export interface PlanningContext {
  goals: {
    active: AgentGoal[];
    completed: AgentGoal[];
  };
  directives: {
    always: AgentDirective[];
    never: AgentDirective[];
    prefer: AgentDirective[];
    avoid: AgentDirective[];
  };
  constraints: AgentConstraints | null;
  portfolio: {
    balance: number;
    pnl: number;
    positions: number;
  };
  pending: Array<{
    type: string;
    content: string;
    author: string;
  }>;
  opportunities: {
    trading: Array<{
      market: string;
      description: string;
      confidence: number;
      expectedValue: number;
    }>;
    social: Array<{
      type: string;
      description: string;
      engagementScore: number;
    }>;
  };
  recentActions: Array<{
    type: string;
    timestamp: Date;
    success: boolean;
  }>;
}

/**
 * Autonomous action execution result
 *
 * Contains detailed results from executing an action plan, including
 * success/failure counts and per-action results.
 */
export interface AutonomousExecutionResult {
  /** Number of actions planned */
  planned: number;
  /** Number of actions executed */
  executed: number;
  /** Number of actions that succeeded */
  successful: number;
  /** Number of actions that failed */
  failed: number;
  /** Detailed results for each action */
  results: Array<{
    action: PlannedAction;
    success: boolean;
    /** Action-specific result data (type varies by action type) */
    result?: JsonValue;
    /** Error message if action failed */
    error?: string;
  }>;
  /** IDs of goals that were updated during execution */
  goalsUpdated: string[];
}

export class AutonomousPlanningCoordinator {
  /**
   * Generate a comprehensive action plan for this tick
   *
   * Analyzes agent goals, constraints, and current state to generate
   * a multi-action plan that maximizes progress toward objectives.
   *
   * @param agentUserId - Unique identifier for the agent
   * @param _runtime - Agent runtime (used for W&B model access)
   * @returns ActionPlan with prioritized actions and reasoning
   * @throws Error if agent not found
   *
   * @remarks
   * - Uses large model (W&B trained if available) for complex planning
   * - Falls back to simple plan if no goals configured
   * - Validates plan against agent constraints
   * - Truncates prompt if exceeds 30K tokens
   */
  async generateActionPlan(
    agentUserId: string,
    _runtime: IAgentRuntime,
  ): Promise<ActionPlan> {
    logger.info(
      `Generating action plan for agent ${agentUserId}`,
      undefined,
      "PlanningCoordinator",
    );

    const [agent] = await db
      .select()
      .from(users)
      .where(eq(users.id, agentUserId))
      .limit(1);

    if (!agent) {
      throw new Error("Agent not found");
    }

    // Get agent config from separate table
    const agentConfig = await getAgentConfig(agentUserId);

    // Gather full planning context
    const context = await this.getPlanningContext(agentUserId);

    // Convert agent to PlanningAgent (null -> undefined for optional fields)
    const planningAgent: PlanningAgent = {
      displayName: agent.displayName ?? "Agent",
      agentSystem: agentConfig?.systemPrompt ?? undefined,
      agentMaxActionsPerTick: agentConfig?.maxActionsPerTick ?? undefined,
      agentRiskTolerance: agentConfig?.riskTolerance ?? undefined,
      autonomousTrading: agentConfig?.autonomousTrading ?? undefined,
      autonomousPosting: agentConfig?.autonomousPosting ?? undefined,
      autonomousCommenting: agentConfig?.autonomousCommenting ?? undefined,
      autonomousDMs: agentConfig?.autonomousDMs ?? undefined,
    };

    // If no goals configured, use simplified planning
    if (context.goals.active.length === 0) {
      logger.info(
        "No goals configured, using simple single-action mode",
        undefined,
        "PlanningCoordinator",
      );
      return this.generateSimplePlan(planningAgent, context);
    }

    // Build enhanced planning prompt
    const prompt = this.buildPlanningPrompt(planningAgent, context);

    // Ensure prompt fits within 32K context limit (W&B trained models)
    const estimatedTokens = countTokensSync(prompt);
    let finalPrompt = prompt;

    if (estimatedTokens > 30000) {
      // 30K with 2K safety margin
      logger.warn(
        `Planning prompt too long: ${estimatedTokens} tokens, truncating`,
        { agentUserId: agent.id },
      );
      const truncated = truncateToTokenLimitSync(prompt, 30000, {
        ellipsis: true,
      });
      finalPrompt = truncated.text;
      logger.info(`Truncated to ${truncated.tokens} tokens`, {
        agentUserId: agent.id,
      });
    }

    // Use the large configured model for complex planning.
    const planResponse = await callGroqDirect({
      prompt: finalPrompt,
      system: planningAgent.agentSystem ?? undefined,
      modelSize: "large", // Uses trained W&B model if available
      runtime: _runtime, // Pass runtime to access W&B trained models AND trajectory context
      temperature: 0.7,
      maxTokens: 1500, // Allow detailed planning
      actionType: "generate_action_plan",
      purpose: "reasoning", // RLAIF: This is a planning/reasoning call
    });

    // Parse action plan
    const plan = this.parseActionPlan(planResponse, context);

    // Validate against constraints
    const validatedPlan = this.validatePlan(
      plan,
      planningAgent,
      context.constraints,
    );

    logger.info(
      `Generated plan with ${validatedPlan.totalActions} actions`,
      {
        agentId: agentUserId,
        actions: validatedPlan.actions.map((a) => a.type),
        goalsAddressed: validatedPlan.goalsAddressed,
      },
      "PlanningCoordinator",
    );

    return validatedPlan;
  }

  /**
   * Gather all context needed for planning
   */
  private async getPlanningContext(
    agentUserId: string,
  ): Promise<PlanningContext> {
    // Get goals
    const goals = await db.agentGoal.findMany({
      where: { agentUserId },
      orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
    });

    const activeGoals = goals
      .filter((g) => g.status === "active")
      .map((g) => ({
        ...g,
        target: g.target ? JSON.parse(JSON.stringify(g.target)) : undefined,
      })) as AgentGoal[];

    const completedGoals = goals
      .filter((g) => g.status === "completed")
      .map((g) => ({
        ...g,
        target: g.target ? JSON.parse(JSON.stringify(g.target)) : undefined,
      })) as AgentGoal[];

    // Get user and agent config
    const [user] = await db
      .select({
        virtualBalance: users.virtualBalance,
        lifetimePnL: users.lifetimePnL,
      })
      .from(users)
      .where(eq(users.id, agentUserId))
      .limit(1);

    const config = await getAgentConfig(agentUserId);

    const directives = config?.directives
      ? (JSON.parse(JSON.stringify(config.directives)) as AgentDirective[])
      : [];

    const constraints = config?.constraints
      ? (JSON.parse(JSON.stringify(config.constraints)) as AgentConstraints)
      : null;

    // If constraints exist, merge with agent settings
    if (constraints && config) {
      constraints.general.maxActionsPerTick = config.maxActionsPerTick;
      constraints.general.riskTolerance = config.riskTolerance as
        | "low"
        | "medium"
        | "high";
    }

    // Get portfolio info
    const [positionCountResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(positions)
      .where(
        and(eq(positions.userId, agentUserId), eq(positions.status, "active")),
      );
    const positionsCount = positionCountResult?.count ?? 0;

    const [perpPositionCountResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(perpPositions)
      .where(
        and(
          eq(perpPositions.userId, agentUserId),
          isNull(perpPositions.closedAt),
        ),
      );
    const perpPositionsCount = perpPositionCountResult?.count ?? 0;

    // Get pending interactions using new utilities
    const [pendingCommentReplies, pendingChatMessages] = await Promise.all([
      gatherPendingCommentReplies(agentUserId),
      gatherPendingChatMessages(agentUserId),
    ]);

    // Get recent actions (last 10)
    const recentLogs = await db
      .select()
      .from(agentLogs)
      .where(
        and(
          eq(agentLogs.agentUserId, agentUserId),
          inArray(agentLogs.type, ["trade", "post", "comment", "dm"]),
        ),
      )
      .orderBy(desc(agentLogs.createdAt))
      .limit(10);

    // Detect trading opportunities
    const tradingOpportunities = await detectTradingOpportunities(
      agentUserId,
      Number(user?.virtualBalance ?? 0),
    );

    // Detect social opportunities
    const socialOpportunities = await detectSocialOpportunities(
      agentUserId,
      pendingCommentReplies,
      pendingChatMessages,
    );

    // Combine pending interactions for context (convert to unified format)
    const pendingForContext = [
      ...pendingCommentReplies.slice(0, 5).map((p) => ({
        type: "comment_reply" as const,
        content: p.content,
        author: p.author,
      })),
      ...pendingChatMessages.slice(0, 5).map((p) => ({
        type: p.isGroupChat ? ("group_message" as const) : ("dm" as const),
        content: p.content,
        author: p.author,
      })),
    ];

    return {
      goals: {
        active: activeGoals,
        completed: completedGoals,
      },
      directives: {
        always: directives.filter((d) => d.type === "always"),
        never: directives.filter((d) => d.type === "never"),
        prefer: directives.filter((d) => d.type === "prefer"),
        avoid: directives.filter((d) => d.type === "avoid"),
      },
      constraints,
      portfolio: {
        balance: Number(user?.virtualBalance ?? 0),
        pnl: Number(user?.lifetimePnL ?? 0),
        positions: positionsCount + perpPositionsCount,
      },
      pending: pendingForContext.slice(0, 10),
      opportunities: {
        trading: tradingOpportunities,
        social: socialOpportunities,
      },
      recentActions: recentLogs.map((log) => ({
        type: log.type,
        timestamp: log.createdAt,
        success: log.level !== "error",
      })),
    };
  }

  /**
   * Build comprehensive planning prompt
   */
  private buildPlanningPrompt(
    agent: PlanningAgent,
    context: PlanningContext,
  ): string {
    const goalsText =
      context.goals.active.length > 0
        ? context.goals.active
            .map((g, i) => {
              const targetInfo = g.target
                ? `Target: ${g.target.metric} = ${g.target.value}${g.target.unit || ""}`
                : "";
              return `${i + 1}. ${g.name} (Priority: ${g.priority}/10) - ${(g.progress * 100).toFixed(0)}% complete
   ${g.description}
   ${targetInfo}`;
            })
            .join("\n\n")
        : "No goals configured";

    const directivesText =
      [
        ...context.directives.always.map((d) => `✓ ALWAYS: ${d.rule}`),
        ...context.directives.never.map((d) => `✗ NEVER: ${d.rule}`),
        ...context.directives.prefer.map((d) => `+ PREFER: ${d.rule}`),
      ].join("\n") || "No directives";

    const constraintsText = context.constraints
      ? `- Max actions this tick: ${context.constraints.general.maxActionsPerTick}
- Max position: $${context.constraints.trading.maxPositionSize}
- Max leverage: ${context.constraints.trading.maxLeverage}x
- Risk tolerance: ${context.constraints.general.riskTolerance}`
      : "No specific constraints";

    const pendingText =
      context.pending.length > 0
        ? context.pending
            .slice(0, 5)
            .map(
              (p) =>
                `- ${p.type}: "${p.content.substring(0, 60)}..." by ${p.author}`,
            )
            .join("\n")
        : "None";

    return `${agent.agentSystem}

You are ${agent.displayName}, planning your actions for this autonomous tick.

=== YOUR GOALS (in priority order) ===
${goalsText}

=== YOUR DIRECTIVES (rules you must follow) ===
${directivesText}

=== YOUR CONSTRAINTS ===
${constraintsText}

=== CURRENT SITUATION ===
Portfolio:
- Balance: $${context.portfolio.balance.toFixed(2)}
- Lifetime P&L: ${context.portfolio.pnl >= 0 ? "+" : ""}$${context.portfolio.pnl.toFixed(2)}
- Open positions: ${context.portfolio.positions}

Capabilities enabled:
${agent.autonomousTrading ? "✓ Trading" : "✗ Trading"}
${agent.autonomousPosting ? "✓ Posting" : "✗ Posting"}
${agent.autonomousCommenting ? "✓ Commenting" : "✗ Commenting"}
${agent.autonomousDMs ? "✓ Direct messages" : "✗ Direct messages"}

Pending interactions (${context.pending.length}):
${pendingText}

Recent actions (last 10):
${context.recentActions
  .slice(0, 10)
  .map((a) => `- ${a.type}: ${a.success ? "success" : "failed"}`)
  .join("\n")}

=== YOUR TASK ===
Plan ${context.constraints?.general.maxActionsPerTick || 3} or fewer actions for this tick to make maximum progress toward your goals.

Consider:
1. Which goals have highest priority?
2. What actions will have most impact?
3. Are there urgent responses needed?
4. Am I within my constraints?
5. Am I following my directives?

IMPORTANT:
- Every action should advance a goal
- Respect all constraints and directives
- Prioritize high-impact actions
- Balance different goal types
- Consider opportunity cost

Respond in JSON format:
{
  "reasoning": "Overall strategy for this tick and how it serves your goals",
  "actions": [
    {
      "type": "trade" | "post" | "comment" | "respond",
      "priority": 1-10,
      "goalId": "goal_id or null if general",
      "reasoning": "How this advances your goals",
      "estimatedImpact": 0.0-1.0,
      "params": {
        // Action-specific parameters will be determined by execution layer
      }
    }
  ]
}

Your action plan (JSON only):`;
  }

  /**
   * Parse action plan from LLM response
   */
  private parseActionPlan(
    response: string,
    _context: PlanningContext,
  ): ActionPlan {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn(
        "No JSON found in planning response, using empty plan",
        undefined,
        "PlanningCoordinator",
      );
      return {
        actions: [],
        totalActions: 0,
        reasoning: "No valid plan generated",
        goalsAddressed: [],
        estimatedCost: 0,
      };
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      reasoning: string;
      actions: Array<{
        type: string;
        priority: number;
        goalId?: string;
        reasoning: string;
        estimatedImpact: number;
        params?: Record<string, JsonValue>;
      }>;
    };

    const actions: PlannedAction[] = parsed.actions.map((a) => ({
      type: a.type as PlannedAction["type"],
      priority: a.priority,
      goalId: a.goalId,
      reasoning: a.reasoning,
      estimatedImpact: a.estimatedImpact,
      params: a.params || {},
    }));

    const goalsAddressed = [
      ...new Set(actions.map((a) => a.goalId).filter(Boolean)),
    ] as string[];

    return {
      actions,
      totalActions: actions.length,
      reasoning: parsed.reasoning,
      goalsAddressed,
      estimatedCost: actions.length, // Simple: 1 point per action
    };
  }

  /**
   * Validate plan against constraints
   */
  private validatePlan(
    plan: ActionPlan,
    agent: PlanningAgent,
    constraints: AgentConstraints | null,
  ): ActionPlan {
    let validActions = [...plan.actions];

    // Enforce max actions per tick
    const maxActions =
      constraints?.general.maxActionsPerTick ||
      agent.agentMaxActionsPerTick ||
      3;
    if (validActions.length > maxActions) {
      logger.warn(
        `Plan has ${validActions.length} actions, limiting to ${maxActions}`,
        undefined,
        "PlanningCoordinator",
      );
      validActions = validActions
        .sort((a, b) => b.priority - a.priority)
        .slice(0, maxActions);
    }

    // Filter by enabled capabilities
    validActions = validActions.filter((action) => {
      switch (action.type) {
        case "trade":
          return agent.autonomousTrading;
        case "post":
          return agent.autonomousPosting;
        case "comment":
        case "respond":
          return agent.autonomousCommenting;
        case "message":
          return agent.autonomousDMs;
        default:
          return true;
      }
    });

    return {
      ...plan,
      actions: validActions,
      totalActions: validActions.length,
    };
  }

  /**
   * Generate simple plan for agents without goals (simple mode)
   */
  private generateSimplePlan(
    agent: PlanningAgent,
    context: PlanningContext,
  ): ActionPlan {
    const actions: PlannedAction[] = [];

    // Respond to pending interactions (priority 1)
    if (context.pending.length > 0 && agent.autonomousCommenting) {
      actions.push({
        type: "respond",
        priority: 9,
        reasoning: "Respond to pending interactions",
        estimatedImpact: 0.3,
        params: {},
      });
    }

    // Trading (priority 2)
    if (agent.autonomousTrading) {
      actions.push({
        type: "trade",
        priority: 7,
        reasoning: "Evaluate trading opportunities",
        estimatedImpact: 0.5,
        params: {},
      });
    }

    // Posting (priority 3)
    if (agent.autonomousPosting) {
      actions.push({
        type: "post",
        priority: 5,
        reasoning: "Create social content",
        estimatedImpact: 0.2,
        params: {},
      });
    }

    return {
      actions: actions.slice(0, agent.agentMaxActionsPerTick || 3),
      totalActions: actions.length,
      reasoning: "Simple mode: executing enabled capabilities",
      goalsAddressed: [],
      estimatedCost: actions.length,
    };
  }

  /**
   * Execute the planned actions in priority order
   */
  /**
   * Execute an action plan
   *
   * Executes all actions in the plan in priority order, tracking
   * successes and failures. Updates goal progress based on results.
   *
   * @param agentUserId - Unique identifier for the agent
   * @param runtime - Agent runtime (used for W&B model access)
   * @param plan - Action plan to execute
   * @returns Execution result with success counts and goal updates
   *
   * @remarks
   * - Executes actions in priority order (highest first)
   * - Continues processing even if individual actions fail
   * - Updates goal progress for completed actions
   * - Returns detailed results for each action
   */
  async executePlan(
    agentUserId: string,
    runtime: IAgentRuntime,
    plan: ActionPlan,
  ): Promise<AutonomousExecutionResult> {
    const results: AutonomousExecutionResult["results"] = [];
    const goalsUpdated: Set<string> = new Set();

    logger.info(
      `Executing plan with ${plan.totalActions} actions`,
      {
        agentId: agentUserId,
        actions: plan.actions.map((a) => a.type),
      },
      "PlanningCoordinator",
    );

    // Sort by priority
    const sortedActions = [...plan.actions].sort(
      (a, b) => b.priority - a.priority,
    );

    for (const action of sortedActions) {
      // Fail fast - don't catch errors, let them propagate
      const result = await this.executeAction(agentUserId, runtime, action);
      results.push({
        action,
        success: result.success,
        result: result.data,
        error: result.error,
      });

      // Track progress toward goal
      if (action.goalId && result.success) {
        await this.updateGoalProgress(action.goalId, agentUserId, action);
        goalsUpdated.add(action.goalId);
      }

      // Small delay between actions
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const successful = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    logger.info(
      "Plan execution complete",
      {
        agentId: agentUserId,
        planned: plan.totalActions,
        executed: results.length,
        successful,
        failed,
      },
      "PlanningCoordinator",
    );

    return {
      planned: plan.totalActions,
      executed: results.length,
      successful,
      failed,
      results,
      goalsUpdated: Array.from(goalsUpdated),
    };
  }

  /**
   * Execute a single action
   *
   * Routes action execution to the appropriate service based on action type.
   * Returns a result object indicating success/failure and any result data.
   *
   * @param agentUserId - Unique identifier for the agent
   * @param runtime - Agent runtime (used for W&B model access)
   * @param action - Planned action to execute
   * @returns Result object with success status and optional data/error
   *
   * @remarks
   * Uses `unknown` for result data as different action types return
   * different data structures (trade results, post IDs, etc.)
   */
  private async executeAction(
    agentUserId: string,
    runtime: IAgentRuntime,
    action: PlannedAction,
  ): Promise<{ success: boolean; data?: JsonValue; error?: string }> {
    logger.info(
      `Executing ${action.type} action`,
      { agentId: agentUserId, priority: action.priority },
      "PlanningCoordinator",
    );

    // Fail fast - don't catch errors here, let them propagate
    switch (action.type) {
      case "trade": {
        const tradeResult = await autonomousTradingService.executeTrades(
          agentUserId,
          runtime,
        );
        return {
          success: tradeResult.tradesExecuted > 0,
          data: { trades: tradeResult.tradesExecuted },
        };
      }

      case "post": {
        const postId = await autonomousPostingService.createAgentPost(
          agentUserId,
          runtime,
        );
        return { success: !!postId, data: { postId } };
      }

      case "respond": {
        const responses = await autonomousBatchResponseService.processBatch(
          agentUserId,
          runtime,
        );
        return { success: responses > 0, data: { responses } };
      }

      case "comment": {
        const commentId = await autonomousCommentingService.createAgentComment(
          agentUserId,
          runtime,
        );
        return { success: !!commentId, data: { commentId } };
      }

      case "message": {
        const dmResponses = await autonomousDMService.respondToDMs(
          agentUserId,
          runtime,
        );
        return { success: dmResponses > 0, data: { responses: dmResponses } };
      }

      default:
        throw new Error(`Unknown action type: ${action.type}`);
    }
  }

  /**
   * Update goal progress based on action execution
   */
  private async updateGoalProgress(
    goalId: string,
    agentUserId: string,
    action: PlannedAction,
  ): Promise<void> {
    const goal = await db.agentGoal.findUnique({
      where: { id: goalId },
    });

    if (!goal) return;

    // Update progress (simplified - could be more sophisticated)
    const newProgress = Math.min(1.0, goal.progress + action.estimatedImpact);

    await db.agentGoal.update({
      where: { id: goalId },
      data: {
        progress: newProgress,
        updatedAt: new Date(),
        ...(newProgress >= 1.0
          ? {
              status: "completed",
              completedAt: new Date(),
            }
          : {}),
      },
    });

    // Record goal action
    await db.agentGoalAction.create({
      data: {
        id: await generateSnowflakeId(),
        goalId,
        agentUserId,
        actionType: action.type,
        impact: action.estimatedImpact,
        metadata: action.params as JsonValue,
      },
    });

    logger.info(
      "Updated goal progress",
      {
        goalId,
        oldProgress: goal.progress,
        newProgress,
        completed: newProgress >= 1.0,
      },
      "PlanningCoordinator",
    );
  }
}

/**
 * Detect trading opportunities for an agent
 */
async function detectTradingOpportunities(
  _agentUserId: string,
  balance: number,
): Promise<
  Array<{
    market: string;
    description: string;
    confidence: number;
    expectedValue: number;
  }>
> {
  const opportunities: Array<{
    market: string;
    description: string;
    confidence: number;
    expectedValue: number;
  }> = [];

  // Get active prediction markets with high volume
  const activeMarkets = await db.market.findMany({
    where: {
      resolved: false,
      endDate: { gte: new Date() },
    },
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  for (const market of activeMarkets) {
    const yesShares = Number(market.yesShares || 0);
    const noShares = Number(market.noShares || 0);
    const totalShares = yesShares + noShares;

    if (totalShares === 0) continue;

    const { yesPrice } = getPredictionMarketPrices(yesShares, noShares);

    // Look for mispriced markets (one side < 0.3 or > 0.7)
    if (yesPrice < 0.3 || yesPrice > 0.7) {
      const confidence = Math.abs(yesPrice - 0.5) * 2; // 0 to 1 scale
      const expectedValue = confidence * balance * 0.1; // 10% of balance

      opportunities.push({
        market: market.id,
        description: `Mispriced market: ${market.question} (YES: ${(yesPrice * 100).toFixed(1)}%)`,
        confidence,
        expectedValue,
      });
    }
  }

  // Get perp markets with significant price movement
  const orgStates = await getDbInstance().getAllOrganizationStates();
  const priceMap = new Map(
    orgStates.map((s): [string, number | null] => [s.id, s.currentPrice]),
  );
  const perpMarkets = StaticDataRegistry.getAllOrganizations()
    .filter((o): o is StaticOrganization => o.type === "company")
    .slice(0, 10)
    .map((o: StaticOrganization) => ({
      ...o,
      currentPrice: priceMap.get(o.id) ?? o.initialPrice,
    }));

  for (const org of perpMarkets) {
    const currentPrice = Number(org.currentPrice || org.initialPrice || 100);
    const initialPrice = Number(org.initialPrice || 100);
    const priceChange = (currentPrice - initialPrice) / initialPrice;

    // Look for significant moves (>5% change)
    if (Math.abs(priceChange) > 0.05) {
      const confidence = Math.min(Math.abs(priceChange) * 2, 1); // Cap at 1.0
      const expectedValue = confidence * balance * 0.15; // 15% of balance

      opportunities.push({
        market: org.id,
        description: `${org.name} moved ${(priceChange * 100).toFixed(1)}% ($${currentPrice.toFixed(2)})`,
        confidence,
        expectedValue,
      });
    }
  }

  // Sort by expected value
  opportunities.sort((a, b) => b.expectedValue - a.expectedValue);

  return opportunities.slice(0, 5); // Top 5 opportunities
}

/**
 * Detect social opportunities for an agent
 */
async function detectSocialOpportunities(
  agentUserId: string,
  pendingCommentReplies: PendingCommentReply[],
  pendingChatMessages: PendingChatMessage[],
): Promise<
  Array<{
    type: string;
    description: string;
    engagementScore: number;
  }>
> {
  const opportunities: Array<{
    type: string;
    description: string;
    engagementScore: number;
  }> = [];

  // High-value comment reply interactions (direct questions, mentions)
  for (const reply of pendingCommentReplies) {
    const content = reply.content.toLowerCase();
    const isQuestion = content.includes("?");
    const isMention = content.includes("@") || content.includes(agentUserId);
    const isDirect = isQuestion || isMention;

    if (isDirect) {
      opportunities.push({
        type: "comment_reply",
        description: `${reply.author}: ${reply.content.substring(0, 60)}...`,
        engagementScore: 0.8,
      });
    } else if (reply.content.length > 50) {
      // Substantive comment
      opportunities.push({
        type: "comment_reply",
        description: `${reply.author}: ${reply.content.substring(0, 60)}...`,
        engagementScore: 0.5,
      });
    }
  }

  // High-value chat message interactions
  for (const msg of pendingChatMessages) {
    const content = msg.content.toLowerCase();
    const isQuestion = content.includes("?");
    const isMention = content.includes("@") || content.includes(agentUserId);
    const isDirect = isQuestion || isMention;
    const msgType = msg.isGroupChat ? "group_message" : "dm";

    if (isDirect) {
      opportunities.push({
        type: msgType,
        description: `${msg.author}: ${msg.content.substring(0, 60)}...`,
        engagementScore: 0.9, // DMs and group mentions are high priority
      });
    } else if (msg.content.length > 50) {
      opportunities.push({
        type: msgType,
        description: `${msg.author}: ${msg.content.substring(0, 60)}...`,
        engagementScore: 0.6,
      });
    }
  }

  // Check for trending topics to post about
  const trendingTagsRaw = await db.query.trendingTags.findMany({
    orderBy: (trendingTags, { desc: descFn }) => [descFn(trendingTags.score)],
    limit: 5,
    with: {
      tag: {
        columns: {
          name: true,
          displayName: true,
        },
      },
    },
  });

  for (const trending of trendingTagsRaw) {
    if (trending.tag) {
      opportunities.push({
        type: "post",
        description: `Trending topic: ${trending.tag.displayName || trending.tag.name}`,
        engagementScore: trending.score / 100, // Normalize score
      });
    }
  }

  // Sort by engagement score
  opportunities.sort((a, b) => b.engagementScore - a.engagementScore);

  return opportunities.slice(0, 5); // Top 5 opportunities
}

export const autonomousPlanningCoordinator =
  new AutonomousPlanningCoordinator();
