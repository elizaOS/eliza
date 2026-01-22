/**
 * Trading Trajectory Service
 *
 * Integrates with @elizaos/plugin-trajectory-logger to capture trading
 * decisions and outcomes for reinforcement learning training.
 */

import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import type { Position, TradeOrder } from "../types.ts";
import { TradeType } from "../types.ts";

// Import types from trajectory logger (we'll make this optional)
interface EnvironmentState {
  timestamp: number;
  agentBalance: number;
  agentPoints: number;
  agentPnL: number;
  openPositions: number;
  activeMarkets?: number;
  portfolioValue?: number;
  custom?: Record<string, unknown>;
}

interface TrajectoryLoggerService {
  startTrajectory(
    agentId: string,
    options?: {
      scenarioId?: string;
      episodeId?: string;
      metadata?: Record<string, unknown>;
    },
  ): string;
  startStep(trajectoryId: string, envState: EnvironmentState): string;
  logLLMCall(
    stepId: string,
    llmCall: {
      model: string;
      systemPrompt: string;
      userPrompt: string;
      response: string;
      reasoning?: string;
      temperature: number;
      maxTokens: number;
      purpose: "action" | "reasoning" | "evaluation" | "response" | "other";
      actionType?: string;
    },
  ): void;
  completeStep(
    trajectoryId: string,
    stepId: string,
    action: {
      actionType: string;
      actionName: string;
      parameters: Record<string, unknown>;
      success: boolean;
      result?: Record<string, unknown>;
      reasoning?: string;
    },
    rewardInfo?: { reward?: number; components?: Record<string, number> },
  ): void;
  endTrajectory(
    trajectoryId: string,
    status: "completed" | "terminated" | "error" | "timeout",
    finalMetrics?: Record<string, unknown>,
  ): Promise<void>;
  getActiveTrajectory(trajectoryId: string): unknown | null;
}

export interface TradingEnvironmentState {
  solBalance: number;
  portfolioValue: number;
  totalPnL: number;
  dailyPnL: number;
  openPositions: Position[];
  winRate: number;
  totalTrades: number;
}

export class TradingTrajectoryService extends Service {
  public static readonly serviceType = "TradingTrajectoryService";
  public readonly capabilityDescription = "Logs trading trajectories for RL training";

  private trajectoryLogger: TrajectoryLoggerService | null = null;
  private activeTrajectoryId: string | null = null;
  private activeStepId: string | null = null;
  private sessionStartState: TradingEnvironmentState | null = null;
  private enabled = false;

  public static async start(runtime: IAgentRuntime): Promise<TradingTrajectoryService> {
    const instance = new TradingTrajectoryService(runtime);
    await instance.initialize();
    return instance;
  }

  private async initialize(): Promise<void> {
    // Try to get TrajectoryLoggerService if available
    try {
      const { TrajectoryLoggerService } = await import("@elizaos/plugin-trajectory-logger");
      this.trajectoryLogger = new TrajectoryLoggerService();
      this.enabled = true;
      logger.info("[TradingTrajectoryService] Trajectory logging enabled");
    } catch {
      logger.info("[TradingTrajectoryService] Trajectory logger not available - logging disabled");
      this.enabled = false;
    }
  }

  public async stop(): Promise<void> {
    if (this.activeTrajectoryId) {
      await this.endSession("terminated");
    }
  }

  public isEnabled(): boolean {
    return this.enabled && this.trajectoryLogger !== null;
  }

  /**
   * Start a new trading session trajectory
   */
  public startSession(params: {
    strategy: string;
    initialState: TradingEnvironmentState;
    scenarioId?: string;
  }): string | null {
    if (!this.isEnabled()) return null;

    this.sessionStartState = params.initialState;

    this.activeTrajectoryId =
      this.trajectoryLogger?.startTrajectory(this.runtime.agentId, {
        scenarioId: params.scenarioId || `trading-${params.strategy}`,
        episodeId: `session-${Date.now()}`,
        metadata: {
          strategy: params.strategy,
          initialBalance: params.initialState.solBalance,
          initialPortfolioValue: params.initialState.portfolioValue,
          tradingMode: this.runtime.getSetting("TRADING_MODE") || "paper",
        },
      }) ?? null;

    logger.info(`[TradingTrajectoryService] Started trajectory: ${this.activeTrajectoryId}`);
    return this.activeTrajectoryId;
  }

