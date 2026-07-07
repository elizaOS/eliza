// @vitest-environment jsdom
//
// Real error-path coverage for the 404 stale-conversation recovery in
// useDataLoaders (issue #12267): when the follow-up conversation-list refresh
// itself fails, the failure must be logged (no longer swallowed by
// `.catch(() => null)`) while the UI still degrades by clearing the dangling
// active conversation id. Deterministic in-memory client mock; the logger is
// spied to assert the failure surfaces.

import { logger } from "@elizaos/logger";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  client: {
    getConversationMessages: vi.fn(),
    listConversations: vi.fn(),
    getConfig: vi.fn(async () => ({ ui: {} })),
  },
}));

vi.mock("../api", () => ({ client: mocks.client }));

import { type DataLoadersDeps, useDataLoaders } from "./useDataLoaders";

const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

function makeDeps() {
  const activeConversationIdRef = { current: "conv-gone" as string | null };
  const setActiveConversationId = vi.fn((v: string | null) => {
    activeConversationIdRef.current = v;
  });
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
    conversationMessagesRef: { current: [] },
    greetingFiredRef: { current: false },
    setConversations: vi.fn(),
    setActiveConversationId,
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
  } as unknown as DataLoadersDeps;
  return { deps, activeConversationIdRef, setActiveConversationId };
}

beforeEach(() => {
  mocks.client.getConversationMessages.mockReset();
  mocks.client.listConversations.mockReset();
  warnSpy.mockReset();
});

describe("useDataLoaders — 404 refresh failure surfaces instead of swallowing", () => {
  it("logs the refresh failure and still clears the dangling active id", async () => {
    // The conversation is gone (404) …
    mocks.client.getConversationMessages.mockRejectedValue(
      Object.assign(new Error("not found"), { status: 404 }),
    );
    // … and the recovery list refresh is also down (transport 500).
    mocks.client.listConversations.mockRejectedValue(
      Object.assign(new Error("boom"), { status: 500 }),
    );

    const { deps, activeConversationIdRef } = makeDeps();
    const { result } = renderHook(() => useDataLoaders(deps));

    let outcome: { ok: boolean } | undefined;
    await act(async () => {
      outcome = (await result.current.loadConversationMessages(
        "conv-gone",
      )) as {
        ok: boolean;
      };
    });

    // Failure is now observable — not swallowed by `.catch(() => null)`.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[1]).toContain(
      "conversation-list refresh after 404 failed",
    );
    // …and the UI still degrades: the dangling active conversation is cleared.
    expect(activeConversationIdRef.current).toBeNull();
    expect(outcome?.ok).toBe(false);
  });

  it("a healthy refresh does not log an error and adopts the refreshed list", async () => {
    mocks.client.getConversationMessages.mockRejectedValue(
      Object.assign(new Error("not found"), { status: 404 }),
    );
    // A realistic list-endpoint record: normalizeConversationList validates the
    // untrusted payload via isConversationRecord (id/title/roomId/createdAt/
    // updatedAt all required), so a stubbed row missing those is dropped and no
    // survivor is adopted. This mirrors the real /api/conversations wire shape.
    mocks.client.listConversations.mockResolvedValue({
      conversations: [
        {
          id: "conv-new",
          title: "New",
          roomId: "11111111-1111-1111-1111-111111111111",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    });

    const { deps, activeConversationIdRef } = makeDeps();
    const { result } = renderHook(() => useDataLoaders(deps));

    await act(async () => {
      await result.current.loadConversationMessages("conv-gone");
    });

    expect(warnSpy).not.toHaveBeenCalled();
    // Active id moved to the first surviving conversation, not silently nulled.
    expect(activeConversationIdRef.current).toBe("conv-new");
  });
});
