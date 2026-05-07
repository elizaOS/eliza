/**
 * Multi-backend training CLI for Eliza-native trajectory data.
 *
 * Usage:
 *   bun run train -- --backend {atropos|tinker|native} --dataset <path> \
 *       [--task {should_respond|context_routing|action_planner|response|media_description}]
 *
 * Backends consume `eliza_native_v1` model-boundary JSONL rows. The CLI is
 * intentionally a thin dispatcher so each backend can evolve independently.
 */

import { parseArgs } from "node:util";
import { runAtroposBackend } from "../backends/atropos.js";
import { NATIVE_OPTIMIZERS, runNativeBackend } from "../backends/native.js";
import { runTinkerBackend } from "../backends/tinker.js";
import type { TrajectoryTrainingTask } from "../core/trajectory-task-datasets.js";
import type { OptimizerName } from "../optimizers/index.js";

const ALLOWED_BACKENDS = new Set(["atropos", "tinker", "native"]);
const ALLOWED_TASKS = new Set([
  "should_respond",
  "context_routing",
  "action_planner",
  "response",
  "media_description",
]);
const ALLOWED_OPTIMIZERS = new Set<string>(NATIVE_OPTIMIZERS);

const HELP = `Usage:
  bun run train -- --backend {atropos|tinker|native} --dataset <path> [options]

Options:
  --backend NAME       atropos | tinker | native (required)
  --dataset PATH       Path to eliza_native_v1 JSONL file (required)
  --task NAME          should_respond | context_routing | action_planner | response | media_description
  --bin PATH           (atropos) Path to atropos CLI binary
  --optimizer NAME     (native) instruction-search | prompt-evolution | bootstrap-fewshot
                       Defaults to instruction-search.
  --baseline PATH      (native) Path to a baseline-prompt text file. Defaults to
                       the first system message in request.messages.
  --help               Show this help text
`;

interface ParsedTrainArgs {
  backend: "atropos" | "tinker" | "native";
  dataset: string;
  task?: TrajectoryTrainingTask;
  bin?: string;
  optimizer?: OptimizerName;
  baseline?: string;
}

export function parseTrainArgs(argv: string[]): ParsedTrainArgs | "help" {
  const { values } = parseArgs({
    args: argv,
    options: {
      backend: { type: "string" },
      dataset: { type: "string" },
      task: { type: "string" },
      bin: { type: "string" },
      optimizer: { type: "string" },
      baseline: { type: "string" },
      help: { type: "boolean" },
    },
    allowPositionals: false,
  });
  if (values.help) return "help";

  const backend = values.backend?.trim();
  if (!backend || !ALLOWED_BACKENDS.has(backend)) {
    throw new Error(
      `--backend is required and must be one of: ${[...ALLOWED_BACKENDS].join(", ")}`,
    );
  }
  const dataset = values.dataset?.trim();
  if (!dataset) {
    throw new Error("--dataset <path> is required");
  }
  let task: TrajectoryTrainingTask | undefined;
  if (values.task) {
    const t = values.task.trim();
    if (!ALLOWED_TASKS.has(t)) {
      throw new Error(
        `--task must be one of: ${[...ALLOWED_TASKS].join(", ")}`,
      );
    }
    task = t as TrajectoryTrainingTask;
  }

  let optimizer: OptimizerName | undefined;
  if (values.optimizer) {
    const opt = values.optimizer.trim();
    if (!ALLOWED_OPTIMIZERS.has(opt)) {
      throw new Error(
        `--optimizer must be one of: ${[...ALLOWED_OPTIMIZERS].join(", ")}`,
      );
    }
    optimizer = opt as OptimizerName;
  }

  return {
    backend: backend as ParsedTrainArgs["backend"],
    dataset,
    task,
    bin: values.bin,
    optimizer,
    baseline: values.baseline,
  };
}

