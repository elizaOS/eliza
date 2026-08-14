/**
 * Exercises trajectory list filtering and limiting through the real CLI.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "../lib/spawn-sync-captured.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const TRAJECTORY_CLI = path.resolve(SCRIPT_DIR, "../trajectory.ts");
const RUNTIME_BIN = process.execPath;
const BASE_TIME_MS = Date.parse("2026-01-01T00:00:00.000Z");

interface FixtureOptions {
  id: string;
  agent: string;
  mtimeMs: number;
  startedAt?: number;
}

function writeTrajectory(directory: string, options: FixtureOptions): string {
  const filePath = path.join(directory, `${options.id}.json`);
  writeFileSync(
    filePath,
    JSON.stringify({
      trajectoryId: options.id,
      agentId: options.agent,
      rootMessage: { id: `message-${options.id}`, text: "fixture" },
      startedAt: options.startedAt ?? options.mtimeMs,
      status: "finished",
      stages: [],
      metrics: {
        totalLatencyMs: 1,
        totalCostUsd: 0,
        toolCallsExecuted: 0,
        finalDecision: "FINISH",
      },
    }),
  );
  utimesSync(filePath, options.mtimeMs / 1000, options.mtimeMs / 1000);
  return filePath;
}

function writeMalformedTrajectory(
  directory: string,
  id: string,
  mtimeMs: number,
): string {
  const filePath = path.join(directory, `${id}.json`);
  writeFileSync(filePath, "{not valid json");
  utimesSync(filePath, mtimeMs / 1000, mtimeMs / 1000);
  return filePath;
}

function runList(directory: string, args: string[] = []) {
  return spawnSync(RUNTIME_BIN, [TRAJECTORY_CLI, "list", ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      ELIZA_TRAJECTORY_DIR: directory,
      NO_COLOR: "1",
    },
    timeout: 30_000,
  });
}

function withFixture(run: (directory: string) => void): void {
  const directory = mkdtempSync(path.join(tmpdir(), "trajectory-list-"));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("trajectory list", () => {
  test("finds an older match behind twenty newer trajectories from another agent", () =>
    withFixture((directory) => {
      writeTrajectory(directory, {
        id: "target-old",
        agent: "target-agent",
        mtimeMs: BASE_TIME_MS,
      });
      for (let index = 1; index <= 20; index++) {
        writeTrajectory(directory, {
          id: `other-${index}`,
          agent: "other-agent",
          mtimeMs: BASE_TIME_MS + index * 1_000,
        });
      }

      const result = runList(directory, [
        "--agent",
        "target-agent",
        "--limit",
        "20",
      ]);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("target-old");
      expect(result.stdout).not.toContain(
        "No trajectories matched the filter.",
      );
    }));

  test("limit one returns only the newest matching trajectory", () =>
    withFixture((directory) => {
      writeTrajectory(directory, {
        id: "match-old",
        agent: "target-agent",
        mtimeMs: BASE_TIME_MS,
      });
      writeTrajectory(directory, {
        id: "match-new",
        agent: "target-agent",
        mtimeMs: BASE_TIME_MS + 2_000,
      });

      const result = runList(directory, [
        "--agent",
        "target-agent",
        "--limit",
        "1",
      ]);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("match-new");
      expect(result.stdout).not.toContain("match-old");
    }));

  test("non-canonical --limit values fail closed instead of listing the wrong count", () =>
    withFixture((directory) => {
      for (let index = 1; index <= 5; index++) {
        writeTrajectory(directory, {
          id: `row-${index}`,
          agent: "target-agent",
          mtimeMs: BASE_TIME_MS + index * 1_000,
        });
      }

      // parseInt("1e3") is 1 and parseInt("abc") is NaN (treated as
      // "flag omitted"), so both used to succeed with the wrong row count.
      for (const bad of ["1e3", "abc", "20foo", "-5", "0x10", "0", " 2 "]) {
        const result = runList(directory, ["--limit", bad]);
        expect(result.status).toBe(2);
        expect(result.stderr).toContain("--limit");
        expect(result.stdout).not.toContain("row-");
      }
    }));

  test("a present --limit without a value fails before listing", () =>
    withFixture((directory) => {
      writeTrajectory(directory, {
        id: "must-not-list",
        agent: "target-agent",
        mtimeMs: BASE_TIME_MS,
      });

      for (const args of [
        ["--limit"],
        ["--limit", "--agent", "target-agent"],
        ["--limit="],
      ]) {
        const result = runList(directory, args);
        expect(result.status).toBe(2);
        expect(result.stderr).toContain("--limit requires a value");
        expect(result.stdout).not.toContain("must-not-list");
      }
    }));

  test("malformed and since-filtered files do not consume the result limit", () =>
    withFixture((directory) => {
      writeTrajectory(directory, {
        id: "match-old",
        agent: "target-agent",
        mtimeMs: BASE_TIME_MS,
        startedAt: BASE_TIME_MS + 5_000,
      });
      writeTrajectory(directory, {
        id: "match-new",
        agent: "target-agent",
        mtimeMs: BASE_TIME_MS + 1_000,
        startedAt: BASE_TIME_MS + 6_000,
      });
      writeTrajectory(directory, {
        id: "before-cutoff",
        agent: "target-agent",
        mtimeMs: BASE_TIME_MS + 2_000,
        startedAt: BASE_TIME_MS - 1_000,
      });
      const malformedPath = writeMalformedTrajectory(
        directory,
        "malformed",
        BASE_TIME_MS + 3_000,
      );

      const result = runList(directory, [
        "--since",
        new Date(BASE_TIME_MS).toISOString(),
        "--limit",
        "2",
      ]);

      expect(result.status).toBe(0);
      expect(result.stderr).toContain(`skip ${malformedPath}:`);
      expect(result.stdout).toContain("match-new");
      expect(result.stdout).toContain("match-old");
      expect(result.stdout).not.toContain("before-cutoff");
    }));

  test("preserves the no-match message", () =>
    withFixture((directory) => {
      writeTrajectory(directory, {
        id: "other-agent-only",
        agent: "other-agent",
        mtimeMs: BASE_TIME_MS,
      });

      const result = runList(directory, ["--agent", "target-agent"]);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.trim()).toBe("No trajectories matched the filter.");
    }));
});
