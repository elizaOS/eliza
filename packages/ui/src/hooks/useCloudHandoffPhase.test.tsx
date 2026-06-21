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

  it("offers a retry on failure that dispatches a retry event for the agent", () => {
    render(<CloudHandoffBanner />);
    emit({ agentId: "a1", phase: "failed", error: "boom" });

    const retried: string[] = [];
    const onRetry = (event: Event) => {
      retried.push((event as CustomEvent<{ agentId: string }>).detail.agentId);
    };
    window.addEventListener("eliza:cloud-handoff-retry", onRetry);

    const button = screen.getByTestId("cloud-handoff-retry");
    act(() => {
      button.click();
    });
    window.removeEventListener("eliza:cloud-handoff-retry", onRetry);

    expect(retried).toEqual(["a1"]);
  });

  it("shows no retry button on the migrating / success phases", () => {
    render(<CloudHandoffBanner />);
    emit({ agentId: "a1", phase: "migrating" });
    expect(screen.queryByTestId("cloud-handoff-retry")).toBeNull();

    emit({ agentId: "a1", phase: "switched", imported: 1 });
    expect(screen.queryByTestId("cloud-handoff-retry")).toBeNull();
  });
});
