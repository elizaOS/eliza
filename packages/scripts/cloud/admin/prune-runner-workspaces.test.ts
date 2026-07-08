/**
 * Exercises safe self-hosted runner workspace cleanup planning without touching
 * real runner paths.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRunnerWorkspacePrunePlan,
  findRunnerWorkDirs,
  parseRunnerWorkspacePruneArgs,
} from "./prune-runner-workspaces";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "runner-workspaces-test-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("parseRunnerWorkspacePruneArgs", () => {
  it("defaults to the prod runner root and dry-run off", () => {
    expect(parseRunnerWorkspacePruneArgs([], {})).toEqual({
      root: "/opt/actions-runners",
      minAgeHours: 6,
      dryRun: false,
      allowActive: false,
    });
  });

  it("accepts explicit root, age floor, dry-run, and active override", () => {
    expect(
      parseRunnerWorkspacePruneArgs(
        [
          "--root",
          "/tmp/runners",
          "--min-age-hours",
          "12",
          "--dry-run",
          "--allow-active",
        ],
        {},
      ),
    ).toEqual({
      root: "/tmp/runners",
      minAgeHours: 12,
      dryRun: true,
      allowActive: true,
    });
  });

  it("uses env fallback and rejects unsafe age values", () => {
    expect(
      parseRunnerWorkspacePruneArgs([], {
        RUNNER_WORKSPACE_ROOT: "/var/runners",
        RUNNER_WORKSPACE_MIN_AGE_HOURS: "24",
      }),
    ).toMatchObject({ root: "/var/runners", minAgeHours: 24 });

    expect(() =>
      parseRunnerWorkspacePruneArgs(["--min-age-hours", "0"], {}),
    ).toThrow("Invalid min-age-hours");
  });
});

describe("findRunnerWorkDirs", () => {
  it("discovers runner _work dirs under a runner root", () => {
    const root = tempRoot();
    const runnerWork = join(root, "runner-1", "_work");
    const nestedWork = join(root, "group", "_work");
    mkdirSync(runnerWork, { recursive: true });
    mkdirSync(nestedWork, { recursive: true });

    expect(findRunnerWorkDirs(root)).toEqual([runnerWork, nestedWork].sort());
  });
});

describe("buildRunnerWorkspacePrunePlan", () => {
  it("selects only stale children of _work directories", () => {
    const root = tempRoot();
    const work = join(root, "runner-1", "_work");
    const stale = join(work, "repo-old");
    const fresh = join(work, "repo-new");
    mkdirSync(stale, { recursive: true });
    mkdirSync(fresh, { recursive: true });
    writeFileSync(join(stale, "file.txt"), "old");
    writeFileSync(join(fresh, "file.txt"), "new");

    const now = Date.now();
    const oldDate = new Date(now - 8 * 60 * 60_000);
    const freshDate = new Date(now - 30 * 60_000);
    utimesSync(stale, oldDate, oldDate);
    utimesSync(fresh, freshDate, freshDate);

    const plan = buildRunnerWorkspacePrunePlan({
      root,
      now,
      minAgeHours: 6,
    });

    expect(plan.workDirs).toEqual([work]);
    expect(plan.entries.map((entry) => entry.path)).toEqual([stale]);
    expect(plan.skippedFresh).toBe(1);
    expect(plan.totalBytes).toBeGreaterThan(0);
  });
});
