/**
 * Simulation Engine
 *
 * Replays pre-generated benchmark data to provide a deterministic game environment.
 * Agents can query game state and make actions, but the underlying game progression
 * is fixed based on the benchmark snapshot.
 *
 * Key features:
 * - Tick-by-tick replay of pre-recorded game data
 * - Fast-forward mode (ticks advance on agent response)
 * - A2A-compatible interface
 * - Tracks agent actions for performance evaluation
 */

import type { JsonValue } from "../adapter";
import { logger } from "../utils/logger";
import type {
  BenchmarkGameSnapshot,
  GameState,
  Tick,
} from "./BenchmarkDataGenerator";
import { MetricsValidator } from "./MetricsValidator";

export interface SimulationConfig {
  /** The benchmark snapshot to replay */
  snapshot: BenchmarkGameSnapshot;

  /** Agent ID being tested */
  agentId: string;

  /** Fast-forward mode (wait for agent response before advancing) */
  fastForward: boolean;

  /** Timeout for agent responses in fast-forward mode (ms) */
  responseTimeout?: number;
}

export interface AgentAction {
  tick: number;
  timestamp: number;
  type: AgentActionType;
  data: Record<string, JsonValue>;
  /** How long agent took to respond in milliseconds */
  duration: number;
  correctness?: {
    /** Prediction market correctness tracking */
    predictionCorrect?: boolean;
    actualOutcome?: boolean;
    predictedOutcome?: boolean;

    /** Perpetual trade correctness tracking */
    perpCorrect?: boolean;
    sentimentAtTrade?: number;
    priceChange?: number;
    expectedDirection?: "up" | "down";

    /** Sentiment analysis accuracy tracking */
    sentimentAccuracy?: number;
    sentimentAtTime?: number;
    actualSentiment?: number;
  };
}

export type AgentActionType =
  | "query_state"
  | "buy_prediction"
  | "sell_prediction"
  | "open_perp"
  | "close_perp"
  | "create_post"
  | "join_group"
  | "send_message";

export type AgentActionResult =
  | { positionId: string; shares: number } // buy_prediction
  | { positionId: string } // open_perp
  | { pnl: number } // close_perp
  | { success: boolean } // join_group
  | { postId: string }; // create_post

export interface SimulationResult {
  /** Simulation ID */
  id: string;

  /** Agent being tested */
  agentId: string;

  /** Benchmark used */
  benchmarkId: string;

  /** Start and end times */
  startTime: number;
  endTime: number;

  /** Total ticks processed */
  ticksProcessed: number;

  /** All agent actions during simulation */
  actions: AgentAction[];

  /** Performance metrics */
  metrics: SimulationMetrics;

  /** Trajectory data for RL training */
  trajectory: TrajectoryData;

  /** PnL history for charting */
  pnlHistory: Array<{ tick: number; pnl: number }>;
}

export interface SimulationMetrics {
  /** Total P&L from all positions */
  totalPnl: number;

  /** Prediction market metrics */
  predictionMetrics: {
    totalPositions: number;
    correctPredictions: number;
    incorrectPredictions: number;
    accuracy: number;
    avgPnlPerPosition: number;
  };

  /** Perpetual trading metrics */
  perpMetrics: {
    totalTrades: number;
    profitableTrades: number;
    winRate: number;
    avgPnlPerTrade: number;
    maxDrawdown: number;
  };

  /** Social metrics */
  socialMetrics: {
    postsCreated: number;
    groupsJoined: number;
    messagesReceived: number;
    reputationGained: number;
  };

  /** Timing metrics */
  timing: {
    avgResponseTime: number;
    maxResponseTime: number;
    totalDuration: number;
  };

  /** Compared to optimal actions */
  optimalityScore: number; // 0-100, how close to optimal
}

export interface TrajectoryData {
  states: GameState[];
  actions: AgentAction[];
  rewards: number[];
  windowId: string;
}

export class SimulationEngine {
  private config: SimulationConfig;
  private currentTick: number = 0;
  private actions: AgentAction[] = [];
  private startTime: number = 0;
  private pnlHistory: Array<{ tick: number; pnl: number }> = [];

