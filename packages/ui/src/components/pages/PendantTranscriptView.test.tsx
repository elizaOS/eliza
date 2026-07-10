/**
 * Pendant transcript view states are rendered against mocked pendant transport
 * and scrolling hooks so the component contract stays deterministic in jsdom.
 */

// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PENDANT_TRANSCRIPT_STORAGE_KEY } from "../../pendant/pendant-transcript-session";
import type {
  UsePendantOptions,
  UsePendantResult,
} from "../../pendant/usePendant";
import { PendantTranscriptView } from "./PendantTranscriptView";

const pendantMock = vi.hoisted(() => ({
  result: undefined as UsePendantResult | undefined,
  onSegment: undefined as UsePendantOptions["onSegment"] | undefined,
}));

vi.mock("../../pendant/usePendant", () => ({
  usePendant: (options?: UsePendantOptions) => {
    pendantMock.onSegment = options?.onSegment;
    if (!pendantMock.result) {
      throw new Error("usePendant mock result was not configured");
    }
    return pendantMock.result;
  },
}));

vi.mock("../../hooks/useThreadAutoScroll", () => ({
  useThreadAutoScroll: () => ({
    scrollRef: vi.fn(),
    atBottom: true,
    jumpToLatest: vi.fn(),
  }),
}));

vi.mock("../views/ShellViewAgentSurface", () => ({
  ShellViewAgentSurface: ({ children }: { children?: ReactNode }) => children,
}));

const connect = vi.fn();
const disconnect = vi.fn();
const pause = vi.fn();
const resume = vi.fn();

