import { promises as fs } from 'fs';
import * as path from 'path';
import type { BenchmarkGameSnapshot } from './BenchmarkDataGenerator';
import { type BenchmarkRunConfig, BenchmarkRunner } from './BenchmarkRunner';
import type { SimulationResult } from './SimulationEngine';
import {
  evaluateTrustMetrics,
  type TrustBenchmarkEvaluation,
  type TrustBenchmarkThresholds,
  type TrustGroundTruth,
  type TrustMetrics,
  type TrustProfile,
} from './trust';

export interface BabylonTrustScenario {
  id: string;
  name: string;
  description: string;
  profile: TrustProfile;
  benchmarkGoals: string[];
  thresholds: TrustBenchmarkThresholds;
  snapshot: BenchmarkGameSnapshot;
}

export interface TrustScenarioMetadata {
  id: string;
  name: string;
  description: string;
  profile: TrustProfile;
  tickCount: number;
  trustEventCount: number;
}

export interface BabylonTrustBenchmarkResult {
  scenario: BabylonTrustScenario;
  simulation: SimulationResult;
  evaluation: TrustBenchmarkEvaluation;
}

const TRUST_SCENARIO_IDS = [
  'infiltration-defense',
  'insider-shill-ring',
] as const;

export type TrustScenarioId = (typeof TRUST_SCENARIO_IDS)[number];

export class TrustScenarioValidationError extends Error {
  constructor(
    public readonly scenarioId: string,
    public readonly issues: string[]
  ) {
    super(
      `Trust scenario "${scenarioId}" validation failed:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`
    );
    this.name = 'TrustScenarioValidationError';
  }
}

function validateTrustGroundTruth(
  trustGroundTruth: TrustGroundTruth | undefined,
  snapshot: BenchmarkGameSnapshot,
  issues: string[]
): void {
  if (!trustGroundTruth) {
    issues.push('snapshot.groundTruth.trustGroundTruth is required');
    return;
  }

  if (
    !Array.isArray(trustGroundTruth.events) ||
    trustGroundTruth.events.length === 0
  ) {
    issues.push('trustGroundTruth.events must be a non-empty array');
    return;
  }

  for (const event of trustGroundTruth.events) {
    if (!event.id) {
      issues.push('Trust event missing id');
    }
    if (!event.description) {
      issues.push(`Trust event ${event.id || '<unknown>'} missing description`);
    }
    if (event.tick < 0 || event.tick >= snapshot.ticks.length) {
      issues.push(
        `Trust event ${event.id || '<unknown>'} tick ${event.tick} is out of bounds`
      );
    }
  }
}

function validateTrustScenario(scenario: BabylonTrustScenario): string[] {
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
  if (!scenario.profile) {
    issues.push('Missing scenario.profile');
  }
  if (
    !Array.isArray(scenario.benchmarkGoals) ||
    scenario.benchmarkGoals.length === 0
  ) {
    issues.push('benchmarkGoals must be a non-empty array');
  }
  if (!scenario.snapshot) {
    issues.push('Missing scenario.snapshot');
  } else {
    validateTrustGroundTruth(
      scenario.snapshot.groundTruth?.trustGroundTruth,
      scenario.snapshot,
      issues
    );
  }

  return issues;
}

export interface TrustScenarioLoaderOptions {
  scenarioDir?: string;
  enableCache?: boolean;
}

export class TrustScenarioLoader {
  private readonly scenarioDir: string;
  private readonly enableCache: boolean;
  private readonly cache = new Map<string, BabylonTrustScenario>();

  constructor(options?: TrustScenarioLoaderOptions | string) {
    if (typeof options === 'string') {
      this.scenarioDir = options;
      this.enableCache = true;
      return;
    }

    this.scenarioDir =
      options?.scenarioDir ||
      path.resolve(import.meta.dir, '../../data/benchmarks/trust-scenarios');
    this.enableCache = options?.enableCache ?? true;
  }

  async listScenarios(): Promise<TrustScenarioMetadata[]> {
    const files = await fs.readdir(this.scenarioDir);
    const scenarios: TrustScenarioMetadata[] = [];

    for (const file of files) {
      if (!file.endsWith('.json')) {
        continue;
      }

      const scenario = await this.loadScenario(file.replace('.json', ''));
      const trustGroundTruth = scenario.snapshot.groundTruth.trustGroundTruth;

      scenarios.push({
        id: scenario.id,
        name: scenario.name,
        description: scenario.description,
        profile: scenario.profile,
        tickCount: scenario.snapshot.ticks.length,
        trustEventCount: trustGroundTruth?.events.length ?? 0,
      });
    }

    return scenarios;
  }

