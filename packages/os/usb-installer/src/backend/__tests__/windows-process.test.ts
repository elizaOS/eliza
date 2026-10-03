import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";

import { spawnPowerShell } from "../windows-backend";

function child() {
  const process = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  return process;
}

it("retains writer ownership until close after a process error", async () => {
  const process = child();
  const failure = new Error("process failed");
  let settled = false;
  const operation = spawnPowerShell(
    "fixture",
    undefined,
    () => process as unknown as ChildProcessWithoutNullStreams,
  );
  void operation.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  process.emit("error", failure);
  await Promise.resolve();
  expect(settled).toBe(false);
  process.emit("close", null, null);
  await expect(operation).rejects.toBe(failure);
});

it("contains progress callback failures and preserves the later writer failure", async () => {
  const process = child();
  const failure = new Error("progress sink closed");
  const progress = vi.fn(() => {
    throw failure;
  });
  const operation = spawnPowerShell(
    "fixture",
    progress,
    () => process as unknown as ChildProcessWithoutNullStreams,
  );
  expect(() =>
    process.stdout.emit("data", Buffer.from("PROGRESS: 1")),
  ).not.toThrow();
  process.stdout.emit("data", Buffer.from("PROGRESS: 2"));
  expect(progress).toHaveBeenCalledOnce();
  process.stderr.emit("data", Buffer.from("write failed"));
  process.emit("close", 23, null);
  await expect(operation).rejects.toMatchObject({
    errors: [
      failure,
      {
        name: "PowerShellExecutionError",
        exitCode: 23,
        stderr: "write failed",
      },
    ],
  });
});

it("reports the terminating signal and does not call generic E_FAIL a user cancellation", async () => {
  const process = child();
  const operation = spawnPowerShell(
    "fixture",
    undefined,
    () => process as unknown as ChildProcessWithoutNullStreams,
  );
  process.stderr.emit("data", Buffer.from("0x80004005"));
  process.emit("close", null, "SIGTERM");
  await expect(operation).rejects.toMatchObject({
    name: "PowerShellExecutionError",
    message: expect.stringContaining("SIGTERM"),
  });
});
