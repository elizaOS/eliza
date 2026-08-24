import { describe, expect, it, vi } from "vitest";
/** @vitest-environment jsdom */
import {
  dispatchConversationResync,
  RESYNC_EVENT,
} from "./AppContext.hooks.js";

describe("AppContext.hooks", () => {
  it("RESYNC_EVENT constant", () => {
    expect(RESYNC_EVENT).toBe("elizaos:needs-resync");
  });

  it("dispatchConversationResync dispatches event", () => {
    const handler = vi.fn();
    window.addEventListener(RESYNC_EVENT, handler as EventListener);
    dispatchConversationResync({
      conversationId: "123",
      reason: "connection-recovered",
    });
    expect(handler).toHaveBeenCalledTimes(1);
    const ev = handler.mock.calls[0][0] as CustomEvent;
    expect(ev.detail.conversationId).toBe("123");
    window.removeEventListener(RESYNC_EVENT, handler as EventListener);
  });

  it("no-op when window undefined", () => {
    const origWindow = globalThis.window;
    // @ts-expect-error
    delete globalThis.window;
    expect(() =>
      dispatchConversationResync({ conversationId: null }),
    ).not.toThrow();
    globalThis.window = origWindow;
  });
});
