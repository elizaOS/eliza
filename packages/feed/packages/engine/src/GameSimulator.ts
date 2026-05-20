/**
 * GameSimulator - Standalone Autonomous Prediction Market Engine
 *
 * @module engine/GameSimulator
 *
 * @description
 * A complete prediction market simulation engine that runs without any
 * server dependencies, database connections, or external services.
 *
 * **Key Features:**
 * - Runs complete games in under 2 seconds
 * - Predetermined outcomes with proper clue distribution
 * - Agent-based betting with various strategies
 * - LMSR-based market pricing
 * - Event emission for real-time monitoring
 * - Reputation system for winners/losers
 *
 * @example
 * ```typescript
 * const simulator = new GameSimulator({
 *   outcome: true,
 *   numAgents: 10,
 *   duration: 30
 * });
 *
 * simulator.on('event', (event) => console.log(event));
 * const result = await simulator.runCompleteGame();
 * ```
 */

import { EventEmitter } from 'events';
import {
  SIMULATION_AGENT_NAMES,
  SIMULATION_CLUE_TEMPLATES,
  SIMULATION_QUESTIONS,
  SIMULATION_STRATEGIES,
} from './config/simulation';
import { SeededRandom } from './utils/entropy';
import { clamp } from './utils/math-utils';

/**
 * Configuration for game simulation
 */
export interface GameConfig {
  /** Predetermined outcome (true = YES wins, false = NO wins) */
  outcome: boolean;
  /** Number of agents participating (default: 10) */
  numAgents?: number;
  /** Game duration in days (default: 30) */
  duration?: number;
  /** LMSR liquidity parameter (default: 100) */
  liquidityB?: number;
  /** Percentage of agents who are insiders (default: 0.3) */
  insiderPercentage?: number;
  /** Random seed for reproducibility */
  seed?: number;
  /** Starting balance for each agent (default: 1000) */
  startingBalance?: number;
}

/**
 * Event types emitted during game simulation
 */
export interface GameEvent {
  type: string;
  timestamp: number;
  data: Record<string, unknown>;
}

/**
 * Agent participating in the simulation
 */
export interface SimulatedAgent {
  id: string;
  name: string;
  balance: number;
  isInsider: boolean;
  cluesReceived: number;
  betsPlaced: number;
  winningBets: number;
  totalPnl: number;
  strategy: 'informed' | 'momentum' | 'contrarian' | 'random';
}

/**
 * Market state
 */
export interface MarketState {
  yesOdds: number;
  noOdds: number;
  yesShares: number;
  noShares: number;
  totalVolume: number;
  liquidity: number;
}

/**
 * Reputation change for an agent
 */
export interface ReputationChange {
  agentId: string;
  change: number;
  reason: string;
}

/**
 * Complete game result
 */
export interface GameResult {
  id: string;
  question: string;
  outcome: boolean;
  events: GameEvent[];
  agents: SimulatedAgent[];
  market: MarketState;
  winners: string[];
  losers: string[];
  reputationChanges: ReputationChange[];
  duration: number;
  totalBets: number;
}

// Use shared simulation constants
const AGENT_NAMES = SIMULATION_AGENT_NAMES;
const SAMPLE_QUESTIONS = SIMULATION_QUESTIONS;
const CLUE_TEMPLATES = SIMULATION_CLUE_TEMPLATES;

/**
 * Autonomous prediction market simulation engine
 */
export class GameSimulator extends EventEmitter {
  private config: Required<GameConfig>;
  private rng: SeededRandom;
  private agents: SimulatedAgent[] = [];
  private market: MarketState;
  private events: GameEvent[] = [];
  private gameId: string;
  private question: string;

  constructor(config: GameConfig) {
    super();

    this.config = {
      outcome: config.outcome,
      numAgents: config.numAgents ?? 10,
      duration: config.duration ?? 30,
      liquidityB: config.liquidityB ?? 100,
      insiderPercentage: config.insiderPercentage ?? 0.3,
      seed: config.seed ?? Date.now(),
      startingBalance: config.startingBalance ?? 1000,
    };

    this.rng = new SeededRandom(this.config.seed);
    this.gameId = `game-${this.rng.nextInt(10000, 99999)}`;
    this.question = this.rng.pick(SAMPLE_QUESTIONS);

    // Initialize market at 50/50
    this.market = {
      yesOdds: 50,
      noOdds: 50,
      yesShares: this.config.liquidityB,
      noShares: this.config.liquidityB,
      totalVolume: 0,
      liquidity: this.config.liquidityB,
    };

    this.initializeAgents();
  }

