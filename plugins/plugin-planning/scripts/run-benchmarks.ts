#!/usr/bin/env tsx

/**
 * Comprehensive Planning Benchmark Runner
 *
 * This script demonstrates how to run ElizaOS planning benchmarks
 * against REALM-Bench and API-Bank test suites.
 *
 * Usage:
 *   npm run benchmark
 *   npm run benchmark -- --realm-bench /path/to/realm-bench --api-bank /path/to/api-bank
 *   tsx scripts/run-benchmarks.ts --verbose --max-tests 50
 */

import { type Character, logger } from '@elizaos/core';
import { runBenchmarkCommand, type BenchmarkCommandOptions } from '../src/cli/benchmark-command';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Example planning-focused character for benchmarks
 */
const PLANNING_CHARACTER: Character = {
  name: 'ElizaPlanningAgent',
  bio: [
    'I am ElizaPlanningAgent, a sophisticated AI assistant specializing in task planning and execution.',
    'I excel at breaking down complex multi-step requests into efficient, actionable plans.',
    'My core strength is systematic thinking and coordinated action execution.',
  ],
  system: `You are ElizaPlanningAgent, an advanced AI assistant with exceptional planning and execution capabilities.

Core Competencies:
- **Strategic Planning**: Break complex requests into logical, efficient step sequences
- **Tool Utilization**: Effectively use available APIs and actions to accomplish goals
- **Adaptive Execution**: Handle errors gracefully and adapt plans when needed
- **Clear Communication**: Provide transparent updates throughout task execution

Planning Methodology:
1. **Analysis**: Thoroughly understand the request and context
2. **Decomposition**: Break complex tasks into manageable steps
3. **Resource Assessment**: Identify required tools and constraints
4. **Execution Planning**: Create optimal step sequences (sequential/parallel/DAG)
5. **Error Handling**: Plan fallback options and recovery strategies
6. **Validation**: Ensure each step contributes to the overall goal

When planning:
- Be thorough but efficient
- Consider dependencies between steps
- Use available tools appropriately
- Handle edge cases and errors
- Provide clear progress updates
- Adapt when plans need modification

Always prioritize accuracy, efficiency, and user satisfaction in your planning process.`,
  messageExamples: [
    [
      {
        name: 'user',
        content: {
          text: 'Help me plan and execute a comprehensive market research project on sustainable technology trends',
        },
      },
      {
        name: 'ElizaPlanningAgent',
        content: {
          text: "I'll help you plan a comprehensive market research project on sustainable technology trends. This requires systematic data gathering, analysis, and synthesis.",
          thought:
            'This is a complex multi-step research project requiring: 1) Scope definition, 2) Source identification, 3) Data collection, 4) Analysis, 5) Report generation. I need to plan each phase carefully.',
          actions: ['THINK', 'SEARCH', 'ANALYZE', 'COMPILE_REPORT'],
        },
      },
    ],
    [
      {
        name: 'user',
        content: {
          text: 'I need to coordinate a product launch involving multiple teams and dependencies',
        },
      },
      {
        name: 'ElizaPlanningAgent',
        content: {
          text: "I'll help you coordinate a successful product launch. This requires careful orchestration of multiple teams with interdependent tasks.",
          thought:
            'Product launch coordination involves: 1) Timeline planning, 2) Team coordination, 3) Dependency management, 4) Risk mitigation, 5) Communication planning. This needs a DAG execution model due to dependencies.',
          actions: ['CREATE_PROJECT_PLAN', 'COORDINATE_TEAMS', 'MANAGE_TIMELINE'],
        },
      },
    ],
    [
      {
        name: 'user',
        content: { text: 'Find the best restaurant nearby and make a reservation for tonight' },
      },
      {
        name: 'ElizaPlanningAgent',
        content: {
          text: "I'll help you find a great restaurant and make a reservation for tonight. Let me search for options and handle the booking.",
          thought:
            'This is a sequential task: 1) Get user location, 2) Search restaurants, 3) Filter by availability, 4) Present options, 5) Make reservation. Straightforward execution plan.',
          actions: ['GET_LOCATION', 'SEARCH_RESTAURANTS', 'MAKE_RESERVATION'],
        },
      },
    ],
  ],
  postExamples: [],
  topics: [
    'strategic planning',
    'project management',
    'task coordination',
    'workflow optimization',
    'resource management',
    'problem solving',
    'research methodology',
    'team coordination',
    'process improvement',
    'decision making',
  ],
  knowledge: [
    'Planning methodologies and frameworks',
    'Project management best practices',
    'Workflow optimization techniques',
    'Resource allocation strategies',
    'Risk management approaches',
    'Team coordination methods',
    'Process improvement principles',
    'Decision-making frameworks',
  ],
  plugins: ['@elizaos/plugin-planning', '@elizaos/plugin-sql'],
};

