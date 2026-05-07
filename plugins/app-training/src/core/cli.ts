/**
 * CLI entry point for the training data pipeline.
 *
 * Usage (from repo root):
 *   bun run eliza/plugins/app-training/src/core/cli.ts generate --variants 5 --output ./training-data
 *   bun run eliza/plugins/app-training/src/core/cli.ts validate --input ./training-data/raw_samples.json
 *   bun run eliza/plugins/app-training/src/core/cli.ts export-trajectories --output ./training-data/trajectories.jsonl
 * Or: `cd eliza/packages/agent && bun run training:cli` (delegates to this file).
 */

import { readFile } from "fs/promises";
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
import { formatQualityReport, validateDataset } from "./replay-validator.js";
import {
  buildRoleplayEpisodes,
  exportRoleplayEpisodes,
} from "./roleplay-trajectories.js";
import { ALL_BLUEPRINTS, BLUEPRINT_STATS } from "./scenario-blueprints.js";
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
