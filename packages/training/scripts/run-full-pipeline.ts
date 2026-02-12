#!/usr/bin/env bun

/**
 * Full Training Pipeline Test
 *
 * This script runs the complete training pipeline end-to-end:
 * 1. Initialize training package
 * 2. Generate real trajectories (or use existing)
 * 3. Score trajectories with LLM-as-judge
 * 4. Export training data
 * 5. Run archetype matchup benchmark
 *
 * Usage:
 *   bun run packages/training/scripts/run-full-pipeline.ts
 *
 * Options:
 *   --skip-generation    Skip trajectory generation (use existing data)
 *   --skip-scoring       Skip LLM scoring
 *   --archetypes         Comma-separated archetypes (default: trader,researcher)
 *   --agents             Agents per archetype (default: 2)
 *   --ticks              Ticks per agent (default: 10)
 */

import { count, db, eq, isNotNull, trajectories } from '@elizaos/db';
import { parseArgs } from 'util';

// Parse command line arguments
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    'skip-generation': { type: 'boolean', default: false },
    'skip-scoring': { type: 'boolean', default: false },
    archetypes: { type: 'string', default: 'trader,researcher' },
    agents: { type: 'string', default: '2' },
    ticks: { type: 'string', default: '10' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help) {
  console.log(`
Full Training Pipeline Test

Usage:
  bun run packages/training/scripts/run-full-pipeline.ts [options]

Options:
  --skip-generation    Skip trajectory generation (use existing data)
  --skip-scoring       Skip LLM scoring
  --archetypes         Comma-separated archetypes (default: trader,researcher)
  --agents             Agents per archetype (default: 2)
  --ticks              Ticks per agent (default: 10)
  -h, --help           Show this help message
`);
  process.exit(0);
}

const config = {
  skipGeneration: values['skip-generation'] as boolean,
  skipScoring: values['skip-scoring'] as boolean,
  archetypes: (values.archetypes as string).split(','),
  agentsPerArchetype: parseInt(values.agents as string, 10),
  ticksPerAgent: parseInt(values.ticks as string, 10),
};

console.log('═══════════════════════════════════════════════════════════════');
console.log('  Babylon Full Training Pipeline');
console.log('═══════════════════════════════════════════════════════════════');
console.log(`  Archetypes: ${config.archetypes.join(', ')}`);
console.log(`  Agents per archetype: ${config.agentsPerArchetype}`);
console.log(`  Ticks per agent: ${config.ticksPerAgent}`);
console.log(`  Skip generation: ${config.skipGeneration}`);
console.log(`  Skip scoring: ${config.skipScoring}`);
console.log(
  '═══════════════════════════════════════════════════════════════\n'
);

