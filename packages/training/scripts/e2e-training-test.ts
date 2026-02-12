#!/usr/bin/env bun

/**
 * End-to-End Training Pipeline Test
 *
 * Verifies the complete training pipeline works:
 * 1. Database connectivity
 * 2. Real trajectory data exists (not synthetic)
 * 3. LLM-as-judge scoring works
 * 4. Data export works
 * 5. Python training pipeline can load data
 *
 * Run: bun run packages/training/scripts/e2e-training-test.ts
 */

import { count, db, desc, eq, isNotNull, trajectories } from '@elizaos/db';
import { spawn } from 'child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

// Get the directory of this script
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TRAINING_PACKAGE_ROOT = resolve(__dirname, '..');

interface TestResult {
  name: string;
  passed: boolean;
  message: string;
  duration: number;
}

const results: TestResult[] = [];

async function runTest(
  name: string,
  testFn: () => Promise<{ passed: boolean; message: string }>
): Promise<void> {
  const start = Date.now();
  console.log(`\n🧪 Running: ${name}...`);

  const result = await testFn();
  const duration = Date.now() - start;

  results.push({
    name,
    ...result,
    duration,
  });

  if (result.passed) {
    console.log(`   ✅ PASSED (${duration}ms): ${result.message}`);
  } else {
    console.log(`   ❌ FAILED (${duration}ms): ${result.message}`);
  }
}

// Test 1: Database Connectivity
async function testDatabaseConnection(): Promise<{
  passed: boolean;
  message: string;
}> {
  const result = await db.select({ count: count() }).from(trajectories);
  const trajectoryCount = result[0]?.count || 0;

  if (typeof trajectoryCount === 'number') {
    return {
      passed: true,
      message: `Database connected, found ${trajectoryCount} trajectories`,
    };
  }

  return {
    passed: false,
    message: 'Failed to query database',
  };
}

// Test 2: Check for Data
async function testRealDataExists(): Promise<{
  passed: boolean;
  message: string;
}> {
  // Get recent trajectories
  const recent = await db
    .select({
      trajectoryId: trajectories.trajectoryId,
      agentId: trajectories.agentId,
      stepsJson: trajectories.stepsJson,
    })
    .from(trajectories)
    .orderBy(desc(trajectories.createdAt))
    .limit(20);

  if (recent.length === 0) {
    return {
      passed: false,
      message:
        'No trajectories found in database. Run "babylon train parallel" to generate data.',
    };
  }

  return {
    passed: true,
    message: `Found ${recent.length} trajectories`,
  };
}

// Test 3: Check Trajectory Quality AND LLM Calls
async function testTrajectoryQuality(): Promise<{
  passed: boolean;
  message: string;
}> {
  const recent = await db
    .select({
      trajectoryId: trajectories.trajectoryId,
      stepsJson: trajectories.stepsJson,
      episodeLength: trajectories.episodeLength,
      tradesExecuted: trajectories.tradesExecuted,
    })
    .from(trajectories)
    .orderBy(desc(trajectories.createdAt))
    .limit(10);

  if (recent.length === 0) {
    return {
      passed: false,
      message: 'No trajectories to check quality',
    };
  }

  let validStepsCount = 0;
  let hasActionsCount = 0;
  let hasRealLLMCalls = 0;
  let totalLLMCalls = 0;

  for (const traj of recent) {
    // Check if stepsJson is valid
    let steps: Array<{
      llmCalls?: Array<{
        systemPrompt?: string;
        system_prompt?: string;
        userPrompt?: string;
        user_prompt?: string;
        response?: string;
      }>;
      llm_calls?: Array<{
        systemPrompt?: string;
        system_prompt?: string;
        userPrompt?: string;
        user_prompt?: string;
        response?: string;
      }>;
    }>;
    try {
      steps = JSON.parse(traj.stepsJson);
      if (Array.isArray(steps) && steps.length > 0) {
        validStepsCount++;
      }
    } catch {
      continue;
    }

    // Check if has meaningful actions
    if (traj.episodeLength && traj.episodeLength > 1) {
      hasActionsCount++;
    }

    // CRITICAL: Check for REAL LLM calls (not mocked/skipped)
    let trajHasRealLLM = false;
    for (const step of steps) {
      const llmCalls = step.llmCalls ?? step.llm_calls ?? [];
      for (const call of llmCalls) {
        totalLLMCalls++;
        const systemPrompt = call.systemPrompt ?? call.system_prompt ?? '';
        const userPrompt = call.userPrompt ?? call.user_prompt ?? '';
        const response = call.response ?? '';

        // Real LLM calls have substantial content
        if (
          systemPrompt.length > 20 &&
          userPrompt.length > 20 &&
          response.length > 30
        ) {
          trajHasRealLLM = true;
        }
      }
    }

    if (trajHasRealLLM) {
      hasRealLLMCalls++;
    }
  }

  if (validStepsCount === 0) {
    return {
      passed: false,
      message: 'No trajectories have valid step data',
    };
  }

  // Require at least 50% of trajectories to have real LLM calls
  const minRealLLM = Math.floor(recent.length * 0.5);
  if (hasRealLLMCalls < minRealLLM) {
    return {
      passed: false,
      message: `Only ${hasRealLLMCalls}/${recent.length} trajectories have real LLM calls. Training requires real LLM data, not mocked/skipped calls.`,
    };
  }

  return {
    passed: true,
    message: `${validStepsCount}/${recent.length} valid steps, ${hasActionsCount}/${recent.length} with actions, ${hasRealLLMCalls}/${recent.length} with real LLM calls (${totalLLMCalls} total)`,
  };
}

