/** Covers useResyncReconcile — the RESYNC_EVENT window listener that reloads the active conversation. */
// @vitest-environment jsdom

/**
 * Real-event harness: no module mocks. The hook is mounted with renderHook,
 * resync signals are dispatched through the REAL dispatchConversationResync
 * boundary from AppContext.hooks (so the event name/detail contract is what
 * production code exercises), and the loader is an observable spy.
 */
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchConversationResync } from "./AppContext.hooks";
import { useResyncReconcile } from "./useResyncReconcile";

function mountHook(activeIdAtMount: string | null) {
  const activeConversationIdRef = { current: activeIdAtMount };
  const loadConversationMessages = vi.fn(
    async (): Promise<{ ok: true }> => ({ ok: true }),
  );
  const utils = renderHook(() =>
    useResyncReconcile({ activeConversationIdRef, loadConversationMessages }),
  );
  return { activeConversationIdRef, loadConversationMessages, ...utils };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("useResyncReconcile", () => {
  it("reloads the active conversation when the resync names it", async () => {
    const { loadConversationMessages } = mountHook("conv-active");

    dispatchConversationResync({
      conversationId: "conv-active",
      reason: "connection-recovered",
    });

    await Promise.resolve();
    expect(loadConversationMessages).toHaveBeenCalledTimes(1);
    expect(loadConversationMessages).toHaveBeenCalledWith("conv-active");
  });

  it("falls back to the active ref when the event carries a null conversation id", async () => {
    const { loadConversationMessages } = mountHook("conv-active");

    dispatchConversationResync({ conversationId: null });

    await Promise.resolve();
    expect(loadConversationMessages).toHaveBeenCalledTimes(1);
    expect(loadConversationMessages).toHaveBeenCalledWith("conv-active");
  });

  it("ignores a resync that names a background conversation", async () => {
    const { loadConversationMessages } = mountHook("conv-active");

    dispatchConversationResync({
      conversationId: "conv-background",
      reason: "voice-turn-complete",
    });

    await Promise.resolve();
    expect(loadConversationMessages).not.toHaveBeenCalled();
  });

  it("does nothing when no conversation is active and the event carries no id", async () => {
    const { loadConversationMessages } = mountHook(null);

    dispatchConversationResync({ conversationId: null });

    await Promise.resolve();
    expect(loadConversationMessages).not.toHaveBeenCalled();
  });

  it("stops reloading after the user navigates away from the named conversation", async () => {
    const { activeConversationIdRef, loadConversationMessages } =
      mountHook("conv-first");

    activeConversationIdRef.current = "conv-second";
    dispatchConversationResync({ conversationId: "conv-first" });

    await Promise.resolve();
    expect(loadConversationMessages).not.toHaveBeenCalled();
  });

  it("reloads the newly active conversation after the active id changes", async () => {
    const { activeConversationIdRef, loadConversationMessages } =
      mountHook("conv-first");

    activeConversationIdRef.current = "conv-second";
    dispatchConversationResync({ conversationId: "conv-second" });

    await Promise.resolve();
    expect(loadConversationMessages).toHaveBeenCalledTimes(1);
    expect(loadConversationMessages).toHaveBeenCalledWith("conv-second");
  });

  it("unsubscribes on unmount", async () => {
    const { loadConversationMessages, unmount } = mountHook("conv-active");

    unmount();
    dispatchConversationResync({ conversationId: "conv-active" });

    await Promise.resolve();
    expect(loadConversationMessages).not.toHaveBeenCalled();
  });
});
