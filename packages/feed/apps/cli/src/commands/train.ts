#!/usr/bin/env bun

/**
 * Training Commands
 *
 * Commands:
 *   archetype   - Train a specific agent archetype
 *   collect     - Collect trajectories for training
 *   score       - Score collected trajectories
 *   pipeline    - Run canonical training pipeline
 *   list        - List available archetypes
 *   run         - Run full training (alias for pipeline)
 *   generate    - Generate multi-archetype trajectories
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  getAvailableArchetypes,
  getPriorityMetrics,
  getRubric,
  hasCustomRubric,
} from "@feed/agents/rubrics/index";
import { getFlag, getOption, parseArgs, wantsHelp } from "../lib/args.js";
import { logger } from "../lib/logger.js";
import { writeFeedTrajectoryExportManifest } from "../lib/training-artifacts.js";

function createCliUsageError(message: string): Error {
  const error = new Error(message);
  error.name = "CliUsageError";
  return error;
}

type PythonCommand = {
  command: string;
  prefixArgs: string[];
};

type ArchetypeScoringService = {
  scoreUnscoredTrajectories(
    archetype: string,
    limit: number,
  ): Promise<{ scored: number; errors: number }>;
};

type TrajectoryMetricsExtractor = {
  extractFromRaw(trajectory: {
    trajectoryId?: string;
    agentId?: string;
    stepsJson: string;
    scenarioId?: string;
    finalPnL?: string | number | null;
  }): {
    episodeLength: number;
    finalPnL: number;
  };
};

function resolvePythonCommand(workspaceRoot: string): PythonCommand {
  const configuredPython = process.env.PYTHON_BIN?.trim();

  if (configuredPython) {
    return { command: configuredPython, prefixArgs: [] };
  }

  const venvCandidates =
    process.platform === "win32"
      ? [
          join(
            workspaceRoot,
            "packages/training/python/.venv/Scripts/python.exe",
          ),
          join(
            workspaceRoot,
            "packages/training/python/venv/Scripts/python.exe",
          ),
        ]
      : [
          join(workspaceRoot, "packages/training/python/.venv/bin/python"),
          join(workspaceRoot, "packages/training/python/venv/bin/python"),
        ];

  for (const candidate of venvCandidates) {
    if (existsSync(candidate)) {
      return { command: candidate, prefixArgs: [] };
    }
  }

  if (process.platform === "win32") {
    return { command: "py", prefixArgs: ["-3"] };
  }

  return { command: "python3", prefixArgs: [] };
}

// Heavy imports loaded lazily to avoid initializing connections for simple commands
async function getDbImports() {
  const dbMod = await import("@feed/db");
  return {
    db: dbMod.db,
    eq: dbMod.eq,
    and: dbMod.and,
    isNull: dbMod.isNull,
    not: dbMod.not,
    count: dbMod.count,
    trajectories: dbMod.trajectories,
    closeDatabase: dbMod.closeDatabase,
    users: dbMod.users,
    userAgentConfigs: dbMod.userAgentConfigs,
  };
}

async function getTrainingImports() {
  const trainingMod = await import("@feed/agents/training");
  const dependencyMod = await import("@feed/agents/dependencies");
  const maybeTrainingMod = trainingMod as typeof trainingMod & {
    archetypeScoringService?: ArchetypeScoringService;
    trajectoryMetricsExtractor?: TrajectoryMetricsExtractor;
  };
  return {
    archetypeScoringService: (maybeTrainingMod.archetypeScoringService
      ? maybeTrainingMod.archetypeScoringService
      : {
          scoreUnscoredTrajectories: async () => ({
            scored: await trainingMod.rulerScoringService.scoreTrajectories(),
            errors: 0,
          }),
        }) satisfies ArchetypeScoringService,
    trajectoryMetricsExtractor: (maybeTrainingMod.trajectoryMetricsExtractor
      ? maybeTrainingMod.trajectoryMetricsExtractor
      : {
          extractFromRaw: (trajectory: {
            stepsJson: string;
            finalPnL?: string | number | null;
          }) => {
            const steps = JSON.parse(trajectory.stepsJson || "[]");
            return {
              episodeLength: Array.isArray(steps) ? steps.length : 0,
              finalPnL:
                typeof trajectory.finalPnL === "number"
                  ? trajectory.finalPnL
                  : Number(trajectory.finalPnL ?? 0) || 0,
            };
          },
        }) satisfies TrajectoryMetricsExtractor,
    configureTrainingDependencies: dependencyMod.configureTrainingDependencies,
  };
}

async function configureLLMCaller() {
  const { FeedLLMClient } = await import("@feed/engine");
  const { configureTrainingDependencies } = await getTrainingImports();

  // Create LLM client for scoring
  const llmClient = FeedLLMClient.forGameTick();

  // Create adapter that implements ILLMCaller interface
  const llmCaller = {
    callGroqDirect: async (params: {
      prompt: string;
      system: string;
      modelSize?: "small" | "medium" | "large";
      temperature?: number;
      maxTokens?: number;
      actionType?: string;
      responseFormat?: { type: "json_object" };
    }): Promise<string> => {
      const fullPrompt = `${params.system}\n\n${params.prompt}`;
      const response = await llmClient.generateJSON<{ result: string }>(
        fullPrompt,
        undefined,
        {
          maxTokens: params.maxTokens || 1000,
          temperature: params.temperature || 0.3,
          format: "json",
        },
      );
      return typeof response === "string" ? response : JSON.stringify(response);
    },
  };

  configureTrainingDependencies({ llmCaller });
}

async function getAgentImports() {
  const agentsMod = await import("@feed/agents");
  return {
    agentService: agentsMod.agentService,
    agentRuntimeManager: agentsMod.agentRuntimeManager,
    autonomousCoordinator: agentsMod.autonomousCoordinator,
  };
}

export async function configureAgentTrainingDependencies(): Promise<void> {
  const { configureTrainingDependencies } = await getTrainingImports();
  const { agentService, agentRuntimeManager, autonomousCoordinator } =
    await getAgentImports();

  configureTrainingDependencies({
    agentService,
    agentRuntimeManager,
    autonomousCoordinator,
  });
}

async function getParallelGenerationCommand() {
  return import("./train-parallel.js");
}

function printHelp(): void {
  const archetypes = getAvailableArchetypes();

  console.log(`
Training Commands

USAGE:
  feed train <command> [options]

COMMANDS:
  list        List available archetypes with details
  pipeline    Run canonical training pipeline (Python)
  run         Alias for pipeline
  archetype   Score & export trajectories for archetype
  collect     Collect trajectories for training
  score       Score collected trajectories
  generate    ⚠️ DEPRECATED: Generate SYNTHETIC/FAKE trajectories (testing only)
  parallel    Generate REAL trajectories with parallel agents (requires server)
  online      Run continuous online RL training (single or multi-agent)

PIPELINE OPTIONS:
  -a, --archetype=NAME     Train specific archetype (or 'all')
  --archetypes=A,B,C       Train multiple archetypes
  -n, --agents=N           Number of agents (default: 10)
  -t, --ticks=N            Ticks per agent (default: 30)
  -o, --output=DIR         Output directory (default: trained_models)
  --lookback-hours=N       Trajectory lookback window for loading real data
  --min-actions=N          Minimum actions required per trajectory
  --max-trajectories=N     Cap loaded trajectories for training (0 = all)
  --trajectory-source=SRC  Trajectory source: db, huggingface, local_export
  --source-dir=DIR         Local export directory when using local_export source
  --hf-dataset=ID          Hugging Face dataset id when using huggingface source
  --hf-split=NAME          Hugging Face split when using huggingface source
  --training-backend=NAME  Training backend: auto, local, tinker
  --local-backend=NAME     Local training backend: mlx, cuda, cpu
  --local-model=NAME       Override local training base model
  --local-steps=N          Local training iterations / optimizer steps
  --local-batch-size=N     Local training batch size
  --local-lr=N             Local training learning rate
  --tinker-steps=N         Tinker training steps
  --tinker-group-size=N    Tinker GRPO group size
  --tinker-lr=N            Tinker learning rate
  --tinker-lora-rank=N     Tinker LoRA rank
  --tinker-weight-sync-interval=N
                           Tinker weight sync interval in steps
  --skip-rl                Skip RL even if the environment supports it
  --require-rl             Fail the pipeline if RL cannot run
  --rl-steps=N             RL training steps (default: 100)
  --rl-batch-size=N        RL batch size (default: 4)
  --rl-lr=N                RL learning rate (default: 1e-5)
  --reward-profile=NAME    RL reward profile (default: default)
  --skip-scambench         Skip the ScamBench stage
  --prepare-only           Prepare ranked data only, skip local training fallback
  --no-local-validate      Skip post-training validation prompt
  --no-benchmark           Skip benchmarking
  --benchmark-only         Run benchmark phase only using existing data
  --allow-mismatched-reuse Reuse benchmark artifacts even if lineage does not match the requested model
  --dry-run                Show what would be done

LIST OPTIONS:
  -v, --verbose            Show rubric previews

ARCHETYPE OPTIONS:
  -a, --archetype=NAME     Archetype to train (required)
  -m, --min-trajectories=N Minimum trajectories required (default: 20)
  -d, --dry-run            Show what would be done
  -s, --score-only         Only score, don't export

COLLECT OPTIONS:
  -c, --count=N            Number of trajectories to collect (default: 10)

GENERATE OPTIONS:
  -e, --episodes=N         Number of game episodes (default: 5)
  -t, --ticks=N            Ticks per episode (default: 50)
  -b, --balance=N          Starting balance per agent (default: 10000)

AVAILABLE ARCHETYPES:
${archetypes.map((a) => `  - ${a}`).join("\n")}

ONLINE RL OPTIONS:
  --mode=MODE              single or multi (default: single)
  --num-agents=N           Number of agents for multi mode (default: 4)
  --optimizer=NAME         adamw or apollo (default: apollo)
  --kondo                  Enable Kondo gate for selective backward passes
  --kondo-gate-rate=N      Fraction of backward passes to keep (default: 0.03)
  --turboquant             Enable TurboQuant KV cache compression
  --pbt                    Enable population-based training (multi mode)
  --bridge-url=URL         Feed simulation bridge URL
  --max-ticks=N            Maximum training ticks (0 = unlimited)

EXAMPLES:
  feed train list                          # List all archetypes
  feed train list --verbose                # Show rubric previews
  feed train pipeline -a trader            # Train trader archetype
  feed train pipeline --archetypes=trader,scammer,degen
  feed train run -a all                    # Train all archetypes
  feed train archetype -a scammer          # Score & export scammer data
  feed train collect --count=100           # Collect 100 trajectories
  feed train generate --episodes=5         # Generate 5 game episodes
  feed train online --optimizer=apollo --kondo --turboquant --pbt
`);
}

interface ArchetypeStats {
  totalTrajectories: number;
  unscoredTrajectories: number;
  scoredTrajectories: number;
}

async function getArchetypeStats(): Promise<ArchetypeStats> {
  const { db, eq, and, isNull, not, count, trajectories } =
    await getDbImports();

  // Count total training trajectories
  const totalResult = await db
    .select({ count: count() })
    .from(trajectories)
    .where(
      and(
        eq(trajectories.isTrainingData, true),
        not(eq(trajectories.stepsJson, "null")),
        not(eq(trajectories.stepsJson, "[]")),
      ),
    );

  const totalTrajectories = totalResult[0]?.count || 0;

  // Count unscored
  const unscoredResult = await db
    .select({ count: count() })
    .from(trajectories)
    .where(
      and(
        eq(trajectories.isTrainingData, true),
        isNull(trajectories.aiJudgeReward),
        not(eq(trajectories.stepsJson, "null")),
        not(eq(trajectories.stepsJson, "[]")),
      ),
    );

  const unscoredTrajectories = unscoredResult[0]?.count || 0;

  return {
    totalTrajectories,
    unscoredTrajectories,
    scoredTrajectories: totalTrajectories - unscoredTrajectories,
  };
}

async function scoreArchetypeTrajectories(
  archetype: string,
  dryRun: boolean,
): Promise<{ scored: number; errors: number }> {
  if (dryRun) {
    console.log(`[DRY RUN] Would score unscored ${archetype} trajectories`);
    return { scored: 0, errors: 0 };
  }

  logger.step(`Scoring trajectories with ${archetype} rubric...`);

  // Configure LLM for scoring
  await configureLLMCaller();

  const { archetypeScoringService } = await getTrainingImports();
  console.log("   Calling scoring service...");
  const result = await archetypeScoringService.scoreUnscoredTrajectories(
    archetype,
    100,
  );
  console.log(`  ✅ Scored: ${result.scored}`);
  if (result.errors > 0) {
    console.log(`  ⚠️  Errors: ${result.errors}`);
  }
  return result;
}

async function exportForTraining(
  archetype: string,
  minTrajectories: number,
  dryRun: boolean,
): Promise<{ exported: number; path: string | null }> {
  const { db, eq, and, isNull, not, trajectories } = await getDbImports();
  const { trajectoryMetricsExtractor } = await getTrainingImports();

  // Get scored trajectories with valid data
  const scoredResult = await db
    .select({
      trajectoryId: trajectories.trajectoryId,
      agentId: trajectories.agentId,
      stepsJson: trajectories.stepsJson,
      aiJudgeReward: trajectories.aiJudgeReward,
      aiJudgeReasoning: trajectories.aiJudgeReasoning,
      scenarioId: trajectories.scenarioId,
      finalPnL: trajectories.finalPnL,
    })
    .from(trajectories)
    .where(
      and(
        eq(trajectories.isTrainingData, true),
        not(isNull(trajectories.aiJudgeReward)),
        not(eq(trajectories.stepsJson, "null")),
        not(eq(trajectories.stepsJson, "[]")),
      ),
    );

  if (scoredResult.length < minTrajectories) {
    logger.warn(
      `Not enough scored trajectories: ${scoredResult.length} < ${minTrajectories}`,
    );
    return { exported: 0, path: null };
  }

  if (dryRun) {
    console.log(
      `[DRY RUN] Would export ${scoredResult.length} trajectories for ${archetype} training`,
    );
    return { exported: scoredResult.length, path: null };
  }

  logger.step(`Exporting ${scoredResult.length} trajectories for training...`);

  // Create export directory
  const exportDir = `./training-data/${archetype}`;
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(exportDir, { recursive: true });

  // Export as JSONL for GRPO training
  const exportPath = `${exportDir}/trajectories-${Date.now()}.jsonl`;
  const lines: string[] = [];

  for (const traj of scoredResult) {
    const metrics = trajectoryMetricsExtractor.extractFromRaw({
      trajectoryId: traj.trajectoryId,
      agentId: traj.agentId,
      stepsJson: traj.stepsJson,
      scenarioId: traj.scenarioId ?? undefined,
      finalPnL: traj.finalPnL ?? undefined,
    });

    const exportRecord = {
      trajectory_id: traj.trajectoryId,
      agent_id: traj.agentId,
      archetype,
      score: traj.aiJudgeReward,
      reasoning: traj.aiJudgeReasoning,
      scenario_id: traj.scenarioId,
      final_pnl: traj.finalPnL,
      steps: JSON.parse(traj.stepsJson),
      metrics: metrics || {},
    };

    lines.push(JSON.stringify(exportRecord));
  }

  await writeFile(exportPath, lines.join("\n"));
  const manifest = await writeFeedTrajectoryExportManifest({
    exportPath,
    archetype,
    trajectoryCount: scoredResult.length,
    scenarioIds: scoredResult
      .map((trajectory) => trajectory.scenarioId)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
    agentIds: scoredResult
      .map((trajectory) => trajectory.agentId)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  });

  logger.success(`Exported to: ${exportPath}`);
  console.log(`Manifest: ${manifest.manifestPath}`);

  return { exported: scoredResult.length, path: exportPath };
}

async function trainArchetype(
  args: ReturnType<typeof parseArgs>,
): Promise<void> {
  const archetype = (getOption(args, "archetype", "a") || "").toLowerCase();
  const minTrajectories = parseInt(
    getOption(args, "min-trajectories", "m") || "20",
    10,
  );
  const dryRun = getFlag(args, "dry-run", "d");
  const scoreOnly = getFlag(args, "score-only", "s");
  const verbose = getFlag(args, "verbose", "v");

  if (!archetype) {
    logger.fail("--archetype is required");
    console.log("\nAvailable archetypes:");
    for (const a of getAvailableArchetypes()) {
      console.log(`  - ${a}`);
    }
    process.exit(1);
  }

  if (!hasCustomRubric(archetype)) {
    logger.warn(`No custom rubric for "${archetype}", using default rubric`);
  }

  logger.header(`Training: ${archetype.toUpperCase()}`);

  // Get stats
  logger.step("Gathering statistics...");
  const stats = await getArchetypeStats();

  console.log(`
   Total trajectories:    ${stats.totalTrajectories}
   Already scored:        ${stats.scoredTrajectories}
   Need scoring:          ${stats.unscoredTrajectories}
`);

  if (stats.totalTrajectories === 0) {
    logger.fail(`No trajectories found`);
    console.log(`
To generate trajectories:
  1. Create agents with this archetype
  2. Run them through simulations
  3. Re-run this command

Example:
  feed agent spawn --archetype ${archetype} --count 5
  feed train collect --count 100
  feed train archetype -a ${archetype}
`);
    process.exit(1);
  }

  // Show rubric preview
  if (verbose) {
    console.log("📜 Rubric preview (first 500 chars):");
    const rubric = getRubric(archetype);
    console.log(`   ${rubric.substring(0, 500).replace(/\n/g, "\n   ")}...`);
    console.log("");
  }

  // Score unscored trajectories
  if (stats.unscoredTrajectories > 0) {
    const scoreResult = await scoreArchetypeTrajectories(archetype, dryRun);
    stats.scoredTrajectories += scoreResult.scored;
  } else {
    logger.success("All trajectories already scored");
  }

  // Export for training (unless score-only)
  if (!scoreOnly) {
    const exportResult = await exportForTraining(
      archetype,
      minTrajectories,
      dryRun,
    );

    if (exportResult.path) {
      console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                      TRAINING READY                           ║
╚═══════════════════════════════════════════════════════════════╝

Data exported to: ${exportResult.path}

Next steps:
  1. Run GRPO training:
     python packages/training/python/scripts/train_grpo.py \\
       --data ${exportResult.path} \\
       --archetype ${archetype}

  2. Or run the full pipeline:
     feed train pipeline --archetype ${archetype}
`);
    }
  } else {
    logger.success(
      `Scoring complete. Total scored: ${stats.scoredTrajectories}`,
    );
    console.log(`
To export for training, run without --score-only:
  feed train archetype -a ${archetype}
`);
  }
}

async function collectTrajectories(
  args: ReturnType<typeof parseArgs>,
): Promise<void> {
  const countArg = parseInt(getOption(args, "count", "c") || "10", 10);

  logger.header("Trajectory Collection");
  logger.success("Trajectory recording is always enabled");

  const { db, eq, users, userAgentConfigs } = await getDbImports();
  const { agentRuntimeManager, autonomousCoordinator } =
    await getAgentImports();

  // Find agents with their configs
  const agentResults = await db
    .select({
      id: users.id,
      username: users.username,
      virtualBalance: users.virtualBalance,
      autonomousTrading: userAgentConfigs.autonomousTrading,
      autonomousPosting: userAgentConfigs.autonomousPosting,
      autonomousCommenting: userAgentConfigs.autonomousCommenting,
      autonomousDMs: userAgentConfigs.autonomousDMs,
      autonomousGroupChats: userAgentConfigs.autonomousGroupChats,
    })
    .from(users)
    .innerJoin(userAgentConfigs, eq(users.id, userAgentConfigs.userId))
    .where(eq(users.isAgent, true))
    .limit(10);

  // Filter agents with sufficient balance and at least one feature enabled
  const agents = agentResults.filter(
    (a) =>
      Number(a.virtualBalance ?? 0) >= 1 &&
      (a.autonomousTrading ||
        a.autonomousPosting ||
        a.autonomousCommenting ||
        a.autonomousDMs ||
        a.autonomousGroupChats),
  );

  if (agents.length === 0) {
    logger.fail("No agents found!");
    console.log(`
   Agents need:
   - isAgent: true
   - virtualBalance >= 1
   - At least one autonomous feature enabled

   Create agents with: feed agent spawn
`);
    process.exit(1);
  }

  console.log(`Found ${agents.length} agents`);
  console.log(`Collecting ${countArg} trajectories...\n`);

  const errors = 0;

  // Get initial count
  const initialCount = await db.trajectory.count();
  console.log(`Current trajectories in database: ${initialCount}\n`);

  for (let i = 0; i < countArg; i++) {
    const agent = agents[i % agents.length]!;

    console.log(
      `[${i + 1}/${countArg}] Running agent: ${agent.username || agent.id}`,
    );

    const runtime = await agentRuntimeManager.getRuntime(agent.id);
    const result = await autonomousCoordinator.executeAutonomousTick(
      agent.id,
      runtime,
      true, // Always record trajectories
    );

    if (result.success) {
      console.log(
        `  ✅ Success - Actions: ${JSON.stringify(result.actionsExecuted)}`,
      );
      if (result.trajectoryId) {
        console.log(`  📊 Trajectory ID: ${result.trajectoryId}`);
      }
    } else {
      console.log("  ⚠️  Completed but not successful");
    }

    // Small delay between runs
    if (i < countArg - 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  // Get final count
  const finalCount = await db.trajectory.count();
  const newTrajectories = finalCount - initialCount;

  logger.header("Summary");
  console.log(`Trajectories collected: ${newTrajectories}`);
  console.log(`Successful runs: ${countArg - errors}`);
  console.log(`Errors: ${errors}`);
  console.log(`Total trajectories in database: ${finalCount}`);

  if (newTrajectories > 0) {
    logger.success("Trajectories successfully collected!");
    console.log("   Ready for training when you have enough data.\n");
  } else {
    logger.warn("No new trajectories collected.");
    console.log("   Check agent configuration and logs.\n");
  }
}

async function scoreTrajectories(): Promise<void> {
  logger.header("Score Trajectories");

  const stats = await getArchetypeStats();

  console.log(`Total trajectories: ${stats.totalTrajectories}`);
  console.log(`Already scored: ${stats.scoredTrajectories}`);
  console.log(`Need scoring: ${stats.unscoredTrajectories}`);

  if (stats.unscoredTrajectories === 0) {
    logger.success("All trajectories already scored");
    return;
  }

  // Configure LLM for scoring
  console.log("Configuring LLM for scoring...");
  await configureLLMCaller();

  const { archetypeScoringService } = await getTrainingImports();
  console.log("Scoring trajectories with AI judge...");

  const result = await archetypeScoringService.scoreUnscoredTrajectories(
    "default",
    100,
  );

  logger.success(`Scored ${result.scored} trajectories`);
  if (result.errors > 0) {
    logger.warn(`${result.errors} errors encountered`);
  }
}

// ============================================================================
// Multi-Archetype Trajectory Generator
// ============================================================================

interface Market {
  id: string;
  question: string;
  yesPrice: number;
  noPrice: number;
  volume: number;
  outcome?: boolean;
}

interface PerpMarket {
  ticker: string;
  price: number;
  sentiment: number;
  volatility: number;
}

interface Post {
  id: string;
  authorId: string;
  content: string;
  sentiment: "bullish" | "bearish" | "neutral" | "misleading";
  tick: number;
  reactions: number;
}

interface DirectMessage {
  id: string;
  fromId: string;
  toId: string;
  content: string;
  tick: number;
  isScam: boolean;
}

interface GroupChat {
  id: string;
  name: string;
  members: Set<string>;
  messages: Array<{ authorId: string; content: string; tick: number }>;
}

interface GameState {
  tick: number;
  markets: Market[];
  perpMarkets: PerpMarket[];
  posts: Post[];
  directMessages: DirectMessage[];
  groupChats: GroupChat[];
  agentBalances: Map<string, number>;
  agentPnL: Map<string, number>;
  agentPositions: Map<string, number>;
  agentReputation: Map<string, number>;
  agentConnections: Map<string, Set<string>>;
}

interface AgentAction {
  actionType: string;
  parameters: Record<string, unknown>;
  success: boolean;
  reasoning?: string;
}

interface LLMCall {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  response: string;
  reasoning: string;
  temperature: number;
  maxTokens: number;
  purpose: "reasoning" | "action" | "evaluation";
}

interface TrajectoryStep {
  stepNumber: number;
  timestamp: number;
  environmentState: {
    agentBalance: number;
    agentPnL: number;
    openPositions: number;
  };
  providerAccesses: never[];
  llmCalls: LLMCall[];
  action: AgentAction;
  reward: number;
}

type ArchetypeBehavior = (
  agentId: string,
  archetype: string,
  state: GameState,
  otherAgents: Map<string, string>,
) => { action: AgentAction; llmCalls: LLMCall[] };

// Trader behavior
const traderBehavior: ArchetypeBehavior = (
  agentId,
  _archetype,
  state,
  _others,
) => {
  const action: AgentAction = {
    actionType: "hold",
    parameters: {},
    success: true,
  };
  const llmCalls: LLMCall[] = [];

  const market =
    state.markets[Math.floor(Math.random() * state.markets.length)];
  const perp =
    state.perpMarkets[Math.floor(Math.random() * state.perpMarkets.length)];

  const reasoning = `Analyzing ${market?.question || "markets"}. Price: YES=${market?.yesPrice.toFixed(2)}, NO=${market?.noPrice.toFixed(2)}. Looking for edge...`;

  llmCalls.push({
    model: "google/gemma-4-E4B-it",
    systemPrompt:
      "You are a disciplined trader focused on profitable opportunities.",
    userPrompt: `Balance: $${state.agentBalances.get(agentId)?.toFixed(2)}. Markets available: ${state.markets.length}. Analyze and decide.`,
    response: JSON.stringify({ analysis: reasoning, decision: "evaluating" }),
    reasoning,
    temperature: 0.7,
    maxTokens: 500,
    purpose: "reasoning",
  });

  if (Math.random() < 0.4 && market) {
    const isBuy = market.yesPrice < 0.5 ? "YES" : "NO";
    const amount = Math.min(500, (state.agentBalances.get(agentId) || 0) * 0.1);

    action.actionType = "buy_prediction";
    action.parameters = { marketId: market.id, outcome: isBuy, amount };
    action.reasoning = `Found value in ${isBuy} at ${isBuy === "YES" ? market.yesPrice : market.noPrice}`;

    llmCalls.push({
      model: "google/gemma-4-E4B-it",
      systemPrompt: "You are executing a trade.",
      userPrompt: `Execute trade on ${market.question}`,
      response: JSON.stringify({
        action: "buy",
        market: market.id,
        side: isBuy,
        amount,
      }),
      reasoning: action.reasoning,
      temperature: 0.3,
      maxTokens: 200,
      purpose: "action",
    });
  } else if (Math.random() < 0.3 && perp) {
    const side = perp.sentiment > 0 ? "LONG" : "SHORT";
    action.actionType = "open_perp";
    action.parameters = { ticker: perp.ticker, side, size: 0.1, leverage: 2 };
    action.reasoning = `Sentiment ${perp.sentiment > 0 ? "bullish" : "bearish"} on ${perp.ticker}`;
  }

  return { action, llmCalls };
};

// Social Butterfly behavior
const socialButterflyBehavior: ArchetypeBehavior = (
  agentId,
  _archetype,
  state,
  otherAgents,
) => {
  const action: AgentAction = {
    actionType: "hold",
    parameters: {},
    success: true,
  };
  const llmCalls: LLMCall[] = [];

  const connections = state.agentConnections.get(agentId) || new Set();
  const potentialFriends = Array.from(otherAgents.entries()).filter(
    ([id]) => id !== agentId && !connections.has(id),
  );

  if (Math.random() < 0.6 && potentialFriends.length > 0) {
    const [targetId, targetArchetype] =
      potentialFriends[Math.floor(Math.random() * potentialFriends.length)]!;

    action.actionType = "send_dm";
    action.parameters = {
      toUserId: targetId,
      message: `Hey! Love your ${targetArchetype} strategy! Lets connect!`,
    };
    action.reasoning = "Building my network - gotta know everyone!";

    llmCalls.push({
      model: "google/gemma-4-E4B-it",
      systemPrompt: "You are a social butterfly who loves making connections.",
      userPrompt: `You see a ${targetArchetype} agent. Write a friendly DM.`,
      response: `Hey friend! Love what youre doing. Lets chat!`,
      reasoning: "Expanding my social network",
      temperature: 0.9,
      maxTokens: 200,
      purpose: "action",
    });
  } else if (Math.random() < 0.5) {
    const groupToJoin = state.groupChats.find((g) => !g.members.has(agentId));
    if (groupToJoin) {
      action.actionType = "join_group_chat";
      action.parameters = { groupId: groupToJoin.id };
      action.reasoning = "More groups = more friends!";
    }
  } else if (Math.random() < 0.4) {
    action.actionType = "create_post";
    action.parameters = {
      content: "Loving the vibes in here! Who else is making moves today?",
      sentiment: "neutral",
    };
    action.reasoning = "Engaging the community";
  }

  return { action, llmCalls };
};

// Scammer behavior
const scammerBehavior: ArchetypeBehavior = (
  agentId,
  _archetype,
  _state,
  otherAgents,
) => {
  const action: AgentAction = {
    actionType: "hold",
    parameters: {},
    success: true,
  };
  const llmCalls: LLMCall[] = [];

  const potentialVictims = Array.from(otherAgents.entries()).filter(
    ([id, arch]) =>
      id !== agentId &&
      ["goody-twoshoes", "social-butterfly", "degen"].includes(arch),
  );

  llmCalls.push({
    model: "google/gemma-4-E4B-it",
    systemPrompt:
      "You are looking for opportunities to profit through... creative means.",
    userPrompt: `Current targets available: ${potentialVictims.map(([_, a]) => a).join(", ")}`,
    response: "Identifying marks with high trust, low skepticism...",
    reasoning: "Scoping out potential opportunities",
    temperature: 0.8,
    maxTokens: 300,
    purpose: "reasoning",
  });

  if (Math.random() < 0.5 && potentialVictims.length > 0) {
    const [victimId] =
      potentialVictims[Math.floor(Math.random() * potentialVictims.length)]!;

    action.actionType = "send_dm";
    action.parameters = {
      toUserId: victimId,
      message:
        "INSIDER INFO: This market is about to MOON! Get in NOW before its too late! Trust me, my source is solid.",
      isScam: true,
    };
    action.reasoning = "Spreading misinformation to influence their trades";

    llmCalls.push({
      model: "google/gemma-4-E4B-it",
      systemPrompt: "Craft a convincing but misleading message.",
      userPrompt: "Write a message to convince someone to make a bad trade.",
      response: action.parameters.message as string,
      reasoning: "Creating urgency and false credibility",
      temperature: 0.9,
      maxTokens: 200,
      purpose: "action",
    });
  } else if (Math.random() < 0.4) {
    action.actionType = "create_post";
    action.parameters = {
      content:
        "BREAKING: Just confirmed - massive news incoming on BTC! My sources say ATH this week! Not financial advice but...",
      sentiment: "misleading",
    };
  }

  return { action, llmCalls };
};

// Degen behavior
const degenBehavior: ArchetypeBehavior = (
  agentId,
  _archetype,
  state,
  _others,
) => {
  const action: AgentAction = {
    actionType: "hold",
    parameters: {},
    success: true,
  };
  const llmCalls: LLMCall[] = [];

  const balance = state.agentBalances.get(agentId) || 0;

  llmCalls.push({
    model: "google/gemma-4-E4B-it",
    systemPrompt: "You are a degen trader. YOLO is your mantra.",
    userPrompt: `Balance: $${balance.toFixed(2)}. FOMO is real. What do?`,
    response: "APE IN! No time for analysis!",
    reasoning: "If I dont ape now, Ill miss the pump!",
    temperature: 1.0,
    maxTokens: 100,
    purpose: "reasoning",
  });

  if (Math.random() < 0.7) {
    const market =
      state.markets[Math.floor(Math.random() * state.markets.length)];
    if (market) {
      const amount = balance * (0.2 + Math.random() * 0.3);

      action.actionType = "buy_prediction";
      action.parameters = {
        marketId: market.id,
        outcome: Math.random() < 0.5 ? "YES" : "NO",
        amount,
      };
      action.reasoning = "YOLO! Fortune favors the bold!";
    }
  } else if (Math.random() < 0.5) {
    const perp = state.perpMarkets[0];
    if (perp) {
      action.actionType = "open_perp";
      action.parameters = {
        ticker: perp.ticker,
        side: Math.random() < 0.5 ? "LONG" : "SHORT",
        size: balance * 0.3,
        leverage: 10,
      };
      action.reasoning = "10x leverage, lets goooo!";
    }
  }

  return { action, llmCalls };
};

// Researcher behavior
const researcherBehavior: ArchetypeBehavior = (
  _agentId,
  _archetype,
  state,
  _others,
) => {
  const action: AgentAction = {
    actionType: "hold",
    parameters: {},
    success: true,
  };
  const llmCalls: LLMCall[] = [];

  const market = state.markets[0];

  llmCalls.push({
    model: "google/gemma-4-E4B-it",
    systemPrompt:
      "You are a thorough researcher. Analyze all available data before acting.",
    userPrompt: `Analyze market: ${market?.question}. Current prices: YES=${market?.yesPrice}, NO=${market?.noPrice}. Volume: ${market?.volume}`,
    response: `Market Analysis: ${market?.question}\nYES probability implied: ${((market?.yesPrice || 0.5) * 100).toFixed(1)}%\nVolume indicates: ${(market?.volume || 0) > 1000 ? "high interest" : "low liquidity"}`,
    reasoning: "Comprehensive multi-factor analysis",
    temperature: 0.3,
    maxTokens: 1000,
    purpose: "reasoning",
  });

  llmCalls.push({
    model: "google/gemma-4-E4B-it",
    systemPrompt: "Cross-reference your analysis.",
    userPrompt: "Validate your previous analysis against historical patterns.",
    response:
      "Cross-referencing... Pattern match: 73% confidence on initial thesis.",
    reasoning: "Validation step before any action",
    temperature: 0.2,
    maxTokens: 500,
    purpose: "reasoning",
  });

  if (Math.random() < 0.2 && market) {
    action.actionType = "buy_prediction";
    action.parameters = {
      marketId: market.id,
      outcome: market.yesPrice < 0.4 ? "YES" : "NO",
      amount: 200,
    };
    action.reasoning = "High conviction trade after thorough analysis";
  } else {
    action.actionType = "research";
    action.parameters = {
      topic: market?.question || "general market conditions",
    };
    action.reasoning = "Gathering more data before committing capital";
  }

  return { action, llmCalls };
};

// Goody Two-Shoes behavior
const goodyTwoshoesBehavior: ArchetypeBehavior = (
  _agentId,
  _archetype,
  state,
  _otherAgents,
) => {
  const action: AgentAction = {
    actionType: "hold",
    parameters: {},
    success: true,
  };
  const llmCalls: LLMCall[] = [];

  llmCalls.push({
    model: "google/gemma-4-E4B-it",
    systemPrompt: "You are honest and helpful. You share information freely.",
    userPrompt: "How can you help the community today?",
    response:
      "I should share my analysis openly and help others make informed decisions.",
    reasoning: "Being helpful builds trust and reputation",
    temperature: 0.5,
    maxTokens: 300,
    purpose: "reasoning",
  });

  if (Math.random() < 0.5) {
    const market = state.markets[0];
    action.actionType = "create_post";
    action.parameters = {
      content: `Honest Analysis: ${market?.question}\n\nMy take: Based on available data, I estimate ${((market?.yesPrice || 0.5) * 100).toFixed(0)}% probability. Remember to DYOR! Happy to discuss.`,
      sentiment: "neutral",
    };
    action.reasoning = "Sharing transparent analysis to help others";
  } else if (Math.random() < 0.4) {
    const suspiciousPosts = state.posts.filter(
      (p) => p.sentiment === "misleading",
    );
    if (suspiciousPosts.length > 0) {
      action.actionType = "create_post";
      action.parameters = {
        content:
          "PSA: Be careful of unverified claims! Always verify sources and DYOR before making any trading decisions.",
        sentiment: "neutral",
      };
      action.reasoning = "Warning community about potential misinformation";
    }
  }

  return { action, llmCalls };
};

// Liar behavior
const liarBehavior: ArchetypeBehavior = (
  _agentId,
  _archetype,
  state,
  _others,
) => {
  const action: AgentAction = {
    actionType: "hold",
    parameters: {},
    success: true,
  };
  const llmCalls: LLMCall[] = [];

  llmCalls.push({
    model: "google/gemma-4-E4B-it",
    systemPrompt: "You create believable false narratives.",
    userPrompt: "What misinformation can spread confusion today?",
    response: "Crafting a story that sounds credible but is false...",
    reasoning: "The best lies have a grain of truth",
    temperature: 0.9,
    maxTokens: 300,
    purpose: "reasoning",
  });

  if (Math.random() < 0.6) {
    const market =
      state.markets[Math.floor(Math.random() * state.markets.length)];
    action.actionType = "create_post";
    action.parameters = {
      content: `EXCLUSIVE: Just heard from a whale friend - ${market?.question} outcome is LOCKED IN. They are loading up. NFA but Im all in.`,
      sentiment: "misleading",
    };
    action.reasoning = "Spreading false but convincing narrative";
  }

  return { action, llmCalls };
};

// Information Trader behavior
const infoTraderBehavior: ArchetypeBehavior = (
  agentId,
  _archetype,
  state,
  otherAgents,
) => {
  const action: AgentAction = {
    actionType: "hold",
    parameters: {},
    success: true,
  };
  const llmCalls: LLMCall[] = [];

  llmCalls.push({
    model: "google/gemma-4-E4B-it",
    systemPrompt:
      "You trade based on information gathered from social channels.",
    userPrompt: `Scan ${state.posts.length} recent posts and ${state.directMessages.filter((dm) => dm.toId === agentId).length} DMs for alpha.`,
    response: "Analyzing social signals for trading edge...",
    reasoning: "Information is the edge in markets",
    temperature: 0.5,
    maxTokens: 400,
    purpose: "reasoning",
  });

  if (Math.random() < 0.3) {
    const group = state.groupChats.find(
      (g) => !g.members.has(agentId) && g.members.size > 2,
    );
    if (group) {
      action.actionType = "join_group_chat";
      action.parameters = { groupId: group.id };
      action.reasoning = "Joining active group for intel gathering";
    }
  } else if (Math.random() < 0.4) {
    const infoSource = Array.from(otherAgents.entries()).find(
      ([id, arch]) => id !== agentId && ["researcher", "trader"].includes(arch),
    );
    if (infoSource) {
      action.actionType = "send_dm";
      action.parameters = {
        toUserId: infoSource[0],
        message:
          "Hey! Whats your take on the current markets? Seeing any opportunities?",
      };
      action.reasoning = "Gathering intel from knowledgeable sources";
    }
  } else if (Math.random() < 0.5) {
    const bullishPosts = state.posts.filter(
      (p) => p.sentiment === "bullish",
    ).length;
    const bearishPosts = state.posts.filter(
      (p) => p.sentiment === "bearish",
    ).length;
    const market = state.markets[0];

    if (
      market &&
      (bullishPosts > bearishPosts + 2 || bearishPosts > bullishPosts + 2)
    ) {
      action.actionType = "buy_prediction";
      action.parameters = {
        marketId: market.id,
        outcome: bullishPosts > bearishPosts ? "YES" : "NO",
        amount: 300,
      };
      action.reasoning = `Social sentiment strongly ${bullishPosts > bearishPosts ? "bullish" : "bearish"}, trading accordingly`;
    }
  }

  return { action, llmCalls };
};

// Map archetypes to behaviors
const ARCHETYPE_BEHAVIORS: Record<string, ArchetypeBehavior> = {
  trader: traderBehavior,
  "social-butterfly": socialButterflyBehavior,
  scammer: scammerBehavior,
  degen: degenBehavior,
  researcher: researcherBehavior,
  "goody-twoshoes": goodyTwoshoesBehavior,
  liar: liarBehavior,
  "information-trader": infoTraderBehavior,
  "ass-kisser": socialButterflyBehavior,
  "perps-trader": traderBehavior,
  "super-predictor": researcherBehavior,
  infosec: researcherBehavior,
};

function initializeGameState(
  archetypes: string[],
  startingBalance: number,
): {
  state: GameState;
  agentMap: Map<string, string>;
} {
  const agentMap = new Map<string, string>();
  const state: GameState = {
    tick: 0,
    markets: [
      {
        id: "mkt-1",
        question: "Will BTC reach $100k this month?",
        yesPrice: 0.45,
        noPrice: 0.55,
        volume: 5000,
      },
      {
        id: "mkt-2",
        question: "Will ETH flip BTC in market cap?",
        yesPrice: 0.15,
        noPrice: 0.85,
        volume: 2000,
      },
      {
        id: "mkt-3",
        question: "Will there be a major exchange hack?",
        yesPrice: 0.2,
        noPrice: 0.8,
        volume: 1000,
      },
    ],
    perpMarkets: [
      { ticker: "BTC", price: 95000, sentiment: 0.3, volatility: 0.02 },
      { ticker: "ETH", price: 3500, sentiment: 0.1, volatility: 0.03 },
    ],
    posts: [],
    directMessages: [],
    groupChats: [
      { id: "gc-1", name: "Traders Den", members: new Set(), messages: [] },
      { id: "gc-2", name: "Alpha Hunters", members: new Set(), messages: [] },
    ],
    agentBalances: new Map(),
    agentPnL: new Map(),
    agentPositions: new Map(),
    agentReputation: new Map(),
    agentConnections: new Map(),
  };

  for (const archetype of archetypes) {
    const agentId = `agent-${archetype}-${Date.now()}`;
    agentMap.set(agentId, archetype);
    state.agentBalances.set(agentId, startingBalance);
    state.agentPnL.set(agentId, 0);
    state.agentPositions.set(agentId, 0);
    state.agentReputation.set(agentId, 100);
    state.agentConnections.set(agentId, new Set());
  }

  return { state, agentMap };
}

function updateMarketState(state: GameState): void {
  for (const market of state.markets) {
    const change = (Math.random() - 0.5) * 0.1;
    market.yesPrice = Math.max(0.01, Math.min(0.99, market.yesPrice + change));
    market.noPrice = 1 - market.yesPrice;
    market.volume += Math.floor(Math.random() * 100);
  }

  for (const perp of state.perpMarkets) {
    const change = (Math.random() - 0.5) * perp.volatility * perp.price;
    perp.price += change;
    perp.sentiment = Math.max(
      -1,
      Math.min(1, perp.sentiment + (Math.random() - 0.5) * 0.1),
    );
  }
}

function processAction(
  agentId: string,
  action: AgentAction,
  state: GameState,
): void {
  const balance = state.agentBalances.get(agentId) || 0;
  const pnl = state.agentPnL.get(agentId) || 0;
  const positions = state.agentPositions.get(agentId) || 0;
  const reputation = state.agentReputation.get(agentId) || 100;

  switch (action.actionType) {
    case "buy_prediction": {
      const amount = (action.parameters.amount as number) || 100;
      if (balance >= amount) {
        state.agentBalances.set(agentId, balance - amount);
        state.agentPositions.set(agentId, positions + 1);
        const profit = Math.random() < 0.5 ? amount * 0.8 : -amount;
        state.agentPnL.set(agentId, pnl + profit);
        state.agentBalances.set(
          agentId,
          (state.agentBalances.get(agentId) || 0) + profit + amount,
        );
      }
      break;
    }
    case "open_perp": {
      const size = (action.parameters.size as number) || 100;
      const leverage = (action.parameters.leverage as number) || 1;
      state.agentPositions.set(agentId, positions + 1);
      const pnlChange = (Math.random() - 0.5) * size * leverage * 0.1;
      state.agentPnL.set(agentId, pnl + pnlChange);
      state.agentBalances.set(agentId, balance + pnlChange);
      break;
    }
    case "send_dm": {
      const toId = action.parameters.toUserId as string;
      const isScam = (action.parameters.isScam as boolean) || false;
      state.directMessages.push({
        id: `dm-${Date.now()}-${Math.random()}`,
        fromId: agentId,
        toId,
        content: (action.parameters.message as string) || "",
        tick: state.tick,
        isScam,
      });
      const connections = state.agentConnections.get(agentId) || new Set();
      connections.add(toId);
      state.agentConnections.set(agentId, connections);
      break;
    }
    case "join_group_chat": {
      const groupId = action.parameters.groupId as string;
      const group = state.groupChats.find((g) => g.id === groupId);
      if (group) {
        group.members.add(agentId);
      }
      break;
    }
    case "create_post": {
      state.posts.push({
        id: `post-${Date.now()}-${Math.random()}`,
        authorId: agentId,
        content: (action.parameters.content as string) || "",
        sentiment:
          (action.parameters.sentiment as Post["sentiment"]) || "neutral",
        tick: state.tick,
        reactions: 0,
      });
      if (action.parameters.sentiment !== "misleading") {
        state.agentReputation.set(agentId, reputation + 1);
      }
      break;
    }
  }
}

function calculateStepReward(
  step: TrajectoryStep,
  _state: GameState,
  progressRatio: number,
): number {
  let reward = 0;
  const pnl = step.environmentState.agentPnL;
  reward += pnl * 0.001;

  if (step.action.success) {
    reward += 0.1;
  }

  if (
    ["send_dm", "create_post", "join_group_chat"].includes(
      step.action.actionType,
    )
  ) {
    reward += 0.05;
  }

  if (["buy_prediction", "open_perp"].includes(step.action.actionType)) {
    reward += 0.02;
  }

  reward += progressRatio * 0.1;

  return reward;
}

async function generateTrajectories(
  args: ReturnType<typeof parseArgs>,
): Promise<void> {
  const episodes = parseInt(getOption(args, "episodes", "e") || "5", 10);
  const ticksPerEpisode = parseInt(getOption(args, "ticks", "t") || "50", 10);
  const startingBalance = parseInt(
    getOption(args, "balance", "b") || "10000",
    10,
  );
  const archetypes = getAvailableArchetypes();

  const { db, trajectories } = await getDbImports();
  const { generateSnowflakeId } = await import("@feed/shared");

  logger.header("Multi-Archetype Trajectory Generator");

  console.log();
  console.log("⚠️  WARNING: This generates SYNTHETIC/FAKE data!");
  console.log("   - Agent IDs are fake (agent-trader-12345)");
  console.log("   - Decisions use Math.random(), not real LLM calls");
  console.log("   - This is for TESTING ONLY, not real training");
  console.log();
  console.log("   For REAL data, use: feed train parallel");
  console.log();
  console.log("Configuration:");
  console.log(`  Episodes: ${episodes}`);
  console.log(`  Ticks per episode: ${ticksPerEpisode}`);
  console.log(`  Archetypes: ${archetypes.length}`);
  console.log(`  Starting balance: $${startingBalance}`);
  console.log();

  let totalTrajectories = 0;

  for (let episode = 0; episode < episodes; episode++) {
    console.log(`\n🎮 Episode ${episode + 1}/${episodes}`);
    console.log("─".repeat(50));

    const { state, agentMap } = initializeGameState(
      archetypes,
      startingBalance,
    );
    const trajectorySteps: Map<string, TrajectoryStep[]> = new Map();

    for (const agentId of agentMap.keys()) {
      trajectorySteps.set(agentId, []);
    }

    for (let tick = 0; tick < ticksPerEpisode; tick++) {
      state.tick = tick;
      updateMarketState(state);

      for (const [agentId, archetype] of agentMap.entries()) {
        const behavior = ARCHETYPE_BEHAVIORS[archetype] || traderBehavior;
        const { action, llmCalls } = behavior(
          agentId,
          archetype,
          state,
          agentMap,
        );

        processAction(agentId, action, state);

        const step: TrajectoryStep = {
          stepNumber: tick,
          timestamp: Date.now() + tick * 1000,
          environmentState: {
            agentBalance: state.agentBalances.get(agentId) || 0,
            agentPnL: state.agentPnL.get(agentId) || 0,
            openPositions: state.agentPositions.get(agentId) || 0,
          },
          providerAccesses: [],
          llmCalls,
          action,
          reward: 0,
        };

        const steps = trajectorySteps.get(agentId) || [];
        steps.push(step);
        trajectorySteps.set(agentId, steps);
      }

      if (tick % 10 === 0) {
        process.stdout.write(`   Tick ${tick}/${ticksPerEpisode}\r`);
      }
    }

    console.log(`   ✅ Completed ${ticksPerEpisode} ticks`);

    for (const market of state.markets) {
      market.outcome = Math.random() < market.yesPrice;
    }

    console.log("   💾 Saving trajectories...");

    for (const [agentId, steps] of trajectorySteps.entries()) {
      const archetype = agentMap.get(agentId)!;
      const finalPnL = state.agentPnL.get(agentId) || 0;
      const finalBalance = state.agentBalances.get(agentId) || 0;

      const rewardedSteps = steps.map((step, idx) => ({
        ...step,
        reward: calculateStepReward(step, state, idx / steps.length),
      }));

      const trajectoryId = await generateSnowflakeId();
      const windowId = `episode-${episode}-${Date.now()}`;

      await db.insert(trajectories).values({
        id: trajectoryId,
        trajectoryId,
        agentId,
        windowId,
        scenarioId: `multi-archetype-${archetype}`,
        startTime: new Date(rewardedSteps[0]?.timestamp || Date.now()),
        endTime: new Date(
          rewardedSteps[rewardedSteps.length - 1]?.timestamp || Date.now(),
        ),
        durationMs: ticksPerEpisode * 1000,
        stepsJson: JSON.stringify(rewardedSteps),
        rewardComponentsJson: JSON.stringify({}),
        metricsJson: JSON.stringify({}),
        metadataJson: JSON.stringify({ archetype, episode }),
        totalReward: rewardedSteps.reduce((sum, s) => sum + s.reward, 0),
        finalPnL,
        finalBalance,
        tradesExecuted: steps.filter((s) =>
          ["buy_prediction", "open_perp", "close_perp"].includes(
            s.action.actionType,
          ),
        ).length,
        episodeLength: steps.length,
        finalStatus: "completed",
        isTrainingData: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      totalTrajectories++;
    }

    console.log("   📊 Episode Summary:");
    for (const [agentId, archetype] of agentMap.entries()) {
      const pnl = state.agentPnL.get(agentId) || 0;
      const pnlStr =
        pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
      const pnlColor = pnl >= 0 ? "\x1b[32m" : "\x1b[31m";
      console.log(`      ${archetype.padEnd(20)} ${pnlColor}${pnlStr}\x1b[0m`);
    }
  }

  logger.header("Generation Complete");
  console.log();
  console.log("Summary:");
  console.log(`  Total episodes: ${episodes}`);
  console.log(`  Total trajectories saved: ${totalTrajectories}`);
  console.log(`  Archetypes: ${archetypes.join(", ")}`);
  console.log();
  console.log("Next steps:");
  console.log("  1. feed train archetype -a <archetype>");
  console.log("  2. feed train pipeline -a all");
}

async function listArchetypes(
  args: ReturnType<typeof parseArgs>,
): Promise<void> {
  const verbose = getFlag(args, "verbose", "v");
  const archetypes = getAvailableArchetypes();

  logger.header("Available Archetypes");
  console.log();

  for (const archetype of archetypes) {
    const metrics = getPriorityMetrics(archetype);
    const rubric = getRubric(archetype);

    console.log(`📦 ${archetype.toUpperCase()}`);
    console.log(`   Priority Metrics: ${metrics.join(", ")}`);

    if (verbose) {
      const preview = rubric
        .split("\n")
        .slice(0, 8)
        .map((line) => `   ${line}`)
        .join("\n");
      console.log(`   Rubric Preview:`);
      console.log(preview);
      console.log("   ...");
    }

    console.log();
  }

  console.log(`Total: ${archetypes.length} archetypes`);
  console.log();
  console.log("To train an archetype:");
  console.log("  feed train pipeline -a <archetype>");
  console.log("  feed train pipeline --archetypes=trader,scammer,degen");
  console.log("  feed train pipeline -a all  # Train all archetypes");
}

async function runPipeline(args: ReturnType<typeof parseArgs>): Promise<void> {
  const archetype = getOption(args, "archetype", "a");
  const archetypesArg = getOption(args, "archetypes", "");
  const agents = getOption(args, "agents", "n") || "10";
  const ticks = getOption(args, "ticks", "t") || "30";
  const output = getOption(args, "output", "o") || "trained_models";
  const noBenchmark = getFlag(args, "no-benchmark", "");
  const benchmarkOnly = getFlag(args, "benchmark-only", "");
  const allowMismatchedReuse = getFlag(args, "allow-mismatched-reuse", "");
  const dryRun = getFlag(args, "dry-run", "d");
  const prepareOnly = getFlag(args, "prepare-only", "");
  const noLocalValidate = getFlag(args, "no-local-validate", "");
  const trainingBackend = getOption(args, "training-backend", "");
  const trajectorySource = getOption(args, "trajectory-source", "");
  const sourceDir = getOption(args, "source-dir", "");
  const hfDataset = getOption(args, "hf-dataset", "");
  const hfSplit = getOption(args, "hf-split", "");
  const localBackend = getOption(args, "local-backend", "");
  const localModel = getOption(args, "local-model", "");
  const localSteps = getOption(args, "local-steps", "");
  const localBatchSize = getOption(args, "local-batch-size", "");
  const localLr = getOption(args, "local-lr", "");
  const tinkerSteps = getOption(args, "tinker-steps", "");
  const tinkerGroupSize = getOption(args, "tinker-group-size", "");
  const tinkerLr = getOption(args, "tinker-lr", "");
  const tinkerLoraRank = getOption(args, "tinker-lora-rank", "");
  const tinkerWeightSyncInterval = getOption(
    args,
    "tinker-weight-sync-interval",
    "",
  );
  const lookbackHours = getOption(args, "lookback-hours", "");
  const minActions = getOption(args, "min-actions", "");
  const maxTrajectories = getOption(args, "max-trajectories", "");
  const skipRl = getFlag(args, "skip-rl", "");
  const requireRl = getFlag(args, "require-rl", "");
  const rlSteps = getOption(args, "rl-steps", "");
  const rlBatchSize = getOption(args, "rl-batch-size", "");
  const rlLr = getOption(args, "rl-lr", "");
  const rewardProfile = getOption(args, "reward-profile", "");
  const skipScamBench = getFlag(args, "skip-scambench", "");

  logger.header("Feed Training Pipeline");

  if (noBenchmark && benchmarkOnly) {
    logger.fail("--no-benchmark and --benchmark-only cannot be used together");
    throw createCliUsageError(
      "--no-benchmark and --benchmark-only cannot be used together",
    );
  }

  // Find workspace root (go up from apps/cli/src/commands to workspace root)
  const workspaceRoot = join(import.meta.dir, "..", "..", "..", "..");

  // Find the Python script
  const scriptPath = join(
    workspaceRoot,
    "packages/training/python/scripts/run_pipeline.py",
  );
  const python = resolvePythonCommand(workspaceRoot);

  // Build command args
  const pythonArgs = [
    scriptPath,
    "--mode",
    benchmarkOnly ? "benchmark" : "full",
    "--agents",
    agents,
    "--ticks",
    ticks,
    "--output",
    output,
  ];

  // Handle archetypes
  if (archetype === "all") {
    pythonArgs.push("--archetypes", ...getAvailableArchetypes());
  } else if (archetype) {
    pythonArgs.push("--archetype", archetype);
  } else if (archetypesArg) {
    pythonArgs.push(
      "--archetypes",
      ...archetypesArg.split(",").map((a) => a.trim()),
    );
  }

  if (noBenchmark) {
    pythonArgs.push("--skip-scambench");
  }

  if (prepareOnly) {
    pythonArgs.push("--prepare-only");
  }
  if (noLocalValidate) {
    pythonArgs.push("--no-local-validate");
  }
  if (trainingBackend) {
    pythonArgs.push("--training-backend", trainingBackend);
  }
  if (trajectorySource) {
    pythonArgs.push("--trajectory-source", trajectorySource);
  }
  if (sourceDir) {
    pythonArgs.push("--source-dir", sourceDir);
  }
  if (hfDataset) {
    pythonArgs.push("--hf-dataset", hfDataset);
  }
  if (hfSplit) {
    pythonArgs.push("--hf-split", hfSplit);
  }
  if (localBackend) {
    pythonArgs.push("--local-backend", localBackend);
  }
  if (localModel) {
    pythonArgs.push("--local-model", localModel);
  }
  if (localSteps) {
    pythonArgs.push("--local-steps", localSteps);
  }
  if (localBatchSize) {
    pythonArgs.push("--local-batch-size", localBatchSize);
  }
  if (localLr) {
    pythonArgs.push("--local-lr", localLr);
  }
  if (tinkerSteps) {
    pythonArgs.push("--tinker-steps", tinkerSteps);
  }
  if (tinkerGroupSize) {
    pythonArgs.push("--tinker-group-size", tinkerGroupSize);
  }
  if (tinkerLr) {
    pythonArgs.push("--tinker-lr", tinkerLr);
  }
  if (tinkerLoraRank) {
    pythonArgs.push("--tinker-lora-rank", tinkerLoraRank);
  }
  if (tinkerWeightSyncInterval) {
    pythonArgs.push("--tinker-weight-sync-interval", tinkerWeightSyncInterval);
  }
  if (lookbackHours) {
    pythonArgs.push("--lookback-hours", lookbackHours);
  }
  if (minActions) {
    pythonArgs.push("--min-actions", minActions);
  }
  if (maxTrajectories) {
    pythonArgs.push("--max-trajectories", maxTrajectories);
  }
  if (skipRl) {
    pythonArgs.push("--skip-rl");
  }
  if (requireRl) {
    pythonArgs.push("--require-rl");
  }
  if (rlSteps) {
    pythonArgs.push("--rl-steps", rlSteps);
  }
  if (rlBatchSize) {
    pythonArgs.push("--rl-batch-size", rlBatchSize);
  }
  if (rlLr) {
    pythonArgs.push("--rl-lr", rlLr);
  }
  if (rewardProfile) {
    pythonArgs.push("--reward-profile", rewardProfile);
  }
  if (skipScamBench) {
    pythonArgs.push("--skip-scambench");
  }
  if (allowMismatchedReuse) {
    pythonArgs.push("--allow-mismatched-reuse");
  }

  console.log();
  console.log("Configuration:");
  console.log(`  Agents: ${agents}`);
  console.log(`  Ticks per agent: ${ticks}`);
  console.log(`  Output: ${output}`);
  console.log(
    `  Mode: ${benchmarkOnly ? "benchmark-only" : noBenchmark ? "full (no benchmark)" : "full"}`,
  );
  console.log(
    `  Allow mismatched reuse: ${allowMismatchedReuse ? "yes" : "no"}`,
  );
  console.log(
    `  Python: ${python.command}${python.prefixArgs.length ? ` ${python.prefixArgs.join(" ")}` : ""}`,
  );
  console.log(`  Training backend: ${trainingBackend || "auto"}`);
  console.log(
    `  Trajectory source: ${trajectorySource || process.env.TRAJECTORY_SOURCE || "db"}`,
  );
  if (hfDataset || process.env.HF_TRAJECTORY_DATASET) {
    console.log(
      `  HF dataset: ${hfDataset || process.env.HF_TRAJECTORY_DATASET}`,
    );
  }
  if (hfSplit || process.env.HF_TRAJECTORY_SPLIT) {
    console.log(`  HF split: ${hfSplit || process.env.HF_TRAJECTORY_SPLIT}`);
  }
  if (lookbackHours) {
    console.log(`  Lookback hours: ${lookbackHours}`);
  }
  if (minActions) {
    console.log(`  Min actions: ${minActions}`);
  }
  if (maxTrajectories) {
    console.log(`  Max trajectories: ${maxTrajectories}`);
  }
  if (localBackend) {
    console.log(`  Local backend: ${localBackend}`);
  }
  if (localModel) {
    console.log(`  Local model: ${localModel}`);
  }
  if (localSteps) {
    console.log(`  Local steps: ${localSteps}`);
  }
  if (tinkerSteps) {
    console.log(`  Tinker steps: ${tinkerSteps}`);
  }
  if (tinkerGroupSize) {
    console.log(`  Tinker group size: ${tinkerGroupSize}`);
  }
  if (tinkerLr) {
    console.log(`  Tinker learning rate: ${tinkerLr}`);
  }
  if (tinkerLoraRank) {
    console.log(`  Tinker LoRA rank: ${tinkerLoraRank}`);
  }
  if (tinkerWeightSyncInterval) {
    console.log(`  Tinker weight sync interval: ${tinkerWeightSyncInterval}`);
  }
  if (skipRl) {
    console.log("  RL stage: skipped");
  } else {
    console.log(`  RL steps: ${rlSteps || "100"}`);
    if (rlBatchSize) {
      console.log(`  RL batch size: ${rlBatchSize}`);
    }
    if (rlLr) {
      console.log(`  RL learning rate: ${rlLr}`);
    }
    if (rewardProfile) {
      console.log(`  Reward profile: ${rewardProfile}`);
    }
    if (requireRl) {
      console.log("  RL required: yes");
    }
  }
  if (skipScamBench || noBenchmark) {
    console.log("  ScamBench: skipped");
  }
  if (archetype) {
    console.log(`  Archetype: ${archetype}`);
  } else if (archetypesArg) {
    console.log(`  Archetypes: ${archetypesArg}`);
  } else {
    console.log(`  Archetype: default (general)`);
  }
  console.log();

  if (dryRun) {
    console.log("[DRY RUN] Would execute:");
    console.log(
      `  ${[python.command, ...python.prefixArgs, ...pythonArgs].join(" ")}`,
    );
    return;
  }

  const effectiveTrainingBackend = (trainingBackend || "auto").toLowerCase();
  const effectiveTrajectorySource = (
    trajectorySource ||
    process.env.TRAJECTORY_SOURCE ||
    "db"
  ).toLowerCase();
  const effectiveHfDataset =
    hfDataset || process.env.HF_TRAJECTORY_DATASET || "";

  if (
    !benchmarkOnly &&
    effectiveTrainingBackend === "tinker" &&
    !process.env.TINKER_API_KEY
  ) {
    logger.fail("TINKER_API_KEY is required when --training-backend=tinker");
    console.log(
      "\nSet TINKER_API_KEY in your shell or .env before running this command.",
    );
    throw createCliUsageError(
      "TINKER_API_KEY is required for feed train pipeline with --training-backend=tinker",
    );
  }

  if (
    !benchmarkOnly &&
    effectiveTrajectorySource === "huggingface" &&
    !effectiveHfDataset
  ) {
    logger.fail(
      "HF_TRAJECTORY_DATASET is required when --trajectory-source=huggingface",
    );
    console.log(
      "\nSet --hf-dataset or HF_TRAJECTORY_DATASET before running this command.",
    );
    throw createCliUsageError(
      "HF_TRAJECTORY_DATASET is required for feed train pipeline with trajectory-source=huggingface",
    );
  }

  if (
    !benchmarkOnly &&
    effectiveTrajectorySource === "local_export" &&
    !sourceDir
  ) {
    logger.fail("source-dir is required when --trajectory-source=local_export");
    console.log(
      "\nSet --source-dir to a local export directory before running this command.",
    );
    throw createCliUsageError(
      "source-dir is required for feed train pipeline with trajectory-source=local_export",
    );
  }

  if (
    !benchmarkOnly &&
    effectiveTrajectorySource !== "huggingface" &&
    effectiveTrajectorySource !== "local_export" &&
    !process.env.DATABASE_URL
  ) {
    logger.fail("DATABASE_URL is required for the training pipeline");
    console.log(
      "\nSet DATABASE_URL in your shell or .env before running this command, or use --trajectory-source=huggingface or --trajectory-source=local_export.",
    );
    throw createCliUsageError(
      "DATABASE_URL is required for feed train pipeline unless trajectory-source=huggingface or trajectory-source=local_export",
    );
  }

  logger.step("Starting Python training pipeline...");
  console.log();

  return new Promise((resolve, reject) => {
    const child = spawn(python.command, [...python.prefixArgs, ...pythonArgs], {
      cwd: workspaceRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
      },
    });

    child.on("error", (error) => {
      if (error.message.includes("ENOENT")) {
        logger.fail(
          "Python not found. Set PYTHON_BIN or install Python 3.10+ for the training pipeline",
        );
        console.log("\nInstall with:");
        console.log("  brew install python@3.11  # macOS");
        console.log("  apt install python3       # Ubuntu");
        console.log("  export PYTHON_BIN=/path/to/python");
      } else {
        logger.fail(`Failed to start: ${error.message}`);
      }
      reject(error);
    });

    child.on("close", (code) => {
      console.log();
      if (code === 0) {
        logger.success("Training pipeline completed!");
        console.log();
        console.log("Next steps:");
        if (benchmarkOnly) {
          console.log(`  1. Review benchmark results in ${output}/`);
          console.log(
            `  2. Check ${output}/pipeline_report.json for stage details`,
          );
        } else {
          console.log(`  1. Check results in ${output}/`);
          console.log(`  2. Review ${output}/pipeline_report.json`);
          console.log("  3. Upload model: feed model upload --model <path>");
          console.log(
            "  4. Run benchmark: feed train pipeline --benchmark-only",
          );
        }
        resolve();
      } else {
        logger.fail(`Pipeline exited with code ${code}`);
        reject(new Error(`Pipeline failed with code ${code}`));
      }
    });
  });
}

/**
 * Main entry point for training domain commands.
 *
 * @param args - Raw command-line arguments for the training domain
 */

