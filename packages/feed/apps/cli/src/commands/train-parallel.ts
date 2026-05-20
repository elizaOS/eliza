/**
 * Parallel Training Data Generation Command
 *
 * Generates REAL trajectories using REAL agents running in parallel.
 * This is the proper way to generate training data at scale.
 */

import { closeDatabase, db, eq, users } from '@feed/db';
import {
  ArchetypeConfigService,
  createParallelGenerator,
  type ParallelGenerationConfig,
} from '@feed/training';
import { getFlag, getOption, parseArgs, wantsHelp } from '../lib/args.js';
import { logger } from '../lib/logger.js';

function printHelp(): void {
  console.log(`
Parallel Training Data Generation

USAGE:
  feed train parallel [options]

DESCRIPTION:
  Creates and runs multiple agents in parallel to generate REAL training trajectories.
  Uses the existing autonomous coordinator with trajectory recording enabled.

OPTIONS:
  -a, --archetypes    Comma-separated archetypes (default: trader)
  -n, --num-agents    Agents per archetype (default: 2)
  -t, --ticks         Ticks per agent (default: 10)
  -p, --parallel      Max agents running simultaneously (default: 5, max: 10)
  --manager-id        Manager user ID (uses first admin if not provided)
  --cleanup           Delete created agents after generation
  --dry-run           Show what would be generated

AVAILABLE ARCHETYPES:
${ArchetypeConfigService.getAvailableArchetypes()
  .map((a) => `  - ${a}`)
  .join('\n')}

EXAMPLES:
  feed train parallel --archetypes trader,degen --num-agents 3 --ticks 20
  feed train parallel -a all -n 1 -t 5 -p 10
  feed train parallel --dry-run

NOTES:
  - Creates REAL agents with archetype-specific behaviors
  - Runs agents through AutonomousCoordinator with trajectory recording
  - Agents execute trades, posts, and social actions based on their archetype
  - All trajectories are saved to database automatically
  - Runs agents in parallel batches for faster generation
`);
}

export async function runParallelGeneration(
  parsed: ReturnType<typeof parseArgs>
): Promise<void> {
  if (wantsHelp(parsed)) {
    printHelp();
    return;
  }

  // Parse options
  const archetypesArg = getOption(parsed, 'archetypes', 'a') || 'trader';
  const archetypes =
    archetypesArg === 'all'
      ? ArchetypeConfigService.getAvailableArchetypes()
      : archetypesArg.split(',').map((a) => a.trim());

  const numAgents = parseInt(getOption(parsed, 'num-agents', 'n') || '2', 10);
  const ticks = parseInt(getOption(parsed, 'ticks', 't') || '10', 10);
  const parallel = parseInt(getOption(parsed, 'parallel', 'p') || '5', 10);
  const cleanup = getFlag(parsed, 'cleanup');
  const dryRun = getFlag(parsed, 'dry-run');
  const providedManagerId = getOption(parsed, 'manager-id');

  logger.header('Parallel Training Data Generation');

  console.log();
  console.log('Configuration:');
  console.log(`  Archetypes: ${archetypes.join(', ')}`);
  console.log(`  Agents per archetype: ${numAgents}`);
  console.log(`  Ticks per agent: ${ticks}`);
  console.log(`  Parallel execution: ${parallel} agents at once`);
  console.log(`  Total agents: ${archetypes.length * numAgents}`);
  console.log(
    `  Expected trajectories: ~${archetypes.length * numAgents * ticks}`
  );
  console.log(`  Cleanup after: ${cleanup ? 'Yes' : 'No'}`);
  console.log();

  if (dryRun) {
    console.log('[DRY RUN] Would generate:');
    console.log(`  ${archetypes.length * numAgents} agents`);
    console.log(
      `  Running in ${Math.ceil((archetypes.length * numAgents) / parallel)} parallel batches`
    );
    console.log(`  ~${archetypes.length * numAgents * ticks} trajectories`);
    console.log();

    // Calculate time estimate
    const batchCount = Math.ceil((archetypes.length * numAgents) / parallel);
    const timePerBatch = ticks * 0.5 + 2; // 0.5s per tick + overhead
    const totalTime = batchCount * timePerBatch;

    console.log(`Estimated time: ~${Math.ceil(totalTime)} seconds`);
    return;
  }

  // Get or find manager ID
  let managerId = providedManagerId;
  if (!managerId) {
    const adminUsers = await db
      .select()
      .from(users)
      .where(eq(users.isAdmin, true))
      .limit(1);

    if (adminUsers[0]) {
      managerId = adminUsers[0].id;
      logger.info(`Using admin user as manager: ${adminUsers[0].username}`);
    } else {
      // Try any user
      const anyUser = await db.select().from(users).limit(1);

      if (!anyUser[0]) {
        logger.fail('No users found. Please create a user first.');
        await closeDatabase();
        process.exit(1);
      }
      managerId = anyUser[0].id;
      logger.warn(`Using regular user as manager: ${anyUser[0].username}`);
    }
  }

  // Create generator configuration
  const config: ParallelGenerationConfig = {
    archetypes,
    agentsPerArchetype: numAgents,
    ticksPerAgent: ticks,
    parallelAgents: parallel,
    recordTrajectories: true,
    managerId,
  };

  // Create and run generator
  logger.step('Initializing parallel generator...');
  const generator = await createParallelGenerator(config);

  logger.step('Starting parallel generation...');
  console.log('Agents will run in parallel batches. Press Ctrl+C to cancel.');
  console.log();

  const result = await generator.generate();

  // Display results
  logger.header('Generation Complete');
  console.log();
  console.log('Results:');
  console.log(`  Agents created: ${result.agentsCreated.length}`);
  console.log(`  Trajectories generated: ${result.trajectoryIds.length}`);
  console.log(`  Total ticks executed: ${result.totalTicks}`);
  console.log(`  Duration: ${(result.duration / 1000).toFixed(1)} seconds`);

  if (result.errors.length > 0) {
    console.log(`  Errors: ${result.errors.length}`);
    console.log();
    console.log('Errors:');
    result.errors.slice(0, 5).forEach((err) => console.log(`  - ${err}`));
    if (result.errors.length > 5) {
      console.log(`  ... and ${result.errors.length - 5} more`);
    }
  }
  console.log();

  // Display archetype stats
  if (Object.keys(result.archetypeStats).length > 0) {
    console.log('By Archetype:');
    for (const [archetype, stats] of Object.entries(result.archetypeStats)) {
      console.log(`  ${archetype}:`);
      console.log(`    Agents: ${stats.agents}`);
      console.log(`    Trajectories: ${stats.trajectories}`);
      console.log(`    Avg ticks/agent: ${stats.avgTicksPerAgent.toFixed(1)}`);
    }
    console.log();
  }

  // Cleanup if requested
  if (cleanup) {
    logger.step('Cleaning up created agents...');
    await generator.cleanup();
    console.log('Agents cleaned up successfully.');
    console.log();
  } else {
    console.log('Created agents:');
    result.agentsCreated.slice(0, 5).forEach((id) => console.log(`  - ${id}`));
    if (result.agentsCreated.length > 5) {
      console.log(`  ... and ${result.agentsCreated.length - 5} more`);
    }
    console.log();
  }

  console.log('Trajectories saved to database.');
  console.log();
  console.log('Next steps:');
  console.log('  1. Score trajectories: feed train score');
  console.log('  2. Export for training: feed train export');
  console.log('  3. Train model: feed train pipeline');

  await closeDatabase();
}
