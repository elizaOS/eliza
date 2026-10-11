// @vitest-environment jsdom
/** Retry and Edit replay an earlier turn; the reply the user armed in the composer stays for their next message. */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { client } from "../../../api/client";
import type {
  Conversation,
  ConversationMessage,
} from "../../../api/client-types-chat";
import type { ChatReplyTarget } from "../../../state/ChatComposerContext.hooks";
import { type UseChatSendDeps, useChatSend } from "../../../state/useChatSend";
import { ChatReplyPill } from "../../composites/chat/chat-reply-pill";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const CONVERSATION = {
  id: "conv-1",
  roomId: "room-1",
  title: "Chat",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
} as Conversation;

const HISTORY: ConversationMessage[] = [
  { id: "m-agent-1", role: "assistant", text: "Pick a city", timestamp: 1 },
  {
    id: "m-user-1",
    role: "user",
    text: "plan my trip",
    timestamp: 2,
    replyToMessageId: "m-agent-1",
  },
  {
    id: "m-agent-2",
    role: "assistant",
    text: "",
    timestamp: 3,
    failureKind: "provider_issue",
  },
];

const ARMED: ChatReplyTarget = {
  messageId: "m-agent-2",
  senderName: "Eliza",
  snippet: "Pick a city",
};

type StreamResult = Awaited<
  ReturnType<typeof client.sendConversationMessageStream>
>;

let chat: ReturnType<typeof useChatSend>;

function Harness() {
  const [messages, setMessages] = useState<ConversationMessage[]>(HISTORY);
  const conversationMessagesRef = useRef<ConversationMessage[]>(HISTORY);
  const [input, setInput] = useState("");
  const chatInputRef = useRef("");
  const [replyTarget, setReplyTarget] = useState<ChatReplyTarget | null>(
    ARMED,
  );
  const chatReplyTargetRef = useRef<ChatReplyTarget | null>(ARMED);
  const deps: UseChatSendDeps = {
    t: (key) => key,
    uiLanguage: "en",
    tab: "chat",
    activeConversationId: "conv-1",
    ptySessionsRef: useRef([]),
    setChatInput: (value) => {
      chatInputRef.current = value;
      setInput(value);
    },
    setChatSending: () => {},
    setChatFirstTokenReceived: () => {},
    setServerTurnStatus: () => {},
    setChatLastUsage: () => {},
    setChatPendingImages: () => {},
    setConversations: () => {},
    setActiveConversationId: () => {},
    setCompanionMessageCutoffTs: () => {},
    setConversationMessages: (value) =>
      setMessages((prev) => {
        const next = typeof value === "function" ? value(prev) : value;
        conversationMessagesRef.current = next;
        return next;
      }),
    setUnreadConversations: () => {},
    setChatReplyTarget: (value) => {
      chatReplyTargetRef.current = value;
      setReplyTarget(value);
    },
    setActionNotice: () => {},
    activeConversationIdRef: useRef<string | null>("conv-1"),
    chatInputRef,
    chatPendingImagesRef: useRef([]),
    chatReplyTargetRef,
    conversationsRef: useRef([CONVERSATION]),
    conversationMessagesRef,
    chatAbortRef: useRef(null),
    chatSendBusyRef: useRef(false),
    chatSendNonceRef: useRef(0),
    loadConversations: async () => [CONVERSATION],
    loadConversationMessages: async () => ({ ok: true as const }),
    claimConversationMessagesOwnership: () => 0,
    isConversationMessagesOwnershipCurrent: () => true,
    conversationHydrationEpochRef: { current: 0 },
    registerConversationMessageOverlay: () => {},
    applyConversationMessageOverlayModification: () => {},
    discardConversationMessageState: () => {},
    elizaCloudEnabled: false,
    elizaCloudConnected: false,
    pollCloudCredits: async () => true,
  };
  chat = useChatSend(deps);
  return (
    <div>
      <ol>
        {messages.map((message) => (
          <li key={message.id}>{message.text}</li>
        ))}
      </ol>
      {replyTarget ? (
        <ChatReplyPill
          target={replyTarget}
          onCancel={() => deps.setChatReplyTarget(null)}
        />
      ) : null}
      <textarea
        aria-label="Message"
        value={input}
        onChange={(event) => deps.setChatInput(event.target.value)}
      />
      <button type="button" onClick={() => void chat.handleChatSend()}>
        Send
      </button>
    </div>
  );
}

function mockServer() {
  vi.spyOn(client, "sendWsMessage").mockImplementation(() => {});
  vi.spyOn(client, "abortConversationTurn").mockResolvedValue({
    aborted: false,
    roomId: "room-1",
    reason: "ui-abort",
  });
  vi.spyOn(client, "truncateConversationMessages").mockResolvedValue({
    deletedCount: 2,
  } as Awaited<ReturnType<typeof client.truncateConversationMessages>>);
  const sent: Array<{ text: string; replyToMessageId: unknown }> = [];
  vi.spyOn(client, "sendConversationMessageStream").mockImplementation(
    async (
      _conversationId,
      text,
      _onToken,
      _channelType,
      _signal,
      _images,
      metadata,
    ) => {
      sent.push({ text, replyToMessageId: metadata?.replyToMessageId });
      return {
        text: "ok",
        agentName: "Eliza",
        completed: true,
      } as StreamResult;
    },
  );
  return sent;
}

async function sendFromComposer(text: string) {
  fireEvent.change(screen.getByLabelText("Message"), {
    target: { value: text },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
  });
}

it("keeps the armed reply for the next message when a failed reply is retried", async () => {
  const sent = mockServer();
  render(<Harness />);
  expect(screen.getByTestId("chat-reply-pill").textContent).toContain(
    "Replying to Eliza",
  );

  await act(async () => {
    await chat.handleChatRetry("m-agent-2");
  });

  await waitFor(() =>
    expect(sent).toEqual([
      { text: "plan my trip", replyToMessageId: "m-agent-1" },
    ]),
  );
  expect(screen.getByTestId("chat-reply-pill").textContent).toContain(
    "Replying to Eliza",
  );

  await sendFromComposer("Lisbon");

  await waitFor(() =>
    expect(sent).toEqual([
      { text: "plan my trip", replyToMessageId: "m-agent-1" },
      { text: "Lisbon", replyToMessageId: "m-agent-2" },
    ]),
  );
  expect(screen.queryByTestId("chat-reply-pill")).toBeNull();
});

it("keeps the armed reply for the next message when an earlier message is edited", async () => {
  const sent = mockServer();
  render(<Harness />);

  let edited!: boolean;
  await act(async () => {
    edited = await chat.handleChatEdit("m-user-1", "plan my trip to Spain");
  });

  expect(edited).toBe(true);
  await waitFor(() =>
    expect(sent).toEqual([
      { text: "plan my trip to Spain", replyToMessageId: "m-agent-1" },
    ]),
  );
  expect(screen.getByTestId("chat-reply-pill").textContent).toContain(
    "Replying to Eliza",
  );

  await sendFromComposer("Madrid");

  await waitFor(() =>
    expect(sent).toEqual([
      { text: "plan my trip to Spain", replyToMessageId: "m-agent-1" },
      { text: "Madrid", replyToMessageId: "m-agent-2" },
    ]),
  );
  expect(screen.queryByTestId("chat-reply-pill")).toBeNull();
});
