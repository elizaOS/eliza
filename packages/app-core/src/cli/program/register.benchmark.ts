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