  /**
   * Log a trading decision step
   */
  public startTradingStep(envState: TradingEnvironmentState): string | null {
    if (!this.isEnabled() || !this.activeTrajectoryId) return null;

    const trajectoryEnvState: EnvironmentState = {
      timestamp: Date.now(),
      agentBalance: envState.solBalance,
      agentPoints: envState.totalTrades,
      agentPnL: envState.totalPnL,
      openPositions: envState.openPositions.length,
      portfolioValue: envState.portfolioValue,
      custom: {
        dailyPnL: envState.dailyPnL,
        winRate: envState.winRate,
        positions: envState.openPositions.map((p) => ({
          token: p.tokenAddress,
          amount: p.amount,
          entryPrice: p.entryPrice,
          currentPrice: p.currentPrice,
        })),
      },
    };

    this.activeStepId =
      this.activeTrajectoryId && this.trajectoryLogger
        ? (this.trajectoryLogger.startStep(this.activeTrajectoryId, trajectoryEnvState) ?? null)
        : null;
    return this.activeStepId;
  }

  /**
   * Log an LLM decision for trading
   */
  public logTradingDecision(params: {
    model: string;
    prompt: string;
    response: string;
    reasoning?: string;
    actionType: string;
  }): void {
    if (!this.isEnabled() || !this.activeStepId) return;

    this.trajectoryLogger?.logLLMCall(this.activeStepId, {
      model: params.model,
      systemPrompt: "Trading strategy analysis",
      userPrompt: params.prompt,
      response: params.response,
      reasoning: params.reasoning,
      temperature: 0.7,
      maxTokens: 4096,
      purpose: "action",
      actionType: params.actionType,
    });
  }

  /**
   * Complete a trading step with the action taken
   */
  public completeTradingStep(params: {
    order: TradeOrder | null;
    success: boolean;
    txId?: string;
    error?: string;
    pnlChange?: number;
  }): void {
    if (!this.isEnabled() || !this.activeTrajectoryId || !this.activeStepId) return;

    const action = params.order
      ? {
          actionType: params.order.action === TradeType.BUY ? "BUY" : "SELL",
          actionName: `${params.order.action}_${params.order.pair}`,
          parameters: {
            pair: params.order.pair,
            quantity: params.order.quantity,
            price: params.order.price,
            orderType: params.order.orderType,
          },
          success: params.success,
          result: params.txId
            ? { txId: params.txId }
            : params.error
              ? { error: params.error }
              : undefined,
          reasoning: params.order.reason,
        }
      : {
          actionType: "HOLD",
          actionName: "HOLD",
          parameters: {},
          success: true,
          reasoning: "No trade signal",
        };

    // Calculate reward based on outcome
    const reward = this.calculateReward(params);

    this.trajectoryLogger?.completeStep(this.activeTrajectoryId, this.activeStepId, action, {
      reward,
      components: {
        environmentReward: reward,
        profitLoss: params.pnlChange || 0,
      },
    });

    this.activeStepId = null;
  }

  /**
   * End the trading session trajectory
   */
  public async endSession(
    status: "completed" | "terminated" | "error" | "timeout",
    finalState?: TradingEnvironmentState,
  ): Promise<void> {
    if (!this.isEnabled() || !this.activeTrajectoryId) return;

    const metrics: Record<string, unknown> = {};

    if (finalState && this.sessionStartState) {
      metrics.finalBalance = finalState.solBalance;
      metrics.finalPnL = finalState.totalPnL;
      metrics.tradesExecuted = finalState.totalTrades - this.sessionStartState.totalTrades;
      metrics.successRate = finalState.winRate;
      metrics.portfolioChange = finalState.portfolioValue - this.sessionStartState.portfolioValue;
      metrics.pnlChange = finalState.totalPnL - this.sessionStartState.totalPnL;
    }

    await this.trajectoryLogger?.endTrajectory(this.activeTrajectoryId, status, metrics);

    logger.info(
      `[TradingTrajectoryService] Ended trajectory: ${this.activeTrajectoryId} status=${status}`,
    );

    this.activeTrajectoryId = null;
    this.activeStepId = null;
    this.sessionStartState = null;
  }

  /**
   * Calculate reward for a trading step
   */
  private calculateReward(params: {
    order: TradeOrder | null;
    success: boolean;
    pnlChange?: number;
    error?: string;
  }): number {
    let reward = 0;

    // Base reward for successful trade execution
    if (params.success && params.order) {
      reward += 0.1;
    }

    // Penalty for failed trades
    if (!params.success && params.order) {
      reward -= 0.2;
    }

    // Reward/penalty based on P&L change
    if (params.pnlChange !== undefined) {
      if (params.pnlChange > 0) {
        // Positive P&L: scale reward logarithmically
        reward += Math.min(Math.log10(params.pnlChange + 1) * 0.5, 1.0);
      } else if (params.pnlChange < 0) {
        // Negative P&L: penalty
        reward += Math.max(Math.log10(Math.abs(params.pnlChange) + 1) * -0.3, -0.5);
      }
    }

    // Small reward for holding when no good opportunity
    if (!params.order) {
      reward += 0.01;
    }

    return reward;
  }

  /**
   * Get the current active trajectory ID
   */
  public getActiveTrajectoryId(): string | null {
    return this.activeTrajectoryId;
  }
}
