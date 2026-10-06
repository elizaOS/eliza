/** Verifies ChatComposerContext draft persistence through the package's configured test harness. */
// @vitest-environment jsdom
/**
 * Per-conversation composer draft persistence (`ChatComposerContext.hooks`):
 * the localStorage-keyed read/write/clear helpers and the debounced hook that
 * saves and restores drafts across conversation switches. Real hook under
 * jsdom + real `localStorage`; no live model or network.
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_DRAFT_STORAGE_PREFIX,
  chatDraftStorageKey,
  clearAllChatDrafts,
  clearChatDraft,
  readChatDraft,
  useChatComposerDraftPersistence,
  writeChatDraft,
} from "./ChatComposerContext.hooks";
import {
  clearPendingChatTurn,
  clearSettledPendingChatTurns,
  listPendingChatTurns,
  markPendingChatTurnRestored,
  PENDING_CHAT_TURN_SETTLE_TIMEOUT_MS,
  PENDING_CHAT_TURN_SETTLED_EVENT,
  persistPendingChatTurn,
} from "./pending-chat-turns";

function DraftHarness({
  activeConversationId,
  chatInput,
  setChatInput,
}: {
  activeConversationId: string | null;
  chatInput: string;
  setChatInput: (next: string) => void;
}) {
  useChatComposerDraftPersistence({
    activeConversationId,
    chatInput,
    setChatInput,
  });
  return null;
}

function installMemoryStorage() {
  const values = new Map<string, string>();
  const storage = {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(values.keys())[index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  } as Storage;
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage,
  });
}

describe("ChatComposerContext draft persistence", () => {
  beforeEach(() => {
    installMemoryStorage();
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    installMemoryStorage();
    window.localStorage.clear();
  });

  it("keys drafts by conversation id", () => {
    expect(chatDraftStorageKey("conversation-1")).toBe(
      `${CHAT_DRAFT_STORAGE_PREFIX}conversation-1`,
    );
    expect(chatDraftStorageKey("conversation-2")).not.toBe(
      chatDraftStorageKey("conversation-1"),
    );
  });

  it("reads, writes, and clears individual drafts", () => {
    expect(readChatDraft("conversation-1")).toBeNull();

    writeChatDraft("conversation-1", "hello");

    expect(readChatDraft("conversation-1")).toBe("hello");
    writeChatDraft("conversation-1", "");
    expect(readChatDraft("conversation-1")).toBeNull();

    writeChatDraft("conversation-1", "again");
    clearChatDraft("conversation-1");
    expect(readChatDraft("conversation-1")).toBeNull();
  });

  it("clears only chat draft keys when clearing all drafts", () => {
    window.localStorage.setItem(chatDraftStorageKey("conversation-1"), "one");
    window.localStorage.setItem(chatDraftStorageKey("conversation-2"), "two");
    window.localStorage.setItem("unrelated", "keep");

    clearAllChatDrafts();

    expect(readChatDraft("conversation-1")).toBeNull();
    expect(readChatDraft("conversation-2")).toBeNull();
    expect(window.localStorage.getItem("unrelated")).toBe("keep");
  });

  it("treats storage exceptions as non-fatal", () => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        get length() {
          throw new Error("blocked");
        },
        clear() {
          throw new Error("blocked");
        },
        getItem() {
          throw new Error("blocked");
        },
        key() {
          throw new Error("blocked");
        },
        removeItem() {
          throw new Error("blocked");
        },
        setItem() {
          throw new Error("quota");
        },
      } as unknown as Storage,
    });

    expect(readChatDraft("conversation-1")).toBeNull();
    expect(() => writeChatDraft("conversation-1", "draft")).not.toThrow();
    expect(() => clearChatDraft("conversation-1")).not.toThrow();
    expect(() => clearAllChatDrafts()).not.toThrow();
  });

  it("restores saved drafts on conversation change and debounces persistence", async () => {
    vi.useFakeTimers();
    window.localStorage.setItem(chatDraftStorageKey("conversation-1"), "saved");
    const setChatInput = vi.fn();

    const view = render(
      <DraftHarness
        activeConversationId="conversation-1"
        chatInput=""
        setChatInput={setChatInput}
      />,
    );

    expect(setChatInput).toHaveBeenCalledWith("saved");

    view.rerender(
      <DraftHarness
        activeConversationId="conversation-1"
        chatInput="new draft"
        setChatInput={setChatInput}
      />,
    );
    expect(readChatDraft("conversation-1")).toBe("saved");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(499);
    });
    expect(readChatDraft("conversation-1")).toBe("saved");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(readChatDraft("conversation-1")).toBe("new draft");

    window.localStorage.setItem(chatDraftStorageKey("conversation-2"), "next");
    view.rerender(
      <DraftHarness
        activeConversationId="conversation-2"
        chatInput="new draft"
        setChatInput={setChatInput}
      />,
    );

    expect(setChatInput).toHaveBeenLastCalledWith("next");
  });

  it("restores an unsettled pending send to the composer after the bounded reload window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T00:00:00.000Z"));
    const setChatInput = vi.fn();

    persistPendingChatTurn({
      conversationId: "conversation-1",
      clientMessageId: "client-1",
      text: "reload-safe message",
      sentAt: Date.now(),
    });

    render(
      <DraftHarness
        activeConversationId="conversation-1"
        chatInput=""
        setChatInput={setChatInput}
      />,
    );

    expect(setChatInput).not.toHaveBeenCalledWith("reload-safe message");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PENDING_CHAT_TURN_SETTLE_TIMEOUT_MS);
    });

    expect(setChatInput).toHaveBeenCalledWith("reload-safe message");
    expect(readChatDraft("conversation-1")).toBe("reload-safe message");
    expect(listPendingChatTurns("conversation-1")[0]?.restoredToDraft).toBe(
      true,
    );
  });

  it("does not restore a pending send after server truth clears its receipt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T00:00:00.000Z"));
    const setChatInput = vi.fn();

    persistPendingChatTurn({
      conversationId: "conversation-1",
      clientMessageId: "client-1",
      text: "already settled",
      sentAt: Date.now(),
    });

    render(
      <DraftHarness
        activeConversationId="conversation-1"
        chatInput=""
        setChatInput={setChatInput}
      />,
    );
    clearPendingChatTurn("conversation-1", "client-1");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PENDING_CHAT_TURN_SETTLE_TIMEOUT_MS);
    });

    expect(setChatInput).not.toHaveBeenCalledWith("already settled");
    expect(readChatDraft("conversation-1")).toBeNull();
  });

  it("waits for history after a late cold launch before restoring an old pending send", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T00:00:00.000Z"));
    persistPendingChatTurn({
      conversationId: "conversation-1",
      clientMessageId: "client-late",
      text: "accepted while phone was off",
      sentAt: Date.now(),
    });
    await vi.advanceTimersByTimeAsync(60_000);
    const setChatInput = vi.fn();
    render(
      <DraftHarness
        activeConversationId="conversation-1"
        chatInput=""
        setChatInput={setChatInput}
      />,
    );
    expect(setChatInput).not.toHaveBeenCalledWith(
      "accepted while phone was off",
    );
    clearPendingChatTurn("conversation-1", "client-late");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PENDING_CHAT_TURN_SETTLE_TIMEOUT_MS);
    });
    expect(setChatInput).not.toHaveBeenCalledWith(
      "accepted while phone was off",
    );
    expect(readChatDraft("conversation-1")).toBeNull();
  });

  it("keeps an uncertain send id through two cold launches without history", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T00:00:00.000Z"));
    persistPendingChatTurn({
      conversationId: "conversation-1",
      clientMessageId: "client-original",
      text: "uncertain send",
      sentAt: Date.now(),
    });
    const first = render(
      <DraftHarness
        activeConversationId="conversation-1"
        chatInput=""
        setChatInput={vi.fn()}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PENDING_CHAT_TURN_SETTLE_TIMEOUT_MS);
    });
    expect(readChatDraft("conversation-1")).toBe("uncertain send");
    first.unmount();
    render(
      <DraftHarness
        activeConversationId="conversation-1"
        chatInput=""
        setChatInput={vi.fn()}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PENDING_CHAT_TURN_SETTLE_TIMEOUT_MS);
    });
    expect(listPendingChatTurns("conversation-1")).toEqual([
      expect.objectContaining({ clientMessageId: "client-original" }),
    ]);
  });

  it("preserves a fresh identical draft when a never-restored send settles", () => {
    const sentAt = Date.now();
    persistPendingChatTurn({
      conversationId: "conversation-1",
      clientMessageId: "older-send",
      text: "continue",
      sentAt,
    });
    writeChatDraft("conversation-1", "continue");
    const setChatInput = vi.fn();
    render(
      <DraftHarness
        activeConversationId="conversation-1"
        chatInput="continue"
        setChatInput={setChatInput}
      />,
    );
    setChatInput.mockClear();
    act(() =>
      clearSettledPendingChatTurns("conversation-1", [
        {
          id: "server-older",
          role: "user",
          text: "continue",
          timestamp: sentAt,
        },
      ]),
    );
    expect(readChatDraft("conversation-1")).toBe("continue");
    expect(setChatInput).not.toHaveBeenCalledWith("");
    expect(listPendingChatTurns("conversation-1")).toEqual([]);
  });

  it.each(["different draft", ""])(
    "preserves recovery ownership revocation after editing to %j and back, including reload",
    async (edited) => {
      vi.useFakeTimers();
      const sentAt = Date.now();
      persistPendingChatTurn({
        conversationId: "conversation-1",
        clientMessageId: "recovered-send",
        text: "continue",
        sentAt,
      });
      const setChatInput = vi.fn();
      const view = render(
        <DraftHarness
          activeConversationId="conversation-1"
          chatInput=""
          setChatInput={setChatInput}
        />,
      );
      await act(async () =>
        vi.advanceTimersByTimeAsync(PENDING_CHAT_TURN_SETTLE_TIMEOUT_MS),
      );
      view.rerender(
        <DraftHarness
          activeConversationId="conversation-1"
          chatInput="continue"
          setChatInput={setChatInput}
        />,
      );
      view.rerender(
        <DraftHarness
          activeConversationId="conversation-1"
          chatInput={edited}
          setChatInput={setChatInput}
        />,
      );
      view.rerender(
        <DraftHarness
          activeConversationId="conversation-1"
          chatInput="continue"
          setChatInput={setChatInput}
        />,
      );
      await act(async () => vi.advanceTimersByTimeAsync(500));
      expect(listPendingChatTurns("conversation-1")).toEqual([
        expect.objectContaining({
          clientMessageId: "recovered-send",
          restoredToDraft: false,
        }),
      ]);
      view.unmount();
      render(
        <DraftHarness
          activeConversationId="conversation-1"
          chatInput="continue"
          setChatInput={setChatInput}
        />,
      );
      setChatInput.mockClear();
      act(() =>
        clearSettledPendingChatTurns("conversation-1", [
          {
            id: "server-older",
            role: "user",
            text: "continue",
            timestamp: sentAt,
          },
        ]),
      );
      expect(readChatDraft("conversation-1")).toBe("continue");
      expect(setChatInput).not.toHaveBeenCalledWith("");
      expect(listPendingChatTurns("conversation-1")).toEqual([]);
    },
  );

  it("ignores a same-text settlement belonging to another recovered receipt", () => {
    persistPendingChatTurn({
      conversationId: "conversation-1",
      clientMessageId: "current-owner",
      text: "continue",
      sentAt: Date.now(),
    });
    expect(markPendingChatTurnRestored("conversation-1", "current-owner")).toBe(
      true,
    );
    writeChatDraft("conversation-1", "continue");
    const setChatInput = vi.fn();
    render(
      <DraftHarness
        activeConversationId="conversation-1"
        chatInput="continue"
        setChatInput={setChatInput}
      />,
    );
    setChatInput.mockClear();
    act(() =>
      window.dispatchEvent(
        new CustomEvent(PENDING_CHAT_TURN_SETTLED_EVENT, {
          detail: {
            conversationId: "conversation-1",
            clientMessageId: "other-owner",
            text: "continue",
          },
        }),
      ),
    );
    expect(readChatDraft("conversation-1")).toBe("continue");
    expect(setChatInput).not.toHaveBeenCalledWith("");
    expect(listPendingChatTurns("conversation-1")[0]?.clientMessageId).toBe(
      "current-owner",
    );
  });

  it("removes a recovered draft when later server history confirms that send", () => {
    const sentAt = Date.now();
    persistPendingChatTurn({
      conversationId: "conversation-1",
      clientMessageId: "client-original",
      text: "accepted prompt",
      sentAt,
    });
    expect(
      markPendingChatTurnRestored("conversation-1", "client-original"),
    ).toBe(true);
    writeChatDraft("conversation-1", "accepted prompt");
    const setChatInput = vi.fn();
    render(
      <DraftHarness
        activeConversationId="conversation-1"
        chatInput="accepted prompt"
        setChatInput={setChatInput}
      />,
    );
    act(() => {
      clearSettledPendingChatTurns("conversation-1", [
        {
          id: "server-user",
          role: "user",
          text: "accepted prompt",
          timestamp: sentAt,
        },
      ]);
    });
    expect(setChatInput).toHaveBeenCalledWith("");
    expect(readChatDraft("conversation-1")).toBeNull();
    expect(listPendingChatTurns("conversation-1")).toEqual([]);
  });
});
