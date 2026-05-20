#!/usr/bin/env bun

/**
 * vLLM Benchmark Runner
 *
 * Standalone benchmark script that uses a local vLLM server for model inference.
 * Designed to run in Docker containers without the full ElizaOS stack.
 *
 * Usage:
 *   bun run scripts/run-vllm-benchmark.ts
 *   bun run scripts/run-vllm-benchmark.ts --scenario bear-market
 *   bun run scripts/run-vllm-benchmark.ts --model ./trained_models/final_model --quick
 *
 * Options:
 *   --scenario <id>      Run specific scenario (bull-market, bear-market, scandal-unfolds, pump-and-dump)
 *   --model <path>       Path to trained model/adapter (or set MODEL_PATH env)
 *   --vllm-url <url>     vLLM server URL (default: http://localhost:9001)
 *   --base-model <name>  Base model name (default: Qwen/Qwen3-4B)
 *   --baseline <type>    Baseline strategy: random, momentum (default: random)
 *   --archetype <type>   Test specific archetype (default: trader)
 *   --quick              Quick mode (7-day scenarios)
 *   --output <dir>       Output directory for reports
 *   --json               Output JSON only (no text summary)
 *
 * Environment Variables:
 *   VLLM_URL            vLLM server URL
 *   MODEL_PATH          Path to trained adapter
 *   ADAPTER_PATH        Alternative to MODEL_PATH
 *   BASE_MODEL          Base model name
 *   BENCHMARK_QUICK     Set to "true" for quick mode
 */

import { mkdirSync, writeFileSync } from 'fs';
import * as path from 'path';
import { parseArgs } from 'util';
import {
  isValidScenarioId,
  type ScenarioId,
} from '../src/benchmark/ScenarioLoader';
import {
  type VLLMBenchmarkResult,
  VLLMBenchmarkRunner,
} from '../src/benchmark/VLLMBenchmarkRunner';

// ============================================================================
// CLI Parsing
// ============================================================================

