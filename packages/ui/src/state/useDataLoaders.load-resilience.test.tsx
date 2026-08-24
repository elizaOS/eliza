/** Verifies useDataLoaders — load resilience contracts through the package's configured test harness. */
// @vitest-environment jsdom
//
// Coverage for the failure-mode and capacity branches of the data loaders that
// the sibling suites do not touch: transient (non-404) fetch failures keep the
// painted thread and report softly when a cache paint exists but fail loudly
// without one; the prefetch cache evicts oldest-first at its 16-entry cap with
// re-insertion refreshing recency; the around-window jump loader abandons
// results after navigation; extension-status checks install a documented
// offline fallback; update-channel changes no-op on the same channel.

import { logger } from "@elizaos/logger";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ConversationMessage,
  ExtensionStatus,
  UpdateStatus,
} from "../api";
import { client } from "../api";
import type { LoadConversationMessagesResult } from "./internal";
import { type DataLoadersDeps, useDataLoaders } from "./useDataLoaders";

vi.mock("../api", () => ({
  client: {
    getConversationMessages: vi.fn(),
    listConversations: vi.fn(async () => ({ conversations: [] })),
    getConfig: vi.fn(async () => ({ ui: {} })),
    getUpdateStatus: vi.fn(),
    setUpdateChannel: vi.fn(),
    getExtensionStatus: vi.fn(),
  },
}));

const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => {});

function userMsg(id: string): ConversationMessage {
  return {
    id,
    role: "user",
    text: `msg-${id}`,
    timestamp: 0,
  } as ConversationMessage;
}

function makeDeps(overrides: Partial<DataLoadersDeps> = {}) {
  const conversationMessagesRef = { current: [] as ConversationMessage[] };
  const activeConversationIdRef = { current: null as string | null };
  const greetingFiredRef = { current: false };
  const noop = () => {};
  const deps = {
    autonomousStoreRef: { current: {} },
    autonomousEventsRef: { current: [] },
    autonomousLatestEventIdRef: { current: null },
    autonomousRunHealthByRunIdRef: { current: {} },
    autonomousReplayInFlightRef: { current: false },
    setAutonomousEvents: noop,
    setAutonomousLatestEventId: noop,
    setAutonomousRunHealthByRunId: noop,
    activeConversationIdRef,
    conversationMessagesRef,
    greetingFiredRef,
    setConversations: vi.fn(),
    setActiveConversationId: vi.fn(),
    setConversationMessages: vi.fn(),
    loadWalletConfig: async () => {},
    agentStatus: null,
    characterData: null,
    characterDraft: null,
    loadCharacter: async () => {},
    selectedVrmIndex: 0,
    firstRunComplete: false,
    uiLanguage: "en",
    setOwnerNameState: noop,
    ...overrides,
  } as unknown as DataLoadersDeps;
  return {
    deps,
    conversationMessagesRef,
    activeConversationIdRef,
    greetingFiredRef,
  };
}

const stableStatus: UpdateStatus = {
  currentVersion: "1.2.3",
  channel: "stable",
  installMethod: "package-manager",
  updateAvailable: false,
  latestVersion: null,
  channels: { stable: "1.2.3", beta: null, nightly: null },
  distTags: { stable: "latest", beta: "beta", nightly: "nightly" },
  lastCheckAt: null,
  error: null,
};

beforeEach(() => {
  vi.mocked(client.getConversationMessages).mockReset();
  vi.mocked(client.getUpdateStatus).mockReset();
  vi.mocked(client.setUpdateChannel).mockReset();
  vi.mocked(client.getExtensionStatus).mockReset();
  debugSpy.mockClear();
  window.localStorage.clear();
});

describe("useDataLoaders — transient load failures", () => {
  it("reports soft success and keeps the painted thread when revalidation fails after a cache paint", async () => {
    vi.mocked(client.getConversationMessages)
      .mockResolvedValueOnce({ messages: [userMsg("conv-a")] })
      .mockRejectedValueOnce(
        Object.assign(new Error("upstream exploded"), { status: 500 }),
      );
    const { deps, conversationMessagesRef } = makeDeps();
    const { result } = renderHook(() => useDataLoaders(deps));

    await act(async () => {
      result.current.prefetchConversationMessages(["conv-a"]);
      await Promise.resolve();
      await Promise.resolve();
    });

    let outcome: LoadConversationMessagesResult | undefined;
    await act(async () => {
      outcome = await result.current.loadConversationMessages("conv-a");
    });

    // The user is looking at usable cached content — the failed revalidation
    // must not blank it or surface an error over it.
    expect(outcome).toEqual({ ok: true });
    expect(conversationMessagesRef.current).toEqual([userMsg("conv-a")]);
  });

  it("reports ok:false with status and message for a transient failure without a cache paint", async () => {
    vi.mocked(client.getConversationMessages).mockRejectedValue(
      Object.assign(new Error("upstream exploded"), { status: 503 }),
    );
    const { deps } = makeDeps();
    const { result } = renderHook(() => useDataLoaders(deps));

    let outcome: LoadConversationMessagesResult | undefined;
    await act(async () => {
      outcome = await result.current.loadConversationMessages("conv-a");
    });

    if (!outcome || outcome.ok) {
      throw new Error("expected a failure result");
    }
    expect(outcome.status).toBe(503);
    expect(outcome.message).toBe("upstream exploded");
  });

  it("falls back to a generic message for rejections that are not Errors", async () => {
    vi.mocked(client.getConversationMessages).mockRejectedValue({
      bodyText: "not an Error instance",
    });
    const { deps } = makeDeps();
    const { result } = renderHook(() => useDataLoaders(deps));

    let outcome: LoadConversationMessagesResult | undefined;
    await act(async () => {
      outcome = await result.current.loadConversationMessages("conv-a");
    });

    if (!outcome || outcome.ok) {
      throw new Error("expected a failure result");
    }
    expect(outcome.status).toBeUndefined();
    expect(outcome.message).toBe("Failed to load conversation messages");
  });
});