  private initializeAgents(): void {
    const numInsiders = Math.floor(
      this.config.numAgents * this.config.insiderPercentage
    );

    for (let i = 0; i < this.config.numAgents; i++) {
      const isInsider = i < numInsiders;
      this.agents.push({
        id: `agent-${i + 1}`,
        name: AGENT_NAMES[i % AGENT_NAMES.length] ?? `Agent ${i + 1}`,
        balance: this.config.startingBalance,
        isInsider,
        cluesReceived: 0,
        betsPlaced: 0,
        winningBets: 0,
        totalPnl: 0,
        strategy: isInsider
          ? 'informed'
          : this.rng.pick([...SIMULATION_STRATEGIES]),
      });
    }
  }

  private emitEvent(type: string, data: Record<string, unknown> = {}): void {
    const event: GameEvent = {
      type,
      timestamp: Date.now(),
      data,
    };
    this.events.push(event);
    this.emit('event', event);
    this.emit(type, event);
  }

  /**
   * Run a complete game simulation
   */
  async runCompleteGame(): Promise<GameResult> {
    const startTime = Date.now();

    this.emitEvent('game:started', {
      gameId: this.gameId,
      question: this.question,
      numAgents: this.config.numAgents,
      duration: this.config.duration,
    });

    // Process each day
    for (let day = 1; day <= this.config.duration; day++) {
      await this.processDay(day);
    }

    // Reveal outcome and settle
    await this.revealOutcome();
    const result = this.calculateResults(startTime);

    this.emitEvent('game:ended', {
      gameId: this.gameId,
      outcome: this.config.outcome,
      duration: result.duration,
      totalBets: result.totalBets,
    });

    return result;
  }

  private async processDay(day: number): Promise<void> {
    this.emitEvent('day:changed', { day, totalDays: this.config.duration });

    // Distribute clues (more frequent towards end)
    const clueChance = 0.3 + (day / this.config.duration) * 0.4;
    if (this.rng.next() < clueChance) {
      await this.distributeClues(day);
    }

    // Agents make betting decisions
    for (const agent of this.agents) {
      if (this.rng.next() < this.getBetProbability(agent, day)) {
        await this.processBet(agent, day);
      }
    }
  }

  private getBetProbability(agent: SimulatedAgent, day: number): number {
    // Insiders bet more
    const baseProbability = agent.isInsider ? 0.6 : 0.3;
    // Activity increases towards end
    const dayModifier = (day / this.config.duration) * 0.3;
    // Balance check
    if (agent.balance < 10) return 0;
    return Math.min(baseProbability + dayModifier, 0.8);
  }

  private async distributeClues(day: number): Promise<void> {
    // Pick random agents to receive clues (insiders more likely)
    const numClues = this.rng.nextInt(1, 3);
    const recipients = this.rng.shuffle(this.agents).slice(0, numClues);

    for (const agent of recipients) {
      // Weight toward insiders
      if (!agent.isInsider && this.rng.next() > 0.4) continue;

      const cluePool = this.config.outcome
        ? CLUE_TEMPLATES.positive
        : CLUE_TEMPLATES.negative;
      const clue = this.rng.pick(cluePool);

      agent.cluesReceived++;

      this.emitEvent('clue:distributed', {
        agentId: agent.id,
        day,
        clue,
        isCorrect: true,
      });
    }
  }

  private async processBet(agent: SimulatedAgent, day: number): Promise<void> {
    const betSide = this.decideBet(agent, day);
    const betAmount = this.calculateBetAmount(agent);

    if (betAmount <= 0) return;

    // Execute the bet
    const preBetOdds = { yes: this.market.yesOdds, no: this.market.noOdds };
    this.executeBet(agent, betSide, betAmount);

    agent.betsPlaced++;

    this.emitEvent('agent:bet', {
      agentId: agent.id,
      side: betSide,
      amount: betAmount,
      day,
      newBalance: agent.balance,
    });

    this.emitEvent('market:updated', {
      yesOdds: this.market.yesOdds,
      noOdds: this.market.noOdds,
      preBetOdds,
      volume: this.market.totalVolume,
    });
  }

