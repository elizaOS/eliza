// @vitest-environment jsdom

/**
 * Jump-to-message coverage for the keyword-search panel (#9955). When a search
 * hit is OLDER than the loaded recent window, its anchor element is absent after
 * selecting the conversation; the sidebar must then load the window CENTERED on
 * the target (`loadConversationMessagesAround`) and only THEN scroll it into
 * view. These tests drive the real ConversationsSidebar → MessageSearchPanel →
 * jumpToMessage path with mocked app state + client.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Conversation,
  ConversationMessageSearchResult,
} from "../../api/client-types-chat";
import { CHAT_TRANSCRIPT_REVEAL_WINDOW_EVENT } from "../../hooks/useConversationRenderWindow";
import { onViewEvent } from "../../views/view-event-bus";
import { getChatMessageAnchorId } from "../composites/chat/chat-message";

type AppState = Record<string, unknown>;

const appMock = vi.hoisted(() => ({ value: {} as AppState }));

vi.mock("../../state", () => ({
  useApp: () => appMock.value,
  useAppSelector: (sel: (value: AppState) => unknown) => sel(appMock.value),
  useAppSelectorShallow: (sel: (value: AppState) => unknown) =>
    sel(appMock.value),
}));

vi.mock("../../state/PtySessionsContext.hooks", () => ({
  usePtySessions: () => ({ ptySessions: [] }),
}));

vi.mock("../../hooks/useDocumentVisibility", () => ({
  useDocumentVisibility: () => true,
  useIntervalWhenDocumentVisible: () => {},
}));

const OLD_MESSAGE_ID = "old-msg-1";
const TARGET_CONVERSATION_ID = "conv-a";

const oldHit: ConversationMessageSearchResult = {
  messageId: OLD_MESSAGE_ID,
  conversationId: TARGET_CONVERSATION_ID,
  roomId: "room-conv-a",
  role: "user",
  text: "the very first thing we ever discussed",
  snippet: "…the very first thing…",
  createdAt: 1,
  score: 5,
};

const clientMock = vi.hoisted(() => ({
  getInboxChats: vi.fn(async () => ({ chats: [] })),
  getConversationMessages: vi.fn(async () => ({ messages: [] })),
  searchConversationMessages: vi.fn(
    async (): Promise<{
      results: ConversationMessageSearchResult[];
      count: number;
    }> => ({ results: [], count: 0 }),
  ),
  spawnShellSession: vi.fn(async () => ({ sessionId: "term-1" })),
}));

vi.mock("../../api", () => ({
  client: clientMock,
}));

import { ConversationsSidebar } from "./ConversationsSidebar";

function conv(overrides: Partial<Conversation> & { id: string }): Conversation {
  const updatedAt = overrides.updatedAt ?? new Date().toISOString();
  return {
    title: overrides.id,
    roomId: `room-${overrides.id}`,
    createdAt: updatedAt,
    updatedAt,
    ...overrides,
  };
}

function makeAppState(overrides: Partial<AppState> = {}): AppState {
  return {
    conversations: [conv({ id: "conv-a", title: "Alpha thread" })],
    activeConversationId: "conv-a",
    activeInboxChat: null,
    activeTerminalSessionId: null,
    unreadConversations: new Set<string>(),
    handleNewConversation: vi.fn(async () => {}),
    handleSelectConversation: vi.fn(async () => {}),
    loadConversationMessagesAround: vi.fn(async () => false),
    handleDeleteConversation: vi.fn(async () => {}),
    handleRenameConversation: vi.fn(async () => {}),
    suggestConversationTitle: vi.fn(async () => "Suggested title"),
    ensurePluginsLoaded: vi.fn(async () => {}),
    setActionNotice: vi.fn(),
    setTab: vi.fn(),
    setState: vi.fn(),
    tab: "chat",
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? key,
    ...overrides,
  };
}

function scrollSpy() {
  const spy = vi.fn();
  // jsdom doesn't implement scrollIntoView — stub it so the flash path runs.
  Element.prototype.scrollIntoView = spy;
  return spy;
}

async function openSearchAndJump() {
  // Open the search panel, type a query, wait for the (mocked) result, click it.
  fireEvent.click(await screen.findByTestId("conversations-search-messages"));
  fireEvent.change(await screen.findByTestId("message-search-input"), {
    target: { value: "first thing" },
  });
  const result = await screen.findByTestId("message-search-result", undefined, {
    timeout: 3000,
  });
  fireEvent.click(result);
}

afterEach(() => {
  cleanup();
  // Anchor stand-ins are appended straight to document.body (not via render), so
  // testing-library's cleanup misses them — remove them so a leftover anchor
  // can't satisfy the NEXT test's "anchor absent" precondition.
  for (const el of document.body.querySelectorAll('[id^="chat-message-"]')) {
    el.remove();
  }
});

describe("ConversationsSidebar jump-to-message (#9955)", () => {
  beforeEach(() => {
    clientMock.getInboxChats.mockResolvedValue({ chats: [] });
    clientMock.getConversationMessages.mockResolvedValue({ messages: [] });
    clientMock.searchConversationMessages.mockResolvedValue({
      results: [oldHit],
      count: 1,
    });
    appMock.value = makeAppState();
  });

  it("emits the render-window reveal after the around-load so a windowed transcript mounts the pivot", async () => {
    // A windowed ChatView/overlay slices the centered around-load's pivot out of
    // the render window unless it is told to reveal (#15281). The sidebar must
    // fire CHAT_TRANSCRIPT_REVEAL_WINDOW_EVENT after a successful around-load.
    const scroll = scrollSpy();
    const revealEvents: number[] = [];
    const off = onViewEvent(CHAT_TRANSCRIPT_REVEAL_WINDOW_EVENT, () =>
      revealEvents.push(Date.now()),
    );
    const loadConversationMessagesAround = vi.fn(
      async (_conversationId: string, messageId: string) => {
        const el = document.createElement("div");
        el.id = getChatMessageAnchorId(messageId);
        document.body.appendChild(el);
        return true;
      },
    );
    appMock.value = makeAppState({ loadConversationMessagesAround });

    render(<ConversationsSidebar />);
    await openSearchAndJump();

    await waitFor(() => expect(scroll).toHaveBeenCalledTimes(1), {
      timeout: 3000,
    });
    expect(loadConversationMessagesAround).toHaveBeenCalledWith(
      TARGET_CONVERSATION_ID,
      OLD_MESSAGE_ID,
    );
    expect(revealEvents).toHaveLength(1);
    off();
  });

  it("does NOT emit the reveal when the hit is already in the loaded window", async () => {
    // No around-load → no reveal: the in-window common case must not force the
    // transcript to unbound its DOM.
    scrollSpy();
    const el = document.createElement("div");
    el.id = getChatMessageAnchorId(OLD_MESSAGE_ID);
    document.body.appendChild(el);
    const revealEvents: number[] = [];
    const off = onViewEvent(CHAT_TRANSCRIPT_REVEAL_WINDOW_EVENT, () =>
      revealEvents.push(Date.now()),
    );
    appMock.value = makeAppState({
      loadConversationMessagesAround: vi.fn(async () => true),
    });

    render(<ConversationsSidebar />);
    await openSearchAndJump();

    await waitFor(
      () => expect(Element.prototype.scrollIntoView).toHaveBeenCalled(),
      { timeout: 3000 },
    );
    expect(revealEvents).toHaveLength(0);
    off();
  });

  it("loads the window AROUND a far-back hit (anchor absent) then scrolls it into view", async () => {
    const scroll = scrollSpy();
    const handleSelectConversation = vi.fn(async () => {});
    // The around-loader stands in for the real store update: it injects the
    // target's anchor element (simulating the centered window re-rendering) so
    // the subsequent scroll can find it.
    const loadConversationMessagesAround = vi.fn(
      async (_conversationId: string, messageId: string) => {
        const el = document.createElement("div");
        el.id = getChatMessageAnchorId(messageId);
        document.body.appendChild(el);
        return true;
      },
    );
    appMock.value = makeAppState({
      handleSelectConversation,
      loadConversationMessagesAround,
    });

    render(<ConversationsSidebar />);
    await openSearchAndJump();

    // It selected the conversation, then — finding no anchor — asked for the
    // window centered on the far-back target.
    await waitFor(
      () =>
        expect(loadConversationMessagesAround).toHaveBeenCalledWith(
          TARGET_CONVERSATION_ID,
          OLD_MESSAGE_ID,
        ),
      { timeout: 3000 },
    );
    expect(handleSelectConversation).toHaveBeenCalledWith(
      TARGET_CONVERSATION_ID,
    );

    // The scroll happens only AFTER the around-window was loaded.
    await waitFor(() => expect(scroll).toHaveBeenCalledTimes(1), {
      timeout: 3000,
    });
    expect(scroll.mock.invocationCallOrder[0]).toBeGreaterThan(
      loadConversationMessagesAround.mock.invocationCallOrder[0],
    );
  });

  it("scrolls directly without an around-load when the hit is already in the loaded window", async () => {
    const scroll = scrollSpy();
    // The target is already mounted (in the recent window).
    const el = document.createElement("div");
    el.id = getChatMessageAnchorId(OLD_MESSAGE_ID);
    document.body.appendChild(el);

    const loadConversationMessagesAround = vi.fn(async () => true);
    appMock.value = makeAppState({ loadConversationMessagesAround });

    render(<ConversationsSidebar />);
    await openSearchAndJump();

    await waitFor(() => expect(scroll).toHaveBeenCalledTimes(1), {
      timeout: 3000,
    });
    expect(loadConversationMessagesAround).not.toHaveBeenCalled();
  });

  it("clears an active terminal/inbox surface and lands on chat before jumping", async () => {
    // ChatView renders the terminal branch first and the inbox branch second,
    // so with either active a jump switched the conversation invisibly beneath
    // it and the anchor never mounted. jumpToMessage must clear both and set
    // the chat tab (mirroring handleRowSelect).
    const scroll = scrollSpy();
    const el = document.createElement("div");
    el.id = getChatMessageAnchorId(OLD_MESSAGE_ID);
    document.body.appendChild(el);

    const setState = vi.fn();
    const setTab = vi.fn();
    appMock.value = makeAppState({
      activeTerminalSessionId: "pty-1",
      activeInboxChat: null,
      loadConversationMessagesAround: vi.fn(async () => true),
      setState,
      setTab,
    });

    render(<ConversationsSidebar />);
    await openSearchAndJump();

    await waitFor(() => expect(scroll).toHaveBeenCalledTimes(1), {
      timeout: 3000,
    });
    expect(setState).toHaveBeenCalledWith("activeTerminalSessionId", null);
    expect(setState).toHaveBeenCalledWith("activeInboxChat", null);
    expect(setTab).toHaveBeenCalledWith("chat");
  });
});
