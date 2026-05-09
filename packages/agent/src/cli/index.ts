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
    const runtime = await startEliza({ serverOnly: true });
    console.log(
      `[cli] startEliza returned: runtime=${runtime ? "present" : "null"}, ELIZA_LOCAL_LLAMA=${process.env.ELIZA_LOCAL_LLAMA ?? "(unset)"}`,
    );
    // AOSP-only post-boot wiring. The upstream `startEliza` does not
    // register local-inference handlers — that lives in the
    // `@elizaos/app-core` runtime wrapper, which the mobile agent
    // bundle cannot import (would create an `agent → app-core →
    // agent` workspace cycle). Bootstrapping the AOSP llama loader
    // and ModelType handlers here keeps the registration in the
    // agent package and out of the bundler's cycle path. No-op when
    // `ELIZA_LOCAL_LLAMA !== "1"`.
    if (runtime && process.env.ELIZA_LOCAL_LLAMA?.trim() === "1") {
      console.log("[cli] importing aosp-local-inference-bootstrap…");
      const { ensureAospLocalInferenceHandlers } = await import(
        "@elizaos/plugin-aosp-local-inference"
      );
      console.log("[cli] calling ensureAospLocalInferenceHandlers(runtime)…");
      const ok = await ensureAospLocalInferenceHandlers(runtime);
      console.log(`[cli] ensureAospLocalInferenceHandlers returned ${ok}`);
    } else if (
      runtime &&
      process.env.ELIZA_DEVICE_BRIDGE_ENABLED?.trim() === "1"
    ) {
      console.log("[cli] importing mobile-device-bridge-bootstrap…");
      const { ensureMobileDeviceBridgeInferenceHandlers } = await import(
        "@elizaos/plugin-capacitor-bridge"
      );
      console.log(
        "[cli] calling ensureMobileDeviceBridgeInferenceHandlers(runtime)…",
      );
      const ok = await ensureMobileDeviceBridgeInferenceHandlers(runtime);
      console.log(
        `[cli] ensureMobileDeviceBridgeInferenceHandlers returned ${ok}`,
      );
    }
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
