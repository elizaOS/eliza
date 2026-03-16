import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

type MockSpawnOptions = {
  exitCode: number;
  stderrOutput?: string;
  emitError?: Error;
};

/**
 * Create a lightweight mocked ChildProcess that emits either an error event
 * or a close event (with optional stderr output) on the next tick.
 */
export function createMockChildProcess(
  options: MockSpawnOptions,
): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  const stderrEmitter = new EventEmitter();
  Object.defineProperty(child, "stderr", { value: stderrEmitter });
  Object.defineProperty(child, "stdin", { value: null });
  Object.defineProperty(child, "stdout", { value: null });

  process.nextTick(() => {
    if (options.emitError) {
      child.emit("error", options.emitError);
      return;
    }
    if (options.stderrOutput) {
      stderrEmitter.emit("data", Buffer.from(options.stderrOutput));
    }
    child.emit("close", options.exitCode);
  });

  return child;
}
