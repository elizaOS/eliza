// @vitest-environment jsdom

/**
 * Pendant transcript view states are rendered against mocked pendant transport
 * and scrolling hooks so the component contract stays deterministic in jsdom.
 */

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
      error: "Bluetooth permission was denied.",
    });

    render(<PendantTranscriptView />);

    expect(screen.getByRole("alert").textContent).toBe(
      "Bluetooth permission was denied.",
    );
    expect(
      screen.getByRole("button", { name: /Connect/ }).hasAttribute("disabled"),
    ).toBe(false);
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

  it("renders persisted resolved transcript text and word timing", () => {
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
          },
        ],
        updatedAt: startedAt + 1_250,
        clearedThrough: null,
      }),
    );

    render(<PendantTranscriptView />);

    expect(screen.getByText("hello world")).toBeTruthy();
    expect(screen.getByText("hello").getAttribute("title")).toBe("0-500ms");
    expect(screen.getByText("world").getAttribute("title")).toBe("550-1200ms");
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

      fireEvent.click(screen.getByRole("button", { name: /Clear/ }));
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
});
