/**
 * Scenario Loader
 *
 * Loads and validates fixed benchmark scenarios from the data directory.
 * Provides utilities for listing, loading, and validating scenarios.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';
import type {
  BenchmarkGameSnapshot,
  GroundTruth,
} from './BenchmarkDataGenerator';

// ============================================================================
// Types
// ============================================================================

export interface ScenarioSuccessCriteria {
  /** Trader should achieve at least this P&L ratio vs baseline (e.g., -0.5 = lose less than 50% of baseline loss) */
  traderMinPnlRatio: number;
  /** Scammer should extract at least this much alpha */
  scammerMinAlpha: number;
  /** Degen should complete at least this many trades */
  degenMinTrades: number;
}

export interface ScenarioExpectedBehavior {
  trader: string;
  degen: string;
  scammer: string;
  'social-butterfly': string;
}

export interface FixedBenchmarkScenario {
  /** Scenario identifier (e.g., "bear-market") */
  id: string;
  /** Human-readable name */
  name: string;
  /** Description of what this scenario tests */
  description: string;
  /** Market condition classification */
  marketCondition: 'bull' | 'bear' | 'volatile' | 'scandal';
  /** Duration in days */
  durationDays: number;
  /** Expected behavior per archetype */
  expectedBehavior: ScenarioExpectedBehavior;
  /** Success criteria for evaluation */
  successCriteria: ScenarioSuccessCriteria;
  /** Whether this scenario uses causal simulation */
  useCausalSimulation: boolean;
  /** The pre-generated benchmark snapshot */
  snapshot: BenchmarkGameSnapshot;
}

export interface ScenarioMetadata {
  id: string;
  name: string;
  description: string;
  marketCondition: string;
  durationDays: number;
  tickCount: number;
  useCausalSimulation: boolean;
  hasCausalEvents: boolean;
  causalEventCount: number;
}

// Centralized scenario ID list - single source of truth
const SCENARIO_IDS = [
  'bull-market',
  'bear-market',
  'scandal-unfolds',
  'pump-and-dump',
] as const;

export type ScenarioId = (typeof SCENARIO_IDS)[number];

// ============================================================================
// Validation
// ============================================================================

export class ScenarioValidationError extends Error {
  constructor(
    public readonly scenarioId: string,
    public readonly issues: string[]
  ) {
    super(
      `Scenario "${scenarioId}" validation failed:\n${issues.map((i) => `  - ${i}`).join('\n')}`
    );
    this.name = 'ScenarioValidationError';
  }
}

function validateSnapshot(snapshot: BenchmarkGameSnapshot): string[] {
  const issues: string[] = [];

  if (!snapshot.id) {
    issues.push('Missing snapshot.id');
  }

  if (!snapshot.version) {
    issues.push('Missing snapshot.version');
  }

  if (!snapshot.initialState) {
    issues.push('Missing snapshot.initialState');
  } else {
    if (
      !Array.isArray(snapshot.initialState.perpetualMarkets) ||
      snapshot.initialState.perpetualMarkets.length === 0
    ) {
      issues.push('initialState.perpetualMarkets must be a non-empty array');
    }
    if (
      !Array.isArray(snapshot.initialState.predictionMarkets) ||
      snapshot.initialState.predictionMarkets.length === 0
    ) {
      issues.push('initialState.predictionMarkets must be a non-empty array');
    }
    if (
      !Array.isArray(snapshot.initialState.agents) ||
      snapshot.initialState.agents.length === 0
    ) {
      issues.push('initialState.agents must be a non-empty array');
    }
  }

  if (!Array.isArray(snapshot.ticks) || snapshot.ticks.length === 0) {
    issues.push('snapshot.ticks must be a non-empty array');
  } else {
    // Validate tick count matches expected duration
    const expectedTicks = Math.floor(snapshot.duration / snapshot.tickInterval);
    if (snapshot.ticks.length !== expectedTicks) {
      issues.push(
        `Expected ${expectedTicks} ticks but got ${snapshot.ticks.length}`
      );
    }

    // Validate tick continuity
    for (let i = 0; i < snapshot.ticks.length; i++) {
      if (snapshot.ticks[i]!.number !== i) {
        issues.push(
          `Tick ${i} has incorrect number: ${snapshot.ticks[i]!.number}`
        );
        break;
      }
    }
  }

  if (!snapshot.groundTruth) {
    issues.push('Missing snapshot.groundTruth');
  } else {
    validateGroundTruth(snapshot.groundTruth, snapshot, issues);
  }

  return issues;
}

