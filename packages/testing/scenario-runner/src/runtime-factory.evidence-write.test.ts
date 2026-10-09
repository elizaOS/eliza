/**
 * Exercises the synthetic runtime evidence writer against the real filesystem
 * contract the stability artifact uploader depends on. No filesystem behavior
 * is mocked: the assertions follow the actual inode through both write paths.
 */

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import { writeSyntheticRuntimeEvidence } from "./runtime-factory.ts";

const outputRoots: string[] = [];

function makeOutputDir(): string {
  const parent = mkdtempSync(path.join(tmpdir(), "synthetic-evidence-"));
  outputRoots.push(parent);
  const dir = path.join(parent, "attempt-01");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function runtimeStub(): AgentRuntime {
  return {
    getRecentReportedErrors: () => [
      { scope: "probe-scope", code: "PROBE_CODE", message: "probe message" },
    ],
  } as unknown as AgentRuntime;
}

const events = [
  {
    phase: "admission",
    resourceKind: "service",
    resourceName: "probe-service",
    outcome: "denied-undeclared-registration",
  },
] as const;

function tmpSiblings(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.includes(".tmp"));
}

afterEach(() => {
  for (const dir of outputRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("writeSyntheticRuntimeEvidence", () => {
  it("creates fresh evidence as private JSON and leaves no temporary file", () => {
    const dir = makeOutputDir();
    const evidencePath = path.join(dir, "child-runtime-ledger.json");

    writeSyntheticRuntimeEvidence(evidencePath, [...events], runtimeStub());

    const written = JSON.parse(readFileSync(evidencePath, "utf8"));
    expect(written.events).toEqual([...events]);
    expect(written.reportedErrors).toEqual([
      { scope: "probe-scope", code: "PROBE_CODE", message: "probe message" },
    ]);
    expect((statSync(evidencePath).mode & 0o777) === 0o600).toBe(true);
    expect(tmpSiblings(dir)).toEqual([]);
  });

  it("updates a launcher pre-created evidence file in place, preserving its inode and mode", () => {
    const dir = makeOutputDir();
    const evidencePath = path.join(dir, "child-runtime-ledger.json");
    // Simulates the launcher's parent-owned pre-creation: a readable private
    // file whose ownership the artifact uploader depends on.
    writeFileSync(evidencePath, "", { mode: 0o600 });
    chmodSync(evidencePath, 0o640);
    const owned = statSync(evidencePath);

    writeSyntheticRuntimeEvidence(evidencePath, [...events], runtimeStub());

    const after = statSync(evidencePath);
    expect(after.ino).toBe(owned.ino);
    expect(after.mode & 0o777).toBe(owned.mode & 0o777);
    const written = JSON.parse(readFileSync(evidencePath, "utf8"));
    expect(written.events).toEqual([...events]);
    expect(tmpSiblings(dir)).toEqual([]);
  });
});
