/**
 * End-to-end crash/restart contract test (issue #10203).
 *
 * Spawns the REAL `crash-injection` fixture child as a separate `bun` process
 * and drives it through a supervisor that mirrors `run-node.mjs`'s exit-code
 * contract: respawn on RESTART_EXIT_CODE (75), abort after MAX_RESTARTS_IN_WINDOW
 * (5) restarts inside RESTART_WINDOW_MS (60s). This proves crash injection
 * actually produces the exit codes the supervisor keys on, and that the
 * supervisor restarts vs. propagates vs. storm-guards as designed — with real
 * processes, no mocks.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(HERE, "fixtures", "crash-injection-child.ts");

// Spawns real `bun` child processes — gated like `test:tui-pty` so it stays out
// of the fast unit lane and runs in the post-merge / on-demand lane with
// `RUN_CRASH_RESTART_E2E=1`. The module logic is covered keyless in
// `src/runtime/crash-injection.test.ts`.
const describeE2E =
  process.env.RUN_CRASH_RESTART_E2E === "1" ? describe : describe.skip;

// Mirrors run-node.mjs:154-159. Kept in sync via this comment + the e2e below.
const RESTART_EXIT_CODE = 75;
const MAX_RESTARTS_IN_WINDOW = 5;
const RESTART_WINDOW_MS = 60_000;

const tmpFiles: string[] = [];
afterAll(() => {
  for (const f of tmpFiles) fs.rmSync(f, { force: true });
});

function runChild(env: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", [CHILD], {
      env: { ...process.env, NODE_ENV: "test", ...env },
      stdio: ["ignore", "ignore", "ignore"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("child did not exit within 15s"));
    }, 15_000);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve(signal ? -1 : (code ?? -2));
    });
    child.on("error", reject);
  });
}

/** Supervisor mirroring run-node.mjs: respawn on 75, storm-guard, else propagate. */
async function supervise(
  spawnChild: () => Promise<number>,
): Promise<{ spawns: number; finalCode: number; aborted: boolean }> {
  const timestamps: number[] = [];
  let spawns = 0;
  for (;;) {
    spawns += 1;
    const code = await spawnChild();
    if (code !== RESTART_EXIT_CODE) {
      return { spawns, finalCode: code, aborted: false };
    }
    const now = Date.now();
    timestamps.push(now);
    while (timestamps.length > 0 && timestamps[0] < now - RESTART_WINDOW_MS) {
      timestamps.shift();
    }
    if (timestamps.length > MAX_RESTARTS_IN_WINDOW) {
      return { spawns, finalCode: code, aborted: true };
    }
  }
}

describeE2E(
  "crash-injection produces the supervisor exit-code contract",
  () => {
    it("restart mode exits 75 (supervisor would respawn)", async () => {
      const code = await runChild({ ELIZA_CRASH_INJECT: "boot:restart" });
      expect(code).toBe(RESTART_EXIT_CODE);
    }, 20_000);

    it("exit mode exits 1 (supervisor would propagate)", async () => {
      const code = await runChild({ ELIZA_CRASH_INJECT: "boot:exit" });
      expect(code).toBe(1);
    }, 20_000);

    it("throw mode exits non-zero (uncaught crash)", async () => {
      const code = await runChild({ ELIZA_CRASH_INJECT: "boot:throw" });
      expect(code).not.toBe(0);
      expect(code).not.toBe(RESTART_EXIT_CODE);
    }, 20_000);

    it("no fault armed -> clean exit 0", async () => {
      const code = await runChild({});
      expect(code).toBe(0);
    }, 20_000);

    it("refuses to arm in production (no allow flag) -> clean exit 0, no crash", async () => {
      const code = await runChild({
        ELIZA_CRASH_INJECT: "boot:exit",
        NODE_ENV: "production",
      });
      expect(code).toBe(0);
    }, 20_000);
  },
);

describeE2E("supervisor restart contract (mirrors run-node.mjs)", () => {
  it("respawns on exit 75 until the child stops requesting restart", async () => {
    const counter = path.join(
      os.tmpdir(),
      `eliza-10203-counter-${process.pid}-a.txt`,
    );
    tmpFiles.push(counter);
    fs.writeFileSync(counter, "0");
    const result = await supervise(() =>
      runChild({
        CRASH_CHILD_COUNTER: counter,
        CRASH_CHILD_RESTART_LIMIT: "3",
      }),
    );
    // 3 restarts (exit 75) + 1 final clean run = 4 spawns; not aborted.
    expect(result.spawns).toBe(4);
    expect(result.finalCode).toBe(0);
    expect(result.aborted).toBe(false);
  }, 60_000);

  it("aborts a restart storm after MAX_RESTARTS_IN_WINDOW", async () => {
    const counter = path.join(
      os.tmpdir(),
      `eliza-10203-counter-${process.pid}-b.txt`,
    );
    tmpFiles.push(counter);
    fs.writeFileSync(counter, "0");
    // limit far above the guard -> the child always requests restart.
    const result = await supervise(() =>
      runChild({
        CRASH_CHILD_COUNTER: counter,
        CRASH_CHILD_RESTART_LIMIT: "100",
      }),
    );
    expect(result.aborted).toBe(true);
    // Each spawn returns 75 and pushes a timestamp; the guard trips once the
    // window holds > MAX restarts, i.e. on the (MAX+1)th spawn. So the child is
    // spawned MAX+1 times, then the supervisor refuses to relaunch.
    expect(result.spawns).toBe(MAX_RESTARTS_IN_WINDOW + 1);
  }, 60_000);
});
