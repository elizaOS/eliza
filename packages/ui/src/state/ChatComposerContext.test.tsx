// @vitest-environment jsdom
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
} from "./ChatComposerContext";

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
});
