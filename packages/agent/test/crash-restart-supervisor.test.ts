/**
 * End-to-end crash/restart contract test (issue #10203).
 *
 * Spawns the REAL `crash-injection` fixture child as a separate `bun` process
 * and drives it through a supervisor that mirrors `run-node.mjs`'s exit-code
 * contract: respawn on RESTART_EXIT_CODE, abort after MAX_RESTARTS_IN_WINDOW
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
import { RESTART_EXIT_CODE } from "@elizaos/shared/restart";
import { afterAll, describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(HERE, "fixtures", "crash-injection-child.ts");
const MEMORY_CHILD = path.join(HERE, "fixtures", "memory-watchdog-child.ts");
const GUARDS_CHILD = path.join(HERE, "fixtures", "process-guards-child.ts");

// Spawns real `bun` child processes — gated like `test:tui-pty` so it stays out
// of the fast unit lane and runs in the post-merge / on-demand lane with
// `RUN_CRASH_RESTART_E2E=1`. The module logic is covered keyless in
// `src/runtime/crash-injection.test.ts`.
const describeE2E =
  process.env.RUN_CRASH_RESTART_E2E === "1" ? describe : describe.skip;

const MAX_RESTARTS_IN_WINDOW = 5;
const RESTART_WINDOW_MS = 60_000;

const tmpFiles: string[] = [];
afterAll(() => {
  for (const f of tmpFiles) fs.rmSync(f, { force: true });
});

function runChildAt(
  childPath: string,
  env: Record<string, string>,
  timeoutMs = 15_000,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", [childPath], {
      env: { ...process.env, NODE_ENV: "test", ...env },
      stdio: ["ignore", "ignore", "ignore"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`child did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve(signal ? -1 : (code ?? -2));
    });
    child.on("error", reject);
  });
}

const runChild = (env: Record<string, string>): Promise<number> =>
  runChildAt(CHILD, env);

// The memory-watchdog child allocates real heap and waits at least one sample
// interval before tripping, so it needs a longer ceiling than the fast
// crash-injection child.
const runMemoryChild = (env: Record<string, string>): Promise<number> =>
  runChildAt(MEMORY_CHILD, env, 25_000);

const runGuardsChild = (env: Record<string, string>): Promise<number> =>
  runChildAt(GUARDS_CHILD, env, 10_000);

/** Supervisor mirroring run-node.mjs: respawn on RESTART_EXIT_CODE, storm-guard, else propagate. */
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
    it("restart mode exits RESTART_EXIT_CODE (supervisor would respawn)", async () => {
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
  it("respawns on RESTART_EXIT_CODE until the child stops requesting restart", async () => {
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
    // 3 restarts + 1 final clean run = 4 spawns; not aborted.
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

// End-to-end proof for the memory watchdog (#10197): the unit test covers
// createMemoryWatchdog's threshold/debounce logic and the block above covers the
// supervisor's exit-75 respawn — but nothing drives a REAL process whose real
// RSS crosses the threshold through the real requestRestart path. These close
// that gap with a spawned bun child under genuine memory pressure.
describeE2E("memory watchdog -> supervised restart (real RSS pressure)", () => {
  it("trips on sustained RSS over threshold and exits RESTART_EXIT_CODE", async () => {
    const code = await runMemoryChild({
      ELIZA_MEMORY_WATCHDOG: "1",
      ELIZA_MEMORY_WATCHDOG_RSS_MB: "128", // floor; the child holds far more
      ELIZA_MEMORY_WATCHDOG_INTERVAL_MS: "1000", // floor
      ELIZA_MEMORY_WATCHDOG_SUSTAINED: "1",
      CRASH_CHILD_ALLOC_MB: "400", // resident heap well above the threshold
      CRASH_CHILD_WATCHDOG_TIMEOUT_MS: "12000",
    });
    expect(code).toBe(RESTART_EXIT_CODE);
  }, 25_000);

  it("does NOT restart while RSS stays under the threshold", async () => {
    // Threshold far above anything the child allocates -> the watchdog samples,
    // sees RSS below the line, never requests a restart, and the child times out
    // to a deliberate non-75 exit.
    const code = await runMemoryChild({
      ELIZA_MEMORY_WATCHDOG: "1",
      ELIZA_MEMORY_WATCHDOG_RSS_MB: "65536", // 64 GB — unreachable here
      ELIZA_MEMORY_WATCHDOG_INTERVAL_MS: "1000",
      ELIZA_MEMORY_WATCHDOG_SUSTAINED: "1",
      CRASH_CHILD_ALLOC_MB: "64",
      CRASH_CHILD_WATCHDOG_TIMEOUT_MS: "3000",
    });
    expect(code).not.toBe(RESTART_EXIT_CODE);
    expect(code).toBe(2); // the child's "watchdog never fired" guard exit
  }, 25_000);

  it("does NOT restart when the watchdog is disabled, even under pressure", async () => {
    // No ELIZA_MEMORY_WATCHDOG -> startMemoryWatchdog returns null -> clean exit 0
    // regardless of RSS. Proves the opt-in gate holds.
    const code = await runMemoryChild({
      ELIZA_MEMORY_WATCHDOG_RSS_MB: "128",
      ELIZA_MEMORY_WATCHDOG_SUSTAINED: "1",
      CRASH_CHILD_ALLOC_MB: "400",
    });
    expect(code).toBe(0);
  }, 25_000);
});

// End-to-end proof for installProcessCrashGuards (#10203): the packages/shared
// unit test can only call the captured listeners by hand with a mocked exit —
// attaching real guards would crash the runner. These spawn a real bun child
// that installs the guards and triggers a REAL uncaughtException / unhandled
// rejection, proving the actual process.on(...) wiring behaves per policy.
describeE2E("installProcessCrashGuards -> real process fault handling", () => {
  it("exits RESTART_EXIT_CODE on a real uncaught exception (restart policy)", async () => {
    const code = await runGuardsChild({
      PG_POLICY: "restart",
      PG_FAULT: "uncaught",
    });
    expect(code).toBe(RESTART_EXIT_CODE);
  }, 15_000);

  it("exits 1 on a real uncaught exception (exit policy)", async () => {
    const code = await runGuardsChild({
      PG_POLICY: "exit",
      PG_FAULT: "uncaught",
    });
    expect(code).toBe(1);
  }, 15_000);

  it("survives a real uncaught exception (keep-alive policy) -> clean exit 0", async () => {
    const code = await runGuardsChild({
      PG_POLICY: "keep-alive",
      PG_FAULT: "uncaught",
    });
    expect(code).toBe(0);
  }, 15_000);

  it("treats a real unhandled promise rejection as non-fatal -> stays alive, exit 0", async () => {
    const code = await runGuardsChild({
      PG_POLICY: "restart",
      PG_FAULT: "rejection",
    });
    expect(code).toBe(0);
  }, 15_000);
});
