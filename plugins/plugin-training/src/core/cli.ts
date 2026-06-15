/**
 * CLI entry point for the training data pipeline.
 *
 * Usage (from repo root):
 *   bun run eliza/plugins/plugin-training/src/core/cli.ts generate --variants 5 --output ./training-data
 *   bun run eliza/plugins/plugin-training/src/core/cli.ts validate --input ./training-data/raw_samples.json
 *   bun run eliza/plugins/plugin-training/src/core/cli.ts export-trajectories --output ./training-data/trajectories.jsonl
 * Or: `cd eliza/packages/agent && bun run training:cli` (delegates to this file).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { AGENT_CONTEXTS, type AgentContext } from "./context-types.js";
import {
  createAnthropicTeacher,
  createCerebrasTeacher,
  createOpenAITeacher,
  exportToElizaNativeJSONL,
  type GenerationConfig,
  generateDataset,
  type TeacherModel,
  type TrainingSample,
} from "./dataset-generator.js";
import {
  ELIZA_ONE_BENCHMARK_TIER_LIST,
  elizaOneActionBenchmarkPairs,
  elizaOneBenchmarkModelId,
  parseElizaOneBenchmarkTiers,
} from "./eliza1-benchmark-recipe.js";
import {
  type CompareMode,
  comparePrompts,
  formatComparisonSummary,
  type ScorerKind,
} from "./prompt-compare.js";
import { formatQualityReport, validateDataset } from "./replay-validator.js";
import {
  buildRoleplayEpisodes,
  exportRoleplayEpisodes,
} from "./roleplay-trajectories.js";
import { ALL_BLUEPRINTS, BLUEPRINT_STATS } from "./scenario-blueprints.js";
import {
  buildTrainingCollectionPreflightWithProbes,
  type ListTrainingCollectionsResult,
  listTrainingCollections,
  runTrainingCollection,
  type TrainingCollectionPreflightSummary,
  type TrainingCollectionRunOptions,
  type TrainingCollectionRunResult,
} from "./training-collection-runner.js";
import type { TrajectoryTrainingTask } from "./trajectory-task-datasets.js";
import { discoverWorkspaceRoot } from "./workspace-runtime.js";

const AGENT_DECISIONS = ["RESPOND", "IGNORE", "STOP"] as const;
type AgentDecision = (typeof AGENT_DECISIONS)[number];

function parseAgentContexts(
  value: string | undefined,
): AgentContext[] | undefined {
  if (!value) return undefined;
  const out: AgentContext[] = [];
  for (const entry of value.split(",")) {
    const trimmed = entry.trim();
    if (trimmed && (AGENT_CONTEXTS as readonly string[]).includes(trimmed)) {
      out.push(trimmed as AgentContext);
    }
  }
  return out.length > 0 ? out : undefined;
}

function parseAgentDecisions(
  value: string | undefined,
): AgentDecision[] | undefined {
  if (!value) return undefined;
  const out: AgentDecision[] = [];
  for (const entry of value.split(",")) {
    const trimmed = entry.trim();
    if (trimmed && (AGENT_DECISIONS as readonly string[]).includes(trimmed)) {
      out.push(trimmed as AgentDecision);
    }
  }
  return out.length > 0 ? out : undefined;
}

function parseCliTierList(value: string | undefined): string[] {
  return parseElizaOneBenchmarkTiers(value);
}

function optionalPositiveInteger(
  value: string | undefined,
): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseCerebrasVariants(
  value: string | undefined,
): "trained" | "base" | "both" {
  if (value === "trained" || value === "base" || value === "both") {
    return value;
  }
  if (value) {
    throw new Error(
      `Invalid --cerebras-variants value ${JSON.stringify(value)}; expected trained, base, or both`,
    );
  }
  return "both";
}

function parseActionBenchmarkVariant(
  value: string | undefined,
): "reference" | "base" | "trained" | undefined {
  if (value === undefined) return undefined;
  if (value === "reference" || value === "base" || value === "trained") {
    return value;
  }
  throw new Error(
    `Invalid --benchmark-variant value ${JSON.stringify(value)}; expected reference, base, or trained`,
  );
}

function parseBenchmarkVsCerebrasBenchmark(
  value: string,
): "eliza_harness_action_selection" | "clawbench" | "hermes" | "all" {
  if (
    value === "eliza_harness_action_selection" ||
    value === "clawbench" ||
    value === "hermes" ||
    value === "all"
  ) {
    return value;
  }
  throw new Error(
    `Invalid --benchmark value ${JSON.stringify(value)}; expected eliza_harness_action_selection, clawbench, hermes, or all`,
  );
}

function getTeacherModel(): TeacherModel {
  // Standing direction: training defaults to Cerebras gpt-oss-120b. The
  // teacher generates synthetic conversations; the agent under test is
  // unaffected.
  const trainProvider =
    process.env.TRAIN_MODEL_PROVIDER?.trim() ??
    process.env.TRAINING_PROVIDER?.trim();
  const cerebrasKey = process.env.CEREBRAS_API_KEY;
  if (trainProvider === "cerebras" && cerebrasKey) {
    console.log("Using Cerebras gpt-oss-120b as teacher model");
    return createCerebrasTeacher();
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (anthropicKey) {
    console.log("Using Anthropic Claude Sonnet 4 as teacher model");
    return createAnthropicTeacher(anthropicKey);
  }

  if (openaiKey) {
    console.log("Using OpenAI GPT-5 as teacher model");
    return createOpenAITeacher(openaiKey);
  }

  throw new Error(
    "No teacher model API key found. Set CEREBRAS_API_KEY (preferred), ANTHROPIC_API_KEY, or OPENAI_API_KEY.",
  );
}

async function cmdGenerate(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      variants: { type: "string", default: "5" },
      output: { type: "string", default: "./training-data" },
      concurrency: { type: "string", default: "5" },
      contexts: { type: "string" },
      decisions: { type: "string" },
      limitBlueprints: { type: "string" },
    },
  });

  const variantsRaw = values.variants;
  const outputDir = values.output;
  const concurrencyRaw = values.concurrency;
  if (
    typeof variantsRaw !== "string" ||
    typeof outputDir !== "string" ||
    typeof concurrencyRaw !== "string"
  ) {
    throw new Error("Missing required generate options");
  }

  const variantsPerBlueprint = parseInt(variantsRaw, 10);
  const concurrency = parseInt(concurrencyRaw, 10);

  const filterContexts = parseAgentContexts(values.contexts);
  const filterDecisions = parseAgentDecisions(values.decisions);
  const limitBlueprints = values.limitBlueprints
    ? parseInt(values.limitBlueprints, 10)
    : undefined;

  const teacher = getTeacherModel();

  const blueprintCount = limitBlueprints
    ? Math.min(limitBlueprints, ALL_BLUEPRINTS.length)
    : ALL_BLUEPRINTS.length;

  console.log(`\nScenario blueprints: ${ALL_BLUEPRINTS.length}`);
  console.log(`Manual blueprints: ${BLUEPRINT_STATS.manualCount}`);
  console.log(
    `Generated blueprints: ${BLUEPRINT_STATS.totalCount - BLUEPRINT_STATS.manualCount}`,
  );
  console.log(`Variants per blueprint: ${variantsPerBlueprint}`);
  console.log(
    `Expected total samples: ${blueprintCount * variantsPerBlueprint}`,
  );
  console.log(`Output directory: ${outputDir}`);
  console.log(`Teacher model: ${teacher.name}`);
  console.log(`Concurrency: ${concurrency}`);
  if (filterContexts)
    console.log(`Filter contexts: ${filterContexts.join(", ")}`);
  if (filterDecisions)
    console.log(`Filter decisions: ${filterDecisions.join(", ")}`);
  if (limitBlueprints) console.log(`Limit blueprints: ${limitBlueprints}`);
  console.log("");

  const config: GenerationConfig = {
    variantsPerBlueprint,
    teacher,
    outputDir,
    concurrency,
    filterContexts,
    filterDecisions,
    limitBlueprints,
    onProgress: (completed, total, sample) => {
      const pct = ((completed / total) * 100).toFixed(1);
      process.stdout.write(
        `\r[${pct}%] ${completed}/${total} - ${sample.blueprintId} (${sample.expectedOutput.decision}/${sample.expectedOutput.primaryContext})`,
      );
    },
  };

  console.log("Generating synthetic training data...\n");
  const samples = await generateDataset(config);
  console.log(`\n\nGenerated ${samples.length} samples.`);

  // Validate
  console.log("\nValidating dataset...");
  const report = validateDataset(samples);
  console.log(formatQualityReport(report));

  // Export
  console.log("\nExporting to eliza_native_v1 JSONL format...");
  const paths = await exportToElizaNativeJSONL(samples, outputDir);
  console.log(`  Combined: ${paths.combinedPath}`);
  console.log(`  Should-respond only: ${paths.shouldRespondPath}`);
  console.log(`  Context routing: ${paths.contextRoutingPath}`);
  const roleplayPaths = await exportRoleplayEpisodes(
    buildRoleplayEpisodes(samples),
    samples,
    outputDir,
  );
  console.log(`  Roleplay episodes: ${roleplayPaths.episodesPath}`);
  console.log(`  Roleplay manifest: ${roleplayPaths.manifestPath}`);
  console.log("\nDone!");
}

async function cmdCompare(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      baseline: { type: "string" },
      variant: { type: "string" },
      dataset: { type: "string" },
      task: { type: "string" },
      scorer: { type: "string" },
      mode: { type: "string" },
      "max-examples": { type: "string" },
      tolerance: { type: "string" },
      output: { type: "string", short: "o" },
      temperature: { type: "string" },
      "max-tokens": { type: "string" },
    },
  });

  if (!values.baseline || !values.variant || !values.dataset) {
    console.error(
      "Usage: compare --baseline <prompt.txt> --variant <prompt.txt> --dataset <dataset.jsonl> [options]",
    );
    console.error("");
    console.error("Options:");
    console.error(
      "  --task <task>          One of: should_respond, context_routing, action_planner, response, media_description",
    );
    console.error(
      "  --scorer <kind>        agreement | planner_action (default: derived from --task)",
    );
    console.error(
      "  --mode <mode>          vs_historical (default) | pairwise",
    );
    console.error("  --max-examples N       Cap evaluations (default: all)");
    console.error(
      "  --tolerance N          Pass threshold delta (default: 0.02)",
    );
    console.error("  --temperature N        Sampling temperature (default: 0)");
    console.error("  --max-tokens N         Per-completion cap (default: 512)");
    console.error("  -o, --output <path>    Write JSON result to file");
    console.error("");
    console.error(
      "Requires ANTHROPIC_API_KEY or OPENAI_API_KEY for the model adapter.",
    );
    process.exit(1);
  }

  const [baselinePrompt, variantPrompt] = await Promise.all([
    readFile(values.baseline, "utf-8"),
    readFile(values.variant, "utf-8"),
  ]);

  const teacher = getTeacherModel();
  const adapter = {
    async complete(input: {
      system?: string;
      user: string;
      temperature?: number;
      maxTokens?: number;
    }): Promise<string> {
      // Teacher model fixes its own temperature/max_tokens, but the
      // scorer asks for 0/512 by default. Re-using the teacher here
      // keeps adapter wiring trivial; if you need stricter
      // determinism, plug a different adapter via the API.
      return await teacher.generate(input.system ?? "", input.user);
    },
  };

  const task = values.task as TrajectoryTrainingTask | undefined;
  const scorer = values.scorer as ScorerKind | undefined;
  const mode = values.mode as CompareMode | undefined;
  const maxExamples = values["max-examples"]
    ? Number.parseInt(values["max-examples"], 10)
    : undefined;
  const temperature = values.temperature
    ? Number.parseFloat(values.temperature)
    : undefined;
  const maxTokens = values["max-tokens"]
    ? Number.parseInt(values["max-tokens"], 10)
    : undefined;

  console.log(
    `[compare] baseline=${values.baseline} variant=${values.variant}`,
  );
  console.log(
    `[compare] dataset=${values.dataset} task=${task ?? "(any)"} mode=${mode ?? "vs_historical"}`,
  );
  console.log(`[compare] adapter=${teacher.name}`);

  const result = await comparePrompts({
    baselinePrompt,
    variantPrompt,
    dataset: values.dataset,
    task,
    scorer,
    mode,
    maxExamples,
    temperature,
    maxTokens,
    adapter,
  });

  console.log("");
  console.log(formatComparisonSummary(result));

  if (values.output) {
    await writeFile(values.output, JSON.stringify(result, null, 2));
    console.log(`[compare] wrote result to ${values.output}`);
  }

  if (!result.passed) {
    process.exit(2);
  }
}

interface RecordedMessage {
  role: string;
  content: string | unknown;
}

interface RecordedStage {
  stageId?: string;
  kind?: string;
  startedAt?: number;
  endedAt?: number;
  model?: {
    modelType?: string;
    modelName?: string;
    provider?: string;
    messages?: RecordedMessage[];
    response?: string | unknown;
    toolCalls?: unknown[];
  };
}

interface RecordedTrajectory {
  trajectoryId: string;
  agentId: string;
  rootMessage?: { text?: string };
  startedAt?: number;
  status?: string;
  stages?: RecordedStage[];
}

/**
 * Map RecordedStage.kind / model.modelType to a TrajectoryTrainingTask bucket.
 * Returns null if the stage doesn't fit a known eval task.
 */