export async function runTrainCli(argv: string[]): Promise<number> {
  const parsed = parseTrainArgs(argv);
  if (parsed === "help") {
    process.stdout.write(HELP);
    return 0;
  }

  switch (parsed.backend) {
    case "atropos": {
      const result = await runAtroposBackend({
        datasetPath: parsed.dataset,
        task: parsed.task,
        bin: parsed.bin,
      });
      console.log(`[train] atropos staged dataset at ${result.stagedPath}`);
      if (result.invoked) {
        console.log(`[train] atropos exited with code ${result.exitCode}`);
        if (result.stderr) console.error(result.stderr);
        return result.exitCode ?? 0;
      }
      return 0;
    }
    case "tinker": {
      const result = await runTinkerBackend({
        datasetPath: parsed.dataset,
        task: parsed.task,
      });
      for (const note of result.notes) console.log(`[train] ${note}`);
      return result.invoked ? 0 : 1;
    }
    case "native": {
      const optimizer = parsed.optimizer ?? "instruction-search";
      const task: TrajectoryTrainingTask = parsed.task ?? "should_respond";
      const baselinePrompt = await loadBaselinePrompt(parsed);
      // CLI invocation runs without a registered runtime/useModel, so we
      // fall back to the deterministic stub adapter that returns the
      // dataset's expected output verbatim. This makes the CLI useful as
      // a smoke test (validates the dataset + optimizer pipeline)
      // without requiring an LLM provider. Production callers go through
      // services/training-trigger.ts which wires the real runtime.
      const stubAdapter = {
        async complete(input: { user: string }): Promise<string> {
          return input.user;
        },
      };
      const result = await runNativeBackend({
        datasetPath: parsed.dataset,
        task,
        optimizer,
        baselinePrompt,
        datasetId: parsed.dataset,
        runtime: { useModel: async () => "" },
        adapter: stubAdapter,
      });
      for (const note of result.notes) console.log(`[train] ${note}`);
      if (!result.invoked) return 1;
      console.log(
        `[train] native ${optimizer} task=${task} dataset=${result.datasetSize} ` +
          `baseline=${result.baselineScore.toFixed(3)} optimized=${result.score.toFixed(3)}`,
      );
      return 0;
    }
    default: {
      // Unreachable thanks to the ALLOWED_BACKENDS guard above.
      throw new Error(`Unknown backend: ${parsed.backend}`);
    }
  }
}

async function loadBaselinePrompt(args: ParsedTrainArgs): Promise<string> {
  if (args.baseline) {
    const { readFile } = await import("node:fs/promises");
    return await readFile(args.baseline, "utf-8");
  }
  const { readFileSync } = await import("node:fs");
  const raw = readFileSync(args.dataset, "utf-8");
  const firstLine = raw.split("\n").find((line) => line.trim().length > 0);
  if (!firstLine) {
    throw new Error(
      `[native] cannot infer baseline from empty dataset ${args.dataset}; pass --baseline <path>`,
    );
  }
  const parsedJson: unknown = JSON.parse(firstLine);
  if (
    !parsedJson ||
    typeof parsedJson !== "object" ||
    (parsedJson as { format?: unknown }).format !== "eliza_native_v1"
  ) {
    throw new Error(
      `[native] dataset first row is not an eliza_native_v1 document; pass --baseline <path>`,
    );
  }
  const request = (parsedJson as { request?: { messages?: unknown } }).request;
  const messages = Array.isArray(request?.messages)
    ? (request.messages as Array<{ role?: string; content?: string }>)
    : [];
  const systemMsg = messages.find(
    (msg) => msg.role === "system" && typeof msg.content === "string",
  );
  if (!systemMsg?.content) {
    throw new Error(
      `[native] dataset first row has no system message; pass --baseline <path>`,
    );
  }
  return systemMsg.content;
}

if (
  import.meta.url ===
  `file://${process.argv[1] ? new URL(`file://${process.argv[1]}`).pathname : ""}`
) {
  runTrainCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
