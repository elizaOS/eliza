#!/usr/bin/env bun

/**
 * Automated Training and Game Testing Pipeline
 *
 * This script automates the complete training and testing workflow:
 * 1. Train a model locally (MLX on Mac, CUDA on Linux/Windows)
 * 2. Test the trained adapter
 * 3. Import to Ollama
 * 4. Run game tests - actual trades on markets
 *
 * Run: bun run packages/training/scripts/train-and-test.ts
 *
 * Options:
 *   --skip-training     Skip model training (use existing adapter)
 *   --skip-test         Skip the game testing after training
 *   --adapter-path      Path to existing adapter (default: auto-detect)
 *   --ticks <n>         Number of game ticks (default: 100)
 *   --archetype <type>  Agent archetype (default: trader)
 *   --verbose           Enable verbose logging
 */

import { type Subprocess, spawn } from 'bun';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '../../..');
const TRAINING_DIR = resolve(SCRIPT_DIR, '../python');

// Configuration
interface PipelineConfig {
  skipTraining: boolean;
  skipBenchmark: boolean;
  adapterPath?: string;
  ticks: number;
  archetype: string;
  verbose: boolean;
}

interface StepResult {
  name: string;
  success: boolean;
  duration: number;
  message: string;
  details?: Record<string, unknown>;
}

const results: StepResult[] = [];

// Show help
function showHelp(): void {
  console.log(`
ElizaOS Automated Training & Game Testing Pipeline

Usage: bun run packages/training/scripts/train-and-test.ts [options]

Options:
  --skip-training     Skip model training (use existing adapter)
  --skip-test         Skip the game testing after training
  --adapter-path      Path to existing adapter (default: auto-detect)
  --ticks <n>         Number of game ticks to run (default: 100)
  --archetype <type>  Agent archetype (default: trader)
  --verbose           Enable verbose logging
  --help              Show this help message

Examples:
  # Full pipeline (train + test)
  bun run packages/training/scripts/train-and-test.ts

  # Skip training, test existing model
  bun run packages/training/scripts/train-and-test.ts --skip-training

  # Train only, no testing
  bun run packages/training/scripts/train-and-test.ts --skip-test

  # Run 500 game ticks with verbose output
  bun run packages/training/scripts/train-and-test.ts --ticks 500 --verbose
`);
}

// Parse command line arguments
function parseConfig(): PipelineConfig {
  // Check for help flag first
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    showHelp();
    process.exit(0);
  }

  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      'skip-training': { type: 'boolean', default: false },
      'skip-test': { type: 'boolean', default: false },
      'adapter-path': { type: 'string' },
      ticks: { type: 'string', default: '100' },
      archetype: { type: 'string', default: 'trader' },
      verbose: { type: 'boolean', default: false },
    },
  });

  return {
    skipTraining: values['skip-training'] ?? false,
    skipBenchmark: values['skip-test'] ?? false,
    adapterPath: values['adapter-path'],
    ticks: parseInt(values.ticks ?? '100', 10),
    archetype: values.archetype ?? 'trader',
    verbose: values.verbose ?? false,
  };
}

// Utility to run a command and capture output
async function runCommand(
  command: string[],
  options: {
    cwd?: string;
    timeout?: number;
    env?: Record<string, string>;
  } = {}
): Promise<{ success: boolean; output: string; exitCode: number }> {
  const { cwd, timeout = 600000, env } = options;

  try {
    const proc = spawn(command, {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, ...env },
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Command timed out')), timeout);
    });

    const [exitCode, stdout, stderr] = await Promise.race([
      Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]),
      timeoutPromise,
    ]);

    const output = stdout + stderr;
    return { success: exitCode === 0, output, exitCode };
  } catch (error) {
    return {
      success: false,
      output: error instanceof Error ? error.message : String(error),
      exitCode: -1,
    };
  }
}

