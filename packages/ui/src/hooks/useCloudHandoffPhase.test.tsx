// @vitest-environment jsdom

import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudHandoffBanner } from "../components/shell/CloudHandoffBanner";
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

  it("keeps a failure visible longer, then clears", () => {
    const { result } = renderHook(() => useCloudHandoffPhase());
    emit({ agentId: "a1", phase: "failed", error: "boom" });
    expect(result.current?.phase).toBe("failed");

    act(() => vi.advanceTimersByTime(4000));
    expect(result.current?.phase).toBe("failed"); // still inside the 8s window

    act(() => vi.advanceTimersByTime(4000));
    expect(result.current).toBeNull();
  });
});

describe("CloudHandoffBanner", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("renders nothing until a handoff starts", () => {
    const { container } = render(<CloudHandoffBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the migrating copy, then the switched confirmation", () => {
    render(<CloudHandoffBanner />);
    emit({ agentId: "a1", phase: "migrating" });
    expect(screen.queryByText(/keep chatting/i)).not.toBeNull();

    emit({ agentId: "a1", phase: "switched", imported: 2 });
    expect(screen.queryByText(/now on your dedicated agent/i)).not.toBeNull();
  });

  it("shows reassuring fallback copy on a failed/timed-out handoff", () => {
    render(<CloudHandoffBanner />);
    emit({ agentId: "a1", phase: "timed-out" });
    expect(screen.queryByText(/still on the shared one/i)).not.toBeNull();
  });

  it("offers a Retry that re-invokes the handoff on a recoverable failure", () => {
    const onRetry = vi.fn();
    render(<CloudHandoffBanner />);
    emit({ agentId: "a1", phase: "failed", error: "boom", onRetry });

    const retry = screen.getByRole("button", { name: /retry/i });
    act(() => retry.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("shows no Retry button when the failure carries no retry handler", () => {
    render(<CloudHandoffBanner />);
    emit({ agentId: "a1", phase: "failed", error: "boom" });
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });

  it("does not offer Retry on a successful switch", () => {
    render(<CloudHandoffBanner />);
    emit({ agentId: "a1", phase: "switched", imported: 2 });
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });
});