function classifyStage(stage: RecordedStage): TrajectoryTrainingTask | null {
  const kind = stage.kind?.toLowerCase() ?? "";
  const modelType = stage.model?.modelType?.toLowerCase() ?? "";
  if (kind === "messagehandler" || modelType.includes("response_handler")) {
    return "should_respond";
  }
  if (kind === "planner" || modelType.includes("planner")) {
    return "action_planner";
  }
  if (kind === "tool" || kind === "action") {
    return "response";
  }
  if (modelType.includes("vision") || modelType.includes("image")) {
    return "media_description";
  }
  return null;
}

function stringifyContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
}

function stageToJsonlRow(stage: RecordedStage): Record<string, unknown> | null {
  const messages = stage.model?.messages ?? [];
  const response = stage.model?.response;
  if (messages.length === 0) return null;
  if (!response && !stage.model?.toolCalls) return null;
  const normalizedMessages = messages.map((m) => ({
    role: m.role,
    content: stringifyContent(m.content),
  }));
  const systemMsg = normalizedMessages.find((m) => m.role === "system");
  const responseText = stringifyContent(response);
  const toolCalls = stage.model?.toolCalls;
  return {
    format: "eliza_native_v1",
    boundary: "vercel_ai_sdk.generateText",
    request: {
      system: systemMsg?.content ?? "",
      messages: normalizedMessages,
    },
    response: toolCalls
      ? { text: responseText, toolCalls }
      : { text: responseText },
  };
}