// Run a pipeline step with logging
async function runStep(
  name: string,
  fn: () => Promise<{
    success: boolean;
    message: string;
    details?: Record<string, unknown>;
  }>
): Promise<boolean> {
  const start = Date.now();
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  STEP: ${name}`);
  console.log(`${'═'.repeat(60)}\n`);

  try {
    const result = await fn();
    const duration = Date.now() - start;

    results.push({ name, ...result, duration });

    if (result.success) {
      console.log(`\n✅ ${name} completed in ${(duration / 1000).toFixed(1)}s`);
      console.log(`   ${result.message}`);
    } else {
      console.log(`\n❌ ${name} failed after ${(duration / 1000).toFixed(1)}s`);
      console.log(`   ${result.message}`);
    }

    return result.success;
  } catch (error) {
    const duration = Date.now() - start;
    const message = error instanceof Error ? error.message : String(error);

    results.push({ name, success: false, duration, message });
    console.log(`\n💥 ${name} errored after ${(duration / 1000).toFixed(1)}s`);
    console.log(`   ${message}`);

    return false;
  }
}

// Step 1: Check prerequisites
async function checkPrerequisites(config: PipelineConfig): Promise<{
  success: boolean;
  message: string;
  details?: Record<string, unknown>;
}> {
  const checks: Record<string, boolean> = {};

  // Check Python
  console.log('Checking Python...');
  const pythonResult = await runCommand(['python3', '--version']);
  checks.python = pythonResult.success;
  if (pythonResult.success) {
    console.log(`  ✓ Python: ${pythonResult.output.trim()}`);
  } else {
    console.log('  ✗ Python not found');
  }

  // Check if training directory exists
  checks.trainingDir = existsSync(TRAINING_DIR);
  console.log(
    checks.trainingDir
      ? `  ✓ Training directory exists`
      : `  ✗ Training directory not found: ${TRAINING_DIR}`
  );

  // Check for MLX (macOS) or CUDA
  const platform = process.platform;
  if (platform === 'darwin') {
    console.log('Checking MLX (macOS)...');
    const mlxResult = await runCommand([
      'python3',
      '-c',
      'import mlx; print(mlx.__version__)',
    ]);
    checks.mlx = mlxResult.success;
    console.log(
      mlxResult.success
        ? `  ✓ MLX: ${mlxResult.output.trim()}`
        : '  ⚠ MLX not installed (will be installed during training)'
    );
  } else {
    console.log('Checking CUDA...');
    const cudaResult = await runCommand([
      'python3',
      '-c',
      'import torch; print(torch.cuda.is_available())',
    ]);
    checks.cuda = cudaResult.success && cudaResult.output.includes('True');
    console.log(
      checks.cuda
        ? '  ✓ CUDA available'
        : '  ⚠ CUDA not available (will use CPU)'
    );
  }

  // Check Ollama
  console.log('Checking Ollama...');
  const ollamaResult = await runCommand(['which', 'ollama']);
  checks.ollama = ollamaResult.success;
  console.log(
    ollamaResult.success
      ? `  ✓ Ollama: ${ollamaResult.output.trim()}`
      : '  ✗ Ollama not installed'
  );

  if (!checks.ollama) {
    console.log('\n  📦 To install Ollama:');
    console.log('     macOS:   brew install ollama');
    console.log('     Linux:   curl -fsSL https://ollama.ai/install.sh | sh');
  }

  const allPassed = checks.python && checks.trainingDir;
  const ollamaRequired = !config.skipBenchmark;

  return {
    success: allPassed && (!ollamaRequired || checks.ollama),
    message: allPassed
      ? `Prerequisites satisfied (Ollama: ${checks.ollama ? 'yes' : 'no'})`
      : 'Missing required prerequisites',
    details: checks,
  };
}

// Step 2: Install Python dependencies
async function installDependencies(): Promise<{
  success: boolean;
  message: string;
  details?: Record<string, unknown>;
}> {
  const trainingDir = TRAINING_DIR;

  console.log('Installing Python dependencies...');

  // Check if requirements.txt exists
  const requirementsPath = join(trainingDir, 'requirements.txt');
  if (!existsSync(requirementsPath)) {
    return {
      success: false,
      message: `requirements.txt not found at ${requirementsPath}`,
    };
  }

  const result = await runCommand(
    ['pip', 'install', '-r', 'requirements.txt', '--quiet'],
    { cwd: trainingDir, timeout: 300000 }
  );

  if (!result.success) {
    console.log('pip install output:', result.output);
  }

  return {
    success: result.success,
    message: result.success
      ? 'Python dependencies installed'
      : `Failed to install dependencies: ${result.output.slice(0, 200)}`,
  };
}

// Step 3: Train model
async function trainModel(config: PipelineConfig): Promise<{
  success: boolean;
  message: string;
  details?: Record<string, unknown>;
}> {
  if (config.skipTraining) {
    return {
      success: true,
      message: 'Training skipped (--skip-training)',
    };
  }

  const trainingDir = TRAINING_DIR;
  const backend = process.platform === 'darwin' ? 'mlx' : 'cuda';

  console.log(`Training model with ${backend} backend...`);
  console.log('This may take several minutes...\n');

  const result = await runCommand(
    [
      'python3',
      'scripts/train_local.py',
      '--backend',
      backend,
      '--archetype',
      config.archetype,
    ],
    {
      cwd: trainingDir,
      timeout: 3600000, // 1 hour
    }
  );

  // Stream output for visibility
  if (config.verbose) {
    console.log(result.output);
  }

  // Find the adapter path
  const adapterDir = join(trainingDir, 'trained_models/local/adapters');
  const adapterExists = existsSync(adapterDir);

  return {
    success: result.success && adapterExists,
    message: result.success
      ? `Model trained successfully (adapter: ${adapterDir})`
      : `Training failed: ${result.output.slice(-500)}`,
    details: {
      backend,
      adapterPath: adapterDir,
      exitCode: result.exitCode,
    },
  };
}

// Step 4: Test trained adapter
async function testAdapter(config: PipelineConfig): Promise<{
  success: boolean;
  message: string;
  details?: Record<string, unknown>;
}> {
  const trainingDir = TRAINING_DIR;

  // Find adapter path
  let adapterPath = config.adapterPath;
  if (!adapterPath) {
    const defaultPath = join(trainingDir, 'trained_models/local/adapters');
    if (existsSync(defaultPath)) {
      adapterPath = defaultPath;
    }
  }

  if (!adapterPath || !existsSync(adapterPath)) {
    return {
      success: false,
      message: `Adapter not found at: ${adapterPath || 'not specified'}`,
    };
  }

  console.log(`Testing adapter at: ${adapterPath}`);

  const result = await runCommand(
    [
      'python3',
      'scripts/test_trained_model.py',
      '--adapter-path',
      adapterPath,
      '--validate',
    ],
    {
      cwd: trainingDir,
      timeout: 300000,
    }
  );

  if (config.verbose) {
    console.log(result.output);
  }

  return {
    success: result.success,
    message: result.success
      ? 'Adapter validation passed'
      : `Adapter test failed: ${result.output.slice(-300)}`,
    details: { adapterPath },
  };
}

// Step 5: Start Ollama
let ollamaProcess: Subprocess | null = null;

async function startOllama(): Promise<{
  success: boolean;
  message: string;
  details?: Record<string, unknown>;
}> {
  // Check if already running
  try {
    const response = await fetch('http://localhost:11434/api/tags', {
      signal: AbortSignal.timeout(3000),
    });
    if (response.ok) {
      return {
        success: true,
        message: 'Ollama already running',
      };
    }
  } catch {
    // Not running, start it
  }

  console.log('Starting Ollama server...');

  ollamaProcess = spawn(['ollama', 'serve'], {
    stdout: 'ignore',
    stderr: 'ignore',
  });

  // Wait for Ollama to be ready
  for (let i = 0; i < 30; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));

    try {
      const response = await fetch('http://localhost:11434/api/tags', {
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) {
        return {
          success: true,
          message: 'Ollama started successfully',
          details: { startedByUs: true },
        };
      }
    } catch {
      // Keep waiting
    }

    if (i % 5 === 4) {
      console.log(`  Waiting for Ollama... (${i + 1}s)`);
    }
  }

  return {
    success: false,
    message: 'Ollama failed to start within 30 seconds',
  };
}

// Step 6: Import adapter to Ollama
async function importToOllama(config: PipelineConfig): Promise<{
  success: boolean;
  message: string;
  details?: Record<string, unknown>;
}> {
  const trainingDir = TRAINING_DIR;

  // Find adapter path
  let adapterPath = config.adapterPath;
  if (!adapterPath) {
    const defaultPath = join(trainingDir, 'trained_models/local/adapters');
    if (existsSync(defaultPath)) {
      adapterPath = defaultPath;
    }
  }

  if (!adapterPath || !existsSync(adapterPath)) {
    return {
      success: false,
      message: `Adapter not found: ${adapterPath}`,
    };
  }

  const modelName = `babylon-${config.archetype}:latest`;
  const baseModel = process.env.OLLAMA_BASE_MODEL || 'qwen2.5:7b-instruct';

  console.log(`Importing adapter as ${modelName}...`);
  console.log(`  Base model: ${baseModel}`);
  console.log(`  Adapter: ${adapterPath}`);

  // Create Modelfile
  const modelfile = `FROM ${baseModel}
ADAPTER ${adapterPath}
PARAMETER temperature 0.7
PARAMETER num_predict 8192
`;

  try {
    const response = await fetch('http://localhost:11434/api/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: modelName,
        modelfile,
        stream: false,
      }),
      signal: AbortSignal.timeout(600000), // 10 minutes
    });

    if (!response.ok) {
      const error = await response.text();
      return {
        success: false,
        message: `Failed to import: ${error}`,
      };
    }

    return {
      success: true,
      message: `Model imported as ${modelName}`,
      details: { modelName, baseModel, adapterPath },
    };
  } catch (error) {
    return {
      success: false,
      message: `Import error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// Step 7: Run game test
async function runGameTest(config: PipelineConfig): Promise<{
  success: boolean;
  message: string;
  details?: Record<string, unknown>;
}> {
  if (config.skipBenchmark) {
    return {
      success: true,
      message: 'Game test skipped (--skip-test)',
    };
  }

  console.log('Running game test...');

  // First, check if the dev server is running
  let serverRunning = false;
  try {
    const response = await fetch('http://localhost:3000/api/health', {
      signal: AbortSignal.timeout(3000),
    });
    serverRunning = response.ok;
  } catch {
    serverRunning = false;
  }

  if (!serverRunning) {
    console.log('⚠️  Dev server not running. Starting it...');
    console.log('   (This may take a minute)\n');

    // Start dev server in background
    const devServer = spawn(['bun', 'run', 'dev:web'], {
      cwd: REPO_ROOT,
      stdout: 'ignore',
      stderr: 'ignore',
    });

    // Wait for server to be ready
    for (let i = 0; i < 60; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      try {
        const response = await fetch('http://localhost:3000/api/health', {
          signal: AbortSignal.timeout(3000),
        });
        if (response.ok) {
          serverRunning = true;
          console.log('   ✓ Dev server started\n');
          break;
        }
      } catch {
        // Keep waiting
      }
      if (i % 10 === 9) {
        console.log(`   Still starting... (${(i + 1) * 2}s)`);
      }
    }

    if (!serverRunning) {
      devServer.kill();
      return {
        success: false,
        message:
          'Failed to start dev server. Run "bun run dev" manually first.',
      };
    }
  } else {
    console.log('✓ Dev server already running\n');
  }

  // Run game ticks using the CLI
  console.log(`Executing ${config.ticks} game ticks with trained model...\n`);

  const result = await runCommand(
    [
      'bun',
      'run',
      'apps/cli/src/index.ts',
      'game',
      'tick',
      '--count',
      String(config.ticks),
      '--agent-archetype',
      config.archetype,
    ],
    {
      cwd: REPO_ROOT,
      timeout: config.ticks * 10000, // 10s per tick max
      env: {
        AGENT_LLM_PROVIDER: 'ollama',
        OLLAMA_MODEL: `babylon-${config.archetype}:latest`,
      },
    }
  );

  if (config.verbose) {
    console.log(result.output);
  }

  // Also run autonomous agent tick if available
  console.log('\nRunning autonomous agent with trained model...\n');

  const agentResult = await runCommand(
    [
      'bun',
      'run',
      'apps/cli/src/index.ts',
      'agent',
      'tick',
      '--archetype',
      config.archetype,
    ],
    {
      cwd: REPO_ROOT,
      timeout: 120000,
      env: {
        AGENT_LLM_PROVIDER: 'ollama',
        OLLAMA_MODEL: `babylon-${config.archetype}:latest`,
      },
    }
  );

  if (config.verbose) {
    console.log(agentResult.output);
  }

  const gameSuccess = result.success;
  const agentSuccess = agentResult.success;

  return {
    success: gameSuccess,
    message: gameSuccess
      ? `Game test completed: ${config.ticks} ticks executed, agent ${agentSuccess ? 'passed' : 'had issues'}`
      : `Game test failed: ${result.output.slice(-300)}`,
    details: {
      ticks: config.ticks,
      gameSuccess,
      agentSuccess,
      serverWasRunning: serverRunning,
    },
  };
}

// Cleanup
async function cleanup(): Promise<void> {
  if (ollamaProcess) {
    console.log('\nStopping Ollama...');
    ollamaProcess.kill();
    ollamaProcess = null;
  }
}

// Main pipeline
async function main(): Promise<void> {
  const config = parseConfig();

  console.log(`
${'═'.repeat(60)}
  ELIZAOS AUTOMATED TRAINING & TESTING PIPELINE
${'═'.repeat(60)}

Configuration:
  - Skip Training: ${config.skipTraining}
  - Skip Benchmark: ${config.skipBenchmark}
  - Archetype: ${config.archetype}
  - Benchmark Ticks: ${config.ticks}
  - Verbose: ${config.verbose}
`);

  const startTime = Date.now();

  // Run pipeline steps
  const steps: Array<{
    name: string;
    fn: () => Promise<{
      success: boolean;
      message: string;
      details?: Record<string, unknown>;
    }>;
  }> = [
    { name: 'Check Prerequisites', fn: () => checkPrerequisites(config) },
    { name: 'Install Dependencies', fn: () => installDependencies() },
    { name: 'Train Model', fn: () => trainModel(config) },
  ];

  const defaultAdapterPath = join(TRAINING_DIR, 'trained_models/local/adapters');
  const hasAdapterCandidate = Boolean(config.adapterPath) || existsSync(defaultAdapterPath);

  if (!config.skipBenchmark) {
    steps.push(
      { name: 'Test Adapter', fn: () => testAdapter(config) },
      { name: 'Start Ollama', fn: () => startOllama() },
      { name: 'Import to Ollama', fn: () => importToOllama(config) },
      { name: 'Run Game Test', fn: () => runGameTest(config) }
    );
  } else if (!config.skipTraining || hasAdapterCandidate) {
    // When benchmark is skipped, only validate adapter if we trained one or a path exists.
    steps.push({ name: 'Test Adapter', fn: () => testAdapter(config) });
  }

  let allPassed = true;
  for (const step of steps) {
    const success = await runStep(step.name, step.fn);
    if (!success) {
      allPassed = false;
      console.log(`\n⛔ Pipeline stopped at: ${step.name}`);
      break;
    }
  }

  // Cleanup
  await cleanup();

  // Summary
  const totalDuration = Date.now() - startTime;
  console.log(`
${'═'.repeat(60)}
  PIPELINE SUMMARY
${'═'.repeat(60)}
`);

  for (const result of results) {
    const icon = result.success ? '✅' : '❌';
    console.log(`${icon} ${result.name}: ${result.message}`);
  }

  console.log(`
Total Duration: ${(totalDuration / 1000).toFixed(1)}s
Status: ${allPassed ? '✅ ALL STEPS PASSED' : '❌ PIPELINE FAILED'}
`);

  // Save report
  const outputDir = './research-output/training-runs';
  mkdirSync(outputDir, { recursive: true });

  const report = {
    timestamp: new Date().toISOString(),
    config,
    results,
    totalDuration,
    success: allPassed,
  };

  const reportPath = join(outputDir, `training-run-${Date.now()}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`📄 Report saved to: ${reportPath}`);

  process.exit(allPassed ? 0 : 1);
}

// Handle signals
process.on('SIGINT', async () => {
  console.log('\n\n🛑 Interrupted. Cleaning up...');
  await cleanup();
  process.exit(130);
});

process.on('SIGTERM', async () => {
  console.log('\n\n🛑 Terminated. Cleaning up...');
  await cleanup();
  process.exit(143);
});

main().catch(async (error) => {
  console.error('Pipeline failed:', error);
  await cleanup();
  process.exit(1);
});
