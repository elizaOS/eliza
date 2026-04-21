/**
 * CLI entry point for the training data pipeline.
 *
 * Usage (from repo root):
 *   bun run eliza/apps/app-training/src/core/cli.ts generate --variants 5 --output ./training-data
 *   bun run eliza/apps/app-training/src/core/cli.ts validate --input ./training-data/raw_samples.json
 *   bun run eliza/apps/app-training/src/core/cli.ts export-trajectories --output ./training-data/trajectories.jsonl
 *   bun run eliza/apps/app-training/src/core/cli.ts tune --project my-gcp-project --bucket my-bucket --model flash-lite --data ./training-data/should_respond_training.jsonl
 *
 * Or: `cd eliza/packages/agent && bun run training:cli` (delegates to this file).
 */

import { readFile } from "fs/promises";
import { parseArgs } from "util";
import { AGENT_CONTEXTS, type AgentContext } from "./context-types.js";
import {
  createAnthropicTeacher,
  createOpenAITeacher,
  exportToGeminiJSONL,
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
import {
  createTuningJob,
  listTuningJobs,
  normalizeVertexBaseModel,
  orchestrateVertexTuning,
  type VertexTuningConfig,
  type VertexTuningScope,
  type VertexTuningSlot,
  waitForTuningJob,
} from "./vertex-tuning.js";

const AGENT_DECISIONS = ["RESPOND", "IGNORE", "STOP"] as const;
type AgentDecision = (typeof AGENT_DECISIONS)[number];

const VERTEX_TUNING_SLOTS: readonly VertexTuningSlot[] = [
  "should_respond",
  "response_handler",
  "action_planner",
  "planner",
  "response",
  "media_description",
];

const VERTEX_TUNING_SCOPES: readonly VertexTuningScope[] = [
  "global",
  "organization",
  "user",
];

function parseAgentContexts(value: string | undefined): AgentContext[] | undefined {
  if (!value) return undefined;
  const out: AgentContext[] = [];
  for (const entry of value.split(",")) {
    const trimmed = entry.trim();
    if (
      trimmed &&
      (AGENT_CONTEXTS as readonly string[]).includes(trimmed)
    ) {
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
    if (
      trimmed &&
      (AGENT_DECISIONS as readonly string[]).includes(trimmed)
    ) {
      out.push(trimmed as AgentDecision);
    }
  }
  return out.length > 0 ? out : undefined;
}

function parseVertexTuningSlot(value: string): VertexTuningSlot {
  if (!(VERTEX_TUNING_SLOTS as readonly string[]).includes(value)) {
    throw new Error(
      `Invalid slot "${value}". Expected one of: ${VERTEX_TUNING_SLOTS.join(", ")}`,
    );
  }
  return value as VertexTuningSlot;
}

function parseVertexTuningScope(value: string): VertexTuningScope {
  if (!(VERTEX_TUNING_SCOPES as readonly string[]).includes(value)) {
    throw new Error(
      `Invalid scope "${value}". Expected one of: ${VERTEX_TUNING_SCOPES.join(", ")}`,
    );
  }
  return value as VertexTuningScope;
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
  console.log("\nExporting to Gemini JSONL format...");
  const paths = await exportToGeminiJSONL(samples, outputDir);
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

async function cmdTune(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      project: { type: "string" },
      bucket: { type: "string" },
      model: { type: "string", default: "gemini-2.5-flash-lite" },
      data: { type: "string" },
      validation: { type: "string" },
      name: { type: "string", default: "eliza-should-respond" },
      epochs: { type: "string", default: "3" },
      region: { type: "string", default: "us-central1" },
    },
  });

  if (!values.project || !values.bucket || !values.data) {
    console.error(
      "Usage: tune --project <gcp-project> --bucket <gcs-bucket> --data <path-to-jsonl> [--model flash-lite|flash] [--name <display-name>]",
    );
    process.exit(1);
  }

  const baseModel = normalizeVertexBaseModel(values.model, "should_respond");

  const config: VertexTuningConfig = {
    projectId: values.project,
    region: values.region,
    gcsBucket: values.bucket,
    baseModel,
    trainingDataPath: values.data,
    validationDataPath: values.validation,
    epochs: parseInt(values.epochs!, 10),
    displayName: values.name!,
  };

  console.log(`\nCreating tuning job...`);
  console.log(`  Project: ${config.projectId}`);
  console.log(`  Region: ${config.region}`);
  console.log(`  Base model: ${config.baseModel}`);
  console.log(`  Training data: ${config.trainingDataPath}`);
  console.log(`  Display name: ${config.displayName}`);
  console.log("");

  const job = await createTuningJob(config);
  console.log(`Job created: ${job.name}`);
  console.log(`State: ${job.state}`);

  console.log("\nPolling for completion (this may take hours)...");
  const final = await waitForTuningJob(job.name, {
    onPoll: (j) => {
      console.log(`  [${new Date().toISOString()}] ${j.state}`);
    },
  });

  if (final.state === "JOB_STATE_SUCCEEDED") {
    console.log(`\nTuning succeeded!`);
    console.log(`Tuned model endpoint: ${final.tunedModelEndpointName}`);
  } else {
    console.log(`\nTuning failed: ${final.error?.message ?? "unknown error"}`);
    process.exit(1);
  }
}