async function cmdExportTrajectories(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      input: { type: "string", short: "i" },
      output: { type: "string", short: "o" },
      "max-per-task": { type: "string" },
    },
  });
  const inputDir =
    values.input ??
    process.env.ELIZA_TRAJECTORY_DIR ??
    join(
      process.env.ELIZA_STATE_DIR ?? join(homedir(), ".eliza"),
      "trajectories",
    );
  const outputDir = values.output ?? "./training-data";
  const cap = values["max-per-task"]
    ? Number.parseInt(values["max-per-task"], 10)
    : Number.POSITIVE_INFINITY;

  if (!existsSync(inputDir)) {
    console.error(`[export-trajectories] input dir not found: ${inputDir}`);
    process.exit(1);
  }

  await mkdir(outputDir, { recursive: true });
  console.log(`[export-trajectories] reading from ${inputDir}`);
  console.log(`[export-trajectories] writing to ${outputDir}`);

  const buckets: Record<TrajectoryTrainingTask, Record<string, unknown>[]> = {
    should_respond: [],
    context_routing: [],
    action_planner: [],
    response: [],
    media_description: [],
  };

  const agentDirs = readdirSync(inputDir).filter((name) => {
    const full = join(inputDir, name);
    return statSync(full).isDirectory();
  });

  let totalTrajectories = 0;
  let totalStages = 0;
  let droppedStages = 0;
  for (const agentDir of agentDirs) {
    const agentPath = join(inputDir, agentDir);
    const files = readdirSync(agentPath).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      let traj: RecordedTrajectory;
      try {
        traj = JSON.parse(
          readFileSync(join(agentPath, file), "utf-8"),
        ) as RecordedTrajectory;
      } catch {
        continue;
      }
      totalTrajectories += 1;
      for (const stage of traj.stages ?? []) {
        totalStages += 1;
        const task = classifyStage(stage);
        if (!task) {
          droppedStages += 1;
          continue;
        }
        if (buckets[task].length >= cap) continue;
        const row = stageToJsonlRow(stage);
        if (!row) {
          droppedStages += 1;
          continue;
        }
        buckets[task].push(row);
      }
    }
  }

  for (const task of Object.keys(buckets) as TrajectoryTrainingTask[]) {
    const path = join(outputDir, `${task}_trajectories.jsonl`);
    const lines = buckets[task].map((row) => JSON.stringify(row));
    await writeFile(path, `${lines.join("\n")}\n`);
    console.log(
      `[export-trajectories] ${task}: wrote ${buckets[task].length} examples to ${path}`,
    );
  }
  console.log(
    `[export-trajectories] summary: ${totalTrajectories} trajectories, ${totalStages} stages (${droppedStages} unclassified)`,
  );
}

