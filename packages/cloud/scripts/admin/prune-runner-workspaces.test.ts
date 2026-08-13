/**
 * Exercises safe self-hosted runner workspace cleanup planning and its real CLI
 * failure boundary without touching real runner paths.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildRunnerWorkspacePrunePlan,
  findRunnerWorkDirs,
  parseRunnerWorkspacePruneArgs,
  RUNNER_MANAGED_WORK_ENTRIES,
} from "./prune-runner-workspaces";

const roots: string[] = [];
const runner = fileURLToPath(
  new URL("./prune-runner-workspaces.ts", import.meta.url),
);
const maxMinAgeHours = Math.floor(Number.MAX_SAFE_INTEGER / (60 * 60_000));

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

  it("uses env fallback and accepts exactly representable age bounds", () => {
    expect(
      parseRunnerWorkspacePruneArgs([], {
        RUNNER_WORKSPACE_ROOT: "/var/runners",
        RUNNER_WORKSPACE_MIN_AGE_HOURS: "24",
      }),
    ).toMatchObject({ root: "/var/runners", minAgeHours: 24 });

    expect(
      parseRunnerWorkspacePruneArgs(["--min-age-hours", "  +012  "], {}),
    ).toMatchObject({ minAgeHours: 12 });

    expect(
      parseRunnerWorkspacePruneArgs(
        ["--min-age-hours", String(maxMinAgeHours)],
        {},
      ),
    ).toMatchObject({ minAgeHours: maxMinAgeHours });
  });

  it("rejects malformed, non-positive, unsafe, and millisecond-overflowing ages", () => {
    for (const raw of [
      "",
      "0",
      "-5",
      "24oops",
      "1e3",
      "24.5",
      String(Number.MAX_SAFE_INTEGER + 1),
      String(maxMinAgeHours + 1),
    ]) {
      expect(() =>
        parseRunnerWorkspacePruneArgs(["--min-age-hours", raw], {}),
      ).toThrow("Invalid min-age-hours");
    }

    expect(() =>
      parseRunnerWorkspacePruneArgs([], {
        RUNNER_WORKSPACE_MIN_AGE_HOURS: "24oops",
      }),
    ).toThrow("Invalid min-age-hours");
  });

  it("rejects malformed age input at the real CLI boundary before pruning", () => {
    const result = spawnSync(
      process.execPath,
      [runner, "--root", tempRoot(), "--min-age-hours", "24oops", "--dry-run"],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Invalid min-age-hours: 24oops");
    expect(result.stdout).not.toContain("would remove");
  });

  it("rejects an unknown flag instead of silently running on defaults", () => {
    // A silently dropped flag reads as configured at the call site while the
    // tool prunes at its default window: a scheduled unit passing `--min-age 19`
    // kept pruning at 6h with no diagnostic anywhere.
    expect(() =>
      parseRunnerWorkspacePruneArgs(["--min-age", "19"], {}),
    ).toThrow("Unknown flag --min-age");

    expect(() =>
      parseRunnerWorkspacePruneArgs(
        ["--root", "/var/runners", "--nope", "1"],
        {},
      ),
    ).toThrow("Unknown flag --nope");
  });

  it("rejects a stray positional argument", () => {
    expect(() => parseRunnerWorkspacePruneArgs(["19"], {})).toThrow(
      "Unexpected argument: 19",
    );
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
  it("never selects runner-owned control directories", () => {
    const root = tempRoot();
    const work = join(root, "runner-1", "_work");
    const staleWorkspace = join(work, "repo-old");
    const runnerManaged = [
      "_actions",
      "_PipelineMapping",
      "_temp",
      "_tool",
      "_update",
    ];
    expect([...RUNNER_MANAGED_WORK_ENTRIES].sort()).toEqual(
      [...runnerManaged].sort(),
    );
    mkdirSync(staleWorkspace, { recursive: true });
    for (const name of runnerManaged) {
      const controlDir = join(work, name);
      mkdirSync(controlDir, { recursive: true });
      writeFileSync(join(controlDir, "runner-state"), name);
    }

    const now = Date.now();
    const oldDate = new Date(now - 8 * 60 * 60_000);
    utimesSync(staleWorkspace, oldDate, oldDate);
    for (const name of runnerManaged) {
      const controlDir = join(work, name);
      utimesSync(controlDir, oldDate, oldDate);
    }

    const plan = buildRunnerWorkspacePrunePlan({
      root,
      now,
      minAgeHours: 6,
    });

    expect(plan.entries.map((entry) => entry.path)).toEqual([staleWorkspace]);
    expect(plan.skippedFresh).toBe(0);
    expect(plan.skippedProtected).toBe(runnerManaged.length);
  });

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
    expect(plan.skippedProtected).toBe(0);
    expect(plan.totalBytes).toBeGreaterThan(0);
  });
});