function setPendantState(
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

describe("PendantTranscriptView", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    setPendantState();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("keeps unsupported distinct from idle", () => {
    setPendantState({}, false);

    render(<PendantTranscriptView />);

    expect(
      screen.getByText(
        "Bluetooth pendant is not available in this environment.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Connect/ })).toBeNull();
    expect(screen.getByTestId("pendant-recording-indicator").textContent).toBe(
      "Idle",
    );
  });

  it("renders an explicit pendant error as an alert row", () => {
    setPendantState({
      status: "error",
      error: "raw denied",
      typedError: {
        code: "permission-denied",
        category: "permission",
        message:
          "Nearby Devices permission is off. Eliza can't find the pendant until it is enabled.",
        recoverable: true,
      },
    });

    render(<PendantTranscriptView />);

    expect(screen.getByRole("alert").textContent).toBe(
      "Nearby Devices permission is off. Eliza can't find the pendant until it is enabled.",
    );
    expect(
      screen.getByRole("button", { name: /Connect/ }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it("renders cache corruption as error instead of a healthy empty feed", () => {
    localStorage.setItem(PENDANT_TRANSCRIPT_STORAGE_KEY, "{not json");

    render(<PendantTranscriptView />);

    expect(screen.getByTestId("pendant-transcript-cache-error")).toBeTruthy();
    expect(screen.getByText("Transcript cache unavailable")).toBeTruthy();
    expect(screen.queryByText("No transcript segments yet")).toBeNull();
    expect(
      screen.getByRole("button", { name: /Clear local view\/cache/ }),
    ).toBeTruthy();
  });

  it("shows pause while connected and calls pause", () => {
    setPendantState({
      status: "connected",
      paused: false,
      deviceName: "omi devkit",
    });

    render(<PendantTranscriptView />);
    fireEvent.click(screen.getByRole("button", { name: /Pause/ }));

    expect(pause).toHaveBeenCalledTimes(1);
    expect(resume).not.toHaveBeenCalled();
  });

  it("shows resume while paused and calls resume", () => {
    setPendantState({
      status: "paused",
      paused: true,
    });

    render(<PendantTranscriptView />);
    fireEvent.click(screen.getByRole("button", { name: /Resume/ }));

    expect(resume).toHaveBeenCalledTimes(1);
    expect(pause).not.toHaveBeenCalled();
  });

  it("renders persisted resolved transcript text with timings hidden by default", () => {
    const startedAt = Date.UTC(2026, 0, 1, 13, 14, 15);
    localStorage.setItem(
      PENDANT_TRANSCRIPT_STORAGE_KEY,
      JSON.stringify({
        segments: [
          {
            id: "segment-1",
            status: "resolved",
            text: "hello world",
            startedAt,
            endedAt: startedAt + 1_250,
            durationMs: 1_250,
            words: [
              { text: "hello", startMs: 0, endMs: 500 },
              { text: "world", startMs: 550, endMs: 1_200 },
            ],
            warning: null,
          },
        ],
        updatedAt: startedAt + 1_250,
        clearedThrough: null,
      }),
    );

    render(<PendantTranscriptView />);

    expect(screen.getByText("hello world")).toBeTruthy();
    expect(
      screen.getByText("Local offline cache · this device only"),
    ).toBeTruthy();
    expect(screen.queryByTitle("0-500ms")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Show timings/ }));
    expect(screen.getByText("hello").getAttribute("title")).toBe("0-500ms");
    expect(screen.getByText("world").getAttribute("title")).toBe("550-1200ms");
    fireEvent.click(screen.getByRole("button", { name: /Hide timings/ }));
    expect(screen.queryByTitle("0-500ms")).toBeNull();
    expect(
      screen.getByText(
        new Intl.DateTimeFormat("en-US", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        }).format(startedAt),
      ),
    ).toBeTruthy();
  });

  it("clear suppresses late old completions but allows new pending segments", () => {
    localStorage.setItem(
      PENDANT_TRANSCRIPT_STORAGE_KEY,
      JSON.stringify({
        segments: [
          {
            id: "segment-before-clear",
            status: "pending",
            text: "",
            startedAt: 1_000,
            endedAt: 1_500,
            durationMs: 500,
            words: [],
            warning: null,
          },
        ],
        updatedAt: 1_500,
        clearedThrough: null,
      }),
    );
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(2_000);

    try {
      render(<PendantTranscriptView />);
      expect(screen.getByText("Transcribing...")).toBeTruthy();

      fireEvent.click(
        screen.getByRole("button", { name: /Clear local view\/cache/ }),
      );
      expect(screen.getByText("No transcript segments yet")).toBeTruthy();

      act(() => {
        pendantMock.onSegment?.({
          id: "segment-before-clear",
          status: "resolved",
          text: "late stale text",
          startedAt: 1_000,
          endedAt: 1_500,
          durationMs: 500,
          words: [],
        });
      });
      expect(screen.queryByText("late stale text")).toBeNull();
      expect(screen.getByText("No transcript segments yet")).toBeTruthy();

      act(() => {
        pendantMock.onSegment?.({
          id: "segment-after-clear",
          status: "pending",
          startedAt: 2_100,
          endedAt: 2_500,
          durationMs: 400,
        });
      });
      expect(screen.getByText("Transcribing...")).toBeTruthy();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("renders ASR failures as quiet visible rows while silence discard stays invisible", () => {
    render(<PendantTranscriptView />);

    act(() => {
      pendantMock.onSegment?.({
        id: "silent",
        status: "pending",
        startedAt: 1_000,
        endedAt: 1_500,
        durationMs: 500,
      });
    });
    expect(screen.getByText("Transcribing...")).toBeTruthy();

    act(() => {
      pendantMock.onSegment?.({
        id: "silent",
        status: "discarded",
        discardReason: "silence",
        startedAt: 1_000,
        endedAt: 1_500,
        durationMs: 500,
      });
    });
    expect(screen.queryByText("Transcribing...")).toBeNull();
    expect(screen.queryByTestId("pendant-segment-discarded")).toBeNull();

    act(() => {
      pendantMock.onSegment?.({
        id: "failed",
        status: "failed",
        failureReason: "asr-failed",
        warning: "Could not transcribe this segment.",
        startedAt: 2_000,
        endedAt: 2_500,
        durationMs: 500,
      });
    });
    expect(screen.getByTestId("pendant-segment-failed")).toBeTruthy();
    expect(screen.getByText("Could not transcribe this segment.")).toBeTruthy();
  });

  it("marks prior disconnected feed as frozen read-only", () => {
    localStorage.setItem(
      PENDANT_TRANSCRIPT_STORAGE_KEY,
      JSON.stringify({
        segments: [
          {
            id: "segment-1",
            status: "resolved",
            text: "old transcript",
            startedAt: 1_000,
            endedAt: 1_500,
            durationMs: 500,
            words: [],
            warning: null,
          },
        ],
        updatedAt: 1_500,
        clearedThrough: null,
      }),
    );
    setPendantState({ status: "idle" });

    render(<PendantTranscriptView />);

    expect(screen.getByText("old transcript")).toBeTruthy();
    expect(screen.getByTestId("pendant-transcript-frozen").textContent).toBe(
      "Feed frozen - reconnect the pendant to resume live capture.",
    );
  });

  it("shows reconnecting without live pause controls", () => {
    localStorage.setItem(
      PENDANT_TRANSCRIPT_STORAGE_KEY,
      JSON.stringify({
        segments: [
          {
            id: "segment-1",
            status: "resolved",
            text: "preserved transcript",
            startedAt: 1_000,
            endedAt: 1_500,
            durationMs: 500,
            words: [],
            warning: null,
          },
        ],
        updatedAt: 1_500,
        clearedThrough: null,
      }),
    );
    setPendantState({ status: "reconnecting" });

    render(<PendantTranscriptView />);

    expect(screen.getByTestId("pendant-recording-indicator").textContent).toBe(
      "Reconnecting",
    );
    expect(screen.getByRole("button", { name: /Reconnecting/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Pause/ })).toBeNull();
    expect(screen.getByTestId("pendant-transcript-frozen").textContent).toBe(
      "Feed frozen - reconnect the pendant to resume live capture.",
    );
  });
});
