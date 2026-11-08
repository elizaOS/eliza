// @vitest-environment jsdom
/**
 * Chat send recovery: an app pause detaches the stream without stopping the
 * agent, restored text merges with what the user typed since, unmount keeps
 * queued text, a live turn is never offered back as a draft, ordinary
 * `#`/`$` messages reach the agent, and a stale turn's workflow handoff does
 * not navigate.
 */
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "../../api/client";
import type {
  Conversation,
  ConversationMessage,
} from "../../api/client-types-chat";
import { VISUALIZE_WORKFLOW_EVENT } from "../../components/pages/workflow-graph-events";
import { APP_PAUSE_EVENT, NAVIGATE_VIEW_EVENT } from "../../events";
import { sentUserTurnPresent } from "../chat-send-failures";
import {
  readChatDraft,
  useChatComposerDraftPersistence,
} from "../ChatComposerContext.hooks";
import {
  clearSettledPendingChatTurns,
  listPendingChatTurns,
  persistPendingChatTurn,
} from "../pending-chat-turns";
import { useAppLifecycleEvents } from "../useAppLifecycleEvents";
import { type UseChatSendDeps, useChatSend } from "../useChatSend";

const CONVERSATION = {
  id: "conv-1",
  roomId: "room-1",
  title: "Chat",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
} as Conversation;

type StreamResult = Awaited<
  ReturnType<typeof client.sendConversationMessageStream>
>;

let chat: ReturnType<typeof useChatSend>;
let composer: { current: string };
let messagesRef: { current: ConversationMessage[] };

function Harness() {
  const [, setMessages] = useState<ConversationMessage[]>([]);
  const conversationMessagesRef = useRef<ConversationMessage[]>([]);
  const chatInputRef = useRef("");
  const [, setInput] = useState("");
  const activeConversationIdRef = useRef<string | null>("conv-1");
  const chatAbortRef = useRef<AbortController | null>(null);
  const setConversationMessages: UseChatSendDeps["setConversationMessages"] = (
    value,
  ) =>
    setMessages((prev) => {
      const next = typeof value === "function" ? value(prev) : value;
      conversationMessagesRef.current = next;
      return next;
    });
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
    setConversationMessages,
    setUnreadConversations: () => {},
    setChatReplyTarget: () => {},
    setActionNotice: () => {},
    activeConversationIdRef,
    chatInputRef,
    chatPendingImagesRef: useRef([]),
    chatReplyTargetRef: useRef(null),
    conversationsRef: useRef([CONVERSATION]),
    conversationMessagesRef,
    chatAbortRef,
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
  useAppLifecycleEvents({
    activeConversationIdRef,
    conversationMessagesRef,
    chatAbortRef,
    setConversationMessages,
    loadConversationMessages: deps.loadConversationMessages,
    hydrateInitialConversationState: async () => "conv-1",
  });
  composer = chatInputRef;
  messagesRef = conversationMessagesRef;
  return null;
}

type HeldTurn = {
  text: string;
  resolve: (result: StreamResult) => void;
  reject: (error: unknown) => void;
};

