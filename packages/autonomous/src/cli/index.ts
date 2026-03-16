import process from "node:process";
import { bootElizaRuntime, startEliza } from "../runtime";

function printHelp(): void {
  console.log(`milady-autonomous

Usage:
  milady-autonomous serve
  milady-autonomous runtime

Commands:
  serve    Start the autonomous backend in server-only mode
  runtime  Boot the runtime without entering the API/CLI wrapper
`);
}

export async function runAutonomousCli(argv: string[] = process.argv): Promise<void> {
  const command = argv[2] ?? "serve";

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
