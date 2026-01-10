import { type Character, type Plugin, logger } from '@elizaos/core';
import { BenchmarkRunner, type BenchmarkConfig } from '../benchmarks/benchmark-runner';
import { planningPlugin } from '../index';
import * as fs from 'fs';
// import * as path from 'path';

/**
 * CLI Command for running planning benchmarks
 */
export interface BenchmarkCommandOptions {
  // Required paths
  characterPath?: string;
  realmBenchPath?: string;
  apiBankPath?: string;

  // Test selection
  realmBench?: boolean;
  apiBank?: boolean;
  maxTests?: number;

  // Output options
  outputDir?: string;
  verbose?: boolean;
  saveDetails?: boolean;

  // Performance options
  timeout?: number;
  enableMetrics?: boolean;
  enableMemory?: boolean;

  // Runtime options
  plugins?: string[];
  providers?: string[];
}

/**
 * Default test character for benchmarks
 */
const DEFAULT_CHARACTER: Character = {
  name: 'PlanningBenchmarkAgent',
  bio: [
    'I am a specialized agent designed for testing and benchmarking planning capabilities.',
    'I excel at breaking down complex tasks into actionable steps and executing them efficiently.',
    'My purpose is to validate planning system performance against established benchmarks.',
  ],
  system: `You are PlanningBenchmarkAgent, a specialized AI assistant focused on planning and task execution.

Your capabilities include:
- Breaking down complex requests into actionable step-by-step plans
- Executing plans efficiently with proper error handling and adaptation
- Using available tools and APIs effectively
- Providing clear, helpful responses while completing requested tasks

When planning:
1. Analyze the request thoroughly
2. Consider available actions and constraints
3. Create logical, efficient step sequences
4. Handle errors gracefully with fallback options
5. Provide clear communication throughout execution

Always prioritize accuracy, efficiency, and user satisfaction in your planning and execution.`,
  messageExamples: [
    [
      {
        name: 'user',
        content: { text: 'Plan a research task on climate change impacts' },
      },
      {
        name: 'PlanningBenchmarkAgent',
        content: {
          text: "I'll help you plan a comprehensive research task on climate change impacts. Let me break this down into actionable steps.",
          thought:
            'This requires a systematic approach: defining scope, gathering sources, analyzing data, and presenting findings.',
          actions: ['CREATE_RESEARCH_PLAN'],
        },
      },
    ],
    [
      {
        name: 'user',
        content: { text: 'Send a project update email to the team' },
      },
      {
        name: 'PlanningBenchmarkAgent',
        content: {
          text: "I'll help you send a project update email. Let me gather the relevant information and compose the message.",
          thought:
            'Need to collect project status, format professionally, and send to team members.',
          actions: ['GATHER_PROJECT_STATUS', 'COMPOSE_EMAIL', 'SEND_EMAIL'],
        },
      },
    ],
  ],
  postExamples: [],
  topics: [
    'planning',
    'task management',
    'project coordination',
    'research',
    'communication',
    'problem solving',
    'workflow optimization',
  ],
  knowledge: [],
  plugins: [],
};

/**
 * Execute benchmark command
 */
