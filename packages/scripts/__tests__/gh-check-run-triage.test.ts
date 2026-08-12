/**
 * Fixture tests for the GitHub check-run triage helper. The harness stays
 * offline: live GitHub access belongs to the CLI path, while the classifier is
 * deterministic over captured check-run shapes.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { fileURLToPath } from "node:url";

const triage = await import(
  new URL("../gh-check-run-triage.mjs", import.meta.url).href
);

const cliPath = fileURLToPath(
  new URL("../gh-check-run-triage.mjs", import.meta.url),
);

function runCliWithFixture(checkRuns: unknown): {
  status: number | null;
  stdout: string;
} {
  const dir = mkdtempSync(path.join(tmpdir(), "gh-check-run-triage-"));
  try {
    const fixturePath = path.join(dir, "check-runs.json");
    writeFileSync(fixturePath, JSON.stringify({ check_runs: checkRuns }));
    const result = spawnSync(
      process.execPath,
      [cliPath, "--input", fixturePath, "--fail", "--json"],
      { encoding: "utf8" },
    );
    return { status: result.status, stdout: result.stdout };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("gh-check-run-triage", () => {
  test("reports only latest completed failure-like checks as actionable", () => {
    const checkRuns = [
      {
        id: 1,
        name: "Type Check",
        status: "completed",
        conclusion: "timed_out",
        completed_at: "2026-07-05T10:00:00Z",
      },
      {
        id: 2,
        name: "Type Check",
        status: "completed",
        conclusion: "success",
        completed_at: "2026-07-05T10:10:00Z",
      },
      {
        id: 3,
        name: "Lint",
        status: "completed",
        conclusion: "failure",
        completed_at: "2026-07-05T10:11:00Z",
      },
      {
        id: 4,
        name: "Build",
        status: "completed",
        conclusion: "cancelled",
        completed_at: "2026-07-05T10:12:00Z",
      },
      {
        id: 5,
        name: "Security",
        status: "queued",
        conclusion: null,
        started_at: null,
      },
    ];

    const classified = triage.classifyCheckRuns(checkRuns);

    expect(classified.actionableFailures.map((run) => run.name)).toEqual([
      "Lint",
    ]);
    expect(classified.superseded.map((run) => run.id)).toEqual([1]);
    expect(classified.current.map((run) => run.name)).toEqual([
      "Build",
      "Lint",
      "Security",
      "Type Check",
    ]);
  });

  test("normalizes paginated GitHub check-run responses", () => {
    const normalized = triage.normalizeCheckRuns([
      { check_runs: [{ id: 1, name: "first" }] },
      { check_runs: [{ id: 2, name: "second" }] },
    ]);

    expect(normalized.map((run) => run.name)).toEqual(["first", "second"]);
  });

  test.each([
    ["success", false],
    ["neutral", false],
    ["skipped", false],
    ["cancelled", false],
    ["failure", true],
    ["timed_out", true],
    ["action_required", true],
    ["startup_failure", true],
    ["stale", true],
  ])("classifies completed %s checks", (conclusion, actionable) => {
    expect(
      triage.isActionableCheckRun({ status: "completed", conclusion }),
    ).toBe(actionable);
  });

  test("fails closed for unknown completed conclusions", () => {
    expect(
      triage.isActionableCheckRun({
        status: "completed",
        conclusion: "new_github_conclusion",
      }),
    ).toBe(true);
    expect(
      triage.isActionableCheckRun({
        status: "in_progress",
        conclusion: "failure",
      }),
    ).toBe(false);
  });

  test("--fail exits nonzero for a timeout and zero for cancellation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "check-run-triage-"));
    try {
      const runCli = async (conclusion: string) => {
        const input = join(directory, `${conclusion}.json`);
        await writeFile(
          input,
          JSON.stringify({
            check_runs: [
              {
                id: 1,
                name: "Build",
                status: "completed",
                conclusion,
                completed_at: "2026-08-12T00:00:00Z",
              },
            ],
          }),
        );
        return spawnSync(
          process.execPath,
          [cliPath, "--input", input, "--fail"],
          {
            encoding: "utf8",
          },
        );
      };

      const timeout = await runCli("timed_out");
      expect(timeout.status).toBe(1);
      expect(timeout.stdout).toContain("1 actionable failure(s)");
      expect(timeout.stdout).toContain("Build: timed_out");

      const cancelled = await runCli("cancelled");
      expect(cancelled.status).toBe(0);
      expect(cancelled.stdout).toContain("0 actionable failure(s)");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("a same-named success from another App does not supersede a failure (#18568)", () => {
    const classified = triage.classifyCheckRuns([
      {
        id: 1,
        name: "Build",
        app: { id: 100 },
        status: "completed",
        conclusion: "failure",
        completed_at: "2026-08-12T00:00:00Z",
      },
      {
        id: 2,
        name: "Build",
        app: { id: 200 },
        status: "completed",
        conclusion: "success",
        completed_at: "2026-08-12T00:01:00Z",
      },
    ]);

    expect(classified.superseded).toEqual([]);
    expect(classified.current.map((run) => run.id)).toEqual([1, 2]);
    expect(classified.actionableFailures.map((run) => run.id)).toEqual([1]);
  });

  test("a retry from the same App still supersedes its own older attempt", () => {
    const classified = triage.classifyCheckRuns([
      {
        id: 1,
        name: "Build",
        app: { id: 100 },
        status: "completed",
        conclusion: "failure",
        completed_at: "2026-08-12T00:00:00Z",
      },
      {
        id: 2,
        name: "Build",
        app: { id: 100 },
        status: "completed",
        conclusion: "success",
        completed_at: "2026-08-12T00:01:00Z",
      },
    ]);

    expect(classified.superseded.map((run) => run.id)).toEqual([1]);
    expect(classified.actionableFailures).toEqual([]);
  });

  test("a run without an app payload never merges into a real App's history", () => {
    const classified = triage.classifyCheckRuns([
      {
        id: 1,
        name: "Build",
        app: { id: 100 },
        status: "completed",
        conclusion: "failure",
        completed_at: "2026-08-12T00:00:00Z",
      },
      {
        id: 2,
        name: "Build",
        status: "completed",
        conclusion: "success",
        completed_at: "2026-08-12T00:01:00Z",
      },
    ]);

    expect(classified.superseded).toEqual([]);
    expect(classified.actionableFailures.map((run) => run.id)).toEqual([1]);
  });

  test("slug-only records without app.id keep the legacy name-only fallback", () => {
    const classified = triage.classifyCheckRuns([
      {
        id: 1,
        name: "Build",
        app: { slug: "app-a" },
        status: "completed",
        conclusion: "failure",
        completed_at: "2026-08-12T00:00:00Z",
      },
      {
        id: 2,
        name: "Build",
        app: { slug: "app-b" },
        status: "completed",
        conclusion: "success",
        completed_at: "2026-08-12T00:01:00Z",
      },
    ]);

    expect(classified.current.map((run) => run.id)).toEqual([2]);
    expect(classified.superseded.map((run) => run.id)).toEqual([1]);
    expect(classified.actionableFailures).toEqual([]);
  });

  test("same-named current runs order deterministically by App identity", () => {
    const runs = [
      {
        id: 2,
        name: "Build",
        app: { id: 200 },
        status: "completed",
        conclusion: "success",
        completed_at: "2026-08-12T00:01:00Z",
      },
      {
        id: 1,
        name: "Build",
        app: { id: 100 },
        status: "completed",
        conclusion: "failure",
        completed_at: "2026-08-12T00:00:00Z",
      },
    ];

    const forward = triage.classifyCheckRuns(runs);
    const reversed = triage.classifyCheckRuns([...runs].reverse());

    expect(forward.current.map((run) => run.id)).toEqual([1, 2]);
    expect(reversed.current.map((run) => run.id)).toEqual([1, 2]);
  });

  test("--fail exits 1 for a cross-App failure and 0 once the owning App recovers", () => {
    const crossApp = runCliWithFixture([
      {
        id: 1,
        name: "Build",
        app: { id: 100 },
        status: "completed",
        conclusion: "failure",
        completed_at: "2026-08-12T00:00:00Z",
      },
      {
        id: 2,
        name: "Build",
        app: { id: 200 },
        status: "completed",
        conclusion: "success",
        completed_at: "2026-08-12T00:01:00Z",
      },
    ]);
    expect(crossApp.status).toBe(1);
    expect(
      JSON.parse(crossApp.stdout).actionableFailures.map(
        (run: { id: number }) => run.id,
      ),
    ).toEqual([1]);

    const recovered = runCliWithFixture([
      {
        id: 1,
        name: "Build",
        app: { id: 100 },
        status: "completed",
        conclusion: "failure",
        completed_at: "2026-08-12T00:00:00Z",
      },
      {
        id: 3,
        name: "Build",
        app: { id: 100 },
        status: "completed",
        conclusion: "success",
        completed_at: "2026-08-12T00:02:00Z",
      },
    ]);
    expect(recovered.status).toBe(0);
    expect(JSON.parse(recovered.stdout).actionableFailures).toEqual([]);
  });
});