interface BenchmarkOptions {
  scenario?: ScenarioId;
  model?: string;
  vllmUrl: string;
  baseModel: string;
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
      'vllm-url': { type: 'string' },
      'base-model': { type: 'string' },
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
vLLM Benchmark Runner

Runs benchmarks using a local vLLM server for model inference.
Designed for containerized environments without the full ElizaOS stack.

Usage:
  bun run scripts/run-vllm-benchmark.ts [options]

Options:
  -s, --scenario <id>     Run specific scenario only
                          (bull-market, bear-market, scandal-unfolds, pump-and-dump)
  -m, --model <path>      Path to trained model/adapter
      --vllm-url <url>    vLLM server URL (default: http://localhost:9001)
      --base-model <name> Base model name (default: Qwen/Qwen3-4B)
  -b, --baseline <type>   Baseline strategy: random, momentum (default: random)
  -a, --archetype <type>  Archetype to test (default: trader)
  -q, --quick             Quick mode (uses shorter scenarios)
  -o, --output <dir>      Output directory for reports
      --json              Output JSON only (skip text summary)
  -h, --help              Show this help message

Environment Variables:
  VLLM_URL       vLLM server URL
  MODEL_PATH     Path to trained adapter
  BASE_MODEL     Base model name

Examples:
  # Run full suite with trained model
  bun run scripts/run-vllm-benchmark.ts --model ./trained_models/final_model

  # Run single scenario in quick mode
  bun run scripts/run-vllm-benchmark.ts --scenario bear-market --quick

  # Use environment variables
  MODEL_PATH=./trained_models/final_model bun run scripts/run-vllm-benchmark.ts
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

  // Model path from CLI or environment
  const modelPath =
    values.model || process.env.MODEL_PATH || process.env.ADAPTER_PATH || '';

  return {
    scenario: values.scenario as ScenarioId | undefined,
    model: modelPath,
    vllmUrl:
      values['vllm-url'] || process.env.VLLM_URL || 'http://localhost:9001',
    baseModel:
      values['base-model'] || process.env.BASE_MODEL || 'Qwen/Qwen3-4B',
    baseline: (values.baseline as 'random' | 'momentum') || 'random',
    archetype: values.archetype || 'trader',
    quick: values.quick || process.env.BENCHMARK_QUICK === 'true',
    output:
      values.output ||
      process.env.BENCHMARK_OUTPUT_DIR ||
      path.join(process.cwd(), 'benchmark-results', `vllm-${Date.now()}`),
    json: values.json || false,
  };
}

// ============================================================================
// Report Generation
// ============================================================================

function generateTextReport(results: VLLMBenchmarkResult[]): string {
  const lines: string[] = [
    '',
    '═══════════════════════════════════════════════════════════════',
    '                    vLLM BENCHMARK RESULTS',
    '═══════════════════════════════════════════════════════════════',
    '',
  ];

  let totalAlpha = 0;
  let deployCount = 0;
  let regressionCount = 0;

  for (const result of results) {
    lines.push(`📊 ${result.scenario.name} (${result.scenario.id})`);
    lines.push('─'.repeat(60));
    lines.push(
      `   Trained P&L:  $${result.trainedResult.metrics.totalPnl.toFixed(2)}`
    );
    lines.push(
      `   Baseline P&L: $${result.baselineResult.metrics.totalPnl.toFixed(2)}`
    );
    lines.push(`   Alpha:        $${result.alpha.toFixed(2)}`);
    lines.push(
      `   Trained Fit:  ${(result.trainedFit.fitScore * 100).toFixed(1)}%`
    );
    lines.push(
      `   Baseline Fit: ${(result.baselineFit.fitScore * 100).toFixed(1)}%`
    );
    lines.push(
      `   Verdict:      ${getVerdictEmoji(result.verdict)} ${result.verdict.toUpperCase()}`
    );
    lines.push('');

    totalAlpha += result.alpha;
    if (result.verdict === 'deploy') deployCount++;
    if (result.verdict === 'regression') regressionCount++;
  }

  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('                         SUMMARY');
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push(`   Scenarios Run:  ${results.length}`);
  lines.push(`   Total Alpha:    $${totalAlpha.toFixed(2)}`);
  lines.push(`   Avg Alpha:      $${(totalAlpha / results.length).toFixed(2)}`);
  lines.push(`   Deploy Ready:   ${deployCount}/${results.length}`);
  lines.push(`   Regressions:    ${regressionCount}/${results.length}`);
  lines.push('');

  const overallVerdict = determineOverallVerdict(results);
  lines.push(
    `   Overall: ${getVerdictEmoji(overallVerdict)} ${overallVerdict.toUpperCase()}`
  );
  lines.push('');

  return lines.join('\n');
}

function getVerdictEmoji(verdict: string): string {
  switch (verdict) {
    case 'deploy':
      return '🎉';
    case 'regression':
      return '❌';
    default:
      return '🔄';
  }
}

function determineOverallVerdict(
  results: VLLMBenchmarkResult[]
): 'deploy' | 'continue' | 'regression' {
  const regressionCount = results.filter(
    (r) => r.verdict === 'regression'
  ).length;
  const deployCount = results.filter((r) => r.verdict === 'deploy').length;

  if (regressionCount > results.length / 2) return 'regression';
  if (deployCount > results.length / 2) return 'deploy';
  return 'continue';
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log('');
  console.log(
    '═══════════════════════════════════════════════════════════════'
  );
  console.log('                    vLLM BENCHMARK RUNNER');
  console.log(
    '═══════════════════════════════════════════════════════════════'
  );
  console.log('');

  const options = parseCliArgs();

  console.log('Configuration:');
  console.log(`  vLLM URL:    ${options.vllmUrl}`);
  console.log(`  Base Model:  ${options.baseModel}`);
  console.log(`  Adapter:     ${options.model || 'none (base model only)'}`);
  console.log(`  Scenario:    ${options.scenario || 'all'}`);
  console.log(`  Baseline:    ${options.baseline}`);
  console.log(`  Archetype:   ${options.archetype}`);
  console.log(`  Quick Mode:  ${options.quick}`);
  console.log(`  Output:      ${options.output}`);
  console.log('');

  // Create output directory
  mkdirSync(options.output, { recursive: true });

  // Set environment variables for runner
  if (options.model) {
    process.env.MODEL_PATH = options.model;
  }
  process.env.VLLM_URL = options.vllmUrl;
  process.env.BASE_MODEL = options.baseModel;
  process.env.BENCHMARK_OUTPUT_DIR = options.output;
  if (options.quick) {
    process.env.BENCHMARK_QUICK = 'true';
  }

  // Create runner
  const runner = new VLLMBenchmarkRunner({
    vllmUrl: options.vllmUrl,
    baseModel: options.baseModel,
    adapterPath: options.model,
    outputDir: options.output,
    quickMode: options.quick,
  });

  // Initialize (wait for vLLM)
  console.log('Connecting to vLLM server...');
  try {
    await runner.initialize();
  } catch (error) {
    console.error('Failed to connect to vLLM server:', error);
    console.error('');
    console.error(
      'Make sure vLLM is running and accessible at:',
      options.vllmUrl
    );
    process.exit(1);
  }

  // Run benchmarks
  let results: VLLMBenchmarkResult[];

  if (options.scenario) {
    console.log(`\nRunning scenario: ${options.scenario}`);
    const result = await runner.runScenario(options.scenario, {
      archetype: options.archetype,
      baseline: options.baseline,
    });
    results = [result];
  } else {
    console.log('\nRunning all scenarios...');
    results = await runner.runAllScenarios({
      archetype: options.archetype,
      baseline: options.baseline,
    });
  }

  // Generate and save reports
  const report = {
    timestamp: new Date().toISOString(),
    config: {
      vllmUrl: options.vllmUrl,
      baseModel: options.baseModel,
      adapterPath: options.model,
      baseline: options.baseline,
      archetype: options.archetype,
      quickMode: options.quick,
    },
    results: results.map((r) => ({
      scenarioId: r.scenario.id,
      scenarioName: r.scenario.name,
      trainedPnl: r.trainedResult.metrics.totalPnl,
      baselinePnl: r.baselineResult.metrics.totalPnl,
      alpha: r.alpha,
      trainedFit: r.trainedFit.fitScore,
      baselineFit: r.baselineFit.fitScore,
      verdict: r.verdict,
    })),
    summary: {
      totalAlpha: results.reduce((sum, r) => sum + r.alpha, 0),
      avgAlpha: results.reduce((sum, r) => sum + r.alpha, 0) / results.length,
      deployCount: results.filter((r) => r.verdict === 'deploy').length,
      regressionCount: results.filter((r) => r.verdict === 'regression').length,
      overallVerdict: determineOverallVerdict(results),
    },
  };

  // Save JSON report
  const jsonPath = path.join(options.output, 'report.json');
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  console.log(`\n📄 JSON report saved: ${jsonPath}`);

  // Print text report
  if (!options.json) {
    const textReport = generateTextReport(results);
    console.log(textReport);

    // Save text report
    const textPath = path.join(options.output, 'report.txt');
    writeFileSync(textPath, textReport);
    console.log(`📄 Text report saved: ${textPath}`);
  }

  // Exit with appropriate code
  const overallVerdict = report.summary.overallVerdict;
  if (overallVerdict === 'regression') {
    console.error('\n❌ Benchmark failed: Model shows regression');
    process.exit(1);
  } else if (overallVerdict === 'deploy') {
    console.log('\n🎉 Benchmark passed: Model ready for deployment');
    process.exit(0);
  } else {
    console.log('\n🔄 Benchmark complete: Continue training');
    process.exit(0);
  }
}

main().catch((error) => {
  console.error('❌ Benchmark failed:', error);
  process.exit(1);
});