export async function runBenchmarkCommand(options: BenchmarkCommandOptions): Promise<void> {
  logger.info('[BenchmarkCommand] Starting planning benchmark execution');

  try {
    // Load character
    const character = await loadCharacter(options.characterPath);

    // Prepare plugins
    const plugins = await preparePlugins(options.plugins);

    // Validate benchmark data paths
    await validateBenchmarkPaths(options);

    // Create benchmark configuration
    const config: BenchmarkConfig = {
      character,
      plugins,
      enabledProviders: options.providers,

      // Test data paths
      realmBenchPath: options.realmBenchPath,
      apiBankPath: options.apiBankPath,

      // Benchmark options
      runRealmBench: options.realmBench ?? true,
      runApiBank: options.apiBank ?? true,
      maxTestsPerCategory: options.maxTests,
      timeoutMs: options.timeout ?? 60000,

      // Output configuration
      outputDir: options.outputDir ?? './benchmark-results',
      saveDetailedLogs: options.saveDetails ?? true,

      // Performance monitoring
      enableMetrics: options.enableMetrics ?? true,
      enableMemoryTracking: options.enableMemory ?? true,
    };

    // Create output directory
    await fs.promises.mkdir(config.outputDir, { recursive: true });

    // Run benchmarks
    const runner = new BenchmarkRunner(config);
    const results = await runner.runBenchmarks();

    // Log summary
    logBenchmarkSummary(results, options.verbose || false);

    // Success
    logger.info('[BenchmarkCommand] Benchmark execution completed successfully');
    process.exit(0);
  } catch (error) {
    logger.error('[BenchmarkCommand] Benchmark execution failed:', error);
    console.error(`❌ Benchmark failed: ${(error as Error).message}`);
    process.exit(1);
  }
}

/**
 * Load character configuration
 */
async function loadCharacter(characterPath?: string): Promise<Character> {
  if (!characterPath) {
    logger.info('[BenchmarkCommand] Using default benchmark character');
    return DEFAULT_CHARACTER;
  }

  try {
    logger.info(`[BenchmarkCommand] Loading character from ${characterPath}`);

    if (!fs.existsSync(characterPath)) {
      throw new Error(`Character file not found: ${characterPath}`);
    }

    const content = await fs.promises.readFile(characterPath, 'utf-8');
    const character = JSON.parse(content) as Character;

    // Validate required fields
    if (!character.name || !character.bio || !character.system) {
      throw new Error('Character file missing required fields (name, bio, system)');
    }

    return character;
  } catch (error) {
    logger.error('[BenchmarkCommand] Failed to load character:', error);
    throw new Error(`Failed to load character: ${(error as Error).message}`);
  }
}

/**
 * Prepare plugins for benchmark
 */
async function preparePlugins(pluginNames?: string[]): Promise<Plugin[]> {
  const plugins: Plugin[] = [planningPlugin];

  if (pluginNames && pluginNames.length > 0) {
    logger.info(`[BenchmarkCommand] Loading additional plugins: ${pluginNames.join(', ')}`);

    for (const pluginName of pluginNames) {
      try {
        // Dynamic import of plugin
        const plugin = await import(pluginName);
        plugins.push(plugin.default || plugin);
        logger.info(`[BenchmarkCommand] Loaded plugin: ${pluginName}`);
      } catch (error) {
        logger.warn(`[BenchmarkCommand] Failed to load plugin ${pluginName}:`, error);
      }
    }
  }

  return plugins;
}

/**
 * Validate benchmark data paths
 */
async function validateBenchmarkPaths(options: BenchmarkCommandOptions): Promise<void> {
  if (options.realmBench && options.realmBenchPath) {
    if (!fs.existsSync(options.realmBenchPath)) {
      throw new Error(`REALM-Bench path not found: ${options.realmBenchPath}`);
    }
    logger.info(`[BenchmarkCommand] REALM-Bench data: ${options.realmBenchPath}`);
  }

  if (options.apiBank && options.apiBankPath) {
    if (!fs.existsSync(options.apiBankPath)) {
      throw new Error(`API-Bank path not found: ${options.apiBankPath}`);
    }
    logger.info(`[BenchmarkCommand] API-Bank data: ${options.apiBankPath}`);
  }

  if (!options.realmBench && !options.apiBank) {
    logger.warn('[BenchmarkCommand] No benchmarks enabled - enabling both by default');
    options.realmBench = true;
    options.apiBank = true;
  }
}

/**
 * Log benchmark summary
 */
