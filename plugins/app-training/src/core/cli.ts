/**
 * CLI entry point for the training data pipeline.
 *
 * Usage (from repo root):
 *   bun run eliza/plugins/app-training/src/core/cli.ts generate --variants 5 --output ./training-data
 *   bun run eliza/plugins/app-training/src/core/cli.ts validate --input ./training-data/raw_samples.json
 *   bun run eliza/plugins/app-training/src/core/cli.ts export-trajectories --output ./training-data/trajectories.jsonl
 * Or: `cd eliza/packages/agent && bun run training:cli` (delegates to this file).
 */

import { readFile, writeFile } from "fs/promises";
import { parseArgs } from "util";
import { AGENT_CONTEXTS, type AgentContext } from "./context-types.js";
import {
  createAnthropicTeacher,
  createOpenAITeacher,
  exportToElizaNativeJSONL,
  type GenerationConfig,
  generateDataset,
  type TeacherModel,
  type TrainingSample,
} from "./dataset-generator.js";
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
import type { TrajectoryTrainingTask } from "./trajectory-task-datasets.js";
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

function getTeacherModel(): TeacherModel {
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
    "No teacher model API key found. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.",
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

  const variantsPerBlueprint = parseInt(values.variants!, 10);
  const outputDir = values.output!;
  const concurrency = parseInt(values.concurrency!, 10);

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
    console.error("  --tolerance N          Pass threshold delta (default: 0.02)");
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

Environment:
  ANTHROPIC_API_KEY   Use Claude as teacher model
  OPENAI_API_KEY      Use GPT-5 as teacher model
`);
      break;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
