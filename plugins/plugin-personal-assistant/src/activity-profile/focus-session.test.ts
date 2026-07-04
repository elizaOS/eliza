/**
 * Unit tests for owner focus-session detection: dwell-threshold gating on the
 * latest foreground app and partitioning of deferrable proactive actions.
 * Deterministic — foreground-app reporting is stubbed, no live tracker.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { ActivityForegroundApp } from "./activity-tracker-reporting.js";
import * as reporting from "./activity-tracker-reporting.js";
import {
  FOCUS_DEFERRABLE_KINDS,
  FOCUS_SESSION_MIN_MS,
  partitionFocusDeferredActions,
  readOwnerFocusSession,
  resolveFocusSession,
  shouldDeferDuringFocus,
} from "./focus-session.js";
import type { ProactiveAction } from "./types.js";

function foregroundApp(activeMs: number): ActivityForegroundApp {
  return {
    bundleId: "com.microsoft.VSCode",
    appName: "Code",
    observedAtMs: 1_700_000_000_000,
    activeMs,
  };
}

function action(kind: ProactiveAction["kind"]): ProactiveAction {
  return {
    kind,
    scheduledFor: 0,
    targetPlatform: "internal",
    contextSummary: "",
    messageText: "",
    status: "pending",
  };
}

describe("resolveFocusSession", () => {
  it("returns a session once dwell crosses the focus threshold", () => {
    const session = resolveFocusSession(foregroundApp(FOCUS_SESSION_MIN_MS));
    expect(session).not.toBeNull();
    expect(session?.app.appName).toBe("Code");
    expect(session?.focusedMs).toBe(FOCUS_SESSION_MIN_MS);
  });

  it("returns null below the threshold or when no app is foregrounded", () => {
    expect(
      resolveFocusSession(foregroundApp(FOCUS_SESSION_MIN_MS - 1)),
    ).toBeNull();
    expect(resolveFocusSession(null)).toBeNull();
  });
});

describe("shouldDeferDuringFocus", () => {
  it("defers only non-urgent goal check-ins", () => {
    expect(shouldDeferDuringFocus("goal_check_in")).toBe(true);
    for (const kind of [
      "gm",
      "gn",
      "pre_activity_nudge",
      "social_overuse_check",
    ] as const) {
      expect(shouldDeferDuringFocus(kind)).toBe(false);
    }
  });

  it("never defers a time-critical pre-activity meeting nudge", () => {
    expect(FOCUS_DEFERRABLE_KINDS.has("pre_activity_nudge")).toBe(false);
  });
});

describe("partitionFocusDeferredActions", () => {
  it("dispatches everything when no focus session is active", () => {
    const actions = [action("goal_check_in"), action("pre_activity_nudge")];
    const { dispatch, deferred } = partitionFocusDeferredActions(
      actions,
      false,
    );
    expect(dispatch).toHaveLength(2);
    expect(deferred).toHaveLength(0);
  });

  it("defers goal check-ins but passes time-critical nudges during focus", () => {
    const actions = [
      action("goal_check_in"),
      action("pre_activity_nudge"),
      action("social_overuse_check"),
    ];
    const { dispatch, deferred } = partitionFocusDeferredActions(actions, true);
    expect(deferred.map((a) => a.kind)).toEqual(["goal_check_in"]);
    expect(dispatch.map((a) => a.kind)).toEqual([
      "pre_activity_nudge",
      "social_overuse_check",
    ]);
  });
});

describe("readOwnerFocusSession", () => {
  const runtime = { agentId: "agent-1" } as unknown as IAgentRuntime;

  it("returns a session for a sustained foreground app", async () => {
    vi.spyOn(reporting, "getLatestForegroundActivity").mockResolvedValueOnce(
      foregroundApp(FOCUS_SESSION_MIN_MS + 5 * 60_000),
    );
    const session = await readOwnerFocusSession({
      runtime,
      now: new Date(1_700_000_000_000),
    });
    expect(session?.app.appName).toBe("Code");
    vi.restoreAllMocks();
  });

  it("returns null (no suppression) when the read throws", async () => {
    vi.spyOn(reporting, "getLatestForegroundActivity").mockRejectedValueOnce(
      new Error("db down"),
    );
    const session = await readOwnerFocusSession({
      runtime,
      now: new Date(1_700_000_000_000),
    });
    expect(session).toBeNull();
    vi.restoreAllMocks();
  });

  it("returns null when no app is foregrounded (idle/deactivated)", async () => {
    vi.spyOn(reporting, "getLatestForegroundActivity").mockResolvedValueOnce(
      null,
    );
    const session = await readOwnerFocusSession({
      runtime,
      now: new Date(1_700_000_000_000),
    });
    expect(session).toBeNull();
    vi.restoreAllMocks();
  });
});