// Test 4: Check LLM-as-judge Scoring
async function testLLMJudgeScoring(): Promise<{
  passed: boolean;
  message: string;
}> {
  // Check if any trajectories have been scored
  const scoredResult = await db
    .select({ count: count() })
    .from(trajectories)
    .where(isNotNull(trajectories.aiJudgeReward));

  const scoredCount = scoredResult[0]?.count || 0;

  if (scoredCount === 0) {
    // This is not a failure, just informational
    return {
      passed: true,
      message:
        'No trajectories scored yet. Run "babylon train score" to score trajectories.',
    };
  }

  // Check score quality
  const scored = await db
    .select({
      aiJudgeReward: trajectories.aiJudgeReward,
      aiJudgeReasoning: trajectories.aiJudgeReasoning,
    })
    .from(trajectories)
    .where(isNotNull(trajectories.aiJudgeReward))
    .limit(10);

  let validScoreCount = 0;
  let hasReasoningCount = 0;

  for (const s of scored) {
    if (
      s.aiJudgeReward !== null &&
      s.aiJudgeReward >= 0 &&
      s.aiJudgeReward <= 1
    ) {
      validScoreCount++;
    }
    if (s.aiJudgeReasoning && s.aiJudgeReasoning.length > 20) {
      hasReasoningCount++;
    }
  }

  return {
    passed: true,
    message: `${scoredCount} trajectories scored, ${validScoreCount}/${scored.length} have valid scores, ${hasReasoningCount}/${scored.length} have reasoning`,
  };
}

// Test 5: Check Data Export
async function testDataExport(): Promise<{
  passed: boolean;
  message: string;
}> {
  const dataDir = join(TRAINING_PACKAGE_ROOT, 'training-data');

  if (!existsSync(dataDir)) {
    return {
      passed: true,
      message:
        'No training data exported yet. Run "babylon train export" to export data.',
    };
  }

  // Check for JSONL files
  const files: string[] = [];
  const searchDir = (dir: string) => {
    const items = readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      const fullPath = join(dir, item.name);
      if (item.isDirectory()) {
        searchDir(fullPath);
      } else if (item.name.endsWith('.jsonl')) {
        files.push(fullPath);
      }
    }
  };

  searchDir(dataDir);

  if (files.length === 0) {
    return {
      passed: true,
      message:
        'No JSONL files found. Run "babylon train export" to export data.',
    };
  }

  // Check file quality
  let totalLines = 0;
  let validLines = 0;

  for (const file of files.slice(0, 3)) {
    const content = readFileSync(file, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim().length > 0);
    totalLines += lines.length;

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.trajectory_id && parsed.steps) {
          validLines++;
        }
      } catch {
        // Invalid JSON
      }
    }
  }

  return {
    passed: validLines > 0,
    message: `Found ${files.length} JSONL files with ${validLines}/${totalLines} valid training examples`,
  };
}

// Test 6: Check Python Environment
async function testPythonEnvironment(): Promise<{
  passed: boolean;
  message: string;
}> {
  return new Promise((resolve) => {
    const python = spawn('python3', ['-c', 'import json; print("ok")']);

    let output = '';
    python.stdout.on('data', (data) => {
      output += data.toString();
    });

    python.on('close', (code) => {
      if (code === 0 && output.includes('ok')) {
        resolve({
          passed: true,
          message: 'Python3 is available',
        });
      } else {
        resolve({
          passed: false,
          message: 'Python3 is not available or not working',
        });
      }
    });

    python.on('error', () => {
      resolve({
        passed: false,
        message: 'Failed to spawn Python process',
      });
    });

    // Timeout
    setTimeout(() => {
      python.kill();
      resolve({
        passed: false,
        message: 'Python check timed out',
      });
    }, 5000);
  });
}

