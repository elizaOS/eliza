// @vitest-environment jsdom
//
// useContextMenu — the desktop (Electrobun) selection context-menu wiring.
// Covers the two regressions this hook owned:
//   • Quote-in-Chat must reach the LIVE floating composer via the chat-prefill
//     event, not the unmounted detached-window ChatView `chatInput` slice.
//   • The custom selection menu must not shadow the native Cut/Copy/Paste menu
//     on editable fields (inputs/textareas/contenteditable).

import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type BridgeListener = (payload: unknown) => void;

const { isElectrobunRuntime, invokeDesktopBridgeRequest, subscribed } =
  vi.hoisted(() => {
    const listeners = new Map<string, BridgeListener>();
    return {
      subscribed: listeners,
      isElectrobunRuntime: vi.fn(() => true),
      invokeDesktopBridgeRequest: vi.fn(() => Promise.resolve(undefined)),
    };
  });

vi.mock("../bridge", () => ({
  isElectrobunRuntime,
  invokeDesktopBridgeRequest,
  subscribeDesktopBridgeEvent: (opts: {
    rpcMessage: string;
    listener: BridgeListener;
  }) => {
    subscribed.set(opts.rpcMessage, opts.listener);
    return () => {
      subscribed.delete(opts.rpcMessage);
    };
  },
}));

vi.mock("../chat", () => ({
  loadSavedCustomCommands: () => [],
  appendSavedCustomCommand: vi.fn(),
}));

import { CHAT_PREFILL_EVENT, type ChatPrefillEventDetail } from "../events";
import { __setAppValueForTests } from "../state/app-store";
import type { AppContextValue } from "../state/internal";
import { useContextMenu } from "./useContextMenu";

function seedStore(): void {
  __setAppValueForTests({
    setState: vi.fn(),
    handleChatSend: vi.fn(),
    setActionNotice: vi.fn(),
  } as unknown as AppContextValue);
}

/** Fire a native `contextmenu` on `target`; returns whether it was prevented. */
function fireContextMenu(target: EventTarget): boolean {
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

beforeEach(() => {
  seedStore();
});

afterEach(() => {
  cleanup();
  __setAppValueForTests(null);
  subscribed.clear();
  invokeDesktopBridgeRequest.mockClear();
  isElectrobunRuntime.mockReturnValue(true);
  document.body.innerHTML = "";
});

describe("useContextMenu — Quote-in-Chat", () => {
  it("routes the selection through the chat-prefill event the live composer listens to", () => {
    const received: ChatPrefillEventDetail[] = [];
    const onPrefill = (e: Event) =>
      received.push((e as CustomEvent<ChatPrefillEventDetail>).detail);
    window.addEventListener(CHAT_PREFILL_EVENT, onPrefill);

    renderHook(() => useContextMenu());
    const quoteInChat = subscribed.get("contextMenuQuoteInChat");
    expect(quoteInChat).toBeTypeOf("function");

    quoteInChat?.({ text: "the selected passage" });

    expect(received).toHaveLength(1);
    expect(received[0].text).toContain("the selected passage");
    // Prefill (never auto-select) so the user can keep typing after the quote.
    expect(received[0].select).toBe(false);

    window.removeEventListener(CHAT_PREFILL_EVENT, onPrefill);
  });
});

describe("useContextMenu — native menu preservation", () => {
  it("does NOT preventDefault on an editable target (native Cut/Copy/Paste kept)", () => {
    renderHook(() => useContextMenu());

    const input = document.createElement("input");
    input.value = "hello world";
    document.body.appendChild(input);
    input.setSelectionRange(0, 5);

    expect(fireContextMenu(input)).toBe(false);
    expect(invokeDesktopBridgeRequest).not.toHaveBeenCalled();
  });

  it("shows the custom menu on a non-editable message target", () => {
    const getSelection = vi.spyOn(window, "getSelection").mockReturnValue({
      toString: () => "a quoted message",
    } as unknown as Selection);

    renderHook(() => useContextMenu());

    const message = document.createElement("div");
    message.textContent = "a quoted message";
    document.body.appendChild(message);

    expect(fireContextMenu(message)).toBe(true);
    expect(invokeDesktopBridgeRequest).toHaveBeenCalledWith(
      expect.objectContaining({ params: { text: "a quoted message" } }),
    );

    getSelection.mockRestore();
  });
});
