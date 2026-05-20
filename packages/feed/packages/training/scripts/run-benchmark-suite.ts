#!/usr/bin/env bun

/**
 * Benchmark Suite Runner
 *
 * Runs trained models against fixed benchmark scenarios and generates reports.
 *
 * Usage:
 *   bun run packages/training/scripts/run-benchmark-suite.ts
 *   bun run packages/training/scripts/run-benchmark-suite.ts --scenario bear-market
 *   bun run packages/training/scripts/run-benchmark-suite.ts --model ./trained_models/step_100
 *   bun run packages/training/scripts/run-benchmark-suite.ts --quick
 *
 * Options:
 *   --scenario <id>     Run specific scenario (bull-market, bear-market, scandal-unfolds, pump-and-dump)
 *   --model <path>      Path to trained model (default: momentum strategy as "smart" baseline)
 *   --baseline <type>   Baseline strategy: random, momentum (default: random)
 *   --archetype <type>  Test specific archetype (default: trader)
 *   --quick             Quick mode (7-day scenarios instead of 22-day)
 *   --output <dir>      Output directory for reports
 *   --json              Output JSON only (no HTML)
 */

import { initializeJsonMode } from '@feed/db';
import type { IAgentRuntime } from '@elizaos/core';
import { mkdirSync, unlinkSync } from 'fs';
import * as path from 'path';
import { parseArgs } from 'util';
import {
  ArchetypeFitCalculator,
  type ArchetypeFitScore,
} from '../src/benchmark/ArchetypeFitCalculator';
import { BenchmarkRunner } from '../src/benchmark/BenchmarkRunner';
import {
  type FixedBenchmarkScenario,
  isValidScenarioId,
  type ScenarioId,
  ScenarioLoader,
} from '../src/benchmark/ScenarioLoader';
import type { SimulationResult } from '../src/benchmark/SimulationEngine';
import {
  type FullBenchmarkReport,
  StakeholderReportGenerator,
} from '../src/benchmark/StakeholderReport';
import { logger } from '../src/utils/logger';

// ============================================================================
// Constants
// ============================================================================

/** Duration in days for quick mode (vs full 22-day scenarios) */
const QUICK_MODE_DURATION_DAYS = 7;

// ============================================================================
// CLI Parsing
// ============================================================================

interface BenchmarkOptions {
  scenario?: ScenarioId;
  model?: string;
  baseline: 'random' | 'momentum';
  archetype: string;
  quick: boolean;
  output: string;
  json: boolean;
}

