#!/usr/bin/env bun
/**
 * CLI entry for the eliza-1 quality + perf bench.
 *
 *   bun run --cwd packages/benchmarks/eliza-1 start [flags]
 *
 * Flags:
 *   --task <should_respond|planner|action:<name>|action:all|all>   (default: all)
 *   --mode <unguided|guided|haiku|all>                              (default: all)
 *   --n <count>                                                     (default: 10)
 *   --out <path.json>                                               (default: ./bench-results-<ISO>.json)
 *   --help
 *
 * Exit code is always 0 even when modes are skipped, so this is safe to wire
 * into CI without secrets / without the GGUF.
 */
import { resolve } from "node:path";
import { ElizaGuidedMode } from "./modes/eliza-guided.ts";
import { ElizaUnguidedMode } from "./modes/eliza-unguided.ts";
import { HaikuMode } from "./modes/haiku.ts";
import { renderReport, writeReportJson } from "./report.ts";
import { runBench, type TaskSelection } from "./runner.ts";
import type { ModeAdapter, ModeName } from "./types.ts";

interface Args {
  tasks: TaskSelection[];
  modes: ModeName[] | "all";
  n: number;
  out: string;
}

const HELP = `eliza-1 bench

Flags:
  --task <should_respond|planner|action:<name>|action:all|all>
      Task to run; may be passed multiple times. Default: all.
  --mode <unguided|guided|haiku|all>
      Mode to run; may be passed multiple times. Default: all.
  --n <count>
      Generations per (mode, case). Default: 10.
  --out <path.json>
      Output JSON path. Default: ./bench-results-<ISO>.json
  --help, -h
      Show this help.

Env:
  ANTHROPIC_API_KEY     enables the haiku reference mode
  ELIZA_BENCH_SKIP_ENGINE=1   force-skip the eliza-1 modes
`;

function parseArgs(argv: string[]): Args {
  const args: Args = {
    tasks: ["all"],
    modes: "all",
    n: 10,
    out: defaultOutPath(),
  };
  const tasks: TaskSelection[] = [];
  const modes: ModeName[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(HELP);
      process.exit(0);
    } else if (arg === "--task") {
      const next = argv[++i];
      if (!next) throw new Error("--task requires a value");
      tasks.push(next as TaskSelection);
    } else if (arg === "--mode") {
      const next = argv[++i];
      if (!next) throw new Error("--mode requires a value");
      if (next === "all") {
        args.modes = "all";
      } else {
        modes.push(next as ModeName);
      }
    } else if (arg === "--n") {
      const next = argv[++i];
      if (!next) throw new Error("--n requires a value");
      const parsed = Number.parseInt(next, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`--n must be a positive integer (got '${next}')`);
      }
      args.n = parsed;
    } else if (arg === "--out") {
      const next = argv[++i];
      if (!next) throw new Error("--out requires a value");
      args.out = next;
    } else {
      throw new Error(`unknown flag: ${arg}`);
    }
  }
  if (tasks.length > 0) args.tasks = tasks;
  if (modes.length > 0) args.modes = modes;
  return args;
}

function defaultOutPath(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `./bench-results-${stamp}.json`;
}

function selectModes(args: Args): ModeAdapter[] {
  const all: ModeAdapter[] = [
    new ElizaUnguidedMode(),
    new ElizaGuidedMode(),
    new HaikuMode(),
  ];
  if (args.modes === "all") return all;
  const wanted = new Set(args.modes);
  return all.filter((m) => wanted.has(m.id));
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(
      `${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.stderr.write(HELP);
    process.exit(2);
  }
  const modes = selectModes(args);
  process.stdout.write(
    `eliza-1 bench — tasks=${args.tasks.join(",")} modes=${
      args.modes === "all" ? "all" : args.modes.join(",")
    } n=${args.n}\n`,
  );
  const report = await runBench({
    tasks: args.tasks,
    modes,
    n: args.n,
    onProgress: (event) => {
      process.stdout.write(
        `[bench] ${event.taskId} × ${event.modeId} — ${event.cases} cases\n`,
      );
    },
  });
  process.stdout.write("\n");
  process.stdout.write(renderReport(report));
  const outPath = resolve(args.out);
  writeReportJson(report, outPath);
  process.stdout.write(`wrote ${outPath}\n`);
}

if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(
      `fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exit(1);
  });
}

export { runBench } from "./runner.ts";
export type { BenchReport, CaseMetric, ModeSummary } from "./types.ts";
