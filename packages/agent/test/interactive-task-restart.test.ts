/** Real Bun host kill/restart against a shared durable SQLite file. */
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("recovers an interrupted dispatch after SIGKILL without executing it again", async () => {
  const root = mkdtempSync(join(tmpdir(), "eliza-task-restart-"));
  const file = join(root, "host.sqlite");
  const fixture = fileURLToPath(
    new URL("./fixtures/interactive-task-child.ts", import.meta.url),
  );
  const child = spawn(
    "bun",
    ["--conditions=eliza-source", fixture, file, "dispatch"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  try {
    const announced = await new Promise<string>((resolve, reject) => {
      let output = "";
      const timeout = setTimeout(
        () => reject(new Error(`Dispatch timed out: ${stderr}`)),
        10000,
      );
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", () => {
        clearTimeout(timeout);
        reject(new Error(`Host exited before dispatch: ${stderr}`));
      });
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.includes("\n")) {
          clearTimeout(timeout);
          resolve(output.trim());
        }
      });
    });
    expect(JSON.parse(announced)).toEqual({
      phase: "dispatched",
      status: "dispatched",
    });
    child.kill("SIGKILL");
    await exited;
    const result = execFileSync(
      "bun",
      ["--conditions=eliza-source", fixture, file, "recover"],
      { encoding: "utf8", timeout: 10000 },
    );
    expect(JSON.parse(result.trim())).toEqual({
      phase: "recovered",
      status: "paused",
      operation: "unknown",
      epoch: 1,
      events: ["create", "observe", "prepare", "dispatch", "recover"].map(
        (kind, sequence) => ({ id: `task-1#${sequence}`, kind }),
      ),
    });
    const readback = (mode: string) =>
      JSON.parse(
        execFileSync(
          "bun",
          ["--conditions=eliza-source", fixture, file, mode],
          { encoding: "utf8", timeout: 10000 },
        ).trim(),
      );
    for (const [mode, code] of [
      ["denied", "TASK_REVOKED"],
      ["stale", "TASK_CONFLICT"],
      ["missing-evidence", "TASK_INVALID"],
    ]) {
      const result = readback(mode);
      expect(result.operation).toBe("unknown");
      expect(result.operations).toBe(1);
      expect(result.errorCode).toBe(code);
    }
    const retryFile = join(root, "retry.sqlite");
    copyFileSync(file, retryFile);
    const retried = JSON.parse(
      execFileSync(
        "bun",
        ["--conditions=eliza-source", fixture, retryFile, "retry-readback"],
        { encoding: "utf8", timeout: 10000 },
      ).trim(),
    );
    expect(retried).toEqual({
      status: "paused",
      operation: "failed",
      operations: 1,
      errorCode: null,
      readbacks: 2,
    });
    const revokedFile = join(root, "revoked.sqlite");
    copyFileSync(file, revokedFile);
    const revoked = JSON.parse(
      execFileSync(
        "bun",
        ["--conditions=eliza-source", fixture, revokedFile, "revoke-readback"],
        { encoding: "utf8", timeout: 10000 },
      ).trim(),
    );
    expect(revoked.operation).toBe("unknown");
    expect(revoked.errorCode).toBe("TASK_CONFLICT");
    expect(readback("ambiguous")).toEqual({
      status: "paused",
      operation: "unknown",
      operations: 1,
      errorCode: null,
    });
    expect(readback("cancel-readback")).toEqual({
      status: "cancelled",
      operation: "unknown",
      operations: 1,
      errorCode: "TASK_CONFLICT",
    });
    expect(readback("reconcile")).toEqual({
      status: "cancelled",
      operation: "failed",
      operations: 1,
      errorCode: null,
    });
    expect(readback("reconcile").errorCode).toBe("TASK_REPLAY");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