export function buildRunCollectionOptionsFromCliArgs(
  args: string[],
): TrainingCollectionRunOptions {
  const { values } = parseArgs({
    args,
    options: {
      output: { type: "string", short: "o" },
      "workspace-root": { type: "string" },
      tiers: { type: "string", default: "0_8b" },
      benchmark: { type: "string", default: "eliza_harness_action_selection" },
      provider: { type: "string", default: "local-llama-cpp" },
      "base-url": { type: "string", default: "http://localhost:11434/v1" },
      "runs-per-case": { type: "string", default: "1" },
      "benchmark-filter": { type: "string" },
      "benchmark-model": { type: "string" },
      "benchmark-runtime-model": { type: "string" },
      "benchmark-variant": { type: "string" },
      "dataset-version": { type: "string", default: "eliza-native-v1" },
      "hf-repo": { type: "string", default: "elizaos/eliza-1-training" },
      "hf-revision": { type: "string", default: "main" },
      "hf-files": { type: "string" },
      "feed-archetypes": { type: "string", default: "trader" },
      "feed-agents": { type: "string", default: "1" },
      "feed-ticks": { type: "string", default: "1" },
      "feed-parallel": { type: "string", default: "1" },
      "cerebras-max-samples": { type: "string", default: "50" },
      "cerebras-variants": { type: "string", default: "both" },
      scenario: { type: "string", default: "deterministic-pr-smoke" },
      "natural-sanitized-jsonl": { type: "string" },
      "natural-raw-jsonl": { type: "string" },
      "natural-run-id": { type: "string" },
      "natural-tasks": { type: "string" },
      "include-natural-raw": { type: "boolean", default: false },
      live: { type: "boolean", default: false },
      "preflight-only": { type: "boolean", default: false },
      "probe-endpoints": { type: "boolean", default: false },
      "skip-hf": { type: "boolean", default: false },
      "skip-feed": { type: "boolean", default: false },
      "skip-natural": { type: "boolean", default: false },
      "skip-tests": { type: "boolean", default: false },
      "skip-scenarios": { type: "boolean", default: false },
      "skip-action-benchmark": { type: "boolean", default: false },
      "skip-cerebras": { type: "boolean", default: false },
      "skip-model-registry": { type: "boolean", default: false },
      "skip-bundle-stage": { type: "boolean", default: false },
      "include-eval-comparison": { type: "boolean", default: false },
      "skip-eval-comparison": { type: "boolean", default: false },
      "include-matrix": { type: "boolean", default: true },
      "skip-matrix": { type: "boolean", default: false },
      mocks: { type: "boolean" },
    },
  });
  const tiers = parseCliTierList(
    typeof values.tiers === "string" ? values.tiers : undefined,
  );
  const live = values.live === true;
  const dryRun = !live;
  const benchmark = parseBenchmarkVsCerebrasBenchmark(
    typeof values.benchmark === "string"
      ? values.benchmark
      : "eliza_harness_action_selection",
  );
  const provider =
    typeof values.provider === "string" ? values.provider : "local-llama-cpp";
  const baseUrl =
    typeof values["base-url"] === "string"
      ? values["base-url"]
      : "http://localhost:11434/v1";
  const datasetVersion =
    typeof values["dataset-version"] === "string"
      ? values["dataset-version"]
      : "eliza-native-v1";
  const actionBenchmark = {
    useMocks: typeof values.mocks === "boolean" ? values.mocks : dryRun,
    forceTrajectoryCapture: true,
    provider,
    baseUrl,
    benchmark,
    datasetVersion,
    modelId:
      typeof values["benchmark-model"] === "string"
        ? values["benchmark-model"]
        : undefined,
    runtimeModel:
      typeof values["benchmark-runtime-model"] === "string"
        ? values["benchmark-runtime-model"]
        : typeof values["benchmark-model"] === "string"
          ? values["benchmark-model"]
          : undefined,
    variant: parseActionBenchmarkVariant(
      typeof values["benchmark-variant"] === "string"
        ? values["benchmark-variant"]
        : undefined,
    ),
    filter:
      typeof values["benchmark-filter"] === "string"
        ? values["benchmark-filter"]
        : undefined,
    runsPerCase: optionalPositiveInteger(
      typeof values["runs-per-case"] === "string"
        ? values["runs-per-case"]
        : undefined,
    ),
    dryRun,
  };

  return {
    preflightOnly: values["preflight-only"] === true,
    preflightProbe: values["probe-endpoints"] === true,
    outputDir: typeof values.output === "string" ? values.output : undefined,
    workspaceRoot:
      typeof values["workspace-root"] === "string"
        ? values["workspace-root"]
        : discoverWorkspaceRoot(),
    includeHuggingFace: values["skip-hf"] !== true,
    includeFeed: values["skip-feed"] !== true,
    includeNaturalTrajectories: values["skip-natural"] !== true,
    includeTestTrajectories: values["skip-tests"] !== true,
    includeScenarios: values["skip-scenarios"] !== true,
    includeEvalComparison:
      values["skip-eval-comparison"] !== true &&
      (dryRun || values["include-eval-comparison"] === true),
    includeActionBenchmark: values["skip-action-benchmark"] !== true,
    includeBenchmarkVsCerebras: values["skip-cerebras"] !== true,
    includeEliza1ModelRegistry: values["skip-model-registry"] !== true,
    includeEliza1BundleStage: values["skip-bundle-stage"] !== true,
    includeBenchmarkMatrix: values["skip-matrix"] !== true,
    naturalTrajectories: {
      sanitizedJsonlPath:
        typeof values["natural-sanitized-jsonl"] === "string"
          ? values["natural-sanitized-jsonl"]
          : undefined,
      rawJsonlPath:
        typeof values["natural-raw-jsonl"] === "string"
          ? values["natural-raw-jsonl"]
          : undefined,
      includeRawJsonl:
        values["include-natural-raw"] === true ||
        typeof values["natural-raw-jsonl"] === "string",
      tasks:
        typeof values["natural-tasks"] === "string"
          ? (values["natural-tasks"]
              .split(",")
              .map((task) => task.trim())
              .filter(Boolean) as TrajectoryTrainingTask[])
          : undefined,
      source: {
        kind: "training_collection_natural_trajectories",
        runId:
          typeof values["natural-run-id"] === "string"
            ? values["natural-run-id"]
            : undefined,
        metadata: {
          cli: true,
          sanitizedJsonlPath:
            typeof values["natural-sanitized-jsonl"] === "string"
              ? values["natural-sanitized-jsonl"]
              : undefined,
          rawJsonlPath:
            typeof values["natural-raw-jsonl"] === "string"
              ? values["natural-raw-jsonl"]
              : undefined,
        },
      },
    },
    huggingFace: {
      repoId:
        typeof values["hf-repo"] === "string"
          ? values["hf-repo"]
          : "elizaos/eliza-1-training",
      revision:
        typeof values["hf-revision"] === "string"
          ? values["hf-revision"]
          : "main",
      files:
        typeof values["hf-files"] === "string"
          ? values["hf-files"]
              .split(",")
              .map((file) => file.trim())
              .filter(Boolean)
          : undefined,
      dryRun,
    },
    feed: {
      archetypes:
        typeof values["feed-archetypes"] === "string"
          ? values["feed-archetypes"]
          : "trader",
      numAgents: optionalPositiveInteger(
        typeof values["feed-agents"] === "string"
          ? values["feed-agents"]
          : undefined,
      ),
      ticks: optionalPositiveInteger(
        typeof values["feed-ticks"] === "string"
          ? values["feed-ticks"]
          : undefined,
      ),
      parallel: optionalPositiveInteger(
        typeof values["feed-parallel"] === "string"
          ? values["feed-parallel"]
          : undefined,
      ),
      cleanup: true,
      dryRun,
    },
    scenarios: {
      scenario:
        typeof values.scenario === "string" ? values.scenario : undefined,
      exportNative: true,
      useDeterministicProxy: true,
      dryRun,
    },
    evalComparison: {
      model: elizaOneBenchmarkModelId(tiers[0] ?? "0_8b", "base"),
      trainedModelPath: elizaOneBenchmarkModelId(tiers[0] ?? "0_8b", "trained"),
      backend: "cpu",
      dryRun,
    },
    actionBenchmark,
    actionBenchmarkPair:
      tiers.length === 1 &&
      actionBenchmark.modelId === undefined &&
      actionBenchmark.runtimeModel === undefined &&
      actionBenchmark.variant === undefined
        ? {
            tier: tiers[0],
            base: {
              variant: "base",
              modelId: elizaOneBenchmarkModelId(tiers[0], "base"),
              runtimeModel: elizaOneBenchmarkModelId(tiers[0], "base"),
            },
            trained: {
              variant: "trained",
              modelId: elizaOneBenchmarkModelId(tiers[0], "trained"),
              runtimeModel: elizaOneBenchmarkModelId(tiers[0], "trained"),
            },
          }
        : undefined,
    actionBenchmarkPairs:
      tiers.length > 1 &&
      actionBenchmark.modelId === undefined &&
      actionBenchmark.runtimeModel === undefined &&
      actionBenchmark.variant === undefined
        ? elizaOneActionBenchmarkPairs(tiers)
        : undefined,
    benchmarkVsCerebras: {
      tiers: tiers.join(","),
      benchmark,
      variants: parseCerebrasVariants(
        typeof values["cerebras-variants"] === "string"
          ? values["cerebras-variants"]
          : undefined,
      ),
      maxSamples:
        optionalPositiveInteger(
          typeof values["cerebras-max-samples"] === "string"
            ? values["cerebras-max-samples"]
            : undefined,
        ) ?? 50,
      dryRun,
    },
    eliza1BundleStage: {
      repoId: "elizaos/eliza-1",
      tier: tiers[0] ?? "0_8b",
      localDir: "/tmp/eliza-1-bundles",
      maxBytes: 8589934592,
      apply: false,
    },
  };
}

