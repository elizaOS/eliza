/** Real Bun host kill/restart against a shared durable SQLite file. */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
