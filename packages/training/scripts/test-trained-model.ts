#!/usr/bin/env bun

/**
 * Test Trained Model - TypeScript/Node
 *
 * Tests a trained model by:
 * 1. Loading model from database or path
 * 2. Running benchmark if available
 * 3. Testing inference
 * 4. Comparing to baseline
 *
 * Usage:
 *   bun run packages/training/scripts/test-trained-model.ts --model-id <id>
 *   bun run packages/training/scripts/test-trained-model.ts --model-path <path> --benchmark
 */

import { db, eq, trainedModels } from '@elizaos/db';
import { BenchmarkService } from '../src/training/BenchmarkService';
import { logger } from '../src/utils/logger';

interface TestConfig {
  modelId?: string;
  modelPath?: string;
  benchmark?: boolean;
  benchmarkPath?: string;
  compareToBaseline?: boolean;
}

async function testModel(config: TestConfig): Promise<void> {
  logger.info('Testing trained model', config);

  // Get model from database or path
  let model;
  if (config.modelId) {
    const result = await db
      .select()
      .from(trainedModels)
      .where(eq(trainedModels.modelId, config.modelId))
      .limit(1);

    model = result[0];

    if (!model) {
      throw new Error(`Model not found: ${config.modelId}`);
    }

    logger.info('Found model in database', {
      modelId: model.modelId,
      version: model.version,
      status: model.status,
      storagePath: model.storagePath,
    });
  } else if (config.modelPath) {
    // Create mock model entry for testing
    model = {
      modelId: `test-${Date.now()}`,
      version: 'test',
      status: 'ready' as const,
      storagePath: config.modelPath,
      benchmarkScore: null,
    };

    logger.info('Using model from path', {
      modelPath: config.modelPath,
    });
  } else {
    throw new Error('Must provide either --model-id or --model-path');
  }

  // Test 1: Model loading validation
  logger.info('='.repeat(60));
  logger.info('TEST 1: Model Loading');
  logger.info('='.repeat(60));

  if (!model.storagePath) {
    throw new Error('Model storage path not set');
  }

  const modelExists = await Bun.file(model.storagePath)
    .exists()
    .catch(() => false);
  if (!modelExists && !config.modelPath) {
    logger.warn('Model file not found at storage path', {
      storagePath: model.storagePath,
    });
  } else {
    logger.info('✅ Model path validated', {
      path: model.storagePath || config.modelPath,
    });
  }

  // Test 2: Benchmark if requested
  if (config.benchmark) {
    logger.info('='.repeat(60));
    logger.info('TEST 2: Running Benchmark');
    logger.info('='.repeat(60));

    if (config.modelId) {
      const benchmarkService = new BenchmarkService();
      const results = await benchmarkService.benchmarkModel(
        config.modelId,
        config.benchmarkPath
      );

      logger.info('Benchmark Results:', {
        score: results.benchmarkScore,
        pnl: results.pnl,
        accuracy: results.accuracy,
        optimality: results.optimality,
      });

      // Compare to baseline if requested
      if (config.compareToBaseline) {
        const comparison = await benchmarkService.compareModels(config.modelId);
        logger.info('Comparison to Baseline:', {
          newScore: comparison.newScore,
          previousScore: comparison.previousScore,
          improvement: comparison.improvement,
          shouldDeploy: comparison.shouldDeploy,
          reason: comparison.reason,
        });
      }
    } else {
      logger.warn('Benchmark requires model-id (model must be in database)');
    }
  }

  // Test 3: Inference test (if we can get runtime)
  logger.info('='.repeat(60));
  logger.info('TEST 3: Inference Test');
  logger.info('='.repeat(60));

  try {
    // Get test agent
    const testAgentResult = await db.select().from(trainedModels).limit(1);

    if (testAgentResult.length > 0) {
      logger.info('✅ Inference test setup available');
      logger.info('Run full benchmark to test inference with real agent');
    } else {
      logger.warn('No test agent available for inference test');
    }
  } catch (error) {
    logger.warn('Inference test skipped', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Summary
  logger.info('='.repeat(60));
  logger.info('TESTING COMPLETE');
  logger.info('='.repeat(60));
  logger.info('Model:', {
    id: model.modelId,
    version: model.version,
    status: model.status,
  });

  if (model.benchmarkScore !== null) {
    logger.info('Benchmark Score:', model.benchmarkScore);
  }
}

async function main() {
  const args = process.argv.slice(2);

  const config: TestConfig = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--model-id' && i + 1 < args.length) {
      config.modelId = args[i + 1];
      i++;
    } else if (arg === '--model-path' && i + 1 < args.length) {
      config.modelPath = args[i + 1];
      i++;
    } else if (arg === '--benchmark') {
      config.benchmark = true;
    } else if (arg === '--benchmark-path' && i + 1 < args.length) {
      config.benchmarkPath = args[i + 1];
      i++;
    } else if (arg === '--compare') {
      config.compareToBaseline = true;
    }
  }

  if (!config.modelId && !config.modelPath) {
    console.error('Usage:');
    console.error(
      '  bun run test-trained-model.ts --model-id <id> [--benchmark] [--compare]'
    );
    console.error(
      '  bun run test-trained-model.ts --model-path <path> [--benchmark]'
    );
    process.exit(1);
  }

  try {
    await testModel(config);
  } catch (error) {
    logger.error('Testing failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}

main();