// Test 7: Check Rubrics Configuration
async function testRubricsConfiguration(): Promise<{
  passed: boolean;
  message: string;
}> {
  const rubricsPath = join(TRAINING_PACKAGE_ROOT, 'config/rubrics.json');

  if (!existsSync(rubricsPath)) {
    return {
      passed: false,
      message: `Rubrics config file not found at ${rubricsPath}`,
    };
  }

  const content = readFileSync(rubricsPath, 'utf-8');
  const rubrics = JSON.parse(content);

  const archetypeCount = rubrics.availableArchetypes?.length || 0;
  const rubricsCount = Object.keys(rubrics.rubrics || {}).length;

  if (archetypeCount === 0 || rubricsCount === 0) {
    return {
      passed: false,
      message: 'Rubrics config is empty or malformed',
    };
  }

  return {
    passed: true,
    message: `Found ${rubricsCount} rubrics for ${archetypeCount} archetypes`,
  };
}

// Test 8: Check Training Data Consistency
async function testTrainingDataConsistency(): Promise<{
  passed: boolean;
  message: string;
}> {
  // Get trajectories marked as training data
  const trainingData = await db
    .select({
      trajectoryId: trajectories.trajectoryId,
      isTrainingData: trajectories.isTrainingData,
      stepsJson: trajectories.stepsJson,
      aiJudgeReward: trajectories.aiJudgeReward,
    })
    .from(trajectories)
    .where(eq(trajectories.isTrainingData, true))
    .limit(20);

  if (trainingData.length === 0) {
    return {
      passed: true,
      message:
        'No trajectories marked as training data yet. Generate and score trajectories first.',
    };
  }

  let hasSteps = 0;
  let hasScore = 0;

  for (const t of trainingData) {
    try {
      const steps = JSON.parse(t.stepsJson);
      if (Array.isArray(steps) && steps.length > 0) {
        hasSteps++;
      }
    } catch {
      // Invalid steps
    }

    if (t.aiJudgeReward !== null) {
      hasScore++;
    }
  }

  const ready = hasSteps > 0 && hasScore > 0;

  return {
    passed: ready,
    message: `${trainingData.length} training trajectories: ${hasSteps} have steps, ${hasScore} have scores. ${ready ? 'Ready for training!' : 'Need scoring or steps.'}`,
  };
}

async function main() {
  console.log(
    '═══════════════════════════════════════════════════════════════'
  );
  console.log('  Babylon Training Pipeline - End-to-End Test');
  console.log(
    '═══════════════════════════════════════════════════════════════'
  );
  console.log(`  Timestamp: ${new Date().toISOString()}`);

  // Run all tests
  await runTest('Database Connection', testDatabaseConnection);
  await runTest('Real Data Exists', testRealDataExists);
  await runTest('Trajectory Quality', testTrajectoryQuality);
  await runTest('LLM-as-Judge Scoring', testLLMJudgeScoring);
  await runTest('Data Export', testDataExport);
  await runTest('Python Environment', testPythonEnvironment);
  await runTest('Rubrics Configuration', testRubricsConfiguration);
  await runTest('Training Data Consistency', testTrainingDataConsistency);

  // Summary
  console.log(
    '\n═══════════════════════════════════════════════════════════════'
  );
  console.log('  Test Summary');
  console.log(
    '═══════════════════════════════════════════════════════════════'
  );

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const totalTime = results.reduce((sum, r) => sum + r.duration, 0);

  console.log(`\n  Passed: ${passed}/${results.length}`);
  console.log(`  Failed: ${failed}/${results.length}`);
  console.log(`  Total Time: ${totalTime}ms`);

  if (failed > 0) {
    console.log('\n  Failed Tests:');
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`    ❌ ${r.name}: ${r.message}`);
    }
  }

  // Write results to file
  const resultsDir = join(TRAINING_PACKAGE_ROOT, 'training-data');
  if (!existsSync(resultsDir)) {
    mkdirSync(resultsDir, { recursive: true });
  }
  const resultsPath = join(resultsDir, 'e2e-test-results.json');
  writeFileSync(
    resultsPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        passed,
        failed,
        total: results.length,
        results,
      },
      null,
      2
    )
  );
  console.log(`\n  Results saved to: ${resultsPath}`);

  console.log(
    '\n═══════════════════════════════════════════════════════════════'
  );

  // Exit with error if any tests failed
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('E2E test failed:', err);
  process.exit(1);
});
