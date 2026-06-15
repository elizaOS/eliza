/**
 * Parallel Training Data Generation Command
 *
 * Generates REAL trajectories using REAL agents running in parallel.
 * This is the proper way to generate training data at scale.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  getAgentRuntimeManager,
  getAgentService,
  getAutonomousCoordinator,
} from "@feed/agents/dependencies";
import { getAvailableArchetypes } from "@feed/agents/rubrics/index";
import { closeDatabase, db, eq, inArray, trajectories, users } from "@feed/db";
import { getFlag, getOption, type parseArgs, wantsHelp } from "../lib/args.js";
import { logger } from "../lib/logger.js";
import { writeFeedParallelGenerationManifest } from "../lib/training-artifacts.js";

interface ParallelGenerationConfig {
  archetypes: string[];
  agentsPerArchetype: number;
  ticksPerAgent: number;
  parallelAgents: number;
  recordTrajectories: boolean;
  managerId: string;
}

interface ParallelGenerator {
  generate(): Promise<{
    agentsCreated: string[];
    trajectoryIds: string[];
    totalTicks: number;
    duration: number;
    archetypeStats: Record<
      string,
      { agents: number; trajectories: number; avgTicksPerAgent: number }
    >;
    errors: string[];
  }>;
  cleanup(): Promise<void>;
}

type CreatedAgent = {
  id: string;
  archetype: string;
};

function parseJsonOrFallback(
  value: string | null | undefined,
  fallback: unknown,
): unknown {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return fallback;
  }
}

async function exportGeneratedTrajectories(
  trajectoryIds: readonly string[],
  outputDir: string,
): Promise<string | null> {
  if (trajectoryIds.length === 0) return null;
  const rows = await db
    .select({
      trajectoryId: trajectories.trajectoryId,
      agentId: trajectories.agentId,
      archetype: trajectories.archetype,
      stepsJson: trajectories.stepsJson,
      aiJudgeReward: trajectories.aiJudgeReward,
      aiJudgeReasoning: trajectories.aiJudgeReasoning,
      scenarioId: trajectories.scenarioId,
      finalPnL: trajectories.finalPnL,
      metricsJson: trajectories.metricsJson,
    })
    .from(trajectories)
    .where(inArray(trajectories.trajectoryId, [...trajectoryIds]));
  const byId = new Map(rows.map((row) => [row.trajectoryId, row]));
  const records = trajectoryIds
    .map((id) => byId.get(id))
    .filter((row): row is NonNullable<typeof row> => Boolean(row))
    .map((trajectory) => ({
      trajectory_id: trajectory.trajectoryId,
      agent_id: trajectory.agentId,
      archetype: trajectory.archetype,
      score: trajectory.aiJudgeReward,
      reasoning: trajectory.aiJudgeReasoning,
      scenario_id: trajectory.scenarioId,
      final_pnl: trajectory.finalPnL,
      steps: parseJsonOrFallback(trajectory.stepsJson, []),
      metrics: parseJsonOrFallback(trajectory.metricsJson, {}),
    }));
  if (records.length === 0) return null;
  const exportPath = join(outputDir, "feed-generated-trajectories.jsonl");
  await writeFile(
    exportPath,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );
  return exportPath;
}

function safeUsername(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 14);
}

async function runLimited<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  for (let index = 0; index < items.length; index += limit) {
    await Promise.all(items.slice(index, index + limit).map(fn));
  }
}

function createParallelGenerator(
  config: ParallelGenerationConfig,
): ParallelGenerator {
  const agentService = getAgentService();
  const runtimeManager = getAgentRuntimeManager();
  const autonomousCoordinator = getAutonomousCoordinator();
  const createdAgents: CreatedAgent[] = [];

  return {
    async generate() {
      const startedAt = Date.now();
      const trajectoryIds: string[] = [];
      const errors: string[] = [];
      const archetypeTrajectoryIds: Record<string, Set<string>> = {};
      const archetypeStats: Record<
        string,
        { agents: number; trajectories: number; avgTicksPerAgent: number }
      > = {};

      for (const archetype of config.archetypes) {
        archetypeStats[archetype] = {
          agents: config.agentsPerArchetype,
          trajectories: 0,
          avgTicksPerAgent: config.ticksPerAgent,
        };
        archetypeTrajectoryIds[archetype] = new Set();
        for (let index = 0; index < config.agentsPerArchetype; index += 1) {
          try {
            const suffix = `${Date.now().toString(36).slice(-5)}_${index.toString(36)}`;
            const agent = await agentService.createAgent({
              userId: config.managerId,
              name: `Training ${archetype} ${index + 1}`,
              username: `tr_${safeUsername(archetype).slice(0, 8)}_${suffix}`,
              description: `Feed training data generator for ${archetype}`,
              system: `You are a ${archetype} feed simulation agent generating trajectories for training.`,
              bio: [`${archetype} training trajectory generator`],
              personality: archetype,
              tradingStrategy: archetype,
              initialDeposit: 0,
            });
            createdAgents.push({ id: agent.id, archetype });
          } catch (err) {
            errors.push(
              `create ${archetype}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }
      }

      let totalTicks = 0;
      await runLimited(
        createdAgents,
        Math.max(1, config.parallelAgents),
        async (agent) => {
          let runtime: Awaited<ReturnType<typeof runtimeManager.getRuntime>>;
          try {
            runtime = await runtimeManager.getRuntime(agent.id);
          } catch (err) {
            errors.push(
              `runtime ${agent.id}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
            return;
          }

          for (let tick = 0; tick < config.ticksPerAgent; tick += 1) {
            try {
              const result = await autonomousCoordinator.executeAutonomousTick(
                agent.id,
                runtime,
                config.recordTrajectories,
              );
              totalTicks += 1;
              if (result.trajectoryId) {
                trajectoryIds.push(result.trajectoryId);
                archetypeTrajectoryIds[agent.archetype]?.add(
                  result.trajectoryId,
                );
                const stats = archetypeStats[agent.archetype];
                const ids = archetypeTrajectoryIds[agent.archetype];
                if (stats && ids) stats.trajectories = ids.size;
              }
              if (!result.success && result.error) {
                errors.push(`tick ${agent.id}: ${result.error}`);
              }
            } catch (err) {
              errors.push(
                `tick ${agent.id}: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            }
          }
        },
      );

      return {
        agentsCreated: createdAgents.map((agent) => agent.id),
        trajectoryIds: [...new Set(trajectoryIds)],
        totalTicks,
        duration: Date.now() - startedAt,
        archetypeStats,
        errors,
      };
    },

    async cleanup() {
      const maybeDelete = agentService.deleteAgent;
      if (!maybeDelete) return;
      await Promise.all(
        createdAgents.map((agent) =>
          maybeDelete.call(agentService, agent.id, config.managerId),
        ),
      );
    },
  };
}

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
  --output-dir        Directory for generation manifest (default: training-data/feed-parallel)
  --dry-run           Show what would be generated

AVAILABLE ARCHETYPES:
${getAvailableArchetypes()
  .map((a) => `  - ${a}`)
  .join("\n")}

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
  parsed: ReturnType<typeof parseArgs>,
): Promise<void> {
  if (wantsHelp(parsed)) {
    printHelp();
    return;
  }

  // Parse options
  const archetypesArg = getOption(parsed, "archetypes", "a") || "trader";
  const archetypes =
    archetypesArg === "all"
      ? getAvailableArchetypes()
      : archetypesArg.split(",").map((a) => a.trim());

  const numAgents = parseInt(getOption(parsed, "num-agents", "n") || "2", 10);
  const ticks = parseInt(getOption(parsed, "ticks", "t") || "10", 10);
  const parallel = parseInt(getOption(parsed, "parallel", "p") || "5", 10);
  const cleanup = getFlag(parsed, "cleanup");
  const dryRun = getFlag(parsed, "dry-run");
  const providedManagerId = getOption(parsed, "manager-id");
  const outputDir =
    getOption(parsed, "output-dir") || "training-data/feed-parallel";

  logger.header("Parallel Training Data Generation");

  console.log();
  console.log("Configuration:");
  console.log(`  Archetypes: ${archetypes.join(", ")}`);
  console.log(`  Agents per archetype: ${numAgents}`);
  console.log(`  Ticks per agent: ${ticks}`);
  console.log(`  Parallel execution: ${parallel} agents at once`);
  console.log(`  Total agents: ${archetypes.length * numAgents}`);
  console.log(
    `  Expected trajectories: ~${archetypes.length * numAgents * ticks}`,
  );
  console.log(`  Cleanup after: ${cleanup ? "Yes" : "No"}`);
  console.log(`  Manifest output: ${outputDir}`);
  console.log();

  if (dryRun) {
    console.log("[DRY RUN] Would generate:");
    console.log(`  ${archetypes.length * numAgents} agents`);
    console.log(
      `  Running in ${Math.ceil((archetypes.length * numAgents) / parallel)} parallel batches`,
    );
    console.log(`  ~${archetypes.length * numAgents * ticks} trajectories`);
    console.log(`  Manifest output: ${outputDir}`);
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
        logger.fail("No users found. Please create a user first.");
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
  logger.step("Initializing parallel generator...");
  const generator = await createParallelGenerator(config);

  logger.step("Starting parallel generation...");
  console.log("Agents will run in parallel batches. Press Ctrl+C to cancel.");
  console.log();

  const result = await generator.generate();
  const exportPath = await exportGeneratedTrajectories(
    result.trajectoryIds,
    outputDir,
  );
  const manifest = await writeFeedParallelGenerationManifest({
    outputDir,
    exportPath,
    archetypes,
    agentsCreated: result.agentsCreated,
    trajectoryIds: result.trajectoryIds,
    totalTicks: result.totalTicks,
    durationMs: result.duration,
    archetypeStats: result.archetypeStats,
    errors: result.errors,
    cleanup,
  });

  // Display results
  logger.header("Generation Complete");
  console.log();
  console.log("Results:");
  console.log(`  Agents created: ${result.agentsCreated.length}`);
  console.log(`  Trajectories generated: ${result.trajectoryIds.length}`);
  console.log(`  Total ticks executed: ${result.totalTicks}`);
  console.log(`  Duration: ${(result.duration / 1000).toFixed(1)} seconds`);
  if (exportPath) console.log(`  Export: ${exportPath}`);
  console.log(`  Manifest: ${manifest.manifestPath}`);

  if (result.errors.length > 0) {
    console.log(`  Errors: ${result.errors.length}`);
    console.log();
    console.log("Errors:");
    for (const err of result.errors.slice(0, 5)) {
      console.log(`  - ${err}`);
    }
    if (result.errors.length > 5) {
      console.log(`  ... and ${result.errors.length - 5} more`);
    }
  }
  console.log();

  // Display archetype stats
  if (Object.keys(result.archetypeStats).length > 0) {
    console.log("By Archetype:");
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
    logger.step("Cleaning up created agents...");
    await generator.cleanup();
    console.log("Agents cleaned up successfully.");
    console.log();
  } else {
    console.log("Created agents:");
    for (const id of result.agentsCreated.slice(0, 5)) {
      console.log(`  - ${id}`);
    }
    if (result.agentsCreated.length > 5) {
      console.log(`  ... and ${result.agentsCreated.length - 5} more`);
    }
    console.log();
  }

  console.log("Trajectories saved to database.");
  console.log();
  console.log("Next steps:");
  console.log("  1. Score trajectories: feed train score");
  console.log("  2. Export for training: feed train export");
  console.log("  3. Train model: feed train pipeline");

  await closeDatabase();
}
