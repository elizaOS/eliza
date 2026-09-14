/**
 * Interrupts the production authority owner with a real synthetic authority,
 * independently of native scenario admission, and proves PID and TCP closure.
 */

import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { authorityPortClosed, stopAuthority } from "./authority-process.ts";

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
  const repoRoot = path.resolve(import.meta.dirname, "../../../../..");
  const ownerPath = path.join(import.meta.dirname, "authority-process.ts");
  const source = `
    import { writeFile, rename } from "node:fs/promises";
    import { startAuthority, installAuthoritySignalCleanup } from ${JSON.stringify(ownerPath)};
    const authority = await startAuthority(${JSON.stringify(repoRoot)}, "authority-interruption", "owned-fixture-control-token");
    installAuthoritySignalCleanup(authority.child);
    await writeFile(${JSON.stringify(readyPath + ".pending")}, JSON.stringify({pid:authority.child.pid,url:authority.url}), {mode:0o600,flag:"wx"});
    await rename(${JSON.stringify(readyPath + ".pending")}, ${JSON.stringify(readyPath)});
    setInterval(() => {}, 1000);
  `;
  const child = spawn(
    process.execPath,
    ["--conditions=eliza-source", "--eval", source],
    {
      cwd: repoRoot,
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let diagnostics = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    diagnostics += chunk.toString("utf8");
  });
  try {
    let authority: { pid: number; url: string } | undefined;
    const deadline = performance.now() + 20_000;
    while (performance.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(
          `Authority controller exited before readiness: ${diagnostics}`,
        );
      try {
        const value: unknown = JSON.parse(await readFile(readyPath, "utf8"));
        if (
          !value ||
          typeof value !== "object" ||
          !("pid" in value) ||
          typeof value.pid !== "number" ||
          !Number.isSafeInteger(value.pid) ||
          value.pid <= 0 ||
          !("url" in value) ||
          typeof value.url !== "string"
        )
          throw new Error("Authority controller emitted invalid readiness");
        authority = { pid: value.pid, url: value.url };
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
    if (!authority)
      throw new Error(
        `Authority controller never became ready: ${diagnostics}`,
      );
    expect(processExists(authority.pid)).toBe(true);
    expect(await authorityPortClosed(authority.url)).toBe(false);
    await stopAuthority(child);
    expect(child.signalCode).toBe("SIGTERM");
    expect(processExists(authority.pid)).toBe(false);
    expect(await authorityPortClosed(authority.url)).toBe(true);
  } finally {
    await stopAuthority(child);
    await rm(directory, { recursive: true, force: true });
  }
}, 45_000);
