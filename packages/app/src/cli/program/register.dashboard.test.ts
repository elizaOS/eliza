/**
 * Real-process regression coverage for the `eliza dashboard` dev-server
 * teardown. Reproduces the `bun run dev` → Vite parent→grandchild shape with a
 * plain Node fixture (no bun dependency) and proves the fix's mechanism:
 * spawning the child detached and signalling the whole process group via the
 * negative PID kills BOTH the direct child and its long-lived grandchild. The
 * baseline case documents the orphan the fix closes — a plain
 * `child.kill("SIGTERM")` on the direct child leaves the grandchild alive and
 * reparented, still holding whatever resource (the UI port) it opened. POSIX
 * only, since it exercises process-group semantics unavailable on win32.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDevServerTeardown } from "./register.dashboard.ts";

const posix = process.platform !== "win32";

// A `dev`-script stand-in: prints its own long-lived grandchild's PID, then
// stays alive. Mirrors `bun run dev` spawning Vite as a separate grandchild.
const PARENT_FIXTURE = `
const { spawn } = require("node:child_process");
const grandchild = spawn(
  process.execPath,
  ["-e", "setInterval(() => {}, 1e9)"],
  { stdio: "ignore" },
);
process.stdout.write("GRANDCHILD " + grandchild.pid + "\\n");
setInterval(() => {}, 1e9);
`;

/** True while `pid` still exists; signal 0 probes without delivering a signal. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = gone; EPERM = alive but not ours to signal (treat as alive).
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForDeath(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return !isAlive(pid);
}

/** Spawn the fixture and resolve once it reports its grandchild PID. */
function spawnFixture(
  fixturePath: string,
  detached: boolean,
): Promise<{ child: ChildProcess; grandchildPid: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixturePath], {
      stdio: ["ignore", "pipe", "pipe"],
      detached,
    });
    const timer = setTimeout(
      () => reject(new Error("fixture never reported grandchild PID")),
      5_000,
    );
    child.stdout.on("data", (chunk: Buffer) => {
      const match = /GRANDCHILD (\d+)/.exec(chunk.toString());
      if (match) {
        clearTimeout(timer);
        resolve({ child, grandchildPid: Number(match[1]) });
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe.skipIf(!posix)("dashboard dev-server process-group teardown", () => {
  let fixtureDir: string;
  let fixturePath: string;
  const strays: number[] = [];

  beforeEach(() => {
    fixtureDir = mkdtempSync(path.join(tmpdir(), "dashboard-teardown-"));
    fixturePath = path.join(fixtureDir, "parent.cjs");
    writeFileSync(fixturePath, PARENT_FIXTURE);
  });

  afterEach(() => {
    // Reap anything a test intentionally left alive so no orphan escapes.
    for (const pid of strays.splice(0)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // error-policy:J6 best-effort teardown: already gone.
      }
    }
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it("group SIGTERM to a detached child kills the whole tree", async () => {
    const { child, grandchildPid } = await spawnFixture(fixturePath, true);
    const childPid = child.pid as number;
    expect(isAlive(childPid)).toBe(true);
    expect(isAlive(grandchildPid)).toBe(true);

    // The exact mechanism cleanup() uses on POSIX: negative PID => the group.
    process.kill(-childPid, "SIGTERM");

    expect(await waitForDeath(childPid)).toBe(true);
    expect(await waitForDeath(grandchildPid)).toBe(true);
  });

  it("swallows ESRCH when the group is already gone", async () => {
    const { child, grandchildPid } = await spawnFixture(fixturePath, true);
    const childPid = child.pid as number;
    process.kill(-childPid, "SIGKILL");
    expect(await waitForDeath(childPid)).toBe(true);
    expect(await waitForDeath(grandchildPid)).toBe(true);

    // A second group signal after the group is gone must raise ESRCH, which
    // cleanup() swallows so a repeated SIGINT never crashes the parent.
    let code: string | undefined;
    try {
      process.kill(-childPid, "SIGTERM");
    } catch (err) {
      code = (err as NodeJS.ErrnoException).code;
    }
    expect(code).toBe("ESRCH");
  });

  it("baseline: killing only the direct child orphans the grandchild", async () => {
    // Documents the regression: without detached+group-kill, SIGTERM to the
    // direct child leaves the reparented grandchild holding its resource.
    const { child, grandchildPid } = await spawnFixture(fixturePath, false);
    const childPid = child.pid as number;
    strays.push(grandchildPid);

    child.kill("SIGTERM");
    expect(await waitForDeath(childPid)).toBe(true);

    // Grace period: the orphaned grandchild is still alive (reparented to the
    // init/subreaper), which is exactly the stale-port symptom the fix closes.
    await new Promise((r) => setTimeout(r, 250));
    expect(isAlive(grandchildPid)).toBe(true);
  });
});

describe("createDevServerTeardown (the shipped teardown)", () => {
  let fixtureDir: string;
  let fixturePath: string;

  beforeEach(() => {
    fixtureDir = mkdtempSync(path.join(tmpdir(), "dashboard-teardown-real-"));
    fixturePath = path.join(fixtureDir, "parent.cjs");
    writeFileSync(fixturePath, PARENT_FIXTURE);
  });

  afterEach(() => {
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it("kills the detached child's whole tree, grandchild included", async () => {
    if (!posix) return;
    const { child, grandchildPid } = await spawnFixture(fixturePath, true);
    expect(isAlive(grandchildPid)).toBe(true);

    createDevServerTeardown(child, (() => {
      throw new Error("taskkill must not run on POSIX");
    }) as never)();

    expect(await waitForDeath(grandchildPid)).toBe(true);
    expect(await waitForDeath(child.pid as number)).toBe(true);
  });

  it("is idempotent — a second call does not re-signal a reaped group", () => {
    const killed: Array<[number, NodeJS.Signals]> = [];
    const spy = vi.spyOn(process, "kill").mockImplementation(((
      pid: number,
      signal: NodeJS.Signals,
    ) => {
      killed.push([pid, signal]);
      return true;
    }) as never);
    try {
      const teardown = createDevServerTeardown(
        { pid: 4242 },
        (() => {
          throw new Error("taskkill must not run on POSIX");
        }) as never,
        "linux",
      );
      teardown();
      teardown();
      teardown();
    } finally {
      spy.mockRestore();
    }
    // One SIGTERM to the GROUP (negative pid), never one per call.
    expect(killed).toEqual([[-4242, "SIGTERM"]]);
  });

  it("tree-kills with taskkill on win32 and never signals a process group", () => {
    const spy = vi.spyOn(process, "kill").mockImplementation((() => {
      throw new Error("win32 must not signal a process group");
    }) as never);
    const calls: unknown[][] = [];
    try {
      createDevServerTeardown(
        { pid: 99 },
        ((...args: unknown[]) => {
          calls.push(args);
          return { status: 0 } as never;
        }) as never,
        "win32",
      )();
    } finally {
      spy.mockRestore();
    }
    expect(calls).toEqual([["taskkill", ["/pid", "99", "/t", "/f"]]]);
  });
});