/** Texts in `hold` stream until settled by the test; others complete at once. */
function mockServer(hold: ReadonlySet<string> = new Set()) {
  const sent: string[] = [];
  const held: HeldTurn[] = [];
  vi.spyOn(client, "sendWsMessage").mockImplementation(() => {});
  const stops = vi
    .spyOn(client, "abortConversationTurn")
    .mockImplementation(async (roomId, reason) => ({
      aborted: true,
      roomId,
      reason: reason ?? "",
    }));
  vi.spyOn(client, "sendConversationMessageStream").mockImplementation(
    async (_conversationId, text, _onToken, _channelType, signal) => {
      sent.push(text);
      if (!hold.has(text))
        return { agentName: "Eliza", text: "ok", completed: true } as StreamResult;
      return new Promise<StreamResult>((resolve, reject) => {
        held.push({ text, resolve, reject });
        signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    },
  );
  return { sent, held, stops };
}

async function send(text: string): Promise<void> {
  await act(async () => {
    composer.current = text;
    void chat.handleChatSend();
  });
}

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

it("detaches the stream on app pause without stopping the agent turn", async () => {
  const server = mockServer(new Set(["long task"]));
  render(<Harness />);
  await send("long task");
  await waitFor(() => expect(server.held).toHaveLength(1));
  expect(listPendingChatTurns("conv-1")).toHaveLength(1);

  await act(async () => {
    document.dispatchEvent(new Event(APP_PAUSE_EVENT));
  });

  await waitFor(() =>
    expect(
      messagesRef.current.some(
        (message) => message.role === "assistant" && message.text === "",
      ),
    ).toBe(true),
  );
  expect(server.stops).not.toHaveBeenCalled();
  // The receipt stays so the resume reload can settle the reply.
  expect(listPendingChatTurns("conv-1")).toHaveLength(1);

  // The next send is admitted at once.
  await send("next");
  await waitFor(() => expect(server.sent).toEqual(["long task", "next"]));
  expect(server.stops).not.toHaveBeenCalled();
});

it("still stops the agent turn when the user presses Stop", async () => {
  const server = mockServer(new Set(["long task"]));
  render(<Harness />);
  await send("long task");
  await waitFor(() => expect(server.held).toHaveLength(1));
  await act(async () => {
    chat.handleChatStop();
  });
  expect(server.stops).toHaveBeenCalledWith("room-1", "ui-chat-stop");
});

it("merges queued text restored by Stop with text typed since", async () => {
  const server = mockServer(new Set(["first"]));
  render(<Harness />);
  await send("first");
  await waitFor(() => expect(server.held).toHaveLength(1));
  await send("queued");
  composer.current = "typed since";
  await act(async () => {
    chat.handleChatStop();
  });
  expect(composer.current).toBe("queued\ntyped since");
  expect(server.sent).toEqual(["first"]);
});

it("merges a rejected message with text typed since", async () => {
  const server = mockServer(new Set(["too big"]));
  render(<Harness />);
  await send("too big");
  await waitFor(() => expect(server.held).toHaveLength(1));
  composer.current = "typed since";
  await act(async () => {
    server.held[0].reject(
      Object.assign(new Error("Attachment too large"), { status: 413 }),
    );
  });
  await waitFor(() => expect(composer.current).toBe("too big\ntyped since"));
});

it("settles queued sends on unmount and keeps their text as the draft", async () => {
  const server = mockServer(new Set(["first"]));
  const view = render(<Harness />);
  await send("first");
  await waitFor(() => expect(server.held).toHaveLength(1));
  let queuedSettled = false;
  await act(async () => {
    void chat.sendChatText("queued").then(() => {
      queuedSettled = true;
    });
  });
  view.unmount();
  await waitFor(() => expect(queuedSettled).toBe(true));
  expect(readChatDraft("conv-1")).toBe("queued");
  expect(server.sent).toEqual(["first"]);
});

function DraftRestore({ onInput }: { onInput: (text: string) => void }) {
  const [input, setInput] = useState("");
  useChatComposerDraftPersistence({
    activeConversationId: "conv-1",
    chatInput: input,
    setChatInput: (text) => {
      onInput(text);
      setInput(text);
    },
  });
  return null;
}

it("does not restore a slow live turn as a draft", async () => {
  const server = mockServer(new Set(["slow"]));
  render(<Harness />);
  await send("slow");
  await waitFor(() => expect(server.held).toHaveLength(1));
  expect(listPendingChatTurns("conv-1")).toHaveLength(1);

  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const onInput = vi.fn();
  render(<DraftRestore onInput={onInput} />);
  await act(async () => {
    vi.advanceTimersByTime(65_000);
  });
  expect(onInput).not.toHaveBeenCalledWith("slow");
  expect(readChatDraft("conv-1")).toBeNull();
});

it("does not let an earlier identical message settle a newer send", () => {
  const sentAt = 1_000_000;
  const earlier: ConversationMessage = {
    id: "u-earlier",
    role: "user",
    text: "yes",
    timestamp: sentAt - 2_000,
  };
  persistPendingChatTurn({
    conversationId: "conv-1",
    clientMessageId: "c-new",
    text: "yes",
    sentAt,
    knownUserMessageIds: ["u-earlier"],
  });
  clearSettledPendingChatTurns("conv-1", [earlier]);
  expect(listPendingChatTurns("conv-1")).toHaveLength(1);
  expect(sentUserTurnPresent([earlier], "yes", sentAt, ["u-earlier"])).toBe(
    false,
  );

  const delivered: ConversationMessage = {
    id: "u-new",
    role: "user",
    text: "yes",
    timestamp: sentAt - 1_000,
  };
  clearSettledPendingChatTurns("conv-1", [earlier, delivered]);
  expect(listPendingChatTurns("conv-1")).toHaveLength(0);

  // A receipt from an older build keeps the 60 s text rule.
  persistPendingChatTurn({
    conversationId: "conv-1",
    clientMessageId: "c-legacy",
    text: "yes",
    sentAt,
  });
  clearSettledPendingChatTurns("conv-1", [earlier]);
  expect(listPendingChatTurns("conv-1")).toHaveLength(0);
});

it("sends ordinary # and $ messages to the agent", async () => {
  const server = mockServer();
  const remember = vi
    .spyOn(client, "rememberMemory")
    .mockResolvedValue({} as Awaited<ReturnType<typeof client.rememberMemory>>);
  render(<Harness />);
  await send("$5 for lunch?");
  await waitFor(() => expect(server.sent).toEqual(["$5 for lunch?"]));
  await send("#1 priority is the launch");
  await waitFor(() =>
    expect(server.sent).toEqual(["$5 for lunch?", "#1 priority is the launch"]),
  );
  await send("#remember the gate code is blue");
  await waitFor(() =>
    expect(remember).toHaveBeenCalledWith("the gate code is blue"),
  );
  expect(server.sent).toHaveLength(2);
});

describe("workflow action handoff", () => {
  const workflowResult = {
    agentName: "Eliza",
    text: "Started your morning digest.",
    completed: true,
    actionResults: [
      { actionName: "WORKFLOW", success: true, values: { workflowId: "wf-1" } },
    ],
  } as unknown as StreamResult;

  function listen() {
    const seen: string[] = [];
    const record = (event: Event) => seen.push(event.type);
    window.addEventListener(NAVIGATE_VIEW_EVENT, record);
    window.addEventListener(VISUALIZE_WORKFLOW_EVENT, record);
    return {
      seen,
      stop: () => {
        window.removeEventListener(NAVIGATE_VIEW_EVENT, record);
        window.removeEventListener(VISUALIZE_WORKFLOW_EVENT, record);
      },
    };
  }

  it("opens the workflow when the turn is still current", async () => {
    const server = mockServer(new Set(["run my morning digest"]));
    const events = listen();
    render(<Harness />);
    await send("run my morning digest");
    await waitFor(() => expect(server.held).toHaveLength(1));
    await act(async () => {
      server.held[0].resolve(workflowResult);
    });
    await waitFor(() =>
      expect(events.seen).toEqual([
        NAVIGATE_VIEW_EVENT,
        VISUALIZE_WORKFLOW_EVENT,
      ]),
    );
    events.stop();
  });

  it("does not navigate when the agent changed while the turn ran", async () => {
    const server = mockServer(new Set(["run my morning digest"]));
    const baseUrl = vi
      .spyOn(client, "getBaseUrl")
      .mockReturnValue("http://agent-a.test");
    const events = listen();
    render(<Harness />);
    await send("run my morning digest");
    await waitFor(() => expect(server.held).toHaveLength(1));
    baseUrl.mockReturnValue("http://agent-b.test");
    await act(async () => {
      server.held[0].resolve(workflowResult);
    });
    await waitFor(() => expect(listPendingChatTurns("conv-1")).toHaveLength(0));
    expect(events.seen).toEqual([]);
    events.stop();
  });
});
