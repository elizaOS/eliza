/**
 * vLLM Benchmark Runner
 *
 * Runs benchmarks using a local vLLM server for model inference.
 * This bypasses the ElizaOS stack and calls vLLM directly, making it
 * suitable for containerized benchmark environments.
 *
 * Features:
 * - Direct vLLM inference (no ElizaOS dependencies)
 * - Support for trained LoRA adapters
 * - Baseline strategy comparisons
 * - Archetype-specific evaluation
 * - Detailed metrics and reports
 *
 * @example
 * ```typescript
 * const runner = new VLLMBenchmarkRunner({
 *   vllmUrl: 'http://localhost:9001',
 *   baseModel: 'Qwen/Qwen3-4B',
 *   adapterPath: './trained_models/final_model',
 * });
 *
 * const result = await runner.runScenario('bear-market', {
 *   archetype: 'trader',
 *   quickMode: true,
 * });
 * ```
 */

import { mkdirSync } from 'fs';
import * as path from 'path';
import { formatCurrency } from '../utils';
import { logger } from '../utils/logger';
import type { ArchetypeFitScore } from './ArchetypeFitCalculator';
import { ArchetypeFitCalculator } from './ArchetypeFitCalculator';
import {
  type BenchmarkGameSnapshot,
  SeededRandom,
} from './BenchmarkDataGenerator';
import type { FixedBenchmarkScenario, ScenarioId } from './ScenarioLoader';
import { ScenarioLoader } from './ScenarioLoader';
import {
  type SimulationConfig,
  SimulationEngine,
  type SimulationResult,
} from './SimulationEngine';
import { VLLMInferenceClient } from './VLLMInferenceClient';

export interface VLLMBenchmarkConfig {
  /** vLLM server URL */
  vllmUrl: string;

  /** Base model name */
  baseModel: string;

  /** Path to trained adapter (optional) */
  adapterPath?: string;

  /** Output directory for results */
  outputDir?: string;

  /** Whether to use quick mode (shorter scenarios) */
  quickMode?: boolean;

  /** Request timeout in ms */
  timeoutMs?: number;

  /** Starting balance for simulations (default: 10000) */
  startingBalance?: number;

  /** Quick mode duration in days (default: 7) */
  quickModeDurationDays?: number;
}

export interface BenchmarkScenarioOptions {
  /** Agent archetype to evaluate */
  archetype?: string;

  /** Baseline strategy for comparison */
  baseline?: 'random' | 'momentum';

  /** Quick mode duration in days */
  quickModeDays?: number;
}

export interface VLLMBenchmarkResult {
  scenario: FixedBenchmarkScenario;
  trainedResult: SimulationResult;
  baselineResult: SimulationResult;
  trainedFit: ArchetypeFitScore;
  baselineFit: ArchetypeFitScore;
  alpha: number;
  verdict: 'deploy' | 'continue' | 'regression';
}

// Agent action decision structure
interface AgentDecision {
  action: string;
  reasoning: string;
  confidence: number;
  parameters?: Record<string, unknown>;
}

const QUICK_MODE_DURATION_DAYS = 7;

/**
 * Benchmark runner that uses vLLM for model inference
 */
export class VLLMBenchmarkRunner {
  private config: Required<VLLMBenchmarkConfig>;
  private vllmClient: VLLMInferenceClient;
  private scenarioLoader: ScenarioLoader;
  private fitCalculator: ArchetypeFitCalculator;

