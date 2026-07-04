// @vitest-environment jsdom

/**
 * Covers `dispatchCloudHandoffPhase`: each phase (migrating, done, …) is emitted
 * on the window as a CLOUD_HANDOFF_PHASE_EVENT CustomEvent carrying the agent id
 * and phase. Listens on the jsdom window.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLOUD_HANDOFF_PHASE_EVENT,
  type CloudHandoffPhaseDetail,
  dispatchCloudHandoffPhase,
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