/**
 * Parse command line arguments
 */
function parseArgs(): BenchmarkCommandOptions {
  const args = process.argv.slice(2);
  const options: BenchmarkCommandOptions = {
    // Defaults
    verbose: false,
    saveDetails: true,
    enableMetrics: true,
    enableMemory: true,
    timeout: 60000,
    maxTests: 100,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    switch (arg) {
      case '--character':
        if (nextArg && !nextArg.startsWith('--')) {
          options.characterPath = nextArg;
          i++;
        }
        break;

      case '--realm-bench':
        if (nextArg && !nextArg.startsWith('--')) {
          options.realmBenchPath = nextArg;
          options.realmBench = true;
          i++;
        } else {
          options.realmBench = true;
        }
        break;

      case '--api-bank':
        if (nextArg && !nextArg.startsWith('--')) {
          options.apiBankPath = nextArg;
          options.apiBank = true;
          i++;
        } else {
          options.apiBank = true;
        }
        break;

      case '--output':
        if (nextArg && !nextArg.startsWith('--')) {
          options.outputDir = nextArg;
          i++;
        }
        break;

      case '--max-tests':
        if (nextArg && !isNaN(parseInt(nextArg))) {
          options.maxTests = parseInt(nextArg);
          i++;
        }
        break;

      case '--timeout':
        if (nextArg && !isNaN(parseInt(nextArg))) {
          options.timeout = parseInt(nextArg);
          i++;
        }
        break;

      case '--verbose':
        options.verbose = true;
        break;

      case '--no-details':
        options.saveDetails = false;
        break;

      case '--no-metrics':
        options.enableMetrics = false;
        break;

      case '--no-memory':
        options.enableMemory = false;
        break;

      case '--help':
        printHelp();
        process.exit(0);
        break;
    }
  }

  return options;
}

/**
 * Print help information
 */
function printHelp(): void {
  console.log(`
ElizaOS Planning Benchmark Runner

Usage:
  npm run benchmark [options]
  tsx scripts/run-benchmarks.ts [options]

Options:
  --character <path>        Path to character JSON file (optional)
  --realm-bench [path]      Enable REALM-Bench tests (optional path)
  --api-bank [path]         Enable API-Bank tests (optional path)
  --output <path>           Output directory for results (default: ./benchmark-results)
  --max-tests <number>      Maximum tests per category (default: 100)
  --timeout <ms>            Timeout per test in milliseconds (default: 60000)
  --verbose                 Enable verbose output
  --no-details              Don't save detailed logs
  --no-metrics              Disable performance metrics
  --no-memory               Disable memory tracking
  --help                    Show this help message

Examples:
  # Run all benchmarks with default settings
  npm run benchmark

  # Run with custom character and specific benchmark data
  npm run benchmark -- --character ./my-character.json --realm-bench ./realm-bench-data

  # Run API-Bank only with custom output directory
  npm run benchmark -- --api-bank ./api-bank-data --output ./my-results --verbose

  # Quick test run with limited tests
  npm run benchmark -- --max-tests 20 --timeout 30000

Note: If benchmark data paths are not provided, the script will look for them in:
  - ./benchmark-data/realm-bench/
  - ./benchmark-data/api-bank/
`);
}

/**
 * Detect benchmark data directories
 */
function detectBenchmarkPaths(options: BenchmarkCommandOptions): void {
  const baseDir = path.join(process.cwd(), 'benchmark-data');

  // Auto-detect REALM-Bench
  if (options.realmBench && !options.realmBenchPath) {
    const realmPath = path.join(baseDir, 'realm-bench');
    if (fs.existsSync(realmPath)) {
      options.realmBenchPath = realmPath;
      logger.info(`[Benchmark] Auto-detected REALM-Bench: ${realmPath}`);
    } else {
      logger.warn(
        '[Benchmark] REALM-Bench enabled but no data found. Create ./benchmark-data/realm-bench/ or specify --realm-bench <path>'
      );
    }
  }

  // Auto-detect API-Bank
  if (options.apiBank && !options.apiBankPath) {
    const apiBankPath = path.join(baseDir, 'api-bank');
    if (fs.existsSync(apiBankPath)) {
      options.apiBankPath = apiBankPath;
      logger.info(`[Benchmark] Auto-detected API-Bank: ${apiBankPath}`);
    } else {
      logger.warn(
        '[Benchmark] API-Bank enabled but no data found. Create ./benchmark-data/api-bank/ or specify --api-bank <path>'
      );
    }
  }
}