function validateGroundTruth(
  groundTruth: GroundTruth,
  snapshot: BenchmarkGameSnapshot,
  issues: string[]
): void {
  if (
    !groundTruth.marketOutcomes ||
    typeof groundTruth.marketOutcomes !== 'object'
  ) {
    issues.push('groundTruth.marketOutcomes must be an object');
  }

  if (
    !groundTruth.priceHistory ||
    typeof groundTruth.priceHistory !== 'object'
  ) {
    issues.push('groundTruth.priceHistory must be an object');
  } else if (!snapshot.initialState) {
    // Early return if initialState is missing (already flagged in validateSnapshot)
    return;
  } else {
    // Validate price history exists for all perpetual markets
    for (const perp of snapshot.initialState.perpetualMarkets) {
      if (!groundTruth.priceHistory[perp.ticker]) {
        issues.push(`Missing price history for ticker: ${perp.ticker}`);
      } else {
        const history = groundTruth.priceHistory[perp.ticker]!;
        if (history.length !== snapshot.ticks.length) {
          issues.push(
            `Price history for ${perp.ticker} has ${history.length} entries but expected ${snapshot.ticks.length}`
          );
        }
      }
    }
  }

  // Validate causal events if present
  if (groundTruth.causalEvents && Array.isArray(groundTruth.causalEvents)) {
    for (const event of groundTruth.causalEvents) {
      if (event.tick < 0 || event.tick >= snapshot.ticks.length) {
        issues.push(`Causal event at tick ${event.tick} is out of bounds`);
      }
      if (!event.eventType) {
        issues.push('Causal event missing eventType');
      }
      if (
        !Array.isArray(event.affectedTickers) ||
        event.affectedTickers.length === 0
      ) {
        issues.push('Causal event must have at least one affected ticker');
      }
    }
  }
}

function validateScenario(scenario: FixedBenchmarkScenario): string[] {
  const issues: string[] = [];

  if (!scenario.id) {
    issues.push('Missing scenario.id');
  }

  if (!scenario.name) {
    issues.push('Missing scenario.name');
  }

  if (!scenario.description) {
    issues.push('Missing scenario.description');
  }

  if (
    !['bull', 'bear', 'volatile', 'scandal'].includes(scenario.marketCondition)
  ) {
    issues.push(`Invalid marketCondition: ${scenario.marketCondition}`);
  }

  if (typeof scenario.durationDays !== 'number' || scenario.durationDays <= 0) {
    issues.push('durationDays must be a positive number');
  }

  if (!scenario.expectedBehavior) {
    issues.push('Missing expectedBehavior');
  } else {
    const requiredArchetypes = [
      'trader',
      'degen',
      'scammer',
      'social-butterfly',
    ];
    for (const archetype of requiredArchetypes) {
      if (
        !scenario.expectedBehavior[archetype as keyof ScenarioExpectedBehavior]
      ) {
        issues.push(`Missing expectedBehavior for archetype: ${archetype}`);
      }
    }
  }

  if (!scenario.successCriteria) {
    issues.push('Missing successCriteria');
  } else {
    if (typeof scenario.successCriteria.traderMinPnlRatio !== 'number') {
      issues.push('successCriteria.traderMinPnlRatio must be a number');
    }
    if (typeof scenario.successCriteria.scammerMinAlpha !== 'number') {
      issues.push('successCriteria.scammerMinAlpha must be a number');
    }
    if (typeof scenario.successCriteria.degenMinTrades !== 'number') {
      issues.push('successCriteria.degenMinTrades must be a number');
    }
  }

  if (!scenario.snapshot) {
    issues.push('Missing snapshot');
  } else {
    const snapshotIssues = validateSnapshot(scenario.snapshot);
    issues.push(...snapshotIssues);
  }

  // Validate consistency for causal scenarios
  if (scenario.useCausalSimulation) {
    // Guard against undefined groundTruth before accessing nested properties
    if (!scenario.snapshot?.groundTruth) {
      issues.push('Scenario marked as causal but missing groundTruth');
    } else {
      if (
        !scenario.snapshot.groundTruth.causalEvents ||
        scenario.snapshot.groundTruth.causalEvents.length === 0
      ) {
        issues.push('Scenario marked as causal but has no causal events');
      }
      if (
        !scenario.snapshot.groundTruth.hiddenNarrativeFacts ||
        scenario.snapshot.groundTruth.hiddenNarrativeFacts.length === 0
      ) {
        issues.push(
          'Scenario marked as causal but has no hidden narrative facts'
        );
      }
    }
  }

  return issues;
}

// ============================================================================
// Loader
// ============================================================================

export interface ScenarioLoaderOptions {
  /** Custom directory for scenario files */
  scenarioDir?: string;
  /** Enable caching of loaded scenarios (default: true) */
  enableCache?: boolean;
}

export class ScenarioLoader {
  private readonly scenarioDir: string;
  private readonly enableCache: boolean;
  private scenarioCache: Map<string, FixedBenchmarkScenario> = new Map();

  constructor(options?: ScenarioLoaderOptions | string) {
    // Support legacy string argument for backwards compatibility
    if (typeof options === 'string') {
      this.scenarioDir = options;
      this.enableCache = true;
    } else {
      this.scenarioDir =
        options?.scenarioDir ||
        // Use import.meta.dir to get path relative to this file, not cwd
        path.resolve(import.meta.dir, '../../data/benchmarks/scenarios');
      this.enableCache = options?.enableCache ?? true;
    }
  }

