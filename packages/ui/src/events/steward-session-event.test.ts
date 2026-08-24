/**
 * Verifies the Steward session-change event surface the UI package re-exports
 * from @elizaos/shared/steward-session-client: the re-export wiring, the
 * window CustomEvent contract, and the epoch / SSR behaviour behind
 * dispatchStewardSessionChange. Listens on the jsdom window.
 */
// @vitest-environment jsdom

import {
  STEWARD_SESSION_CHANGE_EVENT as CANONICAL_STEWARD_SESSION_CHANGE_EVENT,
  dispatchStewardSessionChange as canonicalDispatchStewardSessionChange,
} from "@elizaos/shared/steward-session-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dispatchStewardSessionChange,
  STEWARD_SESSION_CHANGE_EVENT,
  type StewardSessionChangeDetail,
} from "./steward-session-event";

function captureTransitions(): {
  seen: StewardSessionChangeDetail[];
  events: Event[];
  stop: () => void;
} {
  const seen: StewardSessionChangeDetail[] = [];
  const events: Event[] = [];
  const listener = (event: Event) => {
    events.push(event);
    seen.push((event as CustomEvent<StewardSessionChangeDetail>).detail);
  };
  window.addEventListener(STEWARD_SESSION_CHANGE_EVENT, listener);
  return {
    seen,
    events,
    stop: () =>
      window.removeEventListener(STEWARD_SESSION_CHANGE_EVENT, listener),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("steward-session-event re-export surface", () => {
  it("re-exports the canonical shared implementation, not a copy", () => {
    expect(dispatchStewardSessionChange).toBe(
      canonicalDispatchStewardSessionChange,
    );
    expect(STEWARD_SESSION_CHANGE_EVENT).toBe(
      CANONICAL_STEWARD_SESSION_CHANGE_EVENT,
    );
  });

  it("exposes the stable steward-session-change event name", () => {
    expect(STEWARD_SESSION_CHANGE_EVENT).toBe("steward-session-change");
  });
});

describe("dispatchStewardSessionChange", () => {
  it("publishes typed transitions to window listeners in dispatch order", () => {
    const capture = captureTransitions();
    try {
      dispatchStewardSessionChange("present");
      dispatchStewardSessionChange("cleared");
      dispatchStewardSessionChange("present");
    } finally {
      capture.stop();
    }

    expect(capture.seen.map(({ state }) => state)).toEqual([
      "present",
      "cleared",
      "present",
    ]);
    expect(capture.events[0]?.type).toBe(STEWARD_SESSION_CHANGE_EVENT);

    const [first, second, third] = capture.seen;
    expect(second?.sessionEpoch).toBeGreaterThan(first?.sessionEpoch ?? 0);
    expect(third?.sessionEpoch).toBeGreaterThan(second?.sessionEpoch ?? 0);
  });

  it("advances the session epoch by exactly one per browser dispatch", () => {
    const capture = captureTransitions();
    try {
      dispatchStewardSessionChange("present");
    } finally {
      capture.stop();
    }
    const baseEpoch = capture.seen[0]?.sessionEpoch;

    const next = captureTransitions();
    try {
      dispatchStewardSessionChange("cleared");
    } finally {
      next.stop();
    }

    expect(next.seen).toEqual([
      { state: "cleared", sessionEpoch: (baseEpoch ?? 0) + 1 },
    ]);
  });

  it("is a no-op outside the browser: no throw and no consumed epoch", () => {
    const capture = captureTransitions();
    try {
      dispatchStewardSessionChange("present");
    } finally {
      capture.stop();
    }
    const baseEpoch = capture.seen[0]?.sessionEpoch;

    vi.stubGlobal("window", undefined);
    expect(() => dispatchStewardSessionChange("present")).not.toThrow();
    vi.unstubAllGlobals();

    const after = captureTransitions();
    try {
      dispatchStewardSessionChange("cleared");
    } finally {
      after.stop();
    }

    expect(after.seen).toEqual([
      { state: "cleared", sessionEpoch: (baseEpoch ?? 0) + 1 },
    ]);
  });
});
