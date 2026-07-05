/**
 * Fixture tests for the GitHub check-run triage helper. The harness stays
 * offline: live GitHub access belongs to the CLI path, while the classifier is
 * deterministic over captured check-run shapes.
 */

import { describe, expect, test } from "bun:test";

const triage = await import(
  new URL("../gh-check-run-triage.mjs", import.meta.url).href
);

describe("gh-check-run-triage", () => {
  test("reports only latest completed failures as actionable", () => {
    const checkRuns = [
      {
        id: 1,
        name: "Type Check",
        status: "completed",
        conclusion: "failure",
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
});