export function formatTrainingCollectionPreflightSummary(
  preflight: TrainingCollectionPreflightSummary,
): string[] {
  const counts = preflight.checks.reduce<Record<string, number>>(
    (acc, check) => {
      acc[check.status] = (acc[check.status] ?? 0) + 1;
      return acc;
    },
    {},
  );
  return [
    `[run-collection:preflight] live=${preflight.liveRequired ? "yes" : "no"} ok=${counts.ok ?? 0} warning=${counts.warning ?? 0} missing=${counts.missing ?? 0} skipped=${counts.skipped ?? 0}`,
    ...preflight.checks.map(
      (check) =>
        `[run-collection:preflight] ${check.id}=${check.status} ${check.detail}${check.path ? ` path=${check.path}` : ""}`,
    ),
  ];
}

async function cmdRunCollection(args: string[]) {
  const options = buildRunCollectionOptionsFromCliArgs(args);
  if (options.preflightOnly) {
    const preflight = await buildTrainingCollectionPreflightWithProbes({
      options,
      workspaceRoot: options.workspaceRoot,
      trainingRoot: options.workspaceRoot
        ? join(options.workspaceRoot, "packages", "training")
        : undefined,
    });
    for (const line of formatTrainingCollectionPreflightSummary(preflight)) {
      console.log(line);
    }
    return;
  }
  const result = await runTrainingCollection(options);
  for (const line of formatRunCollectionSummary(result)) {
    console.log(line);
  }
}

async function cmdListCollections(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      root: { type: "string" },
      limit: { type: "string", short: "n", default: "20" },
    },
  });
  const result = await listTrainingCollections({
    root: values.root,
    limit: optionalPositiveInteger(values.limit),
  });
  for (const line of formatListTrainingCollectionsSummary(result)) {
    console.log(line);
  }
}