  private decideBet(agent: SimulatedAgent, _day: number): 'YES' | 'NO' {
    switch (agent.strategy) {
      case 'informed':
        // Insiders know the outcome, bet correctly with high probability
        if (agent.cluesReceived > 0) {
          return this.config.outcome ? 'YES' : 'NO';
        }
        // Without clues, use market momentum
        return this.market.yesOdds > 50 ? 'YES' : 'NO';

      case 'momentum':
        // Follow market direction
        return this.market.yesOdds > 50 ? 'YES' : 'NO';

      case 'contrarian':
        // Bet against market
        return this.market.yesOdds > 50 ? 'NO' : 'YES';

      case 'random':
      default:
        return this.rng.next() > 0.5 ? 'YES' : 'NO';
    }
  }

  private calculateBetAmount(agent: SimulatedAgent): number {
    // Bet between 5% and 20% of balance
    const minBet = Math.max(10, agent.balance * 0.05);
    const maxBet = Math.min(agent.balance * 0.2, agent.balance - 10);
    if (maxBet < minBet) return 0;
    return Math.floor(this.rng.nextFloat(minBet, maxBet));
  }

  private executeBet(
    agent: SimulatedAgent,
    side: 'YES' | 'NO',
    amount: number
  ): void {
    // Calculate shares purchased using current price
    const shares =
      amount /
      (side === 'YES' ? this.market.yesOdds / 100 : this.market.noOdds / 100);

    // Update market state
    if (side === 'YES') {
      this.market.yesShares += shares;
    } else {
      this.market.noShares += shares;
    }

    // Update odds using simplified LMSR
    const totalShares = this.market.yesShares + this.market.noShares;
    this.market.yesOdds = Math.round(
      (this.market.yesShares / totalShares) * 100
    );
    this.market.noOdds = 100 - this.market.yesOdds;

    // Clamp odds
    this.market.yesOdds = clamp(this.market.yesOdds, 5, 95);
    this.market.noOdds = clamp(this.market.noOdds, 5, 95);

    this.market.totalVolume += amount;
    agent.balance -= amount;
  }

  private async revealOutcome(): Promise<void> {
    this.emitEvent('outcome:revealed', {
      outcome: this.config.outcome,
      finalYesOdds: this.market.yesOdds,
      finalNoOdds: this.market.noOdds,
    });

    // Settle all positions based on outcome
    for (const agent of this.agents) {
      // Simplified settlement: calculate based on betting behavior
      const correctBets =
        agent.betsPlaced > 0
          ? Math.floor(
              agent.betsPlaced *
                (agent.strategy === 'informed' && agent.cluesReceived > 0
                  ? 0.8
                  : 0.5)
            )
          : 0;
      agent.winningBets = correctBets;
      const pnl =
        (correctBets - (agent.betsPlaced - correctBets)) *
        (this.config.startingBalance * 0.1);
      agent.totalPnl = pnl;
      agent.balance += pnl;
    }
  }

  private calculateResults(startTime: number): GameResult {
    const duration = Date.now() - startTime;

    // Determine winners (positive PnL)
    const winners = this.agents.filter((a) => a.totalPnl > 0).map((a) => a.id);
    const losers = this.agents.filter((a) => a.totalPnl < 0).map((a) => a.id);

    // Calculate reputation changes
    const reputationChanges: ReputationChange[] = this.agents.map((agent) => {
      let change: number;
      let reason: string;

      if (agent.totalPnl > 0) {
        change = Math.round(agent.totalPnl / 10);
        reason = 'Profitable trading';
      } else if (agent.totalPnl < 0) {
        change = Math.round(agent.totalPnl / 20); // Losses hurt less
        reason = 'Trading losses';
      } else {
        change = 0;
        reason = 'No change';
      }

      return { agentId: agent.id, change, reason };
    });

    const totalBets = this.agents.reduce((sum, a) => sum + a.betsPlaced, 0);

    return {
      id: this.gameId,
      question: this.question,
      outcome: this.config.outcome,
      events: this.events,
      agents: this.agents,
      market: this.market,
      winners,
      losers,
      reputationChanges,
      duration,
      totalBets,
    };
  }
}