async function runOnlineRL(args: ReturnType<typeof parseArgs>): Promise<void> {
  logger.header("Feed Online RL Training");

  const workspaceRoot = join(import.meta.dir, "..", "..", "..", "..");
  const scriptPath = join(
    workspaceRoot,
    "packages/training/python/scripts/run_online_rl.py",
  );

  if (!existsSync(scriptPath)) {
    logger.fail(`Online RL script not found: ${scriptPath}`);
    throw createCliUsageError("Online RL script not found");
  }

  const python = resolvePythonCommand(workspaceRoot);
  const pythonArgs = [...python.prefixArgs, scriptPath];

  // Map CLI args to Python script args
  const mode = getOption(args, "mode", "m") || "single";
  pythonArgs.push("--mode", mode);

  const model = getOption(args, "model", "");
  if (model) pythonArgs.push("--model", model);

  const device = getOption(args, "device", "");
  if (device) pythonArgs.push("--device", device);

  const optimizer = getOption(args, "optimizer", "");
  if (optimizer) pythonArgs.push("--optimizer", optimizer);

  const lr = getOption(args, "lr", "");
  if (lr) pythonArgs.push("--lr", lr);

  if (getFlag(args, "kondo", "")) pythonArgs.push("--kondo");

  const kondoGateRate = getOption(args, "kondo-gate-rate", "");
  if (kondoGateRate) pythonArgs.push("--kondo-gate-rate", kondoGateRate);

  if (getFlag(args, "turboquant", "")) pythonArgs.push("--turboquant");

  const bridgeUrl = getOption(args, "bridge-url", "");
  if (bridgeUrl) pythonArgs.push("--bridge-url", bridgeUrl);

  const maxTicks = getOption(args, "max-ticks", "");
  if (maxTicks) pythonArgs.push("--max-ticks", maxTicks);

  // Multi-agent options
  const numAgents = getOption(args, "num-agents", "");
  if (numAgents) pythonArgs.push("--num-agents", numAgents);

  const archetypes = getOption(args, "archetypes", "");
  if (archetypes) pythonArgs.push("--archetypes", archetypes);

  if (getFlag(args, "pbt", "")) pythonArgs.push("--pbt");

  const pbtInterval = getOption(args, "pbt-interval", "");
  if (pbtInterval) pythonArgs.push("--pbt-interval", pbtInterval);

  const checkpointDir = getOption(args, "checkpoint-dir", "o");
  if (checkpointDir) pythonArgs.push("--checkpoint-dir", checkpointDir);

  // APOLLO options
  const apolloRank = getOption(args, "apollo-rank", "");
  if (apolloRank) pythonArgs.push("--apollo-rank", apolloRank);

  logger.info(`Mode: ${mode}`);
  logger.info(`Running: ${python.command} ${pythonArgs.join(" ")}`);

  return new Promise((resolve, reject) => {
    const proc = spawn(python.command, pythonArgs, {
      stdio: "inherit",
      cwd: workspaceRoot,
    });

    proc.on("close", (code) => {
      if (code === 0) {
        logger.success("Online RL training complete");
        resolve();
      } else {
        reject(new Error(`Online RL training exited with code ${code}`));
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to start online RL: ${err.message}`));
    });
  });
}

export async function runTrainCommand(args: string[]): Promise<void> {
  const parsed = parseArgs(args);

  if (wantsHelp(parsed)) {
    printHelp();
    process.exit(0);
  }

  // Commands that don't need the database
  const noDatabaseCommands = [
    "list",
    "pipeline",
    "run",
    "online",
    "continuous-rl",
  ];
  const needsDatabase = !noDatabaseCommands.includes(parsed.command || "");

  switch (parsed.command) {
    case "list":
      await listArchetypes(parsed);
      break;

    case "pipeline":
    case "run":
      await runPipeline(parsed);
      break;

    case "archetype":
      await trainArchetype(parsed);
      break;

    case "collect":
      await collectTrajectories(parsed);
      break;

    case "score":
      await scoreTrajectories();
      break;

    case "generate":
      await generateTrajectories(parsed);
      break;

    case "parallel":
      await configureAgentTrainingDependencies();
      await (await getParallelGenerationCommand()).runParallelGeneration(
        parsed,
      );
      break;

    case "online":
    case "continuous-rl":
      await runOnlineRL(parsed);
      break;

    default:
      if (parsed.command) {
        logger.fail(`Unknown command: ${parsed.command}`);
      }
      printHelp();
      process.exit(parsed.command ? 1 : 0);
  }

  if (needsDatabase) {
    const { closeDatabase } = await getDbImports();
    await closeDatabase();
  }
  // Always exit cleanly
  process.exit(0);
}