export function formatListTrainingCollectionsSummary(
  result: ListTrainingCollectionsResult,
): string[] {
  const lines = [
    `[list-collections] root=${result.root}`,
    `[list-collections] count=${result.collections.length}`,
  ];
  for (const collection of result.collections) {
    const firstEvalComparison = collection.evals.comparisonInventory[0];
    const firstModel =
      collection.training.modelInventory.find(
        (model) => model.model || model.variant,
      ) ?? collection.training.modelInventory[0];
    const sourceSamples = collection.sourceSamples ?? {
      huggingFace: [],
      feed: [],
      natural: [],
      scenarios: [],
      tests: [],
      trainingJsonl: [],
    };
    const sourceSampleEntries = Object.entries(sourceSamples) as Array<
      [
        string,
        Array<{
          trajectoryId?: string | null;
          scenarioId?: string | null;
          title?: string;
          task?: string | null;
        }>,
      ]
    >;
    const sampleCounts = sourceSampleEntries
      .map(([source, samples]) => `${source}:${samples.length}`)
      .join(",");
    const sampleExamples = sourceSampleEntries
      .flatMap(([source, samples]) =>
        samples.slice(0, 1).map((sample) => {
          const id =
            sample.trajectoryId ??
            sample.scenarioId ??
            sample.title ??
            "sample";
          const task = sample.task ? `:${sample.task}` : "";
          return `${source}:${id}${task}`;
        }),
      )
      .slice(0, 4)
      .join(",");
    const evalSummary = [
      `artifacts:${collection.evals.evalArtifacts}`,
      `comparisons:${collection.evals.evalComparisons}`,
      `action:${collection.evals.actionBenchmarks}`,
      `matrices:${collection.evals.benchmarkMatrices}`,
      firstEvalComparison
        ? `first:${firstEvalComparison.baseModel ?? "base"}->${
            firstEvalComparison.trainedModel ?? "trained"
          },improvement:${firstEvalComparison.improvementPercent ?? "n/a"}%`
        : null,
    ]
      .filter(Boolean)
      .join(",");
    const modelSummary = [
      `runs:${collection.training.trainingRuns}`,
      `models:${collection.training.models}`,
      `inventory:${collection.training.modelInventory.length}`,
      firstModel
        ? `first:${firstModel.tier ?? "tier"}/${firstModel.variant ?? "variant"}/${
            firstModel.model ?? "model"
          },improvement:${firstModel.evalImprovementPercent ?? "n/a"}%`
        : null,
    ]
      .filter(Boolean)
      .join(",");
    const gapSummary =
      collection.readinessGaps.length > 0
        ? collection.readinessGaps
            .slice(0, 4)
            .map(
              (gap) =>
                `${gap.id}:${gap.status}${gap.recommendedCapability ? `->${gap.recommendedCapability}` : ""}${formatRecommendedParamsSuffix(gap.recommendedParams)}`,
            )
            .join(",")
        : "none";
    lines.push(
      [
        `[list-collections] run=${collection.generatedAt}`,
        `readiness=${collection.readinessStatus}`,
        `ready=${collection.readiness.ready}`,
        `partial=${collection.readiness.partial}`,
        `missing=${collection.readiness.missing}`,
        `artifacts=${collection.artifactCount}`,
        `sources=hf:${collection.dataSources.huggingFaceDatasets},feed:${collection.dataSources.feedDatasets},natural:${collection.dataSources.naturalTrajectoryBundles},scenarios:${collection.dataSources.scenarioRuns},native:${collection.dataSources.scenarioNativeDatasets},tests:${collection.dataSources.testTrajectories},jsonl:${collection.dataSources.trainingJsonlDatasets}`,
        `benchmarks=pairs:${collection.benchmarks.actionBenchmarkPairs},comparisons:${collection.benchmarks.benchmarkComparisons},cases:${collection.benchmarks.caseSamples},tiers:${collection.benchmarks.tiers.join(",") || "none"}`,
        `baseline=established:${collection.benchmarks.baselineProgress.establishedTiers.join(",") || "none"},next:${collection.benchmarks.baselineProgress.nextTier ?? "none"},remaining:${collection.benchmarks.baselineProgress.remainingTiers.join(",") || "none"}`,
        `evals=${evalSummary}`,
        `models=${modelSummary}`,
        `samples=${sampleCounts}${sampleExamples ? `,examples:${sampleExamples}` : ""}`,
        `artifact-links=source:${collection.sourceArtifacts.length},evidence:${collection.evidenceArtifacts.length}`,
        `gaps=${gapSummary}`,
        `output=${collection.outputDir}`,
        `readme=${collection.readmePath}`,
        `viewer=${collection.analysisIndexHtmlPath}`,
      ].join(" "),
    );
  }
  return lines;
}

function formatRecommendedParamsSuffix(
  params: Record<string, unknown> | null | undefined,
): string {
  if (!params || Object.keys(params).length === 0) return "";
  return ` params=${JSON.stringify(params)}`;
}

function compactStepError(error: string | null | undefined): string {
  const normalized = (error ?? "failed").replace(/\s+/g, " ").trim();
  const priorityPatterns = [
    /Database not initialized\.[^.]*\./,
    /DATABASE_URL is required[^.]*\./,
    /CEREBRAS_API_KEY is required[^.]*\./,
  ];
  for (const pattern of priorityPatterns) {
    const match = normalized.match(pattern);
    if (match?.[0]) return match[0].slice(0, 220);
  }
  return normalized.slice(0, 220);
}