function logBenchmarkSummary(results: any, verbose: boolean): void {
  const { overallMetrics, summary } = results;

  console.log('\n🎯 PLANNING BENCHMARK RESULTS\n');
  console.log('═'.repeat(50));

  console.log(`📊 Overall Performance: ${summary.performanceScore}/100`);
  console.log(`✅ Success Rate: ${(overallMetrics.overallSuccessRate * 100).toFixed(1)}%`);
  console.log(`📈 Tests Passed: ${overallMetrics.totalPassed}/${overallMetrics.totalTests}`);
  console.log(`⚡ Avg Planning Time: ${overallMetrics.averagePlanningTime.toFixed(0)}ms`);
  console.log(`🚀 Avg Execution Time: ${overallMetrics.averageExecutionTime.toFixed(0)}ms`);

  console.log('\n🔍 Key Findings:');
  summary.keyFindings.forEach((finding: string) => {
    console.log(`  • ${finding}`);
  });

  if (results.realmBenchResults) {
    console.log('\n📋 REALM-Bench Results:');
    console.log(
      `  Success Rate: ${((results.realmBenchResults.passedTests / results.realmBenchResults.totalTests) * 100).toFixed(1)}%`
    );
    console.log(
      `  Tests: ${results.realmBenchResults.passedTests}/${results.realmBenchResults.totalTests}`
    );
    console.log(
      `  Plan Quality: ${(results.realmBenchResults.overallMetrics.averagePlanQuality * 100).toFixed(1)}%`
    );
  }

  if (results.apiBankResults) {
    console.log('\n🔧 API-Bank Results:');
    console.log(
      `  Success Rate: ${((results.apiBankResults.passedTests / results.apiBankResults.totalTests) * 100).toFixed(1)}%`
    );
    console.log(
      `  Tests: ${results.apiBankResults.passedTests}/${results.apiBankResults.totalTests}`
    );
    console.log(
      `  API Accuracy: ${(results.apiBankResults.overallMetrics.averageApiCallAccuracy * 100).toFixed(1)}%`
    );
    console.log(
      `  Response Quality: ${(results.apiBankResults.overallMetrics.averageResponseQuality * 100).toFixed(1)}%`
    );
  }

  console.log('\n💡 Recommendations:');
  results.comparison.strengthsAndWeaknesses.recommendations.forEach((rec: string) => {
    console.log(`  • ${rec}`);
  });

  if (verbose) {
    console.log(
      '\n📁 Detailed results saved to:',
      results.metadata.outputDir || './benchmark-results'
    );

    if (results.comparison.strengthsAndWeaknesses.strengths.length > 0) {
      console.log('\n💪 Strengths:');
      results.comparison.strengthsAndWeaknesses.strengths.forEach((strength: string) => {
        console.log(`  ✓ ${strength}`);
      });
    }

    if (results.comparison.strengthsAndWeaknesses.weaknesses.length > 0) {
      console.log('\n⚠️  Areas for Improvement:');
      results.comparison.strengthsAndWeaknesses.weaknesses.forEach((weakness: string) => {
        console.log(`  • ${weakness}`);
      });
    }
  }

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`🎊 Status: ${summary.status.toUpperCase()}`);
  console.log('');
}

/**
 * CLI entry point for standalone execution
 */
export async function main(): Promise<void> {
  // Parse command line arguments (simplified)
  const args = process.argv.slice(2);
  const options: BenchmarkCommandOptions = {};

  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];

    switch (key) {
      case '--character':
        options.characterPath = value;
        break;
      case '--realm-bench':
        options.realmBenchPath = value;
        options.realmBench = true;
        break;
      case '--api-bank':
        options.apiBankPath = value;
        options.apiBank = true;
        break;
      case '--output':
        options.outputDir = value;
        break;
      case '--max-tests':
        options.maxTests = parseInt(value, 10);
        break;
      case '--timeout':
        options.timeout = parseInt(value, 10);
        break;
      case '--verbose':
        options.verbose = true;
        i--; // No value for this flag
        break;
    }
  }

  await runBenchmarkCommand(options);
}

// Run if called directly
if (require.main === module) {
  main().catch((error) => {
    console.error('Benchmark execution failed:', error);
    process.exit(1);
  });
}