async function runPipeline() {
  const startTime = Date.now();

  // Step 1: Check database connection
  console.log('Step 1: Checking database connection...');
  try {
    const result = await db.select({ count: count() }).from(trajectories);
    console.log(
      `  ✅ Database connected. ${result[0]?.count || 0} existing trajectories.\n`
    );
  } catch (error) {
    console.log(`  ❌ Database connection failed: ${error}`);
    console.log('  Make sure DATABASE_URL is set correctly.\n');
    process.exit(1);
  }

  // Step 2: Initialize training package
  console.log('Step 2: Initializing training package...');
  try {
    const { initializeTrainingPackage } = await import('../src/init-training');
    await initializeTrainingPackage();
    console.log('  ✅ Training package initialized.\n');
  } catch (error) {
    console.log(`  ⚠️  Training package initialization failed: ${error}`);
    console.log('  Will continue with limited functionality.\n');
  }

  // Step 3: Generate trajectories
  if (!config.skipGeneration) {
    console.log('Step 3: Generating real trajectories...');
    try {
      const { TrajectoryGenerator } = await import(
        '../src/generation/TrajectoryGenerator'
      );

      // Get a manager ID (first user in DB or create one)
      const { users, desc } = await import('@elizaos/db');
      const managerResult = await db
        .select({ id: users.id })
        .from(users)
        .orderBy(desc(users.createdAt))
        .limit(1);

      if (managerResult.length === 0) {
        console.log('  ⚠️  No users found in database. Skipping generation.');
        console.log('  Create a user first or use --skip-generation.\n');
      } else {
        const managerId = managerResult[0].id;

        const generator = new TrajectoryGenerator({
          archetypes: config.archetypes,
          agentsPerArchetype: config.agentsPerArchetype,
          ticksPerAgent: config.ticksPerAgent,
          parallelAgents: 3,
          recordTrajectories: true,
          managerId,
        });

        const result = await generator.generate();
        console.log(
          `  ✅ Generated ${result.trajectoryIds.length} trajectories.`
        );
        console.log(`  Agents created: ${result.agentsCreated.length}`);
        console.log(`  Duration: ${result.duration}ms\n`);

        // Cleanup test agents
        await generator.cleanup();
      }
    } catch (error) {
      console.log(`  ❌ Generation failed: ${error}`);
      console.log(
        '  Make sure the server is running or use --skip-generation.\n'
      );
    }
  } else {
    console.log(
      'Step 3: Skipping trajectory generation (--skip-generation).\n'
    );
  }

  // Step 4: Score trajectories
  if (!config.skipScoring) {
    console.log('Step 4: Scoring trajectories with LLM-as-judge...');
    try {
      const { archetypeScoringService } = await import(
        '../src/scoring/ArchetypeScoringService'
      );

      // Check for unscored trajectories
      const unscoredCount = await db
        .select({ count: count() })
        .from(trajectories)
        .where(eq(trajectories.isTrainingData, true));

      const scoredCount = await db
        .select({ count: count() })
        .from(trajectories)
        .where(isNotNull(trajectories.aiJudgeReward));

      console.log(`  Training trajectories: ${unscoredCount[0]?.count || 0}`);
      console.log(`  Already scored: ${scoredCount[0]?.count || 0}`);

      // Score a batch of unscored trajectories
      const result = await archetypeScoringService.scoreUnscoredTrajectories(
        'default',
        10
      );
      console.log(
        `  ✅ Scored ${result.scored} trajectories (${result.errors} errors).\n`
      );
    } catch (error) {
      console.log(`  ❌ Scoring failed: ${error}`);
      console.log('  Make sure GROQ_API_KEY is set.\n');
    }
  } else {
    console.log('Step 4: Skipping scoring (--skip-scoring).\n');
  }

  // Step 5: Run archetype matchup benchmark
  console.log('Step 5: Running archetype matchup benchmark...');
  try {
    const { ArchetypeMatchupBenchmark } = await import(
      '../src/benchmark/ArchetypeMatchupBenchmark'
    );

    const benchmark = new ArchetypeMatchupBenchmark({
      archetypes: config.archetypes,
      agentsPerArchetype: 2,
      rounds: 3,
      ticksPerRound: 50,
      marketConditions: ['bull', 'bear'],
      availableVramGb: 16,
    });

    const results = await benchmark.run();

    console.log(`  ✅ Benchmark complete.`);
    for (const result of results) {
      console.log(`  ${result.marketCondition.toUpperCase()} market:`);
      const top3 = result.archetypeRankings.slice(0, 3);
      for (const r of top3) {
        console.log(
          `    ${r.avgRank.toFixed(1)}. ${r.archetype} (avg PnL: ${r.avgPnl.toFixed(2)})`
        );
      }
    }
    console.log('');
  } catch (error) {
    console.log(`  ❌ Benchmark failed: ${error}\n`);
  }

  // Step 6: Export training data
  console.log('Step 6: Checking training data export...');
  try {
    const scoredResult = await db
      .select({ count: count() })
      .from(trajectories)
      .where(isNotNull(trajectories.aiJudgeReward));

    const scored = scoredResult[0]?.count || 0;
    if (scored > 0) {
      console.log(`  ✅ ${scored} trajectories ready for export.`);
      console.log('  Run "babylon train export" to export training data.\n');
    } else {
      console.log('  ⚠️  No scored trajectories available for export.');
      console.log('  Generate and score trajectories first.\n');
    }
  } catch (error) {
    console.log(`  ❌ Export check failed: ${error}\n`);
  }

  // Summary
  const totalTime = Date.now() - startTime;
  console.log(
    '═══════════════════════════════════════════════════════════════'
  );
  console.log('  Pipeline Complete');
  console.log(
    '═══════════════════════════════════════════════════════════════'
  );
  console.log(`  Total time: ${(totalTime / 1000).toFixed(1)}s`);
  console.log('');
  console.log('  Next steps:');
  console.log('  1. Export data: babylon train export');
  console.log('  2. Train models: python python/scripts/run_full_pipeline.py');
  console.log('  3. Benchmark: babylon train benchmark');
  console.log(
    '═══════════════════════════════════════════════════════════════'
  );
}

runPipeline().catch((error) => {
  console.error('Pipeline failed:', error);
  process.exit(1);
});
