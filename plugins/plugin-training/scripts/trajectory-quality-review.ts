#!/usr/bin/env bun
/**
 * Batch trajectory-quality review (#8795) — CLI.
 *
 * Reads recorded trajectory JSON (same corpus `lifeops:gepa` consumes),
 * samples N model calls per LifeOps capability, scores each against the
 * per-capability rubric with the configured eval model (deterministic JSON
 * `{score, reason}`, fail-closed parse), and writes a per-capability
 * scoreboard as JSON + markdown (mean/min/max, worst samples with reasons +
 * source file paths for hand review).
 *
 * Keyless dry run (lists what WOULD be scored, no model calls):
 *   bun run --cwd plugins/plugin-training trajectories:review -- \
 *     --trajectories ../../reports/scenarios/run/trajectories --dry-run
 *
 * Live review (eval backend configured like the other training scripts —
 * EVAL_MODEL_PROVIDER=cerebras CEREBRAS_API_KEY=..., or
 * EVAL_MODEL_PROVIDER=anthropic ANTHROPIC_API_KEY=...):
 *   bun run --cwd plugins/plugin-training trajectories:review -- \
 *     --trajectories ../../reports/scenarios/run/trajectories \
 *     --samples 5 --out reports/trajectory-quality
 */
import { existsSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Trajectory } from "@elizaos/agent";
import {
  buildReview,
  collectQualitySamples,
  judgeSamples,
  renderReviewMarkdown,
  type TrajectoryQualitySample,
} from "../src/core/trajectory-quality-review.js";
import {
  LIFEOPS_TRAINING_TASKS,
  type LifeOpsTrainingTask,
} from "../src/core/trajectory-task-datasets.js";

type CliArgs = {
  trajectories: string;
  samples: number;
  out: string;
  task?: LifeOpsTrainingTask;
  dryRun: boolean;
};

const LIFEOPS_TASK_SET = new Set<string>(LIFEOPS_TRAINING_TASKS);

function parseCliArgs(argv: string[]): CliArgs | "help" {
  const { values } = parseArgs({
    args: argv,
    options: {
      trajectories: { type: "string" },
      samples: { type: "string" },
      out: { type: "string" },
      task: { type: "string" },
      "dry-run": { type: "boolean" },
      help: { type: "boolean" },
    },
    allowPositionals: false,
  });
  if (values.help) return "help";

  const trajectories = values.trajectories?.trim();
  if (!trajectories) {
    throw new Error("--trajectories <file-or-dir> is required");
  }
  const samples = Number.parseInt(values.samples ?? "5", 10);
  if (!Number.isFinite(samples) || samples <= 0) {
    throw new Error("--samples must be a positive integer");
  }
  const task = values.task?.trim();
  if (task && !LIFEOPS_TASK_SET.has(task)) {
    throw new Error(
      `--task must be one of: ${LIFEOPS_TRAINING_TASKS.join(", ")}`,
    );
  }

  return {
    trajectories,
    samples,
    out: values.out?.trim() || "trajectory-quality-review",
    task: task ? (task as LifeOpsTrainingTask) : undefined,
    dryRun: values["dry-run"] ?? false,
  };
}

async function listJsonFiles(inputPath: string): Promise<string[]> {
  const resolved = resolve(process.cwd(), inputPath);
  if (!existsSync(resolved)) {
    throw new Error(`trajectory path does not exist: ${resolved}`);
  }
  const stat = statSync(resolved);
  if (stat.isFile()) return [resolved];
  if (!stat.isDirectory()) {
    throw new Error(
      `trajectory path is neither file nor directory: ${resolved}`,
    );
  }
  const out: string[] = [];
  const stack = [resolved];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile() && entry.name.endsWith(".json"))
        out.push(fullPath);
    }
  }
  out.sort();
  return out;
}

function isTrajectory(value: unknown): value is Trajectory {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as { trajectoryId?: unknown }).trajectoryId === "string"
  );
}

async function readTrajectories(inputPath: string): Promise<{
  trajectories: Trajectory[];
  sourcePathByTrajectoryId: Map<string, string>;
}> {
  const files = await listJsonFiles(inputPath);
  const trajectories: Trajectory[] = [];
  const sourcePathByTrajectoryId = new Map<string, string>();
  for (const file of files) {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    for (const entry of entries) {
      if (!isTrajectory(entry)) continue;
      trajectories.push(entry);
      sourcePathByTrajectoryId.set(String(entry.trajectoryId), file);
    }
  }
  return { trajectories, sourcePathByTrajectoryId };
}

