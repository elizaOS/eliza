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
let harnessDeps: UseChatSendDeps;
let harnessMessagesRef: { current: ConversationMessage[] };

function Harness({
  history = HISTORY,
  armed = ARMED,
}: {
  history?: ConversationMessage[];
  armed?: ChatReplyTarget | null;
}) {
  const [messages, setMessages] = useState<ConversationMessage[]>(history);
  const conversationMessagesRef = useRef<ConversationMessage[]>(history);
  const [input, setInput] = useState("");
  const chatInputRef = useRef("");
  const [replyTarget, setReplyTarget] = useState<ChatReplyTarget | null>(
    armed,
  );
  const chatReplyTargetRef = useRef<ChatReplyTarget | null>(armed);
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
  harnessDeps = deps;
  harnessMessagesRef = conversationMessagesRef;
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

function mockServer(
  respond: (text: string) => Partial<StreamResult> = () => ({
    text: "ok",
    completed: true,
  }),
) {
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
      return { agentName: "Eliza", ...respond(text) } as StreamResult;
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

it("retries a turn that failed before it was saved with its original reply and keeps the armed reply", async () => {
  let failNext = true;
  const sent = mockServer(() => {
    if (!failNext) return { text: "ok", completed: true };
    failNext = false;
    return { text: "", completed: true, failureKind: "provider_issue" };
  });
  render(
    <Harness
      history={[HISTORY[0]]}
      armed={{
        messageId: "m-agent-1",
        senderName: "Eliza",
        snippet: "Pick a city",
      }}
    />,
  );

  await sendFromComposer("plan my trip");

  await waitFor(() =>
    expect(sent).toEqual([
      { text: "plan my trip", replyToMessageId: "m-agent-1" },
    ]),
  );
  let failed: ConversationMessage | undefined;
  await waitFor(() => {
    failed = harnessMessagesRef.current.find(
      (message) => message.failureKind === "provider_issue",
    );
    expect(failed?.id).toMatch(/^temp-resp-/);
  });
  expect(screen.queryByTestId("chat-reply-pill")).toBeNull();

  act(() => harnessDeps.setChatReplyTarget(ARMED));
  await act(async () => {
    await chat.handleChatRetry(failed?.id ?? "");
  });

  await waitFor(() =>
    expect(sent).toEqual([
      { text: "plan my trip", replyToMessageId: "m-agent-1" },
      { text: "plan my trip", replyToMessageId: "m-agent-1" },
    ]),
  );
  expect(screen.getByTestId("chat-reply-pill").textContent).toContain(
    "Replying to Eliza",
  );
});

const PHOTO_BYTES = "photo-bytes";
const STORED_PHOTO_URL = `/api/media/${"a".repeat(64)}.png`;
const PHOTO_HISTORY: ConversationMessage[] = [
  {
    id: "m-user-photo",
    role: "user",
    text: "what is this?",
    timestamp: 1,
    attachments: [
      {
        id: "abc",
        url: STORED_PHOTO_URL,
        title: "photo.png",
        mimeType: "image/png",
        contentType: "image",
      },
    ],
  },
  {
    id: "m-agent-photo",
    role: "assistant",
    text: "",
    timestamp: 2,
    failureKind: "provider_issue",
  },
];
const PHOTO_UPLOAD = [
  { data: btoa(PHOTO_BYTES), mimeType: "image/png", name: "photo.png" },
];

/** Captures the upload payload each replayed turn sends to the server. */
function mockServerImages() {
  mockServer();
  const sentImages: unknown[] = [];
  vi.spyOn(client, "sendConversationMessageStream").mockImplementation(
    async (_conversationId, _text, _onToken, _channelType, _signal, images) => {
      sentImages.push(images);
      return {
        agentName: "Eliza",
        text: "ok",
        completed: true,
      } as StreamResult;
    },
  );
  return sentImages;
}

function mockStoredMedia() {
  return vi.spyOn(client, "rawRequest").mockImplementation(
    async () =>
      ({
        blob: async () => new Blob([PHOTO_BYTES], { type: "image/png" }),
      }) as Response,
  );
}

it("sends the stored image again when a failed turn is retried", async () => {
  const sentImages = mockServerImages();
  const media = mockStoredMedia();
  render(<Harness history={PHOTO_HISTORY} armed={null} />);

  await act(async () => {
    await chat.handleChatRetry("m-agent-photo");
  });

  await waitFor(() => expect(sentImages).toEqual([PHOTO_UPLOAD]));
  expect(media).toHaveBeenCalledWith(STORED_PHOTO_URL);
});

it("sends the stored image again when the turn text is edited", async () => {
  const sentImages = mockServerImages();
  mockStoredMedia();
  render(<Harness history={PHOTO_HISTORY} armed={null} />);

  let edited!: boolean;
  await act(async () => {
    edited = await chat.handleChatEdit("m-user-photo", "what breed is this?");
  });

  expect(edited).toBe(true);
  await waitFor(() => expect(sentImages).toEqual([PHOTO_UPLOAD]));
});

it("keeps the stored turn when its image cannot be read for an edit", async () => {
  const sentImages = mockServerImages();
  vi.spyOn(client, "rawRequest").mockRejectedValue(new Error("gone"));
  render(<Harness history={PHOTO_HISTORY} armed={null} />);

  let edited!: boolean;
  await act(async () => {
    edited = await chat.handleChatEdit("m-user-photo", "what breed is this?");
  });

  expect(edited).toBe(false);
  expect(client.truncateConversationMessages).not.toHaveBeenCalled();
  expect(sentImages).toEqual([]);
  expect(harnessMessagesRef.current).toEqual(PHOTO_HISTORY);
});

it("does not read a scheme-relative attachment URL with the API credential", async () => {
  const sentImages = mockServerImages();
  const media = mockStoredMedia();
  const history: ConversationMessage[] = [
    {
      ...PHOTO_HISTORY[0],
      attachments: [
        { id: "abc", url: "//media.example/abc.png", mimeType: "image/png" },
      ],
    },
    PHOTO_HISTORY[1],
  ];
  render(<Harness history={history} armed={null} />);

  await act(async () => {
    await chat.handleChatRetry("m-agent-photo");
  });

  expect(media).not.toHaveBeenCalled();
  expect(client.truncateConversationMessages).not.toHaveBeenCalled();
  expect(sentImages).toEqual([]);
  expect(harnessMessagesRef.current).toEqual(history);
});

it("does not read another same-origin API path with the API credential", async () => {
  const sentImages = mockServerImages();
  const media = mockStoredMedia();
  const history: ConversationMessage[] = [
    {
      ...PHOTO_HISTORY[0],
      attachments: [
        { id: "config", url: "/api/config", mimeType: "image/png" },
      ],
    },
    PHOTO_HISTORY[1],
  ];
  render(<Harness history={history} armed={null} />);

  await act(async () => {
    await chat.handleChatRetry("m-agent-photo");
  });

  expect(media).not.toHaveBeenCalled();
  expect(client.truncateConversationMessages).not.toHaveBeenCalled();
  expect(sentImages).toEqual([]);
  expect(harnessMessagesRef.current).toEqual(history);
});


it("refuses an oversized stored image before truncation instead of recompressing it", async () => {
  const sentImages = mockServerImages();
  vi.spyOn(client, "rawRequest").mockResolvedValue({ blob: async () => new Blob([new Uint8Array(4 * 1024 * 1024)], { type: "image/png" }) } as Response);
  render(<Harness history={PHOTO_HISTORY} armed={null} />);
  await act(async () => { await chat.handleChatRetry("m-agent-photo"); });
  expect(client.truncateConversationMessages).not.toHaveBeenCalled();
  expect(sentImages).toEqual([]);
  expect(harnessMessagesRef.current).toEqual(PHOTO_HISTORY);
});

it("does not replay stale attachments when the source message changes during the read", async () => {
  const sentImages = mockServerImages();
  let finish!: (response: Response) => void;
  vi.spyOn(client, "rawRequest").mockImplementation(() => new Promise<Response>((resolve) => { finish = resolve; }));
  render(<Harness history={PHOTO_HISTORY} armed={null} />);
  await act(async () => {
    const replay = chat.handleChatRetry("m-agent-photo");
    harnessMessagesRef.current = [{ ...PHOTO_HISTORY[0], text: "a newer version" }, PHOTO_HISTORY[1]];
    finish({ blob: async () => new Blob([PHOTO_BYTES], { type: "image/png" }) } as Response);
    await replay;
  });
  expect(client.truncateConversationMessages).not.toHaveBeenCalled();
  expect(sentImages).toEqual([]);
});

it("does not replay a turn that recovered while its attachment was loading", async () => {
  const sentImages = mockServerImages();
  let finishRead!: (response: Response) => void;
  vi.spyOn(client, "rawRequest").mockImplementation(
    () => new Promise<Response>((resolve) => { finishRead = resolve; }),
  );
  render(<Harness history={PHOTO_HISTORY} armed={null} />);
  await act(async () => {
    const retry = chat.handleChatRetry("m-agent-photo");
    harnessMessagesRef.current = [
      PHOTO_HISTORY[0],
      { ...PHOTO_HISTORY[1], text: "Recovered answer", failureKind: undefined },
    ];
    finishRead({ blob: async () => new Blob([PHOTO_BYTES], { type: "image/png" }) } as Response);
    await retry;
  });
  expect(client.truncateConversationMessages).not.toHaveBeenCalled();
  expect(sentImages).toEqual([]);
});

it("does not edit a turn whose attachments changed while loading", async () => {
  const sentImages = mockServerImages();
  let finishRead!: (response: Response) => void;
  vi.spyOn(client, "rawRequest").mockImplementation(
    () => new Promise<Response>((resolve) => { finishRead = resolve; }),
  );
  render(<Harness history={PHOTO_HISTORY} armed={null} />);
  await act(async () => {
    const edit = chat.handleChatEdit("m-user-photo", "different question");
    harnessMessagesRef.current = [
      { ...PHOTO_HISTORY[0], attachments: [] },
      PHOTO_HISTORY[1],
    ];
    finishRead({ blob: async () => new Blob([PHOTO_BYTES], { type: "image/png" }) } as Response);
    expect(await edit).toBe(false);
  });
  expect(client.truncateConversationMessages).not.toHaveBeenCalled();
  expect(sentImages).toEqual([]);
});
