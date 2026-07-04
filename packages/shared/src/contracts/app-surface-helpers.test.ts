import { describe, expect, it } from "vitest";
import {
  formatDetailTimestamp,
  selectLatestRunForApp,
  toneForHealthState,
  toneForStatusText,
  toneForViewerAttachment,
} from "./app-surface-helpers.js";
import type { AppRunSummary } from "./apps.js";

function makeRun(
  appName: string,
  overrides: Partial<AppRunSummary> = {},
): AppRunSummary {
  return {
    runId: `${appName}-${overrides.startedAt ?? "0"}`,
    appName,
    displayName: appName,
    pluginName: appName,
    launchType: "overlay",
    launchUrl: null,
    viewer: null,
    session: null,
    characterId: null,
    agentId: null,
    status: "running",
    summary: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastHeartbeatAt: null,
    supportsBackground: false,
    supportsViewerDetach: false,
    chatAvailability: "unknown",
    controlAvailability: "unknown",
    viewerAttachment: "unavailable",
    recentEvents: [],
    awaySummary: null,
    health: { state: "healthy", message: null },
    healthDetails: {
      checkedAt: null,
      auth: { state: "unknown", message: null },
      runtime: { state: "unknown", message: null },
      viewer: { state: "unknown", message: null },
      chat: { state: "unknown", message: null },
      control: { state: "unknown", message: null },
      message: null,
    },
    ...overrides,
  };
}

describe("selectLatestRunForApp", () => {
  it("returns the most recent matching run and filters other apps out", () => {
    const runs: AppRunSummary[] = [
      makeRun("@elizaos/plugin-feed", {
        startedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      makeRun("@elizaos/plugin-feed", {
        startedAt: "2026-01-02T00:00:00.000Z",
        updatedAt: "2026-01-03T00:00:00.000Z",
      }),
      makeRun("@elizaos/plugin-other", {
        startedAt: "2026-01-09T00:00:00.000Z",
        updatedAt: "2026-01-09T00:00:00.000Z",
      }),
    ];
    const result = selectLatestRunForApp("@elizaos/plugin-feed", runs);
    expect(result.matchingRuns).toHaveLength(2);
    expect(result.run?.updatedAt).toBe("2026-01-03T00:00:00.000Z");
    expect(
      result.matchingRuns.every((r) => r.appName === "@elizaos/plugin-feed"),
    ).toBe(true);
  });

  it("prefers the larger of updatedAt / startedAt when ordering", () => {
    const runs: AppRunSummary[] = [
      makeRun("app", {
        startedAt: "2026-01-05T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      makeRun("app", {
        startedAt: "2026-01-02T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      }),
    ];
    // First run has the later startedAt (Jan 5) even though its updatedAt is
    // older, so it must sort first.
    expect(selectLatestRunForApp("app", runs).run?.startedAt).toBe(
      "2026-01-05T00:00:00.000Z",
    );
  });

  it("returns an empty selection for null / non-array / no-match input", () => {
    expect(selectLatestRunForApp("app", null)).toEqual({
      run: null,
      matchingRuns: [],
    });
    expect(selectLatestRunForApp("app", undefined)).toEqual({
      run: null,
      matchingRuns: [],
    });
    expect(selectLatestRunForApp("app", [makeRun("other")]).run).toBeNull();
  });
});

describe("formatDetailTimestamp", () => {
  it("formats a numeric epoch and an ISO string", () => {
    expect(formatDetailTimestamp(0)).not.toBe("Not yet verified");
    expect(formatDetailTimestamp("2026-01-01T00:00:00.000Z")).not.toBe(
      "Not yet verified",
    );
  });

  it("returns the sentinel for empty / invalid / nullish values", () => {
    expect(formatDetailTimestamp(null)).toBe("Not yet verified");
    expect(formatDetailTimestamp(undefined)).toBe("Not yet verified");
    expect(formatDetailTimestamp("")).toBe("Not yet verified");
    expect(formatDetailTimestamp("   ")).toBe("Not yet verified");
    expect(formatDetailTimestamp("not-a-date")).toBe("Not yet verified");
    expect(formatDetailTimestamp(Number.NaN)).toBe("Not yet verified");
  });
});

describe("tone helpers", () => {
  it("maps health state to tone", () => {
    expect(toneForHealthState("healthy")).toBe("success");
    expect(toneForHealthState("degraded")).toBe("warn");
    expect(toneForHealthState("offline")).toBe("danger");
    expect(toneForHealthState(null)).toBe("neutral");
    expect(toneForHealthState(undefined)).toBe("neutral");
  });

  it("maps viewer attachment to tone", () => {
    expect(toneForViewerAttachment("attached")).toBe("success");
    expect(toneForViewerAttachment("detached")).toBe("warn");
    expect(toneForViewerAttachment("unavailable")).toBe("neutral");
    expect(toneForViewerAttachment(null)).toBe("neutral");
  });

  it("maps free-text status to tone by keyword", () => {
    expect(toneForStatusText("running")).toBe("success");
    expect(toneForStatusText("Agent ready")).toBe("success");
    expect(toneForStatusText("warning: retry")).toBe("warn");
    expect(toneForStatusText("waiting for auth")).toBe("warn");
    expect(toneForStatusText("fatal error")).toBe("danger");
    expect(toneForStatusText("launch failed")).toBe("danger");
    expect(toneForStatusText("idle")).toBe("neutral");
    expect(toneForStatusText(null)).toBe("neutral");
    expect(toneForStatusText("")).toBe("neutral");
  });
});
