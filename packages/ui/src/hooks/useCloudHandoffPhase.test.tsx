/** Verifies useCloudHandoffPhase through the package's configured test harness. */
// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetLastCloudHandoffPhaseDetailForTests,
  CLOUD_HANDOFF_PHASE_EVENT,
  type CloudHandoffPhaseDetail,
  dispatchCloudHandoffPhase,
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
  beforeEach(() => {
    vi.useFakeTimers();
    __resetLastCloudHandoffPhaseDetailForTests();
  });
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

  it("replays a migrating phase dispatched before the late subscriber mounts", () => {
    dispatchCloudHandoffPhase({ agentId: "a1", phase: "migrating" });

    const { result } = renderHook(() => useCloudHandoffPhase());

    expect(result.current).toEqual({ agentId: "a1", phase: "migrating" });
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

  it("keeps the insufficient-credits prompt visible until the user acts (never a silent shared fallback)", () => {
    const { result } = renderHook(() => useCloudHandoffPhase());
    emit({ agentId: "a1", phase: "insufficient-credits" });
    expect(result.current?.phase).toBe("insufficient-credits");

    // The credit-gate prompt must NOT self-dismiss — it stays so the user sees
    // the add-credits path instead of being silently kept on shared.
    act(() => vi.advanceTimersByTime(60_000));
    expect(result.current?.phase).toBe("insufficient-credits");
  });

  it("self-clears a stale success phase replayed to a late subscriber", () => {
    dispatchCloudHandoffPhase({
      agentId: "a1",
      phase: "switched",
      imported: 2,
    });

    const { result } = renderHook(() => useCloudHandoffPhase());

    expect(result.current).toEqual({
      agentId: "a1",
      phase: "switched",
      imported: 2,
    });
    // The seeded success still runs its normal linger clock — unlike a replayed
    // migrating phase, it is not allowed to outlive its window.
    act(() => vi.advanceTimersByTime(3999));
    expect(result.current?.phase).toBe("switched");

    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBeNull();
  });

  it("lingers then auto-clears the switched-empty success phase like switched", () => {
    const { result } = renderHook(() => useCloudHandoffPhase());
    emit({ agentId: "a1", phase: "switched-empty" });
    expect(result.current?.phase).toBe("switched-empty");

    act(() => vi.advanceTimersByTime(4000));
    expect(result.current).toBeNull();
  });

  it("cancels a pending success linger when a persisting phase replaces it", () => {
    const { result } = renderHook(() => useCloudHandoffPhase());
    emit({ agentId: "a1", phase: "switched" });
    expect(result.current?.phase).toBe("switched");

    // A failure arriving mid-linger must survive past the original deadline:
    // if the stale success timer were left armed it would blank the failure.
    act(() => vi.advanceTimersByTime(1000));
    emit({ agentId: "a1", phase: "failed", error: "swap lost" });
    expect(result.current?.phase).toBe("failed");

    act(() => vi.advanceTimersByTime(60_000));
    expect(result.current?.phase).toBe("failed");
    expect(result.current?.error).toBe("swap lost");
  });

  it("ignores handoff events dispatched without detail instead of clobbering the current phase", () => {
    const { result } = renderHook(() => useCloudHandoffPhase());
    emit({ agentId: "a1", phase: "migrating" });

    // A malformed dispatch (no detail) must not blank or replace the phase.
    act(() => {
      window.dispatchEvent(new Event(CLOUD_HANDOFF_PHASE_EVENT));
    });
    expect(result.current?.agentId).toBe("a1");
    expect(result.current?.phase).toBe("migrating");

    act(() => vi.advanceTimersByTime(60_000));
    expect(result.current?.phase).toBe("migrating");
  });
});

// The floating CloudHandoffBanner was removed: failure/timeout phases now
// surface as the in-chat boot-recovery card (use-boot-recovery-conductor.test
// covers the retry-handoff control) and the home-grid agent-provisioning tile
// remains the durable surface.
