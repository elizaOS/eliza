/**
 * Covers ActivityTracker foreground-activity reporting: latest active app, null on a
 * trailing deactivation, and no fallback to a stale app when system inactivity is the most
 * recent event. Deterministic, mocked event store.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listActivityEvents: vi.fn(),
}));

vi.mock("@elizaos/plugin-health", () => ({
  isSystemInactivityApp: (event: { bundleId?: string; appName?: string }) =>
    event.bundleId === "com.apple.loginwindow" ||
    event.appName === "loginwindow",
}));

vi.mock("../src/activity-profile/activity-tracker-repo.js", () => ({
  listActivityEvents: mocks.listActivityEvents,
}));

import { getLatestForegroundActivity } from "../src/activity-profile/activity-tracker-reporting.js";

const RUNTIME = { agentId: "agent-activity" };
const SINCE_MS = Date.parse("2026-01-15T08:00:00.000Z");
const UNTIL_MS = Date.parse("2026-01-15T18:30:00.000Z");

function event(overrides: {
  observedAt: string;
  eventKind: "activate" | "deactivate";
  bundleId: string;
  appName: string;
}) {
  return {
    id: `event-${overrides.observedAt}`,
    agentId: "agent-activity",
    windowTitle: null,
    ...overrides,
  };
}

describe("getLatestForegroundActivity", () => {
  beforeEach(() => {
    mocks.listActivityEvents.mockReset();
  });

  it("returns the latest active foreground app", async () => {
    mocks.listActivityEvents.mockResolvedValueOnce([
      event({
        observedAt: "2026-01-15T17:00:00.000Z",
        eventKind: "activate",
        bundleId: "com.tinyspeck.slackmacgap",
        appName: "Slack",
      }),
      event({
        observedAt: "2026-01-15T18:00:00.000Z",
        eventKind: "activate",
        bundleId: "com.microsoft.VSCode",
        appName: "VS Code",
      }),
    ]);

    const current = await getLatestForegroundActivity(
      RUNTIME as never,
      "agent-activity",
      { sinceMs: SINCE_MS, untilMs: UNTIL_MS },
    );

    expect(current).toEqual({
      bundleId: "com.microsoft.VSCode",
      appName: "VS Code",
      observedAtMs: Date.parse("2026-01-15T18:00:00.000Z"),
      activeMs: 30 * 60_000,
    });
  });

  it("returns null when the latest real event is a deactivation", async () => {
    mocks.listActivityEvents.mockResolvedValueOnce([
      event({
        observedAt: "2026-01-15T18:00:00.000Z",
        eventKind: "activate",
        bundleId: "com.microsoft.VSCode",
        appName: "VS Code",
      }),
      event({
        observedAt: "2026-01-15T18:20:00.000Z",
        eventKind: "deactivate",
        bundleId: "com.microsoft.VSCode",
        appName: "VS Code",
      }),
    ]);

    await expect(
      getLatestForegroundActivity(RUNTIME as never, "agent-activity", {
        sinceMs: SINCE_MS,
        untilMs: UNTIL_MS,
      }),
    ).resolves.toBeNull();
  });

  it("does not fall back to a stale app when inactivity is latest", async () => {
    mocks.listActivityEvents.mockResolvedValueOnce([
      event({
        observedAt: "2026-01-15T18:00:00.000Z",
        eventKind: "activate",
        bundleId: "com.microsoft.VSCode",
        appName: "VS Code",
      }),
      event({
        observedAt: "2026-01-15T18:20:00.000Z",
        eventKind: "activate",
        bundleId: "com.apple.loginwindow",
        appName: "loginwindow",
      }),
    ]);

    await expect(
      getLatestForegroundActivity(RUNTIME as never, "agent-activity", {
        sinceMs: SINCE_MS,
        untilMs: UNTIL_MS,
      }),
    ).resolves.toBeNull();
  });
});
