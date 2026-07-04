/**
 * Registers the `benchmark` CLI command: runs a benchmark task headlessly
 * against the agent, delegating to `@elizaos/agent`'s `runBenchmark`. Supports a
 * one-shot `--task <path>` JSON run or a long-lived `--server` mode that accepts
 * line-delimited JSON tasks on stdin, with a per-task `--timeout`.
 */
import type { Command } from "commander";

export function registerBenchmarkCommand(program: Command) {
  program
    .command("benchmark")
    .description("Run a benchmark task headlessly against the agent")
    .option("--task <path>", "Path to task JSON file")
    .option(
      "--server",
      "Keep runtime alive and accept tasks via stdin (line-delimited JSON)",
    )
    .option("--timeout <ms>", "Timeout per task in milliseconds", "120000")
    .action(
      async (opts: { task?: string; server?: boolean; timeout: string }) => {
        const { runBenchmark } = await import("@elizaos/agent");
        await runBenchmark(opts);
      },
    );
}