describe("useDataLoaders — prefetch cache capacity and recency", () => {
  it("ignores empty ids in a prefetch batch", async () => {
    vi.mocked(client.getConversationMessages).mockImplementation(
      async (id: string) => ({ messages: [userMsg(id)] }),
    );
    const { deps } = makeDeps();
    const { result } = renderHook(() => useDataLoaders(deps));

    await act(async () => {
      result.current.prefetchConversationMessages([""]);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(vi.mocked(client.getConversationMessages)).not.toHaveBeenCalled();

    await act(async () => {
      result.current.prefetchConversationMessages(["c1"]);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(vi.mocked(client.getConversationMessages)).toHaveBeenCalledTimes(1);
  });

  it("evicts the oldest cached conversation once the 16-entry cap is exceeded", async () => {
    vi.mocked(client.getConversationMessages).mockImplementation(
      async (id: string) => ({ messages: [userMsg(id)] }),
    );
    const { deps } = makeDeps();
    const { result } = renderHook(() => useDataLoaders(deps));

    await act(async () => {
      result.current.prefetchConversationMessages([
        "c0",
        "c1",
        "c2",
        "c3",
        "c4",
        "c5",
        "c6",
        "c7",
        "c8",
        "c9",
        "c10",
        "c11",
        "c12",
        "c13",
        "c14",
        "c15",
      ]);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(vi.mocked(client.getConversationMessages)).toHaveBeenCalledTimes(16);

    // A 17th neighbor fits (evicting c0)…
    await act(async () => {
      result.current.prefetchConversationMessages(["c16"]);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(vi.mocked(client.getConversationMessages)).toHaveBeenCalledTimes(17);

    // …so c0 is gone from the cache and prefetches again…
    await act(async () => {
      result.current.prefetchConversationMessages(["c0"]);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(vi.mocked(client.getConversationMessages)).toHaveBeenCalledTimes(18);

    // Caching the c0 refill itself pushes the map back to 17 entries, so the
    // cap evicted the then-oldest survivor c1 on insert. Untouched c2 survived
    // both evictions and issues no fetch…
    await act(async () => {
      result.current.prefetchConversationMessages(["c2"]);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(vi.mocked(client.getConversationMessages)).toHaveBeenCalledTimes(18);

    // …while c1 is gone from the cache and prefetches again.
    await act(async () => {
      result.current.prefetchConversationMessages(["c1"]);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(vi.mocked(client.getConversationMessages)).toHaveBeenCalledTimes(19);
  });

  it("refreshes recency on re-insert so a touched entry survives the next eviction", async () => {
    vi.mocked(client.getConversationMessages).mockImplementation(
      async (id: string) => ({ messages: [userMsg(id)] }),
    );
    const { deps } = makeDeps();
    const { result } = renderHook(() => useDataLoaders(deps));

    await act(async () => {
      result.current.prefetchConversationMessages([
        "c0",
        "c1",
        "c2",
        "c3",
        "c4",
        "c5",
        "c6",
        "c7",
        "c8",
        "c9",
        "c10",
        "c11",
        "c12",
        "c13",
        "c14",
        "c15",
      ]);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(vi.mocked(client.getConversationMessages)).toHaveBeenCalledTimes(16);

    // Loading c0 re-inserts it as most-recently used.
    await act(async () => {
      await result.current.loadConversationMessages("c0");
    });
    expect(vi.mocked(client.getConversationMessages)).toHaveBeenCalledTimes(17);

    // The next eviction therefore takes untouched c1, not touched c0.
    await act(async () => {
      result.current.prefetchConversationMessages(["c16"]);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(vi.mocked(client.getConversationMessages)).toHaveBeenCalledTimes(18);

    await act(async () => {
      result.current.prefetchConversationMessages(["c0"]);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(vi.mocked(client.getConversationMessages)).toHaveBeenCalledTimes(18);

    await act(async () => {
      result.current.prefetchConversationMessages(["c1"]);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(vi.mocked(client.getConversationMessages)).toHaveBeenCalledTimes(19);
  });
});

describe("useDataLoaders — around-window jump loader (#9955)", () => {
  it("commits the centered window when the conversation is still active", async () => {
    vi.mocked(client.getConversationMessages).mockResolvedValue({
      messages: [userMsg("w1"), userMsg("w2")],
    });
    const { deps, conversationMessagesRef, activeConversationIdRef } =
      makeDeps();
    activeConversationIdRef.current = "conv-a";
    const { result } = renderHook(() => useDataLoaders(deps));

    let landed: boolean | undefined;
    await act(async () => {
      landed = await result.current.loadConversationMessagesAround(
        "conv-a",
        "m42",
      );
    });

    expect(landed).toBe(true);
    expect(vi.mocked(client.getConversationMessages)).toHaveBeenCalledWith(
      "conv-a",
      { around: "m42" },
    );
    expect(conversationMessagesRef.current.map((m) => m.id)).toEqual([
      "w1",
      "w2",
    ]);
    expect(result.current.loadedConversationIdRef.current).toBe("conv-a");
  });

  it("abandons the window after the user navigates away before it lands", async () => {
    let resolveWindow: ((messages: ConversationMessage[]) => void) | undefined;
    vi.mocked(client.getConversationMessages).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveWindow = (messages) => resolve({ messages });
        }),
    );
    const { deps, conversationMessagesRef, activeConversationIdRef } =
      makeDeps();
    activeConversationIdRef.current = "conv-a";
    const { result } = renderHook(() => useDataLoaders(deps));

    let jumped: Promise<boolean> | undefined;
    act(() => {
      jumped = result.current.loadConversationMessagesAround("conv-a", "m42");
    });
    if (!jumped) throw new Error("around-window load did not start");

    // The user swipes to another conversation while the jump is in flight.
    activeConversationIdRef.current = "conv-b";

    let landed: boolean | undefined;
    await act(async () => {
      resolveWindow?.([userMsg("w1")]);
      landed = await jumped;
    });

    expect(landed).toBe(false);
    // The stale window never reaches the thread of the now-active conversation.
    expect(conversationMessagesRef.current).toEqual([]);
  });

  it("returns false and logs at debug when the around-window fetch fails", async () => {
    vi.mocked(client.getConversationMessages).mockRejectedValue(
      new Error("search index down"),
    );
    const { deps, conversationMessagesRef, activeConversationIdRef } =
      makeDeps();
    activeConversationIdRef.current = "conv-a";
    const { result } = renderHook(() => useDataLoaders(deps));

    let landed: boolean | undefined;
    await act(async () => {
      landed = await result.current.loadConversationMessagesAround(
        "conv-a",
        "m42",
      );
    });

    expect(landed).toBe(false);
    expect(conversationMessagesRef.current).toEqual([]);
    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy.mock.calls[0]?.[1]).toContain(
      "around-window load failed for conv-a",
    );
  });
});

describe("useDataLoaders — extension status check", () => {
  it("propagates a healthy relay payload and settles the checking flag", async () => {
    const liveExtension: ExtensionStatus = {
      relayReachable: true,
      relayPort: 19999,
      extensionPath: "/tmp/eliza-extension",
    };
    vi.mocked(client.getExtensionStatus).mockResolvedValue(liveExtension);
    const { deps } = makeDeps();
    const { result } = renderHook(() => useDataLoaders(deps));

    await act(async () => {
      await result.current.checkExtensionStatus();
    });

    expect(result.current.extensionStatus).toEqual(liveExtension);
    expect(result.current.extensionChecking).toBe(false);
  });

  it("installs the documented offline fallback when the probe fails", async () => {
    vi.mocked(client.getExtensionStatus).mockRejectedValue(
      new Error("relay down"),
    );
    const { deps } = makeDeps();
    const { result } = renderHook(() => useDataLoaders(deps));

    await act(async () => {
      await result.current.checkExtensionStatus();
    });

    expect(result.current.extensionStatus).toEqual({
      relayReachable: false,
      relayPort: 18792,
      extensionPath: null,
      chromeBuildPath: null,
      chromePackagePath: null,
      safariWebExtensionPath: null,
      safariAppPath: null,
      safariPackagePath: null,
    });
    expect(result.current.extensionChecking).toBe(false);
  });
});

describe("useDataLoaders — update channel change guard", () => {
  it("no-ops when the requested channel is already active and force-reloads after a real switch", async () => {
    vi.mocked(client.getUpdateStatus).mockResolvedValue(stableStatus);
    vi.mocked(client.setUpdateChannel).mockResolvedValue({ channel: "beta" });
    const { deps } = makeDeps();
    const { result, rerender } = renderHook(() => useDataLoaders(deps));

    await act(async () => {
      await result.current.loadUpdateStatus();
    });
    rerender();
    expect(result.current.updateStatus?.channel).toBe("stable");

    await act(async () => {
      await result.current.handleChannelChange("stable");
    });
    expect(vi.mocked(client.setUpdateChannel)).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.handleChannelChange("beta");
    });
    expect(vi.mocked(client.setUpdateChannel)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(client.setUpdateChannel)).toHaveBeenCalledWith("beta");
    // The post-switch reload forces a fresh status check.
    expect(vi.mocked(client.getUpdateStatus)).toHaveBeenLastCalledWith(true);
    expect(result.current.updateChannelSaving).toBe(false);
  });
});
