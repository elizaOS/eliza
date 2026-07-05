// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLOUD_HANDOFF_PHASE_EVENT,
  type CloudHandoffPhaseDetail,
} from "../events";
import { useCloudHandoffPhase } from "./useCloudHandoffPhase";

function emit(detail: CloudHandoffPhaseDetail) {
  act(() => {
    window.dispatchEvent(
      new CustomEvent(CLOUD_HANDOFF_PHASE_EVENT, { detail }),
    );
  });
}

describe("useCloudHandoffPhase", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("starts empty and holds the migrating phase while the container boots", () => {
    const { result } = renderHook(() => useCloudHandoffPhase());
    expect(result.current).toBeNull();

    emit({ agentId: "a1", phase: "migrating" });
    expect(result.current?.phase).toBe("migrating");

    // migrating has no auto-dismiss — it persists until the swap resolves.
    act(() => vi.advanceTimersByTime(60_000));
    expect(result.current?.phase).toBe("migrating");
  });

  it("auto-clears a success phase after its linger window", () => {
    const { result } = renderHook(() => useCloudHandoffPhase());
    emit({ agentId: "a1", phase: "switched", imported: 3 });
    expect(result.current?.phase).toBe("switched");

    act(() => vi.advanceTimersByTime(4000));
    expect(result.current).toBeNull();
  });

  it("keeps a failure visible until retried (no silent auto-dismiss)", () => {
    const { result } = renderHook(() => useCloudHandoffPhase());
    emit({ agentId: "a1", phase: "failed", error: "boom" });
    expect(result.current?.phase).toBe("failed");

    // The failure must NOT self-dismiss — it stays so the user can retry.
    act(() => vi.advanceTimersByTime(60_000));
    expect(result.current?.phase).toBe("failed");
  });

  it("keeps a timed-out handoff visible until retried", () => {
    const { result } = renderHook(() => useCloudHandoffPhase());
    emit({ agentId: "a1", phase: "timed-out" });
    expect(result.current?.phase).toBe("timed-out");

    act(() => vi.advanceTimersByTime(60_000));
    expect(result.current?.phase).toBe("timed-out");
  });
});

// The floating CloudHandoffBanner was removed: failure/timeout phases now
// surface as the in-chat boot-recovery card (use-boot-recovery-conductor.test
// covers the retry-handoff control) and the home-grid agent-provisioning tile
// remains the durable surface.
