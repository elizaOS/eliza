/** Verifies that the coordinator's resolved runtime topology remains observable after startup reaches the ready shell; the hook is driven deterministically through reducer events without a live backend. */

// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useStartupCoordinator } from "./useStartupCoordinator";

describe("useStartupCoordinator runtime target", () => {
  it("retains the managed Cloud target through hydration and ready", () => {
    const { result } = renderHook(() => useStartupCoordinator());

    act(() => {
      result.current.dispatch({
        type: "SESSION_RESTORED",
        target: "cloud-managed",
      });
    });
    act(() => {
      result.current.dispatch({ type: "BACKEND_POLL_RETRY" });
      result.current.dispatch({
        type: "BACKEND_REACHED",
        firstRunComplete: true,
      });
    });
    act(() => {
      result.current.dispatch({ type: "AGENT_RUNNING" });
    });

    expect(result.current.phase).toBe("hydrating");
    expect(result.current.target).toBe("cloud-managed");

    act(() => {
      result.current.dispatch({ type: "HYDRATION_COMPLETE" });
    });

    expect(result.current.phase).toBe("ready");
    expect(result.current.target).toBe("cloud-managed");
  });

  it("clears the retained target when a fresh restore begins", () => {
    const { result } = renderHook(() => useStartupCoordinator());

    act(() => {
      result.current.dispatch({
        type: "SESSION_RESTORED",
        target: "remote-backend",
      });
    });
    expect(result.current.target).toBe("remote-backend");

    act(() => {
      result.current.dispatch({ type: "RESET" });
    });

    expect(result.current.phase).toBe("restoring-session");
    expect(result.current.target).toBeNull();
  });
});