  constructor(config: VLLMBenchmarkConfig) {
    this.config = {
      vllmUrl: config.vllmUrl,
      baseModel: config.baseModel,
      adapterPath: config.adapterPath || '',
      outputDir: config.outputDir || './benchmark-results',
      quickMode: config.quickMode ?? false,
      timeoutMs: config.timeoutMs ?? 60000,
      startingBalance: config.startingBalance ?? 10000,
      quickModeDurationDays:
        config.quickModeDurationDays ?? QUICK_MODE_DURATION_DAYS,
    };

    this.vllmClient = new VLLMInferenceClient({
      baseUrl: this.config.vllmUrl,
      model: this.config.baseModel,
      adapterPath: this.config.adapterPath || undefined,
      timeoutMs: this.config.timeoutMs,
    });

    this.scenarioLoader = new ScenarioLoader();
    this.fitCalculator = new ArchetypeFitCalculator();
  }

  /**
   * Initialize the runner (wait for vLLM to be ready)
   */
  async initialize(): Promise<void> {
    logger.info('Initializing vLLM benchmark runner...', {
      vllmUrl: this.config.vllmUrl,
      baseModel: this.config.baseModel,
      adapterPath: this.config.adapterPath || 'none',
    });

    await this.vllmClient.waitForReady();
    logger.info('vLLM benchmark runner ready');
  }

  /**
   * Run benchmark on a specific scenario
   */
  async runScenario(
    scenarioId: ScenarioId,
    options: BenchmarkScenarioOptions = {}
  ): Promise<VLLMBenchmarkResult> {
    const archetype = options.archetype || 'trader';
    const baseline = options.baseline || 'random';

    logger.info(`Running scenario: ${scenarioId}`, {
      archetype,
      baseline,
      quickMode: this.config.quickMode,
    });

    // Load scenario
    let scenario = await this.scenarioLoader.loadScenario(scenarioId);

    // Apply quick mode truncation if enabled
    if (this.config.quickMode) {
      scenario = this.truncateScenarioForQuickMode(
        scenario,
        options.quickModeDays || this.config.quickModeDurationDays
      );
    }

    const scenarioOutputDir = path.join(this.config.outputDir, scenarioId);
    mkdirSync(scenarioOutputDir, { recursive: true });

    // Run trained model
    logger.info('Running trained model evaluation...');
    const trainedResult = await this.runAgentSimulation(
      scenario.snapshot,
      archetype,
      scenarioOutputDir
    );

    // Run baseline
    logger.info(`Running baseline (${baseline})...`);
    const baselineResult = await this.runBaselineSimulation(
      scenario.snapshot,
      baseline,
      scenarioOutputDir
    );

    // Calculate archetype fit
    const trainedFit = this.fitCalculator.calculate(
      trainedResult,
      archetype,
      scenario.durationDays
    );

    const baselineFit = this.fitCalculator.calculate(
      baselineResult,
      archetype,
      scenario.durationDays
    );

    // Calculate alpha (trained - baseline)
    const alpha =
      trainedResult.metrics.totalPnl - baselineResult.metrics.totalPnl;

    // Determine verdict
    const verdict = this.determineVerdict(alpha, trainedFit, baselineFit);

    logger.info(`Scenario complete: ${scenarioId}`, {
      trainedPnl: trainedResult.metrics.totalPnl,
      baselinePnl: baselineResult.metrics.totalPnl,
      alpha,
      verdict,
    });

    return {
      scenario,
      trainedResult,
      baselineResult,
      trainedFit,
      baselineFit,
      alpha,
      verdict,
    };
  }

