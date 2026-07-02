import { describe, expect, it } from "vitest";
import {
  BirdclawCliError,
  type BirdclawExec,
  runBirdclawJson,
  runBirdclawText,
} from "./cli.ts";

const OPTIONS = { env: {}, timeoutMs: 1000, maxBufferBytes: 1024 * 1024 };

function execReturning(stdout: string, stderr = ""): BirdclawExec {
  return async () => ({ stdout, stderr });
}

function execRejecting(error: Error): BirdclawExec {
  return async () => {
    throw error;
  };
}

describe("runBirdclawJson", () => {
  it("parses a JSON envelope from stdout", async () => {
    const exec = execReturning('{"stats":{"home":4}}\n');
    const payload = await runBirdclawJson(
      exec,
      "birdclaw",
      ["db", "stats"],
      OPTIONS,
    );
    expect(payload).toEqual({ stats: { home: 4 } });
  });

  it("parses a top-level array envelope (search tweets)", async () => {
    const exec = execReturning('[{"id":"t1"}]');
    const payload = await runBirdclawJson(
      exec,
      "birdclaw",
      ["search"],
      OPTIONS,
    );
    expect(payload).toEqual([{ id: "t1" }]);
  });

  it("ignores stderr noise when the exit code is zero", async () => {
    // node:sqlite prints an ExperimentalWarning to stderr on Node 22; the
    // envelope contract says stderr is progress/warnings, never data.
    const exec = execReturning('{"ok":true}', "ExperimentalWarning: SQLite\n");
    const payload = await runBirdclawJson(
      exec,
      "birdclaw",
      ["db", "stats"],
      OPTIONS,
    );
    expect(payload).toEqual({ ok: true });
  });

  it("throws bad-json when stdout is empty", async () => {
    const exec = execReturning("", "some warning");
    await expect(
      runBirdclawJson(exec, "birdclaw", ["db", "stats"], OPTIONS),
    ).rejects.toMatchObject({ name: "BirdclawCliError", kind: "bad-json" });
  });

  it("throws bad-json when stdout is not JSON", async () => {
    const exec = execReturning("not json at all");
    await expect(
      runBirdclawJson(exec, "birdclaw", ["db", "stats"], OPTIONS),
    ).rejects.toMatchObject({ kind: "bad-json" });
  });

  it("propagates typed CLI errors from the exec seam", async () => {
    const exec = execRejecting(
      new BirdclawCliError(
        "not-installed",
        'birdclaw binary not found at "birdclaw"',
      ),
    );
    await expect(
      runBirdclawJson(exec, "birdclaw", ["db", "stats"], OPTIONS),
    ).rejects.toMatchObject({ kind: "not-installed" });
  });
});

describe("runBirdclawText", () => {
  it("resolves trimmed stdout", async () => {
    const exec = execReturning("0.8.5\n");
    await expect(
      runBirdclawText(exec, "birdclaw", ["--version"], OPTIONS),
    ).resolves.toBe("0.8.5");
  });
});