  /** Agent positions tracked for metrics calculation */
  private predictionPositions: Map<string, PredictionPosition> = new Map();
  private perpPositions: Map<string, PerpPosition> = new Map();
  private socialStats = {
    postsCreated: 0,
    groupsJoined: 0,
    messagesReceived: 0,
  };

  constructor(config: SimulationConfig) {
    this.config = config;
  }

  /**
   * Run the complete simulation.
   *
   * Calculates final metrics after the simulation has been run.
   * In fast-forward mode, the actual simulation must be driven externally by:
   * 1. External runner calling agent logic
   * 2. Agent making A2A calls which trigger actions
   * 3. External runner calling advanceTick() to move forward
   *
   * This method then computes the final results.
   */
  async run(): Promise<SimulationResult> {
    if (this.startTime === 0) {
      this.startTime = Date.now();
    }

    const endTime = Date.now();
    const metrics = this.calculateMetrics();
    const validation = MetricsValidator.validate(
      metrics,
      this.actions,
      this.config.snapshot.groundTruth,
    );

    if (!validation.valid) {
      logger.error("Metrics validation failed", {
        errors: validation.errors,
        warnings: validation.warnings,
      });
    }
    if (validation.warnings.length > 0) {
      logger.warn("Metrics validation warnings", {
        warnings: validation.warnings,
      });
    }
    const trajectory = this.buildTrajectory();

    logger.info("Simulation completed", {
      duration: endTime - this.startTime,
      ticksProcessed: this.currentTick,
      totalPnl: metrics.totalPnl,
      actionsCount: this.actions.length,
      metricsValid: validation.valid,
    });

    return {
      id: `sim-${Date.now()}`,
      agentId: this.config.agentId,
      benchmarkId: this.config.snapshot.id,
      startTime: this.startTime,
      endTime,
      ticksProcessed: this.currentTick,
      actions: this.actions,
      metrics,
      trajectory,
      pnlHistory: this.pnlHistory,
    };
  }

  /**
   * Initialize simulation
   */
  initialize(): void {
    this.startTime = Date.now();
    this.currentTick = 0;
    this.pnlHistory = [];

    logger.info("Simulation initialized", {
      benchmarkId: this.config.snapshot.id,
      agentId: this.config.agentId,
      totalTicks: this.config.snapshot.ticks.length,
    });
  }

  /**
   * Check if simulation is complete
   * Returns true if we've processed all ticks
   */
  isComplete(): boolean {
    return this.currentTick >= this.config.snapshot.ticks.length;
  }

  /**
   * Get total number of ticks in this simulation
   */
  getTotalTicks(): number {
    return this.config.snapshot.ticks.length;
  }

  /**
   * Get current tick number
   */
  getCurrentTickNumber(): number {
    return this.currentTick;
  }

  /**
   * Apply tick updates (called after agent actions)
   * Updates position values based on current market prices
   */
  private applyTickUpdates(): void {
    const tick = this.config.snapshot.ticks[this.currentTick];
    if (tick) {
      this.updatePositionValues(tick);
    }
  }

  /**
   * Get current game state (called by agent via A2A)
   */
  getGameState(): GameState {
    if (this.currentTick === 0) {
      return this.config.snapshot.initialState;
    }

    const tick = this.config.snapshot.ticks[this.currentTick - 1];
    return tick ? tick.state : this.config.snapshot.initialState;
  }

  /**
   * Get specific historical tick (for backtesting/analysis)
   */
  getTickState(tickNumber: number): GameState | null {
    const tick = this.config.snapshot.ticks[tickNumber];
    return tick ? tick.state : null;
  }

