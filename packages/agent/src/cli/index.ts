/**
 * Command dispatch for the `eliza-autonomous` CLI. Reads argv[2] and routes to
 * the matching subcommand — serve/start (boot the backend server, install
 * process crash guards), runtime (boot with no API/CLI wrapper), ios-bridge,
 * android-bridge, and benchmark — lazy-importing each command's heavy
 * dependencies only when invoked. Also handles --version/--help.
 */
import { createRequire } from "node:module";
import process from "node:process";

function printHelp(): void {
  console.log(`eliza-autonomous

Usage:
  eliza-autonomous serve
  eliza-autonomous runtime
  eliza-autonomous ios-bridge --stdio
  eliza-autonomous android-bridge
  eliza-autonomous benchmark [options]

Commands:
  serve          Start the autonomous backend in server-only mode
  runtime        Boot the runtime without entering the API/CLI wrapper
  ios-bridge     Run the iOS full-engine stdio bridge
  android-bridge Boot the Android local-backend (HTTP server on 127.0.0.1:31337)
  benchmark      Run a benchmark task headlessly against the agent

Benchmark options:
  --task <path>    Path to task JSON file
  --server         Keep runtime alive and accept tasks via stdin (line-delimited JSON)
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
    const { bootElizaRuntime } = await import("../runtime/index.ts");
    await bootElizaRuntime();
    return;
  }

  if (command === "ios-bridge") {
    const { runIosBridgeCli } = await import(
      "@elizaos/plugin-capacitor-bridge/ios/bridge"
    );
    await runIosBridgeCli(argv);
    return;
  }

  if (command === "serve" || command === "start") {
    // Keep a serving agent alive across background promise rejections, and hand
    // an uncaught exception off to the supervisor (Docker/K8s restart policy,
    // desktop AgentManager, dev api-supervisor) for a clean restart instead of
    // a silent death. One-shot commands and tests keep default behavior.
    if (process.env.NODE_ENV !== "test") {
      const { installProcessCrashGuards } = await import("@elizaos/shared");
      installProcessCrashGuards({ onUncaughtException: "restart" });
    }
    const keepAlive = setInterval(() => {}, 1 << 30);
    const { startEliza } = await import("../runtime/index.ts");
    const runtime = await startEliza({ serverOnly: true }).catch((error) => {
      clearInterval(keepAlive);
      throw error;
    });
    // AOSP-only post-boot wiring. The upstream `startEliza` does not
    // register local-inference handlers — that lives in the
    // `@elizaos/app-core` runtime wrapper, which the mobile agent
    // bundle cannot import (would create an `agent → app-core →
    // agent` workspace cycle). Bootstrapping the AOSP llama loader
    // and ModelType handlers here keeps the registration in the
    // agent package and out of the bundler's cycle path. Skipped when
    // `ELIZA_LOCAL_LLAMA !== "1"`.
    if (runtime && process.env.ELIZA_LOCAL_LLAMA?.trim() === "1") {
      const { ensureAospLocalInferenceHandlers } = await import(
        "@elizaos/plugin-native-inference"
      );
      await ensureAospLocalInferenceHandlers(runtime);
    } else if (
      runtime &&
      process.env.ELIZA_DEVICE_BRIDGE_ENABLED?.trim() === "1"
    ) {
      const { ensureMobileDeviceBridgeInferenceHandlers } = await import(
        "@elizaos/plugin-capacitor-bridge/mobile-device-bridge-bootstrap"
      );
      await ensureMobileDeviceBridgeInferenceHandlers(runtime);
    }
    return;
  }

  if (command === "android-bridge") {
    const { runAndroidBridgeCli } = await import(
      "@elizaos/plugin-capacitor-bridge/android/bridge"
    );
    await runAndroidBridgeCli();
    return;
  }

  if (command === "benchmark") {
    const { parseBenchmarkCommandOptions, runBenchmark } = await import(
      "./benchmark.ts"
    );
    const opts = parseBenchmarkCommandOptions(argv);
    await runBenchmark(opts);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}
