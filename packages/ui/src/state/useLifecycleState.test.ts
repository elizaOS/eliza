// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLOUD_HANDOFF_PHASE_EVENT,
  type CloudHandoffPhaseDetail,
} from "../events";
import { useLifecycleState } from "./useLifecycleState";

function emitHandoff(detail: CloudHandoffPhaseDetail) {
  act(() => {
    window.dispatchEvent(
      new CustomEvent(CLOUD_HANDOFF_PHASE_EVENT, { detail }),
    );
  });
}

describe("useLifecycleState — cloud handoff phase", () => {
  afterEach(cleanup);

  it("starts with a null cloudHandoffPhase", () => {
    const { result } = renderHook(() => useLifecycleState());
    expect(result.current.state.cloudHandoffPhase).toBeNull();
  });

  it("mirrors the CLOUD_HANDOFF_PHASE_EVENT into lifecycle state", () => {
    const { result } = renderHook(() => useLifecycleState());

    emitHandoff({ agentId: "agent-1", phase: "migrating" });
    expect(result.current.state.cloudHandoffPhase).toEqual({
      agentId: "agent-1",
      phase: "migrating",
    });

    emitHandoff({ agentId: "agent-1", phase: "switched", imported: 3 });
    expect(result.current.state.cloudHandoffPhase?.phase).toBe("switched");
  });

  it("exposes a setCloudHandoffPhase setter that updates + clears", () => {
    const { result } = renderHook(() => useLifecycleState());

    act(() =>
      result.current.setCloudHandoffPhase({
        agentId: "agent-2",
        phase: "migrating",
      }),
    );
    expect(result.current.state.cloudHandoffPhase?.agentId).toBe("agent-2");

    act(() => result.current.setCloudHandoffPhase(null));
    expect(result.current.state.cloudHandoffPhase).toBeNull();
  });

  it("stops mirroring after unmount (listener cleanup)", () => {
    const { result, unmount } = renderHook(() => useLifecycleState());
    emitHandoff({ agentId: "agent-3", phase: "migrating" });
    expect(result.current.state.cloudHandoffPhase?.agentId).toBe("agent-3");

    unmount();
    // Dispatch after unmount must not throw (the listener was removed).
    expect(() =>
      window.dispatchEvent(
        new CustomEvent(CLOUD_HANDOFF_PHASE_EVENT, {
          detail: { agentId: "agent-3", phase: "failed" },
        }),
      ),
    ).not.toThrow();
  });
});
