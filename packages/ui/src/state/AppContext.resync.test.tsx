// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import type { MutableRefObject } from "react";
import { describe, expect, it, vi } from "vitest";
import { RESYNC_EVENT, type ResyncEventDetail } from "./AppContext.hooks";
import type { LoadConversationMessagesResult } from "./internal";
import { useResyncReconcile } from "./useResyncReconcile";

/**
 * AppContext dispatches RESYNC_EVENT after a WebSocket reconnect so the active
 * conversation can be reconciled. Pins the `useResyncReconcile` wiring: on
 * resync the active conversation is reloaded, and only the active one. Real hook
 * under jsdom.
 */
function dispatchResync(conversationId: string | null): void {
  window.dispatchEvent(
    new CustomEvent<ResyncEventDetail>(RESYNC_EVENT, {
      detail: { conversationId },
    }),
  );
}

function setup(activeId: string | null) {
  const activeConversationIdRef = {
    current: activeId,
  } as MutableRefObject<string | null>;
  const loadConversationMessages = vi.fn(
    async (): Promise<LoadConversationMessagesResult> => ({ ok: true }),
  );
  const view = renderHook(() =>
    useResyncReconcile({ activeConversationIdRef, loadConversationMessages }),
  );
  return { activeConversationIdRef, loadConversationMessages, view };
}

describe("useResyncReconcile", () => {
  it("reloads the active conversation on resync", () => {
    const { loadConversationMessages } = setup("conv-1");
    dispatchResync("conv-1");
    expect(loadConversationMessages).toHaveBeenCalledTimes(1);
    expect(loadConversationMessages).toHaveBeenCalledWith("conv-1");
  });

  it("falls back to the active conversation when the event carries a null id", () => {
    const { loadConversationMessages } = setup("conv-active");
    dispatchResync(null);
    expect(loadConversationMessages).toHaveBeenCalledWith("conv-active");
  });

  it("does not reload when the resync targets a non-active conversation", () => {
    const { loadConversationMessages } = setup("conv-active");
    dispatchResync("conv-other");
    expect(loadConversationMessages).not.toHaveBeenCalled();
  });

  it("does nothing when there is no active conversation and no target", () => {
    const { loadConversationMessages } = setup(null);
    dispatchResync(null);
    expect(loadConversationMessages).not.toHaveBeenCalled();
  });

  it("detaches the listener on unmount", () => {
    const { loadConversationMessages, view } = setup("conv-1");
    view.unmount();
    dispatchResync("conv-1");
    expect(loadConversationMessages).not.toHaveBeenCalled();
  });
});
