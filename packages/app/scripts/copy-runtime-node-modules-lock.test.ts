import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireRuntimeCopyLock, sleepSync } from "./copy-runtime-node-modules";

describe("runtime copy lock contention", () => {
  test("sleepSync blocks for the requested duration", () => {
    const started = performance.now();
    sleepSync(60);
    expect(performance.now() - started).toBeGreaterThanOrEqual(55);
  });

  test("waits for a live lock holder instead of throwing, then acquires", () => {
    const targetDist = fs.mkdtempSync(
      path.join(os.tmpdir(), "runtime-copy-lock-"),
    );
    const lockDir = path.join(targetDist, ".runtime-copy.lock");
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(
        path.join(lockDir, "owner.json"),
        JSON.stringify({ pid: process.pid }),
      );
      // A separate process releases the lock; this thread is blocked in
      // the synchronous polling loop meanwhile.
      const releaser = spawn(
        process.execPath,
        [
          "-e",
          `setTimeout(() => require("node:fs").rmSync(${JSON.stringify(
            lockDir,
          )}, { recursive: true, force: true }), 400);`,
        ],
        { stdio: "ignore" },
      );
      releaser.unref();

      const started = Date.now();
      // The returned release callback shells out to the repo-root cleanup
      // script (cwd-relative), so the test cleans up via finally instead.
      acquireRuntimeCopyLock(targetDist);
      expect(Date.now() - started).toBeGreaterThanOrEqual(250);
      const owner = JSON.parse(
        fs.readFileSync(path.join(lockDir, "owner.json"), "utf8"),
      ) as { pid: number };
      expect(owner.pid).toBe(process.pid);
    } finally {
      fs.rmSync(targetDist, { recursive: true, force: true });
    }
  });
});
