import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";
import { describeSpawnFailure } from "../scripts/spawn-failure";

test("names a missing binary instead of a bare non-zero status", () => {
  const result = spawnSync("eliza-no-such-binary-for-test", ["-v"]);
  expect(result.status).toBeNull();
  expect(describeSpawnFailure("bun", result)).toMatch(
    /bun was not found on PATH \(spawn ENOENT\)/,
  );
});

test("reports timeouts, signals and exit codes", () => {
  const timeout = Object.assign(new Error("spawnSync bun ETIMEDOUT"), {
    code: "ETIMEDOUT",
  });
  expect(
    describeSpawnFailure("bun", {
      status: null,
      signal: "SIGTERM",
      error: timeout,
    }),
  ).toBe("bun timed out and was killed");
  expect(describeSpawnFailure("bun", { status: null, signal: "SIGKILL" })).toBe(
    "bun was killed by SIGKILL",
  );
  expect(describeSpawnFailure("bun", { status: 3, signal: null })).toBe(
    "bun exited with status 3",
  );
  expect(describeSpawnFailure("bun", { status: 0, signal: null })).toBeNull();
});