/**
 * Setup benchmark environment
 */
async function setupBenchmarkEnvironment(): Promise<void> {
  // Create benchmark data directory if it doesn't exist
  const benchmarkDataDir = path.join(process.cwd(), 'benchmark-data');
  await fs.promises.mkdir(benchmarkDataDir, { recursive: true });

  // Create README with setup instructions
  const readmePath = path.join(benchmarkDataDir, 'README.md');
  if (!fs.existsSync(readmePath)) {
    const readmeContent = `# Benchmark Data Setup

This directory should contain benchmark datasets for testing ElizaOS planning capabilities.

## Required Structure

\`\`\`
benchmark-data/
├── realm-bench/           # REALM-Bench dataset
│   ├── complex/
│   ├── reactive/
│   ├── sequential/
│   └── README.md
├── api-bank/              # API-Bank dataset  
│   ├── lv1-lv2-samples/
│   ├── lv3-samples/
│   ├── apis/
│   └── README.md
└── README.md              # This file
\`\`\`

## Getting the Data

### REALM-Bench
1. Clone: \`git clone https://github.com/genglongling/REALM-Bench.git\`
2. Copy test data to \`./benchmark-data/realm-bench/\`

### API-Bank
1. Clone: \`git clone https://github.com/AlibabaResearch/DAMO-ConvAI.git\`
2. Copy \`api-bank\` directory to \`./benchmark-data/api-bank/\`

## Running Benchmarks

\`\`\`bash
# Run all benchmarks
npm run benchmark

# Run specific benchmarks
npm run benchmark -- --realm-bench --api-bank --verbose

# Run with custom paths
npm run benchmark -- --realm-bench ./path/to/realm-bench --api-bank ./path/to/api-bank
\`\`\`
`;
    await fs.promises.writeFile(readmePath, readmeContent);
  }
}

/**
 * Create sample character if none provided
 */
async function createSampleCharacter(): Promise<string> {
  const charactersDir = path.join(process.cwd(), 'benchmark-characters');
  await fs.promises.mkdir(charactersDir, { recursive: true });

  const characterPath = path.join(charactersDir, 'planning-agent.json');

  if (!fs.existsSync(characterPath)) {
    await fs.promises.writeFile(characterPath, JSON.stringify(PLANNING_CHARACTER, null, 2));
    logger.info(`[Benchmark] Created sample character: ${characterPath}`);
  }

  return characterPath;
}

/**
 * Main execution function
 */
async function main(): Promise<void> {
  console.log('🚀 ElizaOS Planning Benchmark Runner\n');

  try {
    // Parse command line arguments
    const options = parseArgs();

    // Setup benchmark environment
    await setupBenchmarkEnvironment();

    // Detect benchmark data paths if not specified
    detectBenchmarkPaths(options);

    // Use sample character if none specified
    if (!options.characterPath) {
      options.characterPath = await createSampleCharacter();
    }

    // Enable both benchmarks by default if none specified
    if (!options.realmBench && !options.apiBank) {
      logger.info(
        '[Benchmark] No specific benchmarks selected, enabling both REALM-Bench and API-Bank'
      );
      options.realmBench = true;
      options.apiBank = true;
    }

    // Set default output directory with timestamp
    if (!options.outputDir) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];
      options.outputDir = `./benchmark-results/${timestamp}`;
    }

    // Log configuration
    console.log('📋 Benchmark Configuration:');
    console.log(`   Character: ${options.characterPath}`);
    console.log(
      `   REALM-Bench: ${options.realmBench ? 'enabled' : 'disabled'} ${options.realmBenchPath || ''}`
    );
    console.log(
      `   API-Bank: ${options.apiBank ? 'enabled' : 'disabled'} ${options.apiBankPath || ''}`
    );
    console.log(`   Output: ${options.outputDir}`);
    console.log(`   Max Tests: ${options.maxTests}`);
    console.log(`   Timeout: ${options.timeout}ms`);
    console.log('');

    // Run benchmarks
    await runBenchmarkCommand(options);
  } catch (error) {
    logger.error('[Benchmark] Execution failed:', error);
    console.error(`❌ Benchmark failed: ${error.message}`);

    if (error.message.includes('not found') || error.message.includes('ENOENT')) {
      console.log('\n💡 Tip: Run with --help to see setup instructions');
      console.log(
        '   Make sure benchmark data is available or specify paths with --realm-bench and --api-bank'
      );
    }

    process.exit(1);
  }
}

// Execute if run directly
if (require.main === module) {
  main();
}
