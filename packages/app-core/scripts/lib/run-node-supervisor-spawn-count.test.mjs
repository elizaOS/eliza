/** Unit tests for the supervisor integration test spawn-counter reader. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readSpawnCountForSupervisorTest } from "./run-node-supervisor-spawn-count.mjs";

let workDir;

afterEach(() => {
  if (workDir) {
    fs.rmSync(workDir, { recursive: true, force: true });
    workDir = undefined;
  }
});

describe("readSpawnCountForSupervisorTest", () => {
  it("returns the trimmed counter value when the file exists", () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-spawn-count-"));
    const counterFile = path.join(workDir, "spawn-count.txt");
    fs.writeFileSync(counterFile, " 3\n");

    expect(
      readSpawnCountForSupervisorTest(counterFile, { code: 0, stderr: "" }),
    ).toBe(3);
  });

  it("fails fast with supervisor stderr when the counter file was never written", () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-spawn-count-"));
    const counterFile = path.join(workDir, "spawn-count.txt");
    const stderr = "Error: No usable Node.js 24+ executable found";

    expect(() =>
      readSpawnCountForSupervisorTest(counterFile, { code: 1, stderr }),
    ).toThrow(
      /supervisor exited with code 1 without spawning the child.*spawn-count\.txt was never written: ENOENT/s,
    );
    expect(() =>
      readSpawnCountForSupervisorTest(counterFile, { code: 1, stderr }),
    ).toThrow(stderr);
  });

  it("labels empty stderr explicitly in the missing-counter error", () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-spawn-count-"));
    const counterFile = path.join(workDir, "spawn-count.txt");

    expect(() =>
      readSpawnCountForSupervisorTest(counterFile, { code: 1, stderr: "" }),
    ).toThrow(/--- supervisor stderr ---\n\(empty\)/);
  });
});