  /**
   * Run all available scenarios
   */
  async runAllScenarios(
    options: BenchmarkScenarioOptions = {}
  ): Promise<VLLMBenchmarkResult[]> {
    const scenarios = await this.scenarioLoader.loadAllScenarios();
    const results: VLLMBenchmarkResult[] = [];

    for (const scenario of scenarios) {
      try {
        const result = await this.runScenario(
          scenario.id as ScenarioId,
          options
        );
        results.push(result);
      } catch (error) {
        logger.error(`Scenario failed: ${scenario.id}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return results;
  }

  /**
   * Run agent simulation using vLLM for inference
   */
  private async runAgentSimulation(
    snapshot: BenchmarkGameSnapshot,
    archetype: string,
    _outputDir: string // Reserved for future trajectory saving
  ): Promise<SimulationResult> {
    const simConfig: SimulationConfig = {
      snapshot,
      agentId: 'trained-model',
      fastForward: true,
      responseTimeout: this.config.timeoutMs,
    };

    const engine = new SimulationEngine(simConfig);
    engine.initialize();

    const systemPrompt = this.buildSystemPrompt(archetype);

    while (!engine.isComplete()) {
      const currentTick = engine.getCurrentTickNumber();
      const state = engine.getGameState();

      // Log progress every 100 ticks
      if (currentTick % 100 === 0) {
        logger.debug(`Progress: ${currentTick}/${snapshot.ticks.length} ticks`);
      }

      // Get action from trained model
      try {
        const decision = await this.getAgentDecision(systemPrompt, state);

        // Execute action if valid
        if (decision && decision.action !== 'wait') {
          await this.executeAgentAction(engine, decision);
        }
      } catch (error) {
        logger.warn('Agent decision failed', {
          tick: currentTick,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      engine.advanceTick();

      // Small delay to avoid overwhelming vLLM
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    return engine.run();
  }

  /**
   * Run baseline simulation (no LLM)
   */
  private async runBaselineSimulation(
    snapshot: BenchmarkGameSnapshot,
    strategy: 'random' | 'momentum',
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _outputDir: string
  ): Promise<SimulationResult> {
    const simConfig: SimulationConfig = {
      snapshot,
      agentId: `baseline-${strategy}`,
      fastForward: true,
      responseTimeout: 30000,
    };

    const engine = new SimulationEngine(simConfig);
    engine.initialize();

    // Create seeded RNG for reproducibility
    const seed = snapshot.id
      .split('')
      .reduce((acc, c) => acc + c.charCodeAt(0), 0);
    const rng = new SeededRandom(seed);

    while (!engine.isComplete()) {
      // Execute baseline strategy
      await this.executeBaselineStrategy(strategy, engine, rng);
      engine.advanceTick();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    return engine.run();
  }

  /**
   * Get agent decision from vLLM
   */
  private async getAgentDecision(
    systemPrompt: string,
    gameState: ReturnType<SimulationEngine['getGameState']>
  ): Promise<AgentDecision | null> {
    const userPrompt = this.buildUserPrompt(gameState);

    try {
      const decision = await this.vllmClient.completeJson<AgentDecision>(
        {
          systemPrompt,
          userPrompt,
          temperature: 0.7,
          maxTokens: 512,
          jsonMode: true,
        },
        (data): data is AgentDecision => {
          return (
            typeof data === 'object' &&
            data !== null &&
            'action' in data &&
            typeof (data as AgentDecision).action === 'string'
          );
        }
      );

      return decision;
    } catch (error) {
      logger.debug('Failed to parse agent decision', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Execute agent action on simulation engine
   */
  private async executeAgentAction(
    engine: SimulationEngine,
    decision: AgentDecision
  ): Promise<void> {
    const state = engine.getGameState();

    switch (decision.action) {
      case 'buy_prediction': {
        const market = state.predictionMarkets[0];
        if (market) {
          await engine.performAction('buy_prediction', {
            marketId: market.id,
            outcome: 'YES',
            amount: (decision.parameters?.amount as number) || 50,
          });
        }
        break;
      }

      case 'sell_prediction': {
        const market = state.predictionMarkets[0];
        if (market) {
          await engine.performAction('sell_prediction', {
            marketId: market.id,
            outcome: 'YES',
            amount: (decision.parameters?.amount as number) || 50,
          });
        }
        break;
      }

      case 'open_long': {
        const perp = state.perpetualMarkets[0];
        if (perp) {
          await engine.performAction('open_perp', {
            ticker: perp.ticker,
            side: 'LONG',
            size: (decision.parameters?.size as number) || 10,
            leverage: (decision.parameters?.leverage as number) || 1,
          });
        }
        break;
      }

      case 'open_short': {
        const perp = state.perpetualMarkets[0];
        if (perp) {
          await engine.performAction('open_perp', {
            ticker: perp.ticker,
            side: 'SHORT',
            size: (decision.parameters?.size as number) || 10,
            leverage: (decision.parameters?.leverage as number) || 1,
          });
        }
        break;
      }

      case 'close_position':
        // Note: Position tracking is simplified in benchmarks - we track PnL
        // from buy/sell actions but don't maintain a full position book.
        // The agent's decision to "close" is logged but positions auto-settle at end.
        logger.debug('close_position: Position will settle at benchmark end');
        break;

      case 'wait':
      case 'hold':
        // Do nothing
        break;

      default:
        logger.debug(`Unknown action: ${decision.action}`);
    }
  }

  /**
   * Execute baseline strategy (no LLM)
   */
  private async executeBaselineStrategy(
    strategy: 'random' | 'momentum',
    engine: SimulationEngine,
    rng: SeededRandom
  ): Promise<void> {
    const state = engine.getGameState();

    // Only trade in ~10% of ticks
    if (rng.next() > 0.1) return;

    if (strategy === 'random') {
      const actionType = rng.next() > 0.5 ? 'prediction' : 'perp';

      if (actionType === 'prediction' && state.predictionMarkets.length > 0) {
        const marketIndex = Math.floor(
          rng.next() * state.predictionMarkets.length
        );
        const market = state.predictionMarkets[marketIndex];
        if (market) {
          const outcome = rng.next() > 0.5 ? 'YES' : 'NO';
          const amount = 10 + rng.next() * 90;
          await engine.performAction('buy_prediction', {
            marketId: market.id,
            outcome,
            amount,
          });
        }
      } else if (state.perpetualMarkets.length > 0) {
        const perpIndex = Math.floor(
          rng.next() * state.perpetualMarkets.length
        );
        const perp = state.perpetualMarkets[perpIndex];
        if (perp) {
          const side = rng.next() > 0.5 ? 'LONG' : 'SHORT';
          await engine.performAction('open_perp', {
            ticker: perp.ticker,
            side,
            size: 10,
            leverage: 1,
          });
        }
      }
    } else if (strategy === 'momentum') {
      if (state.perpetualMarkets.length > 0) {
        const perpIndex = Math.floor(
          rng.next() * state.perpetualMarkets.length
        );
        const perp = state.perpetualMarkets[perpIndex];
        if (perp) {
          if (perp.priceChange24h > 0.5) {
            await engine.performAction('open_perp', {
              ticker: perp.ticker,
              side: 'LONG',
              size: 20,
              leverage: 2,
            });
          } else if (perp.priceChange24h < -0.5) {
            await engine.performAction('open_perp', {
              ticker: perp.ticker,
              side: 'SHORT',
              size: 20,
              leverage: 2,
            });
          }
        }
      }
    }
  }

  /**
   * Build system prompt for agent
   */
  private buildSystemPrompt(archetype: string): string {
    return `You are a trading agent with the "${archetype}" archetype in a prediction market simulation.

Your goal is to maximize profit while exhibiting behavior consistent with your archetype.

Respond with a JSON object containing your decision:
{
  "action": "buy_prediction" | "sell_prediction" | "open_long" | "open_short" | "close_position" | "wait",
  "reasoning": "Brief explanation of your decision",
  "confidence": 0.0 to 1.0,
  "parameters": { "amount": number, "size": number, "leverage": number }
}

Available actions:
- buy_prediction: Buy shares in a prediction market
- sell_prediction: Sell shares in a prediction market
- open_long: Open a long perpetual position
- open_short: Open a short perpetual position
- close_position: Close existing positions
- wait: Take no action this tick

Consider market conditions, your current balance, and risk management.`;
  }

  /**
   * Build user prompt with current game state
   */
  private buildUserPrompt(
    state: ReturnType<SimulationEngine['getGameState']>
  ): string {
    const markets = state.predictionMarkets
      .slice(0, 3)
      .map((m) => `  - ${m.id}: ${(m.yesPrice * 100).toFixed(1)}% YES`)
      .join('\n');

    const perps = state.perpetualMarkets
      .slice(0, 3)
      .map(
        (p) =>
          `  - ${p.ticker}: ${formatCurrency(p.price)} (${p.priceChange24h > 0 ? '+' : ''}${p.priceChange24h.toFixed(2)}%)`
      )
      .join('\n');

    // Get agent info from state
    const agent = state.agents[0];
    const pnl = agent?.totalPnl ?? 0;
    // Calculate balance from starting balance + PnL (SimulatedAgent doesn't track balance directly)
    const balance = this.config.startingBalance + pnl;

    return `Current State:
- Balance: ${formatCurrency(balance)}
- P&L: ${formatCurrency(pnl)}
- Tick: ${state.tick}

Prediction Markets:
${markets || '  None available'}

Perpetual Markets:
${perps || '  None available'}

What action do you take?`;
  }

  /**
   * Truncate scenario for quick mode
   */
  private truncateScenarioForQuickMode(
    scenario: FixedBenchmarkScenario,
    quickDays: number
  ): FixedBenchmarkScenario {
    if (scenario.durationDays <= quickDays) {
      return scenario;
    }

    const ticksPerDay = scenario.snapshot.ticks.length / scenario.durationDays;
    const quickTicks = Math.floor(ticksPerDay * quickDays);
    const newDurationSeconds = quickTicks * scenario.snapshot.tickInterval;

    return {
      ...scenario,
      durationDays: quickDays,
      snapshot: {
        ...scenario.snapshot,
        duration: newDurationSeconds,
        ticks: scenario.snapshot.ticks.slice(0, quickTicks),
        groundTruth: {
          ...scenario.snapshot.groundTruth,
          priceHistory: Object.fromEntries(
            Object.entries(scenario.snapshot.groundTruth.priceHistory).map(
              ([ticker, prices]) => [ticker, prices.slice(0, quickTicks)]
            )
          ),
          causalEvents: scenario.snapshot.groundTruth.causalEvents?.filter(
            (event) => event.tick < quickTicks
          ),
        },
      },
    };
  }

  /**
   * Determine benchmark verdict
   */
  private determineVerdict(
    alpha: number,
    trainedFit: ArchetypeFitScore,
    baselineFit: ArchetypeFitScore
  ): 'deploy' | 'continue' | 'regression' {
    // Significant positive alpha and better fit = deploy
    if (alpha > 100 && trainedFit.fitScore > baselineFit.fitScore) {
      return 'deploy';
    }

    // Significant negative alpha = regression
    if (alpha < -100 && trainedFit.fitScore < baselineFit.fitScore) {
      return 'regression';
    }

    // Everything else = continue training
    return 'continue';
  }
}

/**
 * Create benchmark runner from environment variables
 */
export function createVLLMBenchmarkRunnerFromEnv(): VLLMBenchmarkRunner {
  const config: VLLMBenchmarkConfig = {
    vllmUrl: process.env.VLLM_URL || 'http://localhost:9001',
    baseModel:
      process.env.BASE_MODEL || process.env.VLLM_MODEL || 'Qwen/Qwen3-4B',
    adapterPath: process.env.MODEL_PATH || process.env.ADAPTER_PATH,
    outputDir: process.env.BENCHMARK_OUTPUT_DIR || './benchmark-results',
    quickMode: process.env.BENCHMARK_QUICK === 'true',
    timeoutMs: parseInt(process.env.BENCHMARK_TIMEOUT_MS || '60000', 10),
  };

  return new VLLMBenchmarkRunner(config);
}
