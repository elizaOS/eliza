import { createRequire } from "node:module";
import process from "node:process";

function printHelp(): void {
  console.log(`eliza-autonomous

Usage:
  eliza-autonomous serve
  eliza-autonomous tui
  eliza-autonomous tui-smoke [--api <url>]
  eliza-autonomous runtime
  eliza-autonomous ios-bridge --stdio
  eliza-autonomous android-bridge
  eliza-autonomous benchmark [options]

Commands:
  serve          Start the autonomous backend in server-only mode
  tui            Start the terminal TUI against an already-running backend
  tui-smoke      Start the terminal TUI once, print a readiness marker, and exit
  runtime        Boot the runtime without entering the API/CLI wrapper
  ios-bridge     Run the iOS full-engine stdio bridge
  android-bridge Boot the Android local-backend (HTTP server on 127.0.0.1:31337)
  benchmark      Run a benchmark task headlessly against the agent

Benchmark options:
  --task <path>    Path to task JSON file
  --server         Keep runtime alive and accept tasks via stdin (line-delimited JSON)
  --timeout <ms>   Timeout per task in milliseconds (default: 120000)
`);
}

class SmokeTerminal {
  readonly writes: string[] = [];

  start(_onInput: (data: string) => void, _onResize: () => void): void {}
  stop(): void {}
  async drainInput(): Promise<void> {}

  write(data: string): void {
    this.writes.push(data);
  }

  get columns(): number {
    return 100;
  }

  get rows(): number {
    return 28;
  }

  get kittyProtocolActive(): boolean {
    return true;
  }

  moveBy(_lines: number): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(_title: string): void {}

  text(): string {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI escape sequences from the captured TUI frame
    return this.writes.join("").replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
  }
}

function optionValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
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
    // agent package and out of the bundler's cycle path. No-op when
    // `ELIZA_LOCAL_LLAMA !== "1"`.
    if (runtime && process.env.ELIZA_LOCAL_LLAMA?.trim() === "1") {
      const { ensureAospLocalInferenceHandlers } = await import(
        "@elizaos/plugin-aosp-local-inference"
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
    // Only load the TUI when a terminal is actually attached. The cloud
    // image runs server-only with no TTY and may not bundle @elizaos/tui;
    // importing agent-terminal-tui there crashes an otherwise-healthy server.
    const { isTerminalTuiEnabled } = await import("../tui/tui-enabled.ts");
    if (isTerminalTuiEnabled()) {
      const { startAgentTerminalTui } = await import(
        "../tui/agent-terminal-tui.ts"
      );
      startAgentTerminalTui();
    }
    return;
  }

  if (command === "tui" || command === "tui-smoke") {
    const apiBaseUrl =
      optionValue(argv, "--api") ??
      process.env.ELIZA_AGENT_URL ??
      process.env.ELIZA_API_URL;
    const { startAgentTerminalTui } = await import(
      "../tui/agent-terminal-tui.ts"
    );

    if (command === "tui-smoke") {
      const terminal = new SmokeTerminal();
      const handle = startAgentTerminalTui({ apiBaseUrl, terminal });
      if (!handle) throw new Error("terminal TUI did not start");
      await handle.ready;
      await new Promise((resolve) => setTimeout(resolve, 0));
      console.log(terminal.text());
      console.log(`elizaos-tui-ready api=${apiBaseUrl ?? "default"}`);
      handle.stop();
      return;
    }

    const handle = startAgentTerminalTui({ apiBaseUrl });
    if (!handle)
      throw new Error("terminal TUI is disabled; set ELIZA_TERMINAL_TUI=1");
    await handle.ready;
    console.log(`elizaos-tui-ready api=${apiBaseUrl ?? "default"}`);
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
    const { runBenchmark } = await import("./benchmark.ts");
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