  /**
   * List all available scenarios
   */
  async listScenarios(): Promise<ScenarioMetadata[]> {
    const files = await fs.readdir(this.scenarioDir);
    const scenarios: ScenarioMetadata[] = [];

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      const scenarioId = file.replace('.json', '');

      // Validate scenario ID before loading to avoid confusing errors
      if (!isValidScenarioId(scenarioId)) {
        logger.warn('Skipping unknown scenario file', { file });
        continue;
      }

      const scenario = await this.loadScenario(scenarioId);

      scenarios.push({
        id: scenario.id,
        name: scenario.name,
        description: scenario.description,
        marketCondition: scenario.marketCondition,
        durationDays: scenario.durationDays,
        tickCount: scenario.snapshot.ticks.length,
        useCausalSimulation: scenario.useCausalSimulation,
        hasCausalEvents:
          (scenario.snapshot.groundTruth.causalEvents?.length ?? 0) > 0,
        causalEventCount:
          scenario.snapshot.groundTruth.causalEvents?.length ?? 0,
      });
    }

    return scenarios;
  }

  /**
   * Load a specific scenario by ID
   */
  async loadScenario(scenarioId: ScenarioId): Promise<FixedBenchmarkScenario> {
    // Check cache if enabled
    if (this.enableCache) {
      const cached = this.scenarioCache.get(scenarioId);
      if (cached) {
        logger.debug('Returning cached scenario', { scenarioId });
        return cached;
      }
    }

    const filePath = path.join(this.scenarioDir, `${scenarioId}.json`);

    logger.debug('Loading scenario from disk', { scenarioId, filePath });

    const content = await fs.readFile(filePath, 'utf-8');
    const scenario = JSON.parse(content) as FixedBenchmarkScenario;

    // Validate
    const issues = validateScenario(scenario);
    if (issues.length > 0) {
      throw new ScenarioValidationError(scenarioId, issues);
    }

    // Cache if enabled
    if (this.enableCache) {
      this.scenarioCache.set(scenarioId, scenario);
    }

    logger.info('Scenario loaded', {
      scenarioId,
      name: scenario.name,
      ticks: scenario.snapshot.ticks.length,
      causal: scenario.useCausalSimulation,
      cached: this.enableCache,
    });

    return scenario;
  }

  /**
   * Load all scenarios
   */
  async loadAllScenarios(): Promise<FixedBenchmarkScenario[]> {
    const scenarios: FixedBenchmarkScenario[] = [];
    for (const id of SCENARIO_IDS) {
      const scenario = await this.loadScenario(id);
      scenarios.push(scenario);
    }

    return scenarios;
  }

  /**
   * Validate all scenarios without loading fully into memory
   */
  async validateAllScenarios(): Promise<{
    valid: boolean;
    errors: Record<string, string[]>;
  }> {
    const errors: Record<string, string[]> = {};
    let valid = true;

    const files = await fs.readdir(this.scenarioDir);

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      const scenarioId = file.replace('.json', '');
      const filePath = path.join(this.scenarioDir, file);

      const content = await fs.readFile(filePath, 'utf-8');

      // Wrap JSON.parse in try-catch to continue validation of other files
      let scenario: FixedBenchmarkScenario;
      try {
        scenario = JSON.parse(content) as FixedBenchmarkScenario;
      } catch (parseError) {
        valid = false;
        errors[scenarioId] = [
          `Invalid JSON in ${filePath}: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
        ];
        continue;
      }

      const issues = validateScenario(scenario);
      if (issues.length > 0) {
        valid = false;
        errors[scenarioId] = issues;
      }
    }

    return { valid, errors };
  }

  /**
   * Get scenario snapshot directly (for BenchmarkRunner compatibility)
   */
  async getSnapshot(scenarioId: ScenarioId): Promise<BenchmarkGameSnapshot> {
    const scenario = await this.loadScenario(scenarioId);
    return scenario.snapshot;
  }

  /**
   * Check if a scenario exists
   */
  async exists(scenarioId: string): Promise<boolean> {
    const filePath = path.join(this.scenarioDir, `${scenarioId}.json`);
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Clear the scenario cache
   */
  clearCache(): void {
    this.scenarioCache.clear();
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let defaultLoader: ScenarioLoader | null = null;

export function getScenarioLoader(): ScenarioLoader {
  if (!defaultLoader) {
    defaultLoader = new ScenarioLoader();
  }
  return defaultLoader;
}

// ============================================================================
// Quick Access Functions
// ============================================================================

export async function loadScenario(
  scenarioId: ScenarioId
): Promise<FixedBenchmarkScenario> {
  return getScenarioLoader().loadScenario(scenarioId);
}

export async function listScenarios(): Promise<ScenarioMetadata[]> {
  return getScenarioLoader().listScenarios();
}

export async function getScenarioSnapshot(
  scenarioId: ScenarioId
): Promise<BenchmarkGameSnapshot> {
  return getScenarioLoader().getSnapshot(scenarioId);
}

export function isValidScenarioId(id: string): id is ScenarioId {
  return SCENARIO_IDS.includes(id as ScenarioId);
}