  async loadScenario(
    scenarioId: TrustScenarioId | string
  ): Promise<BabylonTrustScenario> {
    if (this.enableCache) {
      const cached = this.cache.get(scenarioId);
      if (cached) {
        return cached;
      }
    }

    const filePath = path.join(this.scenarioDir, `${scenarioId}.json`);
    const scenario = JSON.parse(
      await fs.readFile(filePath, 'utf-8')
    ) as BabylonTrustScenario;
    const issues = validateTrustScenario(scenario);

    if (issues.length > 0) {
      throw new TrustScenarioValidationError(scenarioId, issues);
    }

    if (this.enableCache) {
      this.cache.set(scenarioId, scenario);
    }

    return scenario;
  }

  async getSnapshot(
    scenarioId: TrustScenarioId | string
  ): Promise<BenchmarkGameSnapshot> {
    const scenario = await this.loadScenario(scenarioId);
    return scenario.snapshot;
  }

  async validateAllScenarios(): Promise<{
    valid: boolean;
    errors: Record<string, string[]>;
  }> {
    const files = await fs.readdir(this.scenarioDir);
    const errors: Record<string, string[]> = {};

    for (const file of files) {
      if (!file.endsWith('.json')) {
        continue;
      }

      const scenarioId = file.replace('.json', '');
      try {
        const scenario = await this.loadScenario(scenarioId);
        const issues = validateTrustScenario(scenario);
        if (issues.length > 0) {
          errors[scenarioId] = issues;
        }
      } catch (error) {
        errors[scenarioId] = [
          error instanceof Error ? error.message : String(error),
        ];
      }
    }

    return { valid: Object.keys(errors).length === 0, errors };
  }
}

let defaultLoader: TrustScenarioLoader | null = null;

export function getTrustScenarioLoader(): TrustScenarioLoader {
  if (!defaultLoader) {
    defaultLoader = new TrustScenarioLoader();
  }

  return defaultLoader;
}

export async function loadTrustScenario(
  scenarioId: TrustScenarioId | string
): Promise<BabylonTrustScenario> {
  return getTrustScenarioLoader().loadScenario(scenarioId);
}

export async function listTrustScenarios(): Promise<TrustScenarioMetadata[]> {
  return getTrustScenarioLoader().listScenarios();
}

export function isValidTrustScenarioId(
  scenarioId: string
): scenarioId is TrustScenarioId {
  return (TRUST_SCENARIO_IDS as readonly string[]).includes(scenarioId);
}

export class BabylonTrustBenchmark {
  static evaluateResult(
    scenario: BabylonTrustScenario,
    simulation: SimulationResult
  ): TrustBenchmarkEvaluation {
    const trustMetrics = simulation.metrics.trustMetrics;
    if (!trustMetrics) {
      throw new Error(
        `Simulation result ${simulation.id} is missing trustMetrics for scenario ${scenario.id}`
      );
    }

    return evaluateTrustMetrics(trustMetrics, scenario.thresholds);
  }

  static async runScenario(
    config: BenchmarkRunConfig,
    scenarioId: TrustScenarioId | string
  ): Promise<BabylonTrustBenchmarkResult> {
    const scenario = await loadTrustScenario(scenarioId);
    const simulation = await BenchmarkRunner.runSingle({
      ...config,
      benchmarkSnapshot: scenario.snapshot,
    });

    return {
      scenario,
      simulation,
      evaluation: this.evaluateResult(scenario, simulation),
    };
  }

  static summarizeMetrics(metrics: TrustMetrics): string[] {
    return [
      `Trust score ${metrics.trustScore.toFixed(2)}`,
      `${metrics.scamLossesAvoided.toFixed(2)} scam loss avoided vs ${metrics.scamLossesIncurred.toFixed(2)} incurred`,
      `${metrics.informationSalesRevenue.toFixed(2)} information-sales revenue (${metrics.trustedInformationRevenue.toFixed(2)} trusted / ${metrics.fraudulentInformationRevenue.toFixed(2)} fraudulent)`,
      `${metrics.tradingBreakdown.correctPredictions} correct predictions, ${metrics.tradingBreakdown.goodTrades} good leveraged trades`,
    ];
  }
}
