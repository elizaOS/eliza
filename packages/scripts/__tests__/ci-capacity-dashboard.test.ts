/**
 * Fixture tests for the CI capacity dashboard. The harness stays offline: live
 * GitHub access belongs to the CLI path, while the capacity classifier is
 * deterministic over captured `actions/runners` + `actions/runs` shapes.
 */

import { describe, expect, test } from "bun:test";

const capacity = await import(
  new URL("../ci-capacity-dashboard.mjs", import.meta.url).href
);

const runners = {
  total_count: 4,
  runners: [
    { name: "robot-1", status: "online", busy: true },
    { name: "robot-2", status: "online", busy: false },
    { name: "robot-3", status: "online", busy: true },
    { name: "robot-4", status: "offline", busy: false },
  ],
};

describe("ci-capacity-dashboard", () => {
  test("summarizeRunners counts online/idle/busy from a runners response", () => {
    expect(capacity.summarizeRunners(runners)).toEqual({
      total: 4,
      online: 3,
      offline: 1,
      busy: 2,
      idle: 1,
    });
  });

  test("summarizeRuns reads queue depth from total_count, not the page", () => {
    const summary = capacity.summarizeRuns({
      total_count: 512,
      workflow_runs: [
        { name: "Env Audit", event: "pull_request" },
        { name: "Env Audit", event: "pull_request" },
        { name: "Quality", event: "push" },
      ],
    });
    expect(summary.total).toBe(512);
    expect(summary.sampled).toBe(3);
    expect(summary.pullRequestRuns).toBe(2);
    expect(summary.byWorkflow).toEqual({ "Env Audit": 2, Quality: 1 });
  });

  test("computeCapacity flags an oversubscribed fleet with the tuning ratio", () => {
    const report = capacity.computeCapacity({
      runners,
      queued: { total_count: 90, workflow_runs: [] },
      inProgress: { total_count: 3, workflow_runs: [] },
    });
    // 3 online runners, 93 active runs -> 31x oversubscription.
    expect(report.onlineRunners).toBe(3);
    expect(report.idleRunners).toBe(1);
    expect(report.activeRuns).toBe(93);
    expect(report.oversubscription).toBe(31);
    expect(report.verdict).toBe("oversubscribed");
  });

  test("computeCapacity reports headroom when the queue is empty", () => {
    const report = capacity.computeCapacity({
      runners,
      queued: { total_count: 0, workflow_runs: [] },
      inProgress: { total_count: 0, workflow_runs: [] },
    });
    expect(report.verdict).toBe("idle");
    expect(report.oversubscription).toBe(0);
  });

  test("classifyLoad thresholds: healthy <=1x, saturated <=2x", () => {
    const base = { online: 40, idle: 0, queuedRuns: 20 };
    expect(capacity.classifyLoad({ ...base, oversubscription: 0.9 })).toBe(
      "healthy",
    );
    expect(capacity.classifyLoad({ ...base, oversubscription: 1.8 })).toBe(
      "saturated",
    );
    expect(capacity.classifyLoad({ ...base, oversubscription: 5 })).toBe(
      "oversubscribed",
    );
    expect(
      capacity.classifyLoad({
        online: 0,
        idle: 0,
        queuedRuns: 0,
        oversubscription: null,
      }),
    ).toBe("fleet-offline");
  });

  test("normalizeRuns tolerates a bare array of runs", () => {
    const summary = capacity.summarizeRuns([{ name: "A" }, { name: "B" }]);
    expect(summary.total).toBe(2);
    expect(summary.sampled).toBe(2);
  });
});