async function cmdListJobs(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      project: { type: "string" },
      region: { type: "string", default: "us-central1" },
    },
  });

  if (!values.project) {
    console.error("Usage: list-jobs --project <gcp-project>");
    process.exit(1);
  }

  const jobs = await listTuningJobs(values.project, values.region);
  console.log(`\nTuning jobs for ${values.project}:\n`);
  for (const job of jobs) {
    console.log(`  ${job.name}`);
    console.log(`    State: ${job.state}`);
    console.log(`    Display name: ${job.tunedModelDisplayName}`);
    console.log(`    Created: ${job.createTime}`);
    if (job.tunedModelEndpointName) {
      console.log(`    Endpoint: ${job.tunedModelEndpointName}`);
    }
    console.log("");
  }
}

async function cmdOrchestrate(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      project: { type: "string" },
      bucket: { type: "string" },
      data: { type: "string" },
      slot: { type: "string", default: "should_respond" },
      scope: { type: "string", default: "global" },
      ownerId: { type: "string" },
      model: { type: "string" },
      name: { type: "string", default: "eliza-tuned-model" },
      epochs: { type: "string", default: "3" },
      region: { type: "string", default: "us-central1" },
    },
  });

  if (!values.project || !values.bucket || !values.data) {
    console.error(
      "Usage: orchestrate --project <gcp-project> --bucket <gcs-bucket> --data <path-to-jsonl> [--slot should_respond|action_planner|response] [--scope global|organization|user]",
    );
    process.exit(1);
  }

  const slot = parseVertexTuningSlot(values.slot!);
  const scope = parseVertexTuningScope(values.scope!);

  const result = await orchestrateVertexTuning({
    projectId: values.project,
    region: values.region,
    gcsBucket: values.bucket,
    baseModel: normalizeVertexBaseModel(values.model, slot),
    trainingDataPath: values.data,
    epochs: parseInt(values.epochs!, 10),
    displayName: values.name!,
    slot,
    scope,
    ownerId: values.ownerId,
  });

  console.log(`\nJob created: ${result.job.name}`);
  console.log(`Recommended model ID: ${result.recommendedModelId}`);
  console.log("Model preference patch:");
  console.log(JSON.stringify(result.modelPreferencePatch, null, 2));
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
    case "tune":
      await cmdTune(restArgs);
      break;
    case "list-jobs":
      await cmdListJobs(restArgs);
      break;
    case "orchestrate":
      await cmdOrchestrate(restArgs);
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

  tune              Start a Vertex AI fine-tuning job
    --project ID    GCP project ID
    --bucket NAME   GCS bucket for training data
    --data PATH     Path to training JSONL
    --model TYPE    flash-lite or flash (default: flash-lite)
    --name NAME     Display name (default: eliza-should-respond)
    --epochs N      Training epochs (default: 3)
    --region REG    GCP region (default: us-central1)

  list-jobs         List Vertex AI tuning jobs
    --project ID    GCP project ID

  orchestrate       Submit a tuned-model job and emit the model preference patch
    --project ID    GCP project ID
    --bucket NAME   GCS bucket for training data
    --data PATH     Path to training JSONL
    --slot NAME     should_respond | action_planner | response | media_description
    --scope NAME    global | organization | user

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