export function formatRunCollectionSummary(
  result: TrainingCollectionRunResult,
): string[] {
  const evidence = result.manifest.evidence;
  const readiness = evidence.benchmarkReadiness;
  const preflight = evidence.preflight ?? { liveRequired: false, checks: [] };
  const preflightCounts = preflight.checks.reduce<Record<string, number>>(
    (acc, check) => {
      acc[check.status] = (acc[check.status] ?? 0) + 1;
      return acc;
    },
    {},
  );
  const priorityGapIds = [
    "feed_generation",
    "natural_trajectories",
    "test_trajectories",
    "smallest_model_benchmark",
    "all_eliza1_tiers_benchmark",
    "cerebras_reference",
    "base_trained_improvement",
    "all_eliza1_tier_improvements",
    "agentic_benchmarks",
    "benchmark_matrix",
    "benchmark_case_provenance",
    "eval_comparison",
    "model_tracking",
    "readable_source_samples",
  ];
  const readinessStatusFor = (id: string): "ready" | "partial" | "missing" =>
    evidence.readinessGaps.find((gap) => gap.id === id)?.status ?? "ready";
  const comparisonInventory = evidence.benchmarks.comparisonInventory ?? [];
  const dryRunComparisons = comparisonInventory.filter(
    (comparison) => comparison.dryRun === true,
  ).length;
  const liveComparisons = Math.max(
    0,
    comparisonInventory.length - dryRunComparisons,
  );
  const gaps = [...evidence.readinessGaps]
    .sort((left, right) => {
      const leftIndex = priorityGapIds.indexOf(left.id);
      const rightIndex = priorityGapIds.indexOf(right.id);
      const leftPriority = leftIndex >= 0 ? 0 : 1;
      const rightPriority = rightIndex >= 0 ? 0 : 1;
      if (leftPriority !== rightPriority) return leftPriority - rightPriority;
      if (leftIndex >= 0 && rightIndex >= 0 && leftIndex !== rightIndex) {
        return leftIndex - rightIndex;
      }
      return left.id.localeCompare(right.id);
    })
    .slice(0, 5);
  const sourceSamples = evidence.sourceSamples ?? {
    huggingFace: [],
    feed: [],
    natural: [],
    scenarios: [],
    tests: [],
    trainingJsonl: [],
  };
  const sourceSampleEntries = Object.entries(sourceSamples) as Array<
    [
      string,
      Array<{
        trajectoryId?: string | null;
        title?: string;
        task?: string | null;
      }>,
    ]
  >;
  const sampleCounts = sourceSampleEntries
    .map(([source, samples]) => `${source}=${samples.length}`)
    .join(" ");
  const sampleExamples = sourceSampleEntries
    .flatMap(([source, samples]) =>
      samples.slice(0, 2).map((sample) => {
        const id = sample.trajectoryId ?? sample.title ?? "sample";
        const task = sample.task ? `:${sample.task}` : "";
        return `${source}:${id}${task}`;
      }),
    )
    .slice(0, 5)
    .join(" ");
  const failedSteps = (result.manifest.steps ?? [])
    .filter((step) => step.status === "failed")
    .map((step) => `${step.id}:${compactStepError(step.error)}`);
  return [
    `[run-collection] output=${result.outputDir}`,
    `[run-collection] manifest=${result.manifestPath}`,
    `[run-collection] readme=${result.readmePath}`,
    `[run-collection] viewer=${result.manifest.analysis.indexHtmlPath}`,
    `[run-collection] collection-index=${result.collectionIndex.indexHtmlPath} json=${result.collectionIndex.indexJsonPath}`,
    `[run-collection] readiness=${result.manifest.readiness.status} ready=${result.manifest.readiness.ready} partial=${result.manifest.readiness.partial} missing=${result.manifest.readiness.missing}`,
    `[run-collection] preflight live=${preflight.liveRequired ? "yes" : "no"} ok=${preflightCounts.ok ?? 0} warning=${preflightCounts.warning ?? 0} missing=${preflightCounts.missing ?? 0} skipped=${preflightCounts.skipped ?? 0}`,
    `[run-collection] sources hf=${evidence.dataSources.huggingFaceDatasets} feed=${evidence.dataSources.feedDatasets} natural=${evidence.dataSources.naturalTrajectoryBundles} scenarios=${evidence.dataSources.scenarioRuns} scenario-native=${evidence.dataSources.scenarioNativeDatasets} tests=${evidence.dataSources.testTrajectories} jsonl=${evidence.dataSources.trainingJsonlDatasets}`,
    `[run-collection] evals artifacts=${evidence.evals.evalArtifacts} comparisons=${evidence.evals.evalComparisons} action=${evidence.evals.actionBenchmarks} matrices=${evidence.evals.benchmarkMatrices} models=${evidence.training.models} training-runs=${evidence.training.trainingRuns}`,
    `[run-collection] benchmarks pairs=${evidence.benchmarks.actionBenchmarkPairs} rows=${evidence.benchmarks.benchmarkRows} comparisons=${evidence.benchmarks.benchmarkComparisons} tiers=${evidence.benchmarks.tiers.join(",") || "none"}`,
    `[run-collection] baseline established=${evidence.benchmarks.baselineProgress.establishedTiers.join(",") || "none"} next=${evidence.benchmarks.baselineProgress.nextTier ?? "none"} remaining=${evidence.benchmarks.baselineProgress.remainingTiers.join(",") || "none"} smallest=${evidence.benchmarks.baselineProgress.smallestTierEstablished ? "yes" : "no"} all=${evidence.benchmarks.baselineProgress.allTiersEstablished ? "yes" : "no"}`,
    `[run-collection] benchmark-comparisons live=${liveComparisons} dry-run=${dryRunComparisons} improvements=${evidence.benchmarks.improvementComparisons.length}`,
    `[run-collection] benchmark-readiness smallest=${readiness.smallestTier} all-tiers=${readiness.allEliza1Tiers} improvement=${readiness.baseTrainedImprovement} all-tier-improvements=${readiness.allEliza1TierImprovements} cerebras=${readiness.cerebrasReference} cases=${readinessStatusFor("benchmark_case_provenance")}`,
    `[run-collection] source-readiness natural=${readinessStatusFor("natural_trajectories")} tests=${readinessStatusFor("test_trajectories")} readable=${readinessStatusFor("readable_source_samples")}`,
    `[run-collection] eval-readiness comparison=${readinessStatusFor("eval_comparison")} models=${readinessStatusFor("model_tracking")}`,
    `[run-collection] sample-readiness readable=${readinessStatusFor("readable_source_samples")}`,
    `[run-collection] source-samples ${sampleCounts}${sampleExamples ? ` examples=${sampleExamples}` : ""}`,
    failedSteps.length > 0
      ? `[run-collection] failed-steps ${failedSteps.join(" | ")}`
      : "[run-collection] failed-steps none",
    gaps.length > 0
      ? `[run-collection] readiness-gaps ${gaps
          .map(
            (gap) =>
              `${gap.id}:${gap.status}${gap.recommendedCapability ? `->${gap.recommendedCapability}` : ""}${formatRecommendedParamsSuffix(gap.recommendedParams)}`,
          )
          .join(" ")}`
      : "[run-collection] readiness-gaps none",
  ];
}

async function cmdValidate(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      input: { type: "string", short: "i" },
    },
  });

  if (!values.input) {
    console.error("Usage: validate --input <path-to-raw_samples.json>");
    process.exit(1);
  }

  const raw = await readFile(values.input, "utf-8");
  const samples: TrainingSample[] = JSON.parse(raw);

  console.log(`Loaded ${samples.length} samples from ${values.input}`);
  console.log("");

  const report = validateDataset(samples);
  console.log(formatQualityReport(report));
}

const OPTIMIZED_PROMPT_TASKS_CLI = [
  "should_respond",
  "context_routing",
  "action_planner",
  "response",
  "media_description",
] as const;
type OptimizedPromptTaskCli = (typeof OPTIMIZED_PROMPT_TASKS_CLI)[number];

function isOptimizedPromptTaskCli(
  value: string,
): value is OptimizedPromptTaskCli {
  return (OPTIMIZED_PROMPT_TASKS_CLI as readonly string[]).includes(value);
}

/**
 * Flip the `current` and `previous` symlinks in
 * `<state-dir>/optimized-prompts/<task>/` so the previously-deployed prompt
 * artifact becomes live again. Defers to `OptimizedPromptService.rollback`
 * so the CLI and runtime share one implementation.
 */
