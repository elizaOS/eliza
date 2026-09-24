/**
 * Interrupts the real stability controller after its authority is ready and
 * proves the active attempt, owned descendants, and authority listener disappear.
 */

import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // error-policy:J1 ESRCH is the explicit absent-process result.
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ESRCH"
    )
      return false;
    throw error;
  }
}

function descendants(parentPid: number): number[] {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number));
  const owned = new Set([parentPid]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [pid, parent] of rows) {
      if (owned.has(parent) && !owned.has(pid)) {
        owned.add(pid);
        changed = true;
      }
    }
  }
  owned.delete(parentPid);
  return [...owned];
}

function removeOwnedProcess(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    // error-policy:J6 The observed test-owned process may already have exited.
    if (
      !error ||
      typeof error !== "object" ||
      !("code" in error) ||
      error.code !== "ESRCH"
    )
      throw error;
  }
}

async function assertControllerInterrupted(
  waitForScenario: boolean,
): Promise<void> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "cloud-stability-authority-cleanup-"),
  );
  const readyPath = path.join(directory, "authority-ready.json");
  const child = Bun.spawn(
    [
      process.execPath,
      "--conditions=eliza-source",
      path.resolve(import.meta.dirname, "../../scripts/run-stability-lane.ts"),
      "--mode",
      "deterministic-mock",
      "--run-id",
      "cloud-stability-authority-interrupt",
      "--output",
      path.join(directory, "artifacts"),
    ],
    {
      cwd: path.resolve(import.meta.dirname, "../../../../.."),
      env: {
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        ELIZA_STABILITY_AUTHORITY_TEST_READY_PATH: readyPath,
      },
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  let owned: number[] = [];
  try {
    let authority: { pid: number; url: string } | undefined;
    for (let attempt = 0; attempt < 800; attempt += 1) {
      try {
        authority = JSON.parse(await readFile(readyPath, "utf8")) as {
          pid: number;
          url: string;
        };
        break;
      } catch (error) {
        // error-policy:J3 ENOENT is the bounded not-ready state for this test seam.
        if (
          !error ||
          typeof error !== "object" ||
          !("code" in error) ||
          error.code !== "ENOENT"
        )
          throw error;
      }
      await Bun.sleep(25);
    }
    expect(authority).toBeDefined();
    let readyToInterrupt = false;
    for (
      let attempt = 0;
      attempt < (waitForScenario ? 2_000 : 400);
      attempt += 1
    ) {
      owned = descendants(child.pid);
      readyToInterrupt = owned.some((pid) => pid !== authority?.pid);
      if (readyToInterrupt && waitForScenario) {
        const commands = execFileSync("ps", ["-axo", "pid=,command="], {
          encoding: "utf8",
        });
        readyToInterrupt = commands.split("\n").some((line) => {
          const match = line.trim().match(/^(\d+)\s+(.+)$/);
          return (
            match !== null &&
            owned.includes(Number(match[1])) &&
            match[2].includes("stability-scenario-child.ts")
          );
        });
      }
      if (readyToInterrupt) break;
      await Bun.sleep(25);
    }
    expect(readyToInterrupt).toBe(true);
    process.kill(child.pid, "SIGTERM");
    const exitCode = await Promise.race([
      child.exited,
      Bun.sleep(15_000).then(() => "timeout" as const),
    ]);
    expect(exitCode).not.toBe("timeout");
    expect(child.signalCode).toBe("SIGTERM");
    for (const pid of owned) expect(processExists(pid)).toBe(false);
    for (
      let attempt = 0;
      attempt < 200 && processExists(authority?.pid as number);
      attempt += 1
    )
      await Bun.sleep(25);
    expect(processExists(authority?.pid as number)).toBe(false);
    await expect(
      fetch(`${authority?.url}/health`, {
        signal: AbortSignal.timeout(500),
      }),
    ).rejects.toThrow();
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    for (const pid of owned) removeOwnedProcess(pid);
    await rm(directory, { recursive: true, force: true });
  }
}

test(
  "controller interruption removes its active attempt, descendants, authority PID and port",
  () => assertControllerInterrupted(false),
  45_000,
);

test(
  "controller interruption also removes the nested scenario process group",
  () => assertControllerInterrupted(true),
  120_000,
);
