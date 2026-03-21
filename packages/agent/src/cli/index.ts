import { createRequire } from "node:module";
import process from "node:process";
import { bootElizaRuntime, startEliza } from "../runtime";

function printHelp(): void {
  console.log(`eliza-autonomous

Usage:
  eliza-autonomous serve
  eliza-autonomous runtime

Commands:
  serve    Start the autonomous backend in server-only mode
  runtime  Boot the runtime without entering the API/CLI wrapper
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
    await bootElizaRuntime();
    return;
  }

  if (command === "serve" || command === "start") {
    await startEliza({ serverOnly: true });
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}
