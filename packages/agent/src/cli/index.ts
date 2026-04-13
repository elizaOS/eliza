import { createRequire } from "node:module";
import process from "node:process";

function printHelp(): void {
  console.log(`eliza-autonomous

Usage:
  eliza-autonomous serve
  eliza-autonomous runtime
  eliza-autonomous benchmark [options]

Commands:
  serve      Start the autonomous backend in server-only mode
  runtime    Boot the runtime without entering the API/CLI wrapper
  benchmark  Run a benchmark task headlessly against the agent

Benchmark options:
  --task <path>    Path to task JSON file
  --server         Keep runtime alive and accept tasks via stdin (line-delimited JSON)
  --timeout <ms>   Timeout per task in milliseconds (default: 120000)
`);
}

function printVersion(): void {
  const require = createRequire(import.meta.url);
  const pkg = require("../../package.json") as { version: string };
  console.log(pkg.version);
}

export async function runAutonomousCli(
  argv: string[] = process.argv,
): Promise<void> {
  const command = argv[2] ?? "serve";

  if (command === "--version" || command === "-v" || command === "version") {
    printVersion();
    return;
  }

  if (command === "--help" || command === "-h" || command === "help") {
    printHelp();
    return;
  }

  if (command === "runtime") {
    const { bootElizaRuntime } = await import("../runtime/index.js");
    await bootElizaRuntime();
    return;
  }

  if (command === "serve" || command === "start") {
    const { startEliza } = await import("../runtime/index.js");
    await startEliza({ serverOnly: true });
    return;
  }

  if (command === "benchmark") {
    const { runBenchmark } = await import("./benchmark.js");
    // Parse benchmark-specific flags from argv
    const opts = {
      task: undefined as string | undefined,
      server: false,
      timeout: "120000",
    };
    for (let i = 3; i < argv.length; i++) {
      if (argv[i] === "--task" && argv[i + 1]) {
        opts.task = argv[++i];
      } else if (argv[i] === "--server") {
        opts.server = true;
      } else if (argv[i] === "--timeout" && argv[i + 1]) {
        opts.timeout = argv[++i];
      }
    }
    await runBenchmark(opts);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}
