#!/usr/bin/env bun
/**
 * LifeOps per-capability GEPA loop (#8795).
 *
 * This is the file-backed CLI entrypoint around `triggerTraining`: it loads
 * recorded real/scenario trajectories, privacy-filters and buckets them through
 * the normal training orchestrator, runs the native GEPA backend for one
 * LifeOps task, and persists through the existing promotion gate.
 *
 * Dry run:
 *   bun run --cwd plugins/plugin-training lifeops:gepa -- \
 *     --trajectories ../../reports/scenarios/run/trajectories --task calendar_extract --dry-run
 *
 * Live GEPA/promotion run:
 *   TRAIN_MODEL_PROVIDER=cerebras CEREBRAS_API_KEY=... \
 *   bun run --cwd plugins/plugin-training lifeops:gepa -- \
 *     --trajectories ../../reports/scenarios/run/trajectories --task calendar_extract
 */
import { existsSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Trajectory } from "@elizaos/agent";
import { OptimizedPromptService } from "@elizaos/core";
import { triggerTraining } from "../src/core/training-orchestrator.js";
import {
  LIFEOPS_TRAINING_TASKS,
  type TrajectoryTrainingTask,
} from "../src/core/trajectory-task-datasets.js";

type CliArgs = {
  dryRun: boolean;
  stateDir?: string;
  task: TrajectoryTrainingTask;
  trajectories: string;
};

const LIFEOPS_TASK_SET = new Set<string>(LIFEOPS_TRAINING_TASKS);

function parseCliArgs(argv: string[]): CliArgs | "help" {
  const { values } = parseArgs({
    args: argv,
    options: {
      trajectories: { type: "string" },
      task: { type: "string" },
      "state-dir": { type: "string" },
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
  const task = values.task?.trim();
  if (!task || !LIFEOPS_TASK_SET.has(task)) {
    throw new Error(
      `--task must be one of: ${LIFEOPS_TRAINING_TASKS.join(", ")}`,
    );
  }

  return {
    dryRun: values["dry-run"] ?? false,
    stateDir: values["state-dir"],
    task: task as TrajectoryTrainingTask,
    trajectories,
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

async function readTrajectories(inputPath: string): Promise<Trajectory[]> {
  const files = await listJsonFiles(inputPath);
  const trajectories: Trajectory[] = [];
  for (const file of files) {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (isTrajectory(entry)) trajectories.push(entry);
      }
    } else if (isTrajectory(parsed)) {
      trajectories.push(parsed);
    }
  }
  return trajectories;
}

function makeTrajectoryService(trajectories: Trajectory[]) {
  const byId = new Map(
    trajectories.map((trajectory, index) => [
      trajectory.trajectoryId || `trajectory-${index}`,
      trajectory,
    ]),
  );
  return {
    async listTrajectories() {
      return {
        trajectories: [...byId.keys()].map((id) => ({ id })),
      };
    },
    async getTrajectoryDetail(id: string) {
      return byId.get(id) ?? null;
    },
  };
}

async function main(): Promise<number> {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (parsed === "help") {
    process.stdout.write(
      `Usage: bun run lifeops:gepa -- --trajectories <file-or-dir> --task <lifeops-task> [--dry-run] [--state-dir <dir>]\n`,
    );
    return 0;
  }

  const trajectories = await readTrajectories(parsed.trajectories);
  if (trajectories.length === 0) {
    throw new Error("no recorded trajectory JSON files were found");
  }

  const resolvedStateDir = parsed.stateDir
    ? resolve(process.cwd(), parsed.stateDir)
    : undefined;
  if (resolvedStateDir) {
    process.env.TRAINING_STATE_DIR = resolvedStateDir;
    process.env.ELIZA_STATE_DIR = resolvedStateDir;
  }

  const optimizedPromptService = new OptimizedPromptService();
  if (resolvedStateDir) {
    optimizedPromptService.setStoreRoot(
      join(resolvedStateDir, "optimized-prompts"),
    );
  }
  const trajectoryService = makeTrajectoryService(trajectories);

  const runtime = {
    getService(name: string) {
      if (name === "trajectories") return trajectoryService;
      if (name === "optimized_prompt") return optimizedPromptService;
      return null;
    },
    logger: {
      info: (message: string) => process.stdout.write(`${message}\n`),
      warn: (message: string) => process.stderr.write(`${message}\n`),
      error: (message: string) => process.stderr.write(`${message}\n`),
    },
  };

  const record = await triggerTraining(runtime, {
    backend: "native",
    dryRun: parsed.dryRun,
    source: "manual",
    task: parsed.task,
    trajectoryLimit: trajectories.length,
  });

  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
  return record.status === "failed" ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(
      `[lifeops-gepa-loop] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
