// Explicit qualification-only command prefix for runtimes that need a loader.
import { spawn } from "node:child_process";

export function spawnTestRuntime(args, options) {
  const configured = process.env.ELIZA_TASK_TEST_RUNTIME_COMMAND;
  const command = configured ? JSON.parse(configured) : [process.execPath];
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    command.some(
      (part) => typeof part !== "string" || !part || part.includes("\0"),
    )
  )
    throw new Error("Invalid qualification runtime command");
  return spawn(command[0], [...command.slice(1), ...args], options);
}