function parseCliArgs(): BenchmarkOptions {
  const { values } = parseArgs({
    options: {
      scenario: { type: 'string', short: 's' },
      model: { type: 'string', short: 'm' },
      baseline: { type: 'string', short: 'b', default: 'random' },
      archetype: { type: 'string', short: 'a', default: 'trader' },
      quick: { type: 'boolean', short: 'q', default: false },
      output: { type: 'string', short: 'o', default: '' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`
Benchmark Suite Runner

Usage:
  bun run packages/training/scripts/run-benchmark-suite.ts [options]

Options:
  -s, --scenario <id>     Run specific scenario only
                          (bull-market, bear-market, scandal-unfolds, pump-and-dump)
  -m, --model <path>      Path to trained model checkpoint
  -b, --baseline <type>   Baseline strategy: random, momentum (default: random)
  -a, --archetype <type>  Archetype to test (default: trader)
  -q, --quick             Quick mode (uses shorter scenarios)
  -o, --output <dir>      Output directory for reports
      --json              Output JSON only (skip HTML report)
  -h, --help              Show this help message

Examples:
  # Run full suite with random baseline
  bun run packages/training/scripts/run-benchmark-suite.ts

  # Run single scenario with trained model
  bun run packages/training/scripts/run-benchmark-suite.ts --scenario bear-market --model ./trained_models/step_100

  # Quick benchmark with momentum baseline
  bun run packages/training/scripts/run-benchmark-suite.ts --quick --baseline momentum
    `);
    process.exit(0);
  }

  // Validate scenario
  if (values.scenario && !isValidScenarioId(values.scenario)) {
    console.error(`Invalid scenario: ${values.scenario}`);
    console.error(
      'Valid scenarios: bull-market, bear-market, scandal-unfolds, pump-and-dump'
    );
    process.exit(1);
  }

  // Validate baseline
  if (values.baseline && !['random', 'momentum'].includes(values.baseline)) {
    console.error(`Invalid baseline: ${values.baseline}`);
    console.error('Valid baselines: random, momentum');
    process.exit(1);
  }

  return {
    scenario: values.scenario as ScenarioId | undefined,
    model: values.model,
    baseline: (values.baseline as 'random' | 'momentum') || 'random',
    archetype: values.archetype || 'trader',
    quick: values.quick || false,
    output:
      values.output ||
      path.join(process.cwd(), 'benchmark-results', `suite-${Date.now()}`),
    json: values.json || false,
  };
}

// ============================================================================
// Mock Runtime Factory
// ============================================================================

/**
 * Creates a mock IAgentRuntime for benchmark simulations.
 *
 * This factory provides a minimal runtime interface that the benchmark
 * runner needs. For production, this should be replaced with a proper
 * runtime factory from @elizaos/core.
 *
 * @param modelPath - Optional path to a trained model checkpoint
 * @returns A mock runtime suitable for benchmarking
 */
function createBenchmarkRuntime(modelPath?: string): IAgentRuntime {
  const settings: Record<string, string> = {
    model: modelPath || 'gpt-4-turbo',
  };

  if (modelPath) {
    logger.info('Model path provided - using trained model', { modelPath });
    settings.GROQ_LARGE_MODEL = modelPath;
    settings.GROQ_SMALL_MODEL = modelPath;
  }

  // Minimal mock runtime - extend as needed for actual model inference
  const runtime: Partial<IAgentRuntime> = {
    character: {
      settings,
    } as IAgentRuntime['character'],
  };

  return runtime as IAgentRuntime;
}

// ============================================================================
// Quick Mode Scenario Truncation
// ============================================================================

/**
 * Truncates a scenario to QUICK_MODE_DURATION_DAYS for faster benchmarking.
 *
 * This creates a shallow copy with truncated ticks and adjusted duration,
 * while preserving all other scenario properties.
 */
function truncateScenarioForQuickMode(
  scenario: FixedBenchmarkScenario
): FixedBenchmarkScenario {
  const originalDays = scenario.durationDays;

  // If scenario is already shorter than quick mode duration, return as-is
  if (originalDays <= QUICK_MODE_DURATION_DAYS) {
    return scenario;
  }

  // Calculate how many ticks to keep
  const ticksPerDay = scenario.snapshot.ticks.length / originalDays;
  const quickModeTicks = Math.floor(ticksPerDay * QUICK_MODE_DURATION_DAYS);

  // Calculate new duration in seconds
  const tickIntervalSeconds = scenario.snapshot.tickInterval;
  const newDurationSeconds = quickModeTicks * tickIntervalSeconds;

  logger.debug('Truncating scenario for quick mode', {
    scenarioId: scenario.id,
    originalDays,
    quickDays: QUICK_MODE_DURATION_DAYS,
    originalTicks: scenario.snapshot.ticks.length,
    quickTicks: quickModeTicks,
  });

  // Create truncated scenario (shallow copy with modified snapshot)
  return {
    ...scenario,
    durationDays: QUICK_MODE_DURATION_DAYS,
    snapshot: {
      ...scenario.snapshot,
      duration: newDurationSeconds,
      ticks: scenario.snapshot.ticks.slice(0, quickModeTicks),
      // Truncate ground truth price history to match
      groundTruth: {
        ...scenario.snapshot.groundTruth,
        priceHistory: Object.fromEntries(
          Object.entries(scenario.snapshot.groundTruth.priceHistory).map(
            ([ticker, prices]) => [ticker, prices.slice(0, quickModeTicks)]
          )
        ),
        // Keep only causal events within the truncated time range
        causalEvents: scenario.snapshot.groundTruth.causalEvents?.filter(
          (event) => event.tick < quickModeTicks
        ),
      },
    },
  };
}

// ============================================================================
// Benchmark Execution
// ============================================================================

async function runScenarioBenchmark(
  scenario: FixedBenchmarkScenario,
  options: BenchmarkOptions,
  outputDir: string
): Promise<{
  baselineResult: SimulationResult;
  challengerResult: SimulationResult;
  baselineFit: ArchetypeFitScore;
  challengerFit: ArchetypeFitScore;
}> {
  logger.info(`Running benchmark: ${scenario.name}`, {
    scenarioId: scenario.id,
    archetype: options.archetype,
    baseline: options.baseline,
    hasModel: !!options.model,
  });

  const scenarioOutputDir = path.join(outputDir, scenario.id);
  mkdirSync(scenarioOutputDir, { recursive: true });

  // Initialize JSON DB for this run
  const dbPath = path.join(scenarioOutputDir, 'db_storage');
  mkdirSync(dbPath, { recursive: true });
  initializeJsonMode(dbPath);

  const mockRuntime = createBenchmarkRuntime(options.model);
  const fitCalculator = new ArchetypeFitCalculator();

  // Save the snapshot temporarily for BenchmarkRunner to load
  const tempSnapshotPath = path.join(scenarioOutputDir, 'temp-snapshot.json');
  const snapshotJson = JSON.stringify(scenario.snapshot);
  await Bun.write(tempSnapshotPath, snapshotJson);

  try {
    // Run baseline
    logger.info(`Running baseline (${options.baseline})...`);
    const baselineResult = await BenchmarkRunner.runSingle({
      benchmarkPath: tempSnapshotPath,
      agentRuntime: mockRuntime,
      agentUserId: 'baseline-agent',
      saveTrajectory: false,
      outputDir: path.join(scenarioOutputDir, 'baseline'),
      forceStrategy: options.baseline,
    });

    // Run challenger
    logger.info('Running challenger...');
    const challengerStrategy = options.model
      ? undefined // Use agent-driven if model provided
      : 'momentum'; // Use momentum as "smart" proxy otherwise

    const challengerResult = await BenchmarkRunner.runSingle({
      benchmarkPath: tempSnapshotPath,
      agentRuntime: mockRuntime,
      agentUserId: 'challenger-agent',
      saveTrajectory: true,
      outputDir: path.join(scenarioOutputDir, 'challenger'),
      forceStrategy: challengerStrategy,
      forceModel: options.model,
    });

    // Calculate archetype fit
    const baselineFit = fitCalculator.calculate(
      baselineResult,
      options.archetype,
      scenario.durationDays
    );

    const challengerFit = fitCalculator.calculate(
      challengerResult,
      options.archetype,
      scenario.durationDays
    );

    logger.info(`Scenario complete: ${scenario.name}`, {
      baselinePnl: baselineResult.metrics.totalPnl,
      challengerPnl: challengerResult.metrics.totalPnl,
      alpha:
        challengerResult.metrics.totalPnl - baselineResult.metrics.totalPnl,
      baselineFit: baselineFit.fitScore,
      challengerFit: challengerFit.fitScore,
    });

    return {
      baselineResult,
      challengerResult,
      baselineFit,
      challengerFit,
    };
  } finally {
    // Clean up temp snapshot file
    try {
      unlinkSync(tempSnapshotPath);
    } catch {
      // Ignore cleanup errors - file may not exist
    }
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log('');
  console.log(
    '═══════════════════════════════════════════════════════════════'
  );
  console.log('                    BENCHMARK SUITE RUNNER');
  console.log(
    '═══════════════════════════════════════════════════════════════'
  );
  console.log('');

  const options = parseCliArgs();

  logger.info('Starting benchmark suite', {
    scenario: options.scenario || 'all',
    model: options.model || 'none (using strategy proxy)',
    baseline: options.baseline,
    archetype: options.archetype,
    quick: options.quick,
  });

  // Create output directory
  mkdirSync(options.output, { recursive: true });

  // Load scenarios
  const scenarioLoader = new ScenarioLoader();
  let scenarios: FixedBenchmarkScenario[];

  if (options.scenario) {
    scenarios = [await scenarioLoader.loadScenario(options.scenario)];
  } else {
    scenarios = await scenarioLoader.loadAllScenarios();
  }

  // Apply quick mode: truncate scenarios to QUICK_MODE_DURATION_DAYS
  if (options.quick) {
    const originalDuration = scenarios[0]?.durationDays || 22;
    scenarios = scenarios.map((scenario) =>
      truncateScenarioForQuickMode(scenario)
    );
    console.log(
      `⚡ Quick mode: Running ${QUICK_MODE_DURATION_DAYS}-day scenarios (vs full ${originalDuration} days)`
    );
  }

  console.log(`📋 Running ${scenarios.length} scenario(s):`);
  for (const s of scenarios) {
    console.log(
      `   • ${s.name} (${s.id}) - ${s.durationDays} days, ${s.snapshot.ticks.length} ticks`
    );
  }
  console.log('');

  // Run benchmarks
  const results: Array<{
    scenario: FixedBenchmarkScenario;
    baselineResult: SimulationResult;
    challengerResult: SimulationResult;
    baselineFit: ArchetypeFitScore;
    challengerFit: ArchetypeFitScore;
    archetype: string;
  }> = [];

  // Track failed scenarios for summary
  const failures: Array<{ scenario: string; error: string }> = [];

  for (const scenario of scenarios) {
    console.log(`\n🎯 Running: ${scenario.name}`);
    console.log('─'.repeat(60));

    try {
      const result = await runScenarioBenchmark(
        scenario,
        options,
        options.output
      );

      results.push({
        scenario,
        ...result,
        archetype: options.archetype,
      });

      console.log(`   ✅ Complete`);
      console.log(
        `   📈 Baseline P&L: $${result.baselineResult.metrics.totalPnl.toFixed(2)}`
      );
      console.log(
        `   📈 Challenger P&L: $${result.challengerResult.metrics.totalPnl.toFixed(2)}`
      );
      console.log(
        `   🎯 Alpha: $${(result.challengerResult.metrics.totalPnl - result.baselineResult.metrics.totalPnl).toFixed(2)}`
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(`   ❌ Scenario failed: ${scenario.name}`);
      console.error(`   Error: ${errorMessage}`);
      logger.error('Scenario benchmark failed', {
        scenario: scenario.name,
        error: errorMessage,
      });
      // Track failure and continue to next scenario
      failures.push({ scenario: scenario.name, error: errorMessage });
    }
  }

  // Report any failures
  if (failures.length > 0) {
    console.warn(`\n⚠️ ${failures.length} scenario(s) failed:`);
    for (const f of failures) {
      console.warn(`   • ${f.scenario}: ${f.error}`);
    }
  }

  // Generate report
  console.log('\n📊 Generating reports...');

  const modelVersion = options.model
    ? path.basename(options.model)
    : 'momentum-strategy-proxy';

  const baselineDescription = `${options.baseline} strategy`;

  const report: FullBenchmarkReport = StakeholderReportGenerator.createReport(
    modelVersion,
    baselineDescription,
    results
  );

  // Save reports
  if (options.json) {
    const jsonPath = path.join(options.output, 'report.json');
    await StakeholderReportGenerator.generateJson(report, jsonPath);
    console.log(`\n✅ JSON report saved to: ${jsonPath}`);
  } else {
    const paths = await StakeholderReportGenerator.saveAllFormats(
      report,
      options.output
    );
    console.log(`\n✅ Reports saved to:`);
    console.log(`   HTML: ${paths.html}`);
    console.log(`   JSON: ${paths.json}`);
    console.log(`   Text: ${paths.text}`);
  }

  // Print summary
  console.log('\n' + StakeholderReportGenerator.generateTextSummary(report));

  // Exit with appropriate code
  if (report.summary.overallVerdict === 'regression') {
    console.error('\n❌ Benchmark failed: Model shows regression');
    process.exit(1);
  } else if (report.summary.overallVerdict === 'deploy') {
    console.log('\n🎉 Benchmark passed: Model ready for deployment');
    process.exit(0);
  } else {
    console.log('\n🔄 Benchmark complete: Continue training');
    process.exit(0);
  }
}

main().catch((error) => {
  console.error('❌ Benchmark suite failed:', error);
  logger.error('Benchmark suite failed', {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});