/**
 * Eval-model judge, configured exactly like the other plugin-training
 * scripts: `EVAL_MODEL_PROVIDER` (cerebras default, anthropic supported)
 * via the shared lifeops-eval-model helper. Imported dynamically because the
 * helper lives in plugin-personal-assistant's test tree, outside this
 * package's emit rootDir (same pattern as src/cli/train.ts).
 */
async function makeJudge(): Promise<{
  judge: (prompt: string) => Promise<string>;
  description: string;
}> {
  interface EvalModelModule {
    getEvalModelClient(): (req: {
      prompt: string;
      systemPrompt?: string;
      temperature?: number;
      maxTokens?: number;
    }) => Promise<{ text: string }>;
  }
  const helperPath =
    "../../plugin-personal-assistant/test/helpers/lifeops-eval-model.ts";
  const helperModule: EvalModelModule = await import(helperPath);
  const client = helperModule.getEvalModelClient();
  const provider =
    process.env.EVAL_MODEL_PROVIDER?.trim() ||
    process.env.EVAL_PROVIDER?.trim() ||
    "cerebras";
  return {
    judge: async (prompt: string) => {
      const response = await client({ prompt, temperature: 0, maxTokens: 700 });
      return response.text;
    },
    description: `eval provider ${provider} (EVAL_MODEL_PROVIDER)`,
  };
}

function describeSamplePlan(
  samplesByTask: Record<LifeOpsTrainingTask, TrajectoryQualitySample[]>,
): string {
  const lines: string[] = [];
  for (const [task, samples] of Object.entries(samplesByTask)) {
    lines.push(`  ${task}: ${samples.length} sample(s)`);
    for (const sample of samples) {
      lines.push(
        `    - ${sample.trajectoryId} / ${sample.callId}${sample.sourcePath ? ` (${sample.sourcePath})` : ""}`,
      );
    }
  }
  return lines.join("\n");
}

async function main(): Promise<number> {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (parsed === "help") {
    process.stdout.write(
      "Usage: bun run trajectories:review -- --trajectories <file-or-dir> [--samples <n>] [--task <lifeops-task>] [--out <dir>] [--dry-run]\n",
    );
    return 0;
  }

  const { trajectories, sourcePathByTrajectoryId } = await readTrajectories(
    parsed.trajectories,
  );
  if (trajectories.length === 0) {
    throw new Error("no recorded trajectory JSON files were found");
  }

  const tasks = parsed.task ? [parsed.task] : LIFEOPS_TRAINING_TASKS;
  const samplesByTask = collectQualitySamples(trajectories, {
    samplesPerTask: parsed.samples,
    tasks,
    sourcePathByTrajectoryId,
  });
  const sampled = Object.values(samplesByTask).reduce(
    (sum, samples) => sum + samples.length,
    0,
  );

  if (parsed.dryRun) {
    process.stdout.write(
      `[trajectory-quality-review] dry run — would judge ${sampled} sample(s) across ${tasks.length} capability(ies):\n${describeSamplePlan(samplesByTask)}\n`,
    );
    return 0;
  }
  if (sampled === 0) {
    throw new Error(
      "no LifeOps samples found in the corpus — nothing to judge (run with --dry-run to inspect bucketing)",
    );
  }

  const { judge, description } = await makeJudge();
  const { judged, failed } = await judgeSamples(samplesByTask, judge);
  const review = buildReview({
    judgeModel: description,
    samplesPerTask: parsed.samples,
    sampled,
    judged,
    failed,
  });

  const outDir = resolve(process.cwd(), parsed.out);
  await mkdir(outDir, { recursive: true });
  const jsonPath = join(outDir, "trajectory-quality-review.json");
  const markdownPath = join(outDir, "trajectory-quality-review.md");
  await writeFile(jsonPath, `${JSON.stringify(review, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderReviewMarkdown(review), "utf8");

  process.stdout.write(
    `[trajectory-quality-review] judged ${judged.length}/${sampled} sample(s) (${failed.length} failed judgment(s))\n` +
      `[trajectory-quality-review] scoreboard → ${jsonPath}\n` +
      `[trajectory-quality-review] markdown  → ${markdownPath}\n`,
  );
  // Fail-closed: unparseable judge output means the review is incomplete.
  return failed.length > 0 ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(
      `[trajectory-quality-review] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
