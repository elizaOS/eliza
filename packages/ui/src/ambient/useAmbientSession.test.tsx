/**
 * Behavior tests for the ambient session controller hook.
 *
 * usePendant is mocked so the hook's consent gating, segment folding (into the
 * reused pendant transcript store), duration bookkeeping, and stop/reset
 * semantics are exercised deterministically in jsdom.
 */

// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  UsePendantOptions,
  UsePendantResult,
} from "../pendant/usePendant";
import { useAmbientSession } from "./useAmbientSession";

const pendantMock = vi.hoisted(() => ({
  result: undefined as UsePendantResult | undefined,
  onSegment: undefined as UsePendantOptions["onSegment"] | undefined,
}));

vi.mock("../pendant/usePendant", () => ({
  usePendant: (options?: UsePendantOptions) => {
    pendantMock.onSegment = options?.onSegment;
    if (!pendantMock.result) {
      throw new Error("usePendant mock result was not configured");
    }
    return pendantMock.result;
  },
}));

const connect = vi.fn();
const disconnect = vi.fn();
const pause = vi.fn();
const resume = vi.fn();

function setPendant(
  overrides: Partial<UsePendantResult["state"]> = {},
  supported = true,
): void {
  pendantMock.result = {
    state: {
      status: supported ? "idle" : "unsupported",
      connectStep: "idle",
      deviceName: null,
      batteryPercent: null,
      codecId: null,
      lastTranscript: null,
      droppedPackets: 0,
      error: null,
      typedError: null,
      paused: false,
      ...overrides,
    },
    supported,
    connect,
    disconnect,
    pause,
    resume,
  };
}

let captured: ReturnType<typeof useAmbientSession> | undefined;
let clock = 0;

function Harness(): React.ReactElement {
  captured = useAmbientSession({ now: () => clock });
  return <div data-testid="harness" />;
}

describe("useAmbientSession", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    clock = 1_000;
    captured = undefined;
    setPendant();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("blocks start until consent is granted", () => {
    render(<Harness />);
    expect(captured?.consent).toBe("ungranted");

    act(() => captured?.start());
    expect(connect).not.toHaveBeenCalled();

    act(() => captured?.grantConsent());
    expect(captured?.consent).toBe("granted");

    act(() => captured?.start());
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("folds pendant segments into the reused transcript store", () => {
    render(<Harness />);
    act(() => {
      pendantMock.onSegment?.({
        id: "seg-1",
        status: "resolved",
        text: "hello world",
        startedAt: 1_000,
        endedAt: 2_000,
        durationMs: 1_000,
        words: [],
      });
    });
    expect(captured?.segments).toHaveLength(1);
    expect(captured?.segments[0]?.text).toBe("hello world");
    expect(captured?.resolvedCount).toBe(1);
  });

  it("reports capturing status and processing location for the batch path", () => {
    setPendant({ status: "hearing", deviceName: "omi pendant" });
    render(<Harness />);
    expect(captured?.snapshot.status).toBe("capturing");
    expect(captured?.snapshot.capturing).toBe(true);
    // Batch/local-ASR path is on-device today; the WS path (cloud) is a seam.
    expect(captured?.snapshot.processingLocation).toBe("on-device");
    expect(captured?.snapshot.transport).toBe("batch");
  });

  it("reports paused status without claiming capture", () => {
    setPendant({ status: "paused", paused: true });
    render(<Harness />);
    expect(captured?.snapshot.status).toBe("paused");
    expect(captured?.snapshot.capturing).toBe(false);
  });

  it("stop revokes consent so the next start re-prompts", () => {
    render(<Harness />);
    act(() => captured?.grantConsent());
    expect(captured?.consent).toBe("granted");

    act(() => captured?.stop());
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(captured?.consent).toBe("ungranted");

    act(() => captured?.start());
    expect(connect).not.toHaveBeenCalled();
  });

  it("stop resets the session duration to zero (no carry-over)", () => {
    // Capture for 5s, stop, and confirm elapsed resets so the next session
    // does not inherit the prior duration.
    setPendant({ status: "hearing" });
    const { rerender } = render(<Harness />);
    clock = 6_000; // 5s after the initial clock of 1_000
    // Flip out of capturing to flush the active span into the accumulator.
    setPendant({ status: "idle" });
    rerender(<Harness />);
    expect(captured?.elapsedMs).toBeGreaterThanOrEqual(5_000);

    act(() => captured?.stop());
    expect(captured?.elapsedMs).toBe(0);
  });

  it("surfaces an error snapshot from the pendant error state", () => {
    setPendant({
      status: "error",
      error: "raw denied",
      typedError: {
        code: "permission-denied",
        category: "permission",
        message: "Mic permission is off.",
        recoverable: true,
      },
    });
    render(<Harness />);
    expect(captured?.snapshot.status).toBe("error");
    expect(captured?.snapshot.error).toBe("Mic permission is off.");
  });

  it("clear empties the transcript store", () => {
    render(<Harness />);
    act(() => {
      pendantMock.onSegment?.({
        id: "seg-1",
        status: "resolved",
        text: "hi",
        startedAt: 1_000,
        endedAt: 2_000,
        durationMs: 1_000,
        words: [],
      });
    });
    expect(captured?.segments).toHaveLength(1);
    act(() => captured?.clear());
    expect(captured?.segments).toHaveLength(0);
  });
});
