// @vitest-environment jsdom

/**
 * Covers `dispatchCloudHandoffPhase`: each phase (migrating, done, …) is emitted
 * on the window as a CLOUD_HANDOFF_PHASE_EVENT CustomEvent carrying the agent id
 * and phase. Listens on the jsdom window.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetLastCloudHandoffPhaseDetailForTests,
  CHAT_OPEN_EVENT,
  CHAT_PREFILL_EVENT,
  CLOUD_HANDOFF_PHASE_EVENT,
  CLOUD_HANDOFF_RETRY_EVENT,
  type CloudHandoffPhaseDetail,
  clearPendingFocusConnector,
  dispatchBackIntent,
  dispatchChatOpen,
  dispatchChatPrefill,
  dispatchCloudHandoffPhase,
  dispatchCloudHandoffRetry,
  dispatchFocusConnector,
  dispatchOpenNotificationCenter,
  dispatchVoiceControl,
  ELIZA_BACK_INTENT_EVENT,
  FOCUS_CONNECTOR_EVENT,
  getLastCloudHandoffPhaseDetail,
  OPEN_NOTIFICATION_CENTER_EVENT,
  readPendingFocusConnector,
  VOICE_CONTROL_EVENT,
} from "./index";

describe("dispatchCloudHandoffPhase", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function capture(): CloudHandoffPhaseDetail[] {
    const seen: CloudHandoffPhaseDetail[] = [];
    window.addEventListener(CLOUD_HANDOFF_PHASE_EVENT, (event) => {
      seen.push((event as CustomEvent<CloudHandoffPhaseDetail>).detail);
    });
    return seen;
  }

  it("emits the in-flight migrating phase", () => {
    const seen = capture();
    dispatchCloudHandoffPhase({ agentId: "agent-1", phase: "migrating" });
    expect(seen).toEqual([{ agentId: "agent-1", phase: "migrating" }]);
  });

  it("carries the imported count on a successful switch", () => {
    const seen = capture();
    dispatchCloudHandoffPhase({
      agentId: "agent-1",
      phase: "switched",
      imported: 3,
    });
    expect(seen[0]).toEqual({
      agentId: "agent-1",
      phase: "switched",
      imported: 3,
    });
  });

  it("carries the error on a failed handoff (no longer silently discarded)", () => {
    const seen = capture();
    dispatchCloudHandoffPhase({
      agentId: "agent-1",
      phase: "failed",
      error: "container import failed (HTTP 500)",
    });
    expect(seen[0]).toEqual({
      agentId: "agent-1",
      phase: "failed",
      error: "container import failed (HTTP 500)",
    });
  });

  it("surfaces every terminal handoff status as a distinct phase", () => {
    const seen = capture();
    for (const phase of [
      "switched",
      "switched-empty",
      "timed-out",
      "failed",
    ] as const) {
      dispatchCloudHandoffPhase({ agentId: "agent-1", phase });
    }
    expect(seen.map((d) => d.phase)).toEqual([
      "switched",
      "switched-empty",
      "timed-out",
      "failed",
    ]);
  });
});

describe("last-phase cache for late-mounting surfaces", () => {
  beforeEach(() => {
    __resetLastCloudHandoffPhaseDetailForTests();
  });

  it("starts null before any dispatch (a fresh session has no in-flight phase)", () => {
    expect(getLastCloudHandoffPhaseDetail()).toBeNull();
  });

  it("returns the most recent dispatched phase so a tile mounting AFTER the runner's initial dispatch still sees it", () => {
    dispatchCloudHandoffPhase({ agentId: "agent-1", phase: "migrating" });
    expect(getLastCloudHandoffPhaseDetail()).toEqual({
      agentId: "agent-1",
      phase: "migrating",
    });
    dispatchCloudHandoffPhase({
      agentId: "agent-1",
      phase: "switched",
      imported: 2,
    });
    expect(getLastCloudHandoffPhaseDetail()).toEqual({
      agentId: "agent-1",
      phase: "switched",
      imported: 2,
    });
  });

  it("forgets the cached phase on the test-only reset", () => {
    dispatchCloudHandoffPhase({ agentId: "agent-1", phase: "failed" });
    __resetLastCloudHandoffPhaseDetailForTests();
    expect(getLastCloudHandoffPhaseDetail()).toBeNull();
  });
});

describe("UI-only event dispatch helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.sessionStorage.clear();
  });

  function captureWindow(name: string): Array<unknown> {
    const seen: unknown[] = [];
    window.addEventListener(name, (event) => {
      seen.push((event as CustomEvent).detail);
    });
    return seen;
  }

  it("dispatchCloudHandoffRetry emits the retry request with the agent id", () => {
    const seen = captureWindow(CLOUD_HANDOFF_RETRY_EVENT);
    dispatchCloudHandoffRetry({ agentId: "agent-1" });
    expect(seen).toEqual([{ agentId: "agent-1" }]);
  });

  it("dispatchVoiceControl emits start/stop commands", () => {
    const seen = captureWindow(VOICE_CONTROL_EVENT);
    dispatchVoiceControl({ command: "start" });
    dispatchVoiceControl({ command: "stop" });
    expect(seen).toEqual([{ command: "start" }, { command: "stop" }]);
  });

  it("dispatchChatPrefill and dispatchChatOpen reach window listeners", () => {
    const prefill = captureWindow(CHAT_PREFILL_EVENT);
    const opens = captureWindow(CHAT_OPEN_EVENT);
    dispatchChatPrefill({ text: "hello", select: true });
    dispatchChatOpen();
    expect(prefill).toEqual([{ text: "hello", select: true }]);
    expect(opens).toHaveLength(1);
  });

  it("dispatchOpenNotificationCenter emits the surface-agnostic open request", () => {
    const seen = captureWindow(OPEN_NOTIFICATION_CENTER_EVENT);
    dispatchOpenNotificationCenter();
    expect(seen).toHaveLength(1);
  });

  it("dispatchBackIntent returns false at rest and true once a consumer handles it", () => {
    expect(dispatchBackIntent()).toBe(false);
    const handler = (event: Event) => {
      (event as CustomEvent<{ handled: boolean }>).detail.handled = true;
    };
    window.addEventListener(ELIZA_BACK_INTENT_EVENT, handler);
    expect(dispatchBackIntent()).toBe(true);
    window.removeEventListener(ELIZA_BACK_INTENT_EVENT, handler);
  });

  it("dispatchFocusConnector stores the pending hint, dispatches on document, and clear respects the id guard", () => {
    const seen: unknown[] = [];
    document.addEventListener(FOCUS_CONNECTOR_EVENT, (event) => {
      seen.push((event as CustomEvent).detail);
    });

    dispatchFocusConnector("  discord  ");
    expect(seen).toEqual([{ connectorId: "discord" }]);
    expect(readPendingFocusConnector()).toBe("discord");

    // Clearing for a DIFFERENT connector must not drop the pending hint.
    clearPendingFocusConnector("telegram");
    expect(readPendingFocusConnector()).toBe("discord");
    clearPendingFocusConnector("discord");
    expect(readPendingFocusConnector()).toBeNull();

    // Blank input dispatches nothing.
    dispatchFocusConnector("   ");
    expect(seen).toHaveLength(1);
  });
});