  /**
   * Agent performs an action
   */
  async performAction(
    type: AgentActionType,
    data: Record<string, JsonValue>,
  ): Promise<{ success: boolean; result?: AgentActionResult; error?: string }> {
    const actionStart = Date.now();

    let result: AgentActionResult;
    let correctness: AgentAction["correctness"];

    try {
      switch (type) {
        case "buy_prediction": {
          result = this.handleBuyPrediction(data);
          const { marketId, outcome } = data as {
            marketId: string;
            outcome: "YES" | "NO";
          };

          // Track correctness for prediction markets
          const marketOutcome =
            this.config.snapshot.groundTruth.marketOutcomes[marketId];
          if (marketOutcome !== undefined) {
            const predictedOutcome = outcome === "YES";
            const isCorrect = predictedOutcome === marketOutcome;

            correctness = {
              predictionCorrect: isCorrect,
              actualOutcome: marketOutcome,
              predictedOutcome,
            };
          }
          break;
        }

        case "open_perp": {
          result = this.handleOpenPerp(data);
          const { ticker, side } = data as {
            ticker: string;
            side: "LONG" | "SHORT";
          };

          // Track correctness for perp trades based on sentiment and price movement
          const state = this.getGameState();
          const market = state.perpetualMarkets.find(
            (m: { ticker: string }) => m.ticker === ticker,
          );

          if (market) {
            // Calculate sentiment (simplified: based on price change)
            const priceHistory =
              this.config.snapshot.groundTruth.priceHistory[ticker];
            const currentPrice = market.price;
            const futurePrice =
              priceHistory?.[
                Math.min(this.currentTick + 10, priceHistory.length - 1)
              ]?.price;

            if (futurePrice !== undefined) {
              const priceChange = (futurePrice - currentPrice) / currentPrice;
              const sentimentAtTrade = priceChange > 0 ? 0.5 : -0.5; // Simplified sentiment

              // Determine if trade was correct
              // If sentiment is negative and we went short, that's correct
              // If sentiment is positive and we went long, that's correct
              const expectedDirection = sentimentAtTrade < 0 ? "down" : "up";
              const tradeDirection = side === "SHORT" ? "down" : "up";
              const isCorrect = expectedDirection === tradeDirection;

              correctness = {
                perpCorrect: isCorrect,
                sentimentAtTrade,
                priceChange,
                expectedDirection,
              };
            }
          }
          break;
        }

        case "close_perp":
          result = this.handleClosePerp(data);
          break;

        case "join_group":
          result = this.handleJoinGroup(data);
          break;

        case "create_post":
          result = this.handleCreatePost(data);
          break;

        default:
          return { success: false, error: `Unknown action type: ${type}` };
      }

      // Record action with correctness metadata
      this.actions.push({
        tick: this.currentTick,
        timestamp: Date.now(),
        type,
        data,
        duration: Date.now() - actionStart,
        correctness,
      });

      return { success: true, result };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Advance to next tick (called after agent finishes processing)
   */
  advanceTick(): void {
    // Apply any price-based updates for current tick
    this.applyTickUpdates();

    // Record PnL history
    const currentPnl = this.calculateCurrentTotalPnl();
    this.pnlHistory.push({
      tick: this.currentTick,
      pnl: currentPnl,
    });

    // Move to next tick
    this.currentTick++;
  }

  /**
   * Calculate current PnL (realized + unrealized)
   */
  private calculateCurrentTotalPnl(): number {
    let totalPnl = 0;

    // Realized PnL from closed trades
    for (const pos of this.perpPositions.values()) {
      totalPnl += pos.realizedPnl || 0;
      totalPnl += pos.unrealizedPnl || 0;
    }

    // Note: Prediction market PnL is only realized on resolution in this simple engine
    // We could add mark-to-market valuation here if needed

    return totalPnl;
  }
  /**
   * Stop simulation early
   */
  stop(): void {
    // Stop simulation (currently not actively used but kept for API compatibility)
  }

  /**
   * Handle buying prediction market shares
   */
  private handleBuyPrediction(data: Record<string, JsonValue>): {
    positionId: string;
    shares: number;
  } {
    const { marketId, outcome, amount } = data as {
      marketId: string;
      outcome: "YES" | "NO";
      amount: number;
    };

    const state = this.getGameState();
    const market = state.predictionMarkets.find(
      (m: { id: string }) => m.id === marketId,
    );

    if (!market) {
      throw new Error(`Market ${marketId} not found`);
    }

    // Calculate shares based on current price
    const price = outcome === "YES" ? market.yesPrice : market.noPrice;
    const shares = amount / price;

    // Record position
    const positionId = `pos-${Date.now()}`;
    this.predictionPositions.set(positionId, {
      marketId,
      outcome,
      shares,
      entryPrice: price,
      amount,
      openedAt: this.currentTick,
    });

    return { positionId, shares };
  }

  /**
   * Handle opening perpetual position
   */
  private handleOpenPerp(data: Record<string, JsonValue>): {
    positionId: string;
  } {
    const { ticker, side, size, leverage } = data as {
      ticker: string;
      side: "LONG" | "SHORT";
      size: number;
      leverage: number;
    };

    const state = this.getGameState();
    const market = state.perpetualMarkets.find(
      (m: { ticker: string }) => m.ticker === ticker,
    );

    if (!market) {
      throw new Error(`Market ${ticker} not found`);
    }

    const positionId = `perp-${Date.now()}`;
    this.perpPositions.set(positionId, {
      ticker,
      side,
      size,
      leverage,
      entryPrice: market.price,
      openedAt: this.currentTick,
      unrealizedPnl: 0,
    });

    return { positionId };
  }

  /**
   * Handle closing perpetual position
   */
  private handleClosePerp(data: Record<string, JsonValue>): { pnl: number } {
    const { positionId } = data as { positionId: string };

    const position = this.perpPositions.get(positionId);
    if (!position) {
      throw new Error(`Position ${positionId} not found`);
    }

    const state = this.getGameState();
    const market = state.perpetualMarkets.find(
      (m: { ticker: string }) => m.ticker === position.ticker,
    );

    if (!market) {
      throw new Error(`Market ${position.ticker} not found`);
    }

    // Calculate realized P&L
    const priceChange = market.price - position.entryPrice;
    const pnl =
      position.side === "LONG"
        ? priceChange * position.size * position.leverage
        : -priceChange * position.size * position.leverage;

    position.realizedPnl = pnl;
    position.unrealizedPnl = 0;
    position.closedAt = this.currentTick;

    return { pnl };
  }

  /**
   * Handle joining group chat
   */
  private handleJoinGroup(_data: Record<string, JsonValue>): {
    success: boolean;
  } {
    this.socialStats.groupsJoined++;
    return { success: true };
  }

  /**
   * Handle creating post
   */
  private handleCreatePost(_data: Record<string, JsonValue>): {
    postId: string;
  } {
    this.socialStats.postsCreated++;
    return { postId: `post-${Date.now()}` };
  }

  /**
   * Update position values based on current prices
   */
  private updatePositionValues(tick: Tick): void {
    // Update perp positions with unrealized P&L
    for (const [_positionId, position] of this.perpPositions.entries()) {
      if (position.closedAt) continue; // Skip closed positions

      const market = tick.state.perpetualMarkets.find(
        (m: { ticker: string; price: number }) => m.ticker === position.ticker,
      );
      if (!market) continue;

      const priceChange = market.price - position.entryPrice;
      position.unrealizedPnl =
        position.side === "LONG"
          ? priceChange * position.size * position.leverage
          : -priceChange * position.size * position.leverage;
    }
  }

  /**
   * Calculate comprehensive metrics
   */
  private calculateMetrics(): SimulationMetrics {
    // Calculate P&L from all positions
    let totalPnl = 0;

    // Prediction markets
    let correctPredictions = 0;
    let incorrectPredictions = 0;
    let predictionPnl = 0;

    for (const [_positionId, position] of this.predictionPositions.entries()) {
      const marketOutcome =
        this.config.snapshot.groundTruth.marketOutcomes[position.marketId];
      const isCorrect =
        (position.outcome === "YES" && marketOutcome) ||
        (position.outcome === "NO" && !marketOutcome);

      if (isCorrect) {
        correctPredictions++;
        const profit = position.amount; // Simplified: win amount = stake
        predictionPnl += profit;
      } else {
        incorrectPredictions++;
        predictionPnl -= position.amount;
      }
    }

    totalPnl += predictionPnl;

    // Perpetual trades
    let profitableTrades = 0;
    let perpPnl = 0;
    let maxDrawdown = 0;
    let runningPnl = 0;
    let peak = 0;

    for (const [_positionId, position] of this.perpPositions.entries()) {
      const pnl = position.realizedPnl ?? position.unrealizedPnl;
      perpPnl += pnl;

      if (pnl > 0) profitableTrades++;

      // Track drawdown
      runningPnl += pnl;
      if (runningPnl > peak) peak = runningPnl;
      const drawdown = peak - runningPnl;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }

    totalPnl += perpPnl;

    // Timing metrics
    const responseTimes = this.actions.map((a) => a.duration);
    const avgResponseTime =
      responseTimes.length > 0
        ? responseTimes.reduce((sum, t) => sum + t, 0) / responseTimes.length
        : 0;
    const maxResponseTime =
      responseTimes.length > 0 ? Math.max(...responseTimes) : 0;

    // Calculate optimality score (how well did agent follow optimal actions)
    const optimalityScore = this.calculateOptimalityScore();

    return {
      totalPnl,
      predictionMetrics: {
        totalPositions: this.predictionPositions.size,
        correctPredictions,
        incorrectPredictions,
        accuracy:
          this.predictionPositions.size > 0
            ? correctPredictions / this.predictionPositions.size
            : 0,
        avgPnlPerPosition:
          this.predictionPositions.size > 0
            ? predictionPnl / this.predictionPositions.size
            : 0,
      },
      perpMetrics: {
        totalTrades: this.perpPositions.size,
        profitableTrades,
        winRate:
          this.perpPositions.size > 0
            ? profitableTrades / this.perpPositions.size
            : 0,
        avgPnlPerTrade:
          this.perpPositions.size > 0 ? perpPnl / this.perpPositions.size : 0,
        maxDrawdown,
      },
      socialMetrics: {
        postsCreated: this.socialStats.postsCreated,
        groupsJoined: this.socialStats.groupsJoined,
        messagesReceived: this.socialStats.messagesReceived,
        reputationGained: correctPredictions * 10 - incorrectPredictions * 5,
      },
      timing: {
        avgResponseTime,
        maxResponseTime,
        totalDuration: Date.now() - this.startTime,
      },
      optimalityScore,
    };
  }

  /**
   * Calculate how close agent came to optimal play
   */
  private calculateOptimalityScore(): number {
    const optimalActions = this.config.snapshot.groundTruth.optimalActions;
    let matchedActions = 0;

    for (const optimalAction of optimalActions) {
      // Check if agent took this action within reasonable window
      const windowStart = optimalAction.tick - 2;
      const windowEnd = optimalAction.tick + 2;

      const agentAction = this.actions.find((a) => {
        if (a.tick < windowStart || a.tick > windowEnd) return false;

        // Match action type and target
        if (
          optimalAction.type === "buy_prediction" &&
          a.type === "buy_prediction"
        ) {
          return a.data.marketId === optimalAction.target;
        }
        if (optimalAction.type === "open_perp" && a.type === "open_perp") {
          return a.data.ticker === optimalAction.target;
        }

        return false;
      });

      if (agentAction) matchedActions++;
    }

    return optimalActions.length > 0
      ? (matchedActions / optimalActions.length) * 100
      : 0;
  }

  /**
   * Build trajectory data for RL training
   */
  private buildTrajectory(): TrajectoryData {
    const states: GameState[] = [];
    const rewards: number[] = [];

    // Extract states at each action point
    for (const action of this.actions) {
      const tick = this.config.snapshot.ticks[action.tick];
      if (tick) {
        states.push(tick.state);

        // Calculate reward based on action outcome
        let reward = 0;

        if (action.type === "buy_prediction") {
          const positionId = Object.keys(
            Object.fromEntries(this.predictionPositions),
          ).find((id) => {
            const pos = this.predictionPositions.get(id);
            return pos !== undefined && pos.openedAt === action.tick;
          });

          if (positionId) {
            const position = this.predictionPositions.get(positionId);
            if (!position) continue;
            const marketOutcome =
              this.config.snapshot.groundTruth.marketOutcomes[
                position.marketId
              ];
            const isCorrect =
              (position.outcome === "YES" && marketOutcome) ||
              (position.outcome === "NO" && !marketOutcome);
            reward = isCorrect ? 1.0 : -1.0;
          }
        }

        rewards.push(reward);
      }
    }

    return {
      states,
      actions: this.actions,
      rewards,
      windowId: `benchmark-${this.config.snapshot.id}`,
    };
  }
}

// ============================================================================
// Helper types
// ============================================================================

interface PredictionPosition {
  marketId: string;
  outcome: "YES" | "NO";
  shares: number;
  entryPrice: number;
  amount: number;
  openedAt: number;
}

interface PerpPosition {
  ticker: string;
  side: "LONG" | "SHORT";
  size: number;
  leverage: number;
  entryPrice: number;
  openedAt: number;
  closedAt?: number;
  unrealizedPnl: number;
  realizedPnl?: number;
}
