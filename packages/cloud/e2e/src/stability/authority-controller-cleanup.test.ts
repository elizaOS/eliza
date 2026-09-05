/**
 * Interrupts the real stability controller after its authority is ready and
 * proves the owned authority PID and loopback listener disappear.
 */

import { expect, test } from "bun:test";
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

test("controller interruption removes its synthetic authority PID and port", async () => {
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
    process.kill(child.pid, "SIGTERM");
    const exitCode = await Promise.race([
      child.exited,
      Bun.sleep(15_000).then(() => "timeout" as const),
    ]);
    expect(exitCode).not.toBe("timeout");
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
    await rm(directory, { recursive: true, force: true });
  }
}, 45_000);
