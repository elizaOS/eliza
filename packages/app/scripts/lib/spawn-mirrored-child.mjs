/**
 * Owns a foreground child process for thin development wrappers. Signals from
 * the shell are forwarded to the child, and the child's final exit status is
 * mirrored back so callers can distinguish interruption from failure.
 */

import { spawn } from "node:child_process";

const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM"];

/** Spawn a child whose numeric exit code or terminating signal becomes ours. */
export function spawnMirroredChild(command, args, options) {
  const child = spawn(command, args, options);
  const signalHandlers = new Map();

  for (const signal of FORWARDED_SIGNALS) {
    const forward = () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill(signal);
      }
    };
    signalHandlers.set(signal, forward);
    process.once(signal, forward);
  }

  child.once("exit", (code, signal) => {
    for (const [forwardedSignal, handler] of signalHandlers) {
      process.off(forwardedSignal, handler);
    }

    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });

  return child;
}
