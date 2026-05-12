/**
 * Training CLI for Eliza-native trajectory data.
 *
 * Usage:
 *   bun run train -- --backend native --dataset <path> \
 *       [--task {should_respond|context_routing|action_planner|response|media_description}]
 *
 * Consumes `eliza_native_v1` model-boundary JSONL rows.
 */

import { parseArgs } from "node:util";
import { NATIVE_OPTIMIZERS, runNativeBackend } from "../backends/native.js";
import type { TrajectoryTrainingTask } from "../core/trajectory-task-datasets.js";
import type { OptimizerName } from "../optimizers/index.js";

const ALLOWED_BACKENDS = new Set(["native"]);
const ALLOWED_TASKS = new Set([
  "should_respond",
  "context_routing",
  "action_planner",
  "response",
  "media_description",
]);
const ALLOWED_OPTIMIZERS = new Set<string>(NATIVE_OPTIMIZERS);

const HELP = `Usage:
  bun run train -- --backend native --dataset <path> [options]

Options:
  --backend NAME       native (required)
  --dataset PATH       Path to eliza_native_v1 JSONL file (required)
  --task NAME          should_respond | context_routing | action_planner | response | media_description
  --optimizer NAME     instruction-search | prompt-evolution | gepa
                       | bootstrap-fewshot | dspy-bootstrap-fewshot
                       | dspy-copro | dspy-mipro
                       Defaults to instruction-search.
                       gepa is the formal Pareto+feedback variant (Goyal et
                       al. 2024); prompt-evolution is the simpler genetic
                       mutation variant — both stay registered.
                       The dspy-* variants use the native DSPy primitives
                       (Signature + Predict + privacy-filtered Example loader)
                       and emit eliza_native_v1-compatible artifacts.
  --baseline PATH      Path to a baseline-prompt text file. Defaults to
                       the first system message in request.messages.
  --help               Show this help text
`;

interface ParsedTrainArgs {
  backend: "native";
  dataset: string;
  task?: TrajectoryTrainingTask;
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
    case "native": {
      const optimizer = parsed.optimizer ?? "instruction-search";
      const task: TrajectoryTrainingTask = parsed.task ?? "should_respond";
      const baselinePrompt = await loadBaselinePrompt(parsed);
      // Real-model adapter: scoring + variant generation run through the
      // Cerebras gpt-oss-120b client (lifeops-eval-model.ts). This is the path
      // `bun run lifeops:optimize` exercises against captured trajectories.
      const trainProvider =
        process.env.TRAIN_MODEL_PROVIDER?.trim() ??
        process.env.TRAINING_PROVIDER?.trim();
      if (trainProvider !== "cerebras") {
        console.error(
          "[train] TRAIN_MODEL_PROVIDER=cerebras (or TRAINING_PROVIDER=cerebras) is required. " +
            "The native backend has no offline stub; set the env var and rerun.",
        );
        return 1;
      }
      const helperPath =
        "../../../app-lifeops/test/helpers/lifeops-eval-model.ts";
      const { getTrainingUseModelAdapter } = (await import(
        helperPath
      )) as typeof import("../../../app-lifeops/test/helpers/lifeops-eval-model.ts");
      const useModel = getTrainingUseModelAdapter();
      const adapter = {
        async complete(input: {
          system?: string;
          user: string;
          temperature?: number;
          maxTokens?: number;
        }): Promise<string> {
          const prompt = input.system
            ? `${input.system}\n\n${input.user}`
            : input.user;
          return await useModel({
            prompt,
            temperature: input.temperature,
            maxTokens: input.maxTokens,
          });
        },
      };
      console.log(
        "[train] adapter: cerebras gpt-oss-120b (TRAIN_MODEL_PROVIDER=cerebras)",
      );
      const result = await runNativeBackend({
        datasetPath: parsed.dataset,
        task,
        optimizer,
        baselinePrompt,
        datasetId: parsed.dataset,
        runtime: { useModel },
        adapter,
      });
      for (const note of result.notes) console.log(`[train] ${note}`);
      if (!result.invoked) return 1;
      console.log(
        `[train] native ${optimizer} task=${task} dataset=${result.datasetSize} ` +
          `baseline=${result.baselineScore.toFixed(3)} optimized=${result.score.toFixed(3)}`,
      );

      // Persist the optimized prompt + lineage so the operator can inspect
      // and deploy it. Routed through `OptimizedPromptService.setPrompt` so
      // the on-disk versioning (`vN.json` + `current`/`previous` symlinks)
      // matches what the runtime trigger service writes. Keeps `rollback`
      // working regardless of which write path produced the artifact.
      const path = await import("node:path");
      const os = await import("node:os");
      const stateDir =
        process.env.ELIZA_STATE_DIR?.trim() ||
        process.env.MILADY_STATE_DIR?.trim() ||
        path.join(os.homedir(), ".eliza");
      const artifactPayload = {
        task,
        optimizer,
        baseline: baselinePrompt,
        prompt: result.result.optimizedPrompt,
        baselineScore: result.baselineScore,
        score: result.score,
        datasetSize: result.datasetSize,
        datasetId: parsed.dataset,
        generatedAt: new Date().toISOString(),
        lineage: result.result.lineage,
        ...(result.result.fewShotExamples
          ? { fewShotExamples: result.result.fewShotExamples }
          : {}),
      };
      try {
        const { OptimizedPromptService } = await import("@elizaos/core");
        const service = new OptimizedPromptService();
        service.setStoreRoot(path.join(stateDir, "optimized-prompts"));
        const artifactPath = await service.setPrompt(task, artifactPayload);
        console.log(`[train] artifact: ${artifactPath}`);
      } catch (err) {
        // Fallback: write the artifact directly to <stateDir>/optimized-prompts/<task>/vN.json
        // when @elizaos/core fails to load (e.g. transient drizzle-orm
        // resolution issues during cleanup). Keeps the optimizer output
        // recoverable.
        const fs = await import("node:fs");
        const dir = path.join(stateDir, "optimized-prompts", task);
        fs.mkdirSync(dir, { recursive: true });
        const existing = fs
          .readdirSync(dir)
          .filter((f) => /^v\d+\.json$/.test(f))
          .map((f) => Number.parseInt(f.replace(/^v|\.json$/g, ""), 10))
          .filter((n) => Number.isFinite(n));
        const nextVersion = (existing.length ? Math.max(...existing) : 0) + 1;
        const out = path.join(dir, `v${nextVersion}.json`);
        fs.writeFileSync(out, JSON.stringify(artifactPayload, null, 2));
        console.warn(
          `[train] OptimizedPromptService unavailable (${(err as Error)?.message ?? err}); wrote raw artifact -> ${out}`,
        );
      }
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
  const request = (
    parsedJson as { request?: { system?: unknown; messages?: unknown } }
  ).request;
  const messages = Array.isArray(request?.messages)
    ? (request.messages as Array<{ role?: string; content?: string }>)
    : [];
  const systemMsg = messages.find(
    (msg) => msg.role === "system" && typeof msg.content === "string",
  );
  const system =
    typeof request?.system === "string" && request.system.length > 0
      ? request.system
      : systemMsg?.content;
  if (!system) {
    throw new Error(
      `[native] dataset first row has no request.system or system message; pass --baseline <path>`,
    );
  }
  return system;
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