async function cmdRollbackPrompt(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      task: { type: "string" },
      "store-root": { type: "string" },
    },
    allowPositionals: true,
  });

  const taskName =
    (values.task as string | undefined)?.trim() ?? positionals[0]?.trim();
  if (!taskName) {
    console.error(
      `Usage: rollback-prompt <task>\n  task: one of ${OPTIMIZED_PROMPT_TASKS_CLI.join(", ")}`,
    );
    process.exit(1);
  }
  if (!isOptimizedPromptTaskCli(taskName)) {
    console.error(
      `Unknown task "${taskName}". Must be one of: ${OPTIMIZED_PROMPT_TASKS_CLI.join(", ")}`,
    );
    process.exit(1);
  }

  const { OptimizedPromptService } = await import("@elizaos/core");
  const service = new OptimizedPromptService();
  const customRoot = (values["store-root"] as string | undefined)?.trim();
  if (customRoot) {
    service.setStoreRoot(customRoot);
  } else {
    // Match the runtime precedence used by `bun run train`: ELIZA_STATE_DIR
    // then ELIZA_STATE_DIR then ~/.eliza. Stay aligned so `rollback-prompt`
    // operates on the same store the runtime + train CLI write to.
    const stateDir =
      process.env.ELIZA_STATE_DIR?.trim() ||
      process.env.ELIZA_STATE_DIR?.trim() ||
      join(homedir(), ".eliza");
    service.setStoreRoot(join(stateDir, "optimized-prompts"));
  }

  await service.refresh();
  try {
    const promptTask =
      taskName === "context_routing" ? "should_respond" : taskName;
    const newCurrent = await service.rollback(promptTask);
    console.log(
      `[rollback-prompt] task=${taskName} now points at ${newCurrent}`,
    );
  } catch (err) {
    console.error(
      `[rollback-prompt] ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
}

// ==================== Main ====================

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const restArgs = args.slice(1);

  switch (command) {
    case "generate":
      await cmdGenerate(restArgs);
      break;
    case "validate":
      await cmdValidate(restArgs);
      break;
    case "compare":
      await cmdCompare(restArgs);
      break;
    case "export-trajectories":
      await cmdExportTrajectories(restArgs);
      break;
    case "run-collection":
      await cmdRunCollection(restArgs);
      break;
    case "list-collections":
      await cmdListCollections(restArgs);
      break;
    case "rollback-prompt":
      await cmdRollbackPrompt(restArgs);
      break;
    default:
      console.log(`Usage: cli.ts <command> [options]

Commands:
  generate          Generate synthetic training data
    --variants N    Number of variants per blueprint (default: 5)
    --output DIR    Output directory (default: ./training-data)
    --concurrency N API call concurrency (default: 5)
    --contexts X,Y  Filter to specific contexts
    --decisions X,Y Filter to RESPOND,IGNORE,STOP

  validate          Validate a generated dataset
    --input PATH    Path to raw_samples.json

  export-trajectories  Re-export raw recorded trajectories to per-task JSONL
    -i, --input DIR    Trajectory dir (default: $ELIZA_TRAJECTORY_DIR or ~/.eliza/trajectories)
    -o, --output DIR   Output dir (default: ./training-data)
    --max-per-task N   Cap examples per task bucket

  run-collection    Collect HF/feed/natural/test/scenario/eval/benchmark evidence
    -o, --output DIR   Output dir (default: training state collection dir)
    --tiers LIST       Eliza-1 benchmark tiers, comma-separated, or "all" (default: 0_8b)
                       (all expands to ${ELIZA_ONE_BENCHMARK_TIER_LIST})
    --live             Execute live external work instead of dry-run defaults
    --preflight-only   Print live-readiness checks without collecting artifacts
    --probe-endpoints  Probe local OpenAI-compatible endpoints during preflight
    --skip-matrix      Skip benchmark matrix generation
    --skip-hf          Skip Hugging Face ingest
    --hf-files LIST    Comma-separated Hugging Face dataset paths to ingest
    --skip-feed        Skip feed generation
    --skip-natural     Skip natural trajectory export
    --skip-tests       Skip test trajectory collection
    --skip-scenarios   Skip scenario trajectories
    --skip-action-benchmark Skip Eliza harness action benchmark execution
    --benchmark-filter LIST Comma-separated action benchmark case ids
    --benchmark-model ID  Run action benchmark for one explicit model id
    --benchmark-runtime-model ID Served local/provider model id (defaults to --benchmark-model)
    --benchmark-variant V reference, base, or trained label for the explicit model
    --cerebras-max-samples N Max prompts for benchmark-vs-Cerebras (default: 50)
    --cerebras-variants V   Eliza variants for benchmark-vs-Cerebras: trained, base, both (default: both)
    --natural-sanitized-jsonl PATH Existing sanitized app trajectory JSONL
    --natural-raw-jsonl PATH       Existing raw app trajectory JSONL
    --natural-run-id ID            Run id to record on imported natural trajectories
    --natural-tasks LIST           Task buckets for natural trajectory export
    --include-natural-raw          Copy raw natural trajectory JSONL into the collection
    --skip-eval-comparison Skip dry-run local eval comparison artifact
    --skip-cerebras    Skip benchmark-vs-Cerebras step
    --skip-model-registry Skip persisted Eliza-1 model registry manifests
    --skip-bundle-stage Skip Eliza-1 bundle stage step

  list-collections  List saved training collection runs
    --root DIR       Collection root or a single collection output dir
    -n, --limit N    Maximum runs to print (default: 20)
                    Prints gaps=<id>:<status>-><capability> params={...}

  compare           A/B compare two prompts on a trajectory dataset
    --baseline PATH    Path to baseline prompt (.txt)
    --variant PATH     Path to variant prompt (.txt)
    --dataset PATH     Path to JSONL dataset (eliza_native_v1)
    --task NAME        should_respond | context_routing | action_planner | response | media_description
    --scorer KIND      agreement | planner_action (default: from --task)
    --mode MODE        vs_historical (default) | pairwise
    --max-examples N   Cap evaluations
    --tolerance F      Pass threshold delta (default: 0.02)
    --temperature F    Sampling temperature (default: 0)
    --max-tokens N     Per-completion cap (default: 512)
    -o, --output PATH  Write JSON result to file
    Exits with code 2 if variant regresses beyond --tolerance.

    rollback-prompt   Flip the optimized-prompt 'current' and 'previous' symlinks
      <task>            Required positional: should_respond | context_routing |
                      action_planner | response | media_description
    --store-root DIR  Override the optimized-prompts store root (default:
                      $ELIZA_STATE_DIR / ~/.eliza/optimized-prompts)

Environment:
  ANTHROPIC_API_KEY   Use Claude as teacher model
  OPENAI_API_KEY      Use GPT-5 as teacher model
`);
      break;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
