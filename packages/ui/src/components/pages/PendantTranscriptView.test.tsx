/**
 * Pendant transcript view states are rendered against mocked pendant transport
 * and canonical session sync so the ambient route contract stays deterministic.
 */

// @vitest-environment jsdom

import type { PendantSessionSnapshot } from "@elizaos/shared/contracts";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  UsePendantOptions,
  UsePendantResult,
} from "../../pendant/usePendant";
import { PendantTranscriptView } from "./PendantTranscriptView";

const pendantMock = vi.hoisted(() => ({
  result: undefined as UsePendantResult | undefined,
  onSegment: undefined as UsePendantOptions["onSegment"] | undefined,
}));

const syncMock = vi.hoisted(() => ({
  clients: [] as Array<ReturnType<typeof createMockSyncClient>>,
  createClient: vi.fn(
    (onSnapshot?: (snapshot: PendantSessionSnapshot) => void) =>
      createMockSyncClient(onSnapshot),
  ),
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

vi.mock("../../pendant/session-sync-client", () => ({
  createPendantSessionSyncClient: (options?: {
    onSnapshot?: (snapshot: PendantSessionSnapshot) => void;
    onError?: (error: Error) => void;
  }) => {
    const client = syncMock.createClient(options?.onSnapshot);
    syncMock.clients.push(client);
    return client;
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

function createMockSyncClient(
  onSnapshot?: (snapshot: PendantSessionSnapshot) => void,
) {
  return {
    unsyncedQueue: [],
    createSession: vi.fn(async () => {
      const snapshot = sessionSnapshot();
      onSnapshot?.(snapshot);
      return snapshot;
    }),
    acquireLease: vi.fn(async () => ({
      ok: true as const,
      session: sessionSnapshot().session,
      leaseToken: "lease-token",
    })),
    appendSegment: vi.fn(async () => {
      const snapshot = sessionSnapshot({
        segments: [segmentSnapshot({ status: "pending", text: "" })],
        revision: 2,
      });
      onSnapshot?.(snapshot);
      return snapshot;
    }),
    patchSegment: vi.fn(async () => {
      const snapshot = sessionSnapshot({
        segments: [
          segmentSnapshot({ status: "resolved", text: "hello pendant" }),
        ],
        revision: 3,
      });
      onSnapshot?.(snapshot);
      return snapshot;
    }),
    pause: vi.fn(async () => {
      const snapshot = sessionSnapshot({
        state: "paused",
        segments: [
          segmentSnapshot({
            status: "resolved",
            text: "late tail after pause",
          }),
        ],
        revision: 4,
      });
      onSnapshot?.(snapshot);
      return snapshot;
    }),
    resume: vi.fn(async () => sessionSnapshot({ revision: 5 })),
    startPolling: vi.fn(),
    stopPolling: vi.fn(),
    discardUnsyncedMutation: vi.fn(),
  };
}

function sessionSnapshot({
  segments = [],
  state = "active",
  revision = 1,
}: {
  segments?: PendantSessionSnapshot["segments"];
  state?: PendantSessionSnapshot["session"]["state"];
  revision?: number;
} = {}): PendantSessionSnapshot {
  return {
    schemaVersion: 1,
    session: {
      id: "session-1",
      ownerId: "owner",
      agentId: "agent",
      startedAt: "2026-08-04T00:00:00.000Z",
      endedAt: null,
      state,
      captureLease: null,
      processingLocation: "cloud",
      revision,
    },
    segments,
    insightRefs: [],
  };
}

function segmentSnapshot({
  status,
  text,
}: {
  status: "pending" | "resolved" | "asr-error";
  text: string;
}): PendantSessionSnapshot["segments"][number] {
  return {
    id: "session-1:segment:0",
    sessionId: "session-1",
    ordinal: 0,
    status,
    text,
    words: [],
    speakerCluster: null,
    speakerAlias: null,
    confidence: null,
    error: status === "asr-error" ? "ASR failed" : null,
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:01.000Z",
    startedAt: "2026-08-04T00:00:00.000Z",
    endedAt: status === "pending" ? null : "2026-08-04T00:00:01.000Z",
    revision: status === "pending" ? 0 : 1,
  };
}

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
    vi.clearAllMocks();
    syncMock.clients = [];
    syncMock.createClient.mockClear();
    setPendantState();
  });

  afterEach(() => {
    cleanup();
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
      "Off",
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

  it("connects through the canonical session controller before BLE capture", async () => {
    render(<PendantTranscriptView />);

    fireEvent.click(screen.getByRole("button", { name: /^Connect$/ }));

    await waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    const client = syncMock.clients[0];
    expect(client?.createSession).toHaveBeenCalledWith({
      processingLocation: "cloud",
    });
    expect(client?.acquireLease).toHaveBeenCalledWith("session-1", {
      holder: expect.any(String),
      leaseMs: 300_000,
    });
    expect(client?.startPolling).toHaveBeenCalledWith("session-1");
    expect(
      screen.getByText(
        "Canonical private session · synced across owner devices",
      ),
    ).toBeTruthy();
  });

  it("renders status and transcript from canonical session snapshots", async () => {
    const { rerender } = render(<PendantTranscriptView />);
    fireEvent.click(screen.getByRole("button", { name: /^Connect$/ }));
    await waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    setPendantState({
      status: "listening",
      paused: false,
      deviceName: "omi devkit",
      batteryPercent: 91,
    });
    rerender(<PendantTranscriptView />);

    await act(async () => {
      pendantMock.onSegment?.({
        id: "local-1",
        status: "pending",
        startedAt: Date.parse("2026-08-04T00:00:00.000Z"),
        endedAt: Date.parse("2026-08-04T00:00:01.000Z"),
        durationMs: 1000,
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId("pendant-recording-indicator").textContent).toBe(
      "Listeningcloud",
    );
    expect(screen.getByText("Transcribing...")).toBeTruthy();

    await act(async () => {
      pendantMock.onSegment?.({
        id: "local-1",
        status: "resolved",
        text: "hello pendant",
        startedAt: Date.parse("2026-08-04T00:00:00.000Z"),
        endedAt: Date.parse("2026-08-04T00:00:01.000Z"),
        durationMs: 1000,
        words: [],
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("hello pendant")).toBeTruthy();
    expect(screen.getByText("1 resolved · 0 pending")).toBeTruthy();
  });

  it("severs canonical capture on pause and suppresses in-flight transcript tails", async () => {
    const { rerender } = render(<PendantTranscriptView />);
    fireEvent.click(screen.getByRole("button", { name: /^Connect$/ }));
    await waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    setPendantState({ status: "listening", paused: false });
    rerender(<PendantTranscriptView />);

    await act(async () => {
      pendantMock.onSegment?.({
        id: "local-tail",
        status: "pending",
        startedAt: Date.parse("2026-08-04T00:00:00.000Z"),
        endedAt: Date.parse("2026-08-04T00:00:01.000Z"),
        durationMs: 1000,
      });
      fireEvent.click(screen.getByRole("button", { name: /Pause Listening/ }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const client = syncMock.clients[0];
    expect(pause).toHaveBeenCalledTimes(1);
    expect(client?.stopPolling).toHaveBeenCalled();
    expect(client?.pause).toHaveBeenCalledWith("session-1");
    expect(screen.queryByText("late tail after pause")).toBeNull();
    expect(screen.queryByText("Transcribing...")).toBeNull();
  });

  it("resumes the severed canonical session before BLE capture", async () => {
    const { rerender } = render(<PendantTranscriptView />);
    fireEvent.click(screen.getByRole("button", { name: /^Connect$/ }));
    await waitFor(() => expect(connect).toHaveBeenCalledTimes(1));

    setPendantState({ status: "listening", paused: false });
    rerender(<PendantTranscriptView />);
    fireEvent.click(screen.getByRole("button", { name: /Pause Listening/ }));
    setPendantState({ status: "paused", paused: true });
    rerender(<PendantTranscriptView />);
    fireEvent.click(screen.getByRole("button", { name: /Resume Listening/ }));

    await waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
    const client = syncMock.clients[0];
    expect(client?.createSession).toHaveBeenCalledTimes(1);
    expect(client?.resume).toHaveBeenCalledWith("session-1");
    expect(client?.startPolling).toHaveBeenLastCalledWith("session-1");
  });

  it("does not read or write browser storage as transcript authority", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const removeItem = vi.spyOn(Storage.prototype, "removeItem");

    render(<PendantTranscriptView />);

    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
  });
});
