// @vitest-environment jsdom
/** Action messages sent while an assistant reply is still streaming: delivery, single-flight, Stop, and the handoff freeze. */
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
import { CLOUD_HANDOFF_PHASE_EVENT } from "../../../events";
import type {
  Conversation,
  ConversationMessage,
} from "../../../api/client-types-chat";
import { type UseChatSendDeps, useChatSend } from "../../../state/useChatSend";
import { clearPendingChatTurn, listPendingChatTurns } from "../../../state/pending-chat-turns";
import { ChoiceWidget } from "../widgets/ChoiceWidget";
import { useInlineWidgetContext } from "../widgets/use-inline-widget-context";

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

type StreamResult = Awaited<
  ReturnType<typeof client.sendConversationMessageStream>
>;

let sendChatText: (text: string) => Promise<void>;
let sendActionMessage: (text: string) => Promise<boolean>;
let stopChat: () => void;
let selectedConversation: { current: string | null };
let sendToConversation: (text: string, conversationId: string) => Promise<void>;

function Harness() {
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [input, setInput] = useState("");
  const chatInputRef = useRef("");
  const conversationMessagesRef = useRef<ConversationMessage[]>([]);
  const deps: UseChatSendDeps = {
    t: (key) => key,
    uiLanguage: "en",
    tab: "chat",
    activeConversationId: "conv-1",
    ptySessionsRef: useRef([]),
    setChatInput: (value) => { chatInputRef.current = value; setInput(value); },
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
    setChatReplyTarget: () => {},
    setActionNotice: () => {},
    activeConversationIdRef: useRef<string | null>("conv-1"),
    chatInputRef,
    chatPendingImagesRef: useRef([]),
    chatReplyTargetRef: useRef(null),
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
  selectedConversation = deps.activeConversationIdRef;
  const chat = useChatSend(deps);
  sendChatText = (text) =>
    chat.sendChatText(text, { conversationId: "conv-1" });
  sendToConversation = (text, conversationId) =>
    chat.sendChatText(text, { conversationId });
  sendActionMessage = chat.sendActionMessage;
  stopChat = chat.handleChatStop;
  const ctx = useInlineWidgetContext(chat.sendActionMessage, () => {});
  return (
    <>
    <ChoiceWidget
      id="deploy"
      scope="app-create"
      options={[
        { value: "staging", label: "Staging" },
        { value: "production", label: "Production" },
      ]}
      onChoose={(value) => ctx.sendAction(value)}
    />
    <textarea aria-label="Draft" value={input} onChange={(event) => deps.setChatInput(event.target.value)} />
    <div data-testid="transcript">{messages.map((message) => <p key={message.id}>{message.text}</p>)}</div>
    </>
  );
}

/** Mounts the harness and starts a composer turn whose reply stays open. */
async function startStreamingTurn() {
  vi.spyOn(client, "sendWsMessage").mockImplementation(() => {});
  vi.spyOn(client, "abortConversationTurn").mockResolvedValue({
    aborted: false,
    roomId: "room-1",
    reason: "ui-abort",
  });
  let finishFirstReply!: () => void;
  let emitLateToken!: () => void;
  const sentTexts: string[] = [];
  vi.spyOn(client, "sendConversationMessageStream").mockImplementation(
    async (_conversationId, text, onToken) => {
      sentTexts.push(text);
      if (sentTexts.length === 1) {
        emitLateToken = () => onToken?.("late old token", "late old token");
        onToken?.("Where should I deploy?", "Where should I deploy?");
        await new Promise<void>((resolve) => {
          finishFirstReply = resolve;
        });
      }
      return {
        text: "ok",
        agentName: "Eliza",
        completed: true,
      } as StreamResult;
    },
  );

  const mounted = render(<Harness />);
  let firstTurn!: Promise<void>;
  act(() => {
    firstTurn = sendChatText("deploy my app");
  });
  await waitFor(() => expect(sentTexts).toEqual(["deploy my app"]));
  const finishFirstTurn = () =>
    act(async () => {
      finishFirstReply();
      await firstTurn;
    });
  return { sentTexts, finishFirstTurn, unmount: mounted.unmount, emitLateToken };
}

function holdNextStop() {
  let release!: () => void;
  vi.mocked(client.abortConversationTurn).mockImplementationOnce(async (roomId) => {
    await new Promise<void>((resolve) => { release = resolve; });
    return { aborted: true, roomId, reason: "ui-chat-stop" };
  });
  return () => release();
}

it("waits for the old room Stop before dispatching an explicit replacement", async () => {
  const { sentTexts, finishFirstTurn } = await startStreamingTurn();
  const releaseStop = holdNextStop();
  act(() => stopChat());
  let replacement!: Promise<void>;
  act(() => { replacement = sendChatText("replacement"); });
  await finishFirstTurn();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(client.abortConversationTurn).toHaveBeenCalledTimes(1);
  expect(client.abortConversationTurn).toHaveBeenCalledWith("room-1", "ui-chat-stop");
  expect(sentTexts).toEqual(["deploy my app"]);
  await act(async () => { releaseStop(); await replacement; });
  expect(sentTexts).toEqual(["deploy my app", "replacement"]);
});

it("keeps an old room Stop bound while the replacement selects another conversation", async () => {
  const { sentTexts, finishFirstTurn } = await startStreamingTurn();
  const releaseStop = holdNextStop();
  act(() => stopChat());
  selectedConversation.current = "conv-2";
  let replacement!: Promise<void>;
  act(() => { replacement = sendToConversation("new room", "conv-2"); });
  await finishFirstTurn();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(client.abortConversationTurn).toHaveBeenCalledTimes(1);
  expect(client.abortConversationTurn).toHaveBeenCalledWith("room-1", "ui-chat-stop");
  expect(sentTexts).toEqual(["deploy my app"]);
  await act(async () => { releaseStop(); await replacement; });
  expect(vi.mocked(client.sendConversationMessageStream).mock.calls[1][0]).toBe("conv-2");
});

it("restores the queued draft when Stop cancels it before dispatch", async () => {
  const { sentTexts, finishFirstTurn } = await startStreamingTurn();
  let queued!: Promise<void>;
  act(() => { queued = sendChatText("keep my queued draft"); });
  await waitFor(() => expect(screen.getByTestId("transcript").textContent).toContain("keep my queued draft"));
  act(() => stopChat());
  await act(async () => { await queued; });
  expect((screen.getByRole("textbox", { name: "Draft" }) as HTMLTextAreaElement).value).toBe("keep my queued draft");
  await finishFirstTurn();
  expect(sentTexts).toEqual(["deploy my app"]);
});

it("keeps a replacement draft when its earlier Stop is not confirmed", async () => {
  const { sentTexts, finishFirstTurn } = await startStreamingTurn();
  vi.mocked(client.abortConversationTurn).mockRejectedValueOnce(new Error("Host unavailable"));
  act(() => stopChat());
  await finishFirstTurn();
  await act(async () => { await sendChatText("keep this replacement"); });
  expect((screen.getByRole("textbox", { name: "Draft" }) as HTMLTextAreaElement).value).toBe("keep this replacement");
  expect(sentTexts).toEqual(["deploy my app"]);
  expect(screen.getByTestId("transcript").textContent).not.toContain("keep this replacement");
});

for (const receipt of [
  { aborted: false, roomId: "room-1", reason: "ui-chat-stop" },
  { aborted: true, roomId: "another-room", reason: "ui-chat-stop" },
  { aborted: true, roomId: "room-1", reason: "another-request" },
]) it(`does not release a replacement for an unconfirmed Stop receipt ${JSON.stringify(receipt)}`, async () => {
  const { sentTexts, finishFirstTurn } = await startStreamingTurn();
  vi.mocked(client.abortConversationTurn).mockResolvedValueOnce(receipt);
  act(() => stopChat());
  await finishFirstTurn();
  await act(async () => { await sendChatText("keep the unconfirmed replacement"); });
  expect((screen.getByRole("textbox", { name: "Draft" }) as HTMLTextAreaElement).value).toBe("keep the unconfirmed replacement");
  expect(sentTexts).toEqual(["deploy my app"]);
});

it("cancels a replacement waiting for Stop without discarding its draft", async () => {
  const { sentTexts, finishFirstTurn } = await startStreamingTurn();
  const releaseStop = holdNextStop();
  act(() => stopChat());
  let replacement!: Promise<void>;
  act(() => { replacement = sendChatText("cancel the waiting draft"); });
  await finishFirstTurn();
  act(() => stopChat());
  await act(async () => { await replacement; });
  expect((screen.getByRole("textbox", { name: "Draft" }) as HTMLTextAreaElement).value).toBe("cancel the waiting draft");
  expect(sentTexts).toEqual(["deploy my app"]);
  expect(client.abortConversationTurn).toHaveBeenCalledTimes(1);
  await act(async () => { releaseStop(); });
  expect(sentTexts).toEqual(["deploy my app"]);
});

it("returns an undispatched action to its caller when Stop was not confirmed", async () => {
  const { sentTexts, finishFirstTurn } = await startStreamingTurn();
  vi.mocked(client.abortConversationTurn).mockRejectedValueOnce(new Error("Host unavailable"));
  act(() => stopChat());
  await finishFirstTurn();
  let accepted: boolean | undefined;
  await act(async () => { accepted = await sendActionMessage("production"); });
  expect(accepted).toBe(false);
  expect(sentTexts).toEqual(["deploy my app"]);
  expect(screen.getByTestId("transcript").textContent).not.toContain("production");
});

it("remount cannot leave a delayed old-room Stop behind the new turn", async () => {
  const { sentTexts, unmount, finishFirstTurn, emitLateToken } = await startStreamingTurn();
  let releaseStop = () => {};
  const completedStopsAfterPosts: number[] = [];
  vi.mocked(client.abortConversationTurn).mockImplementationOnce(async (roomId) => {
    await new Promise<void>((resolve) => { releaseStop = resolve; });
    completedStopsAfterPosts.push(sentTexts.length);
    return { aborted: true, roomId, reason: "ui-chat-stop" };
  });
  const receipt = listPendingChatTurns("conv-1").find((turn) => turn.text === "deploy my app");
  expect(receipt).toBeDefined();
  unmount();
  render(<Harness />);
  await act(async () => { await sendChatText("new mounted owner"); });
  await act(async () => { releaseStop(); });
  await act(async () => { emitLateToken(); });
  await finishFirstTurn();
  expect(sentTexts).toEqual(["deploy my app", "new mounted owner"]);
  expect(completedStopsAfterPosts).toEqual([]);
  expect(client.abortConversationTurn).not.toHaveBeenCalled();
  expect(screen.getByTestId("transcript").textContent).not.toContain("late old token");
  expect(listPendingChatTurns("conv-1")).toContainEqual(receipt);
  clearPendingChatTurn("conv-1", receipt!.clientMessageId);
});

it("retains the request ID on a 404 retry and stops the recreated room", async () => {
  vi.spyOn(client, "sendWsMessage").mockImplementation(() => {});
  const stop = vi.spyOn(client, "abortConversationTurn").mockResolvedValue({
    aborted: true, roomId: "room-2", reason: "ui-chat-stop",
  });
  vi.spyOn(client, "createConversation").mockResolvedValue({
    conversation: { ...CONVERSATION, id: "conv-2", roomId: "room-2" },
  });
  let finishRetry!: () => void;
  const stream = vi.spyOn(client, "sendConversationMessageStream")
    .mockRejectedValueOnce(Object.assign(new Error("Conversation removed"), { status: 404 }))
    .mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { finishRetry = resolve; });
      return { text: "recovered", agentName: "Eliza", completed: true } as StreamResult;
    });
  render(<Harness />);
  let pending!: Promise<void>;
  act(() => { pending = sendChatText("retry once"); });
  await waitFor(() => expect(stream).toHaveBeenCalledTimes(2));
  expect(stream.mock.calls[1][0]).toBe("conv-2");
  expect(stream.mock.calls[0][9]).toEqual(expect.any(String));
  expect(stream.mock.calls[1][9]).toBe(stream.mock.calls[0][9]);
  act(() => stopChat());
  await waitFor(() => expect(stop).toHaveBeenCalledWith("room-2", "ui-chat-stop"));
  await act(async () => { finishRetry(); await pending; });
  expect(stream).toHaveBeenCalledTimes(2);
});

it("delivers a choice picked while the previous reply is still streaming", async () => {
  const { sentTexts, finishFirstTurn } = await startStreamingTurn();

  fireEvent.click(screen.getByRole("button", { name: "Production" }));
  expect(screen.getByRole("status").textContent).toBe("Selected: Production");

  await finishFirstTurn();

  await waitFor(() =>
    expect(sentTexts).toEqual(["deploy my app", "production"]),
  );
});

it("sends an action once when it is activated twice during a stream", async () => {
  const { sentTexts, finishFirstTurn } = await startStreamingTurn();

  let actions!: Promise<boolean[]>;
  act(() => {
    actions = Promise.all([
      sendActionMessage("[action:refresh]"),
      sendActionMessage("[action:refresh]"),
    ]);
  });

  await finishFirstTurn();
  await act(async () => {
    expect(await actions).toEqual([true, true]);
  });

  expect(sentTexts).toEqual(["deploy my app", "[action:refresh]"]);
});

it("does not send a waiting action after Stop", async () => {
  const { sentTexts, finishFirstTurn } = await startStreamingTurn();

  let action!: Promise<boolean>;
  act(() => {
    action = sendActionMessage("production");
  });
  act(() => stopChat());

  await finishFirstTurn();
  await act(async () => {
    expect(await action).toBe(false);
  });

  expect(sentTexts).toEqual(["deploy my app"]);
});

it("unlocks the choice row when Stop cancels the waiting pick", async () => {
  const { sentTexts, finishFirstTurn } = await startStreamingTurn();

  fireEvent.click(screen.getByRole("button", { name: "Production" }));
  expect(screen.getByRole("status").textContent).toBe("Selected: Production");

  act(() => stopChat());

  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Staging" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  expect(screen.queryByRole("status")).toBeNull();

  await finishFirstTurn();
  expect(sentTexts).toEqual(["deploy my app"]);
});

it("holds a waiting action until the cloud handoff ends", async () => {
  const { sentTexts, finishFirstTurn } = await startStreamingTurn();
  const dispatchPhase = (phase: string) =>
    window.dispatchEvent(
      new CustomEvent(CLOUD_HANDOFF_PHASE_EVENT, {
        detail: { phase, agentId: "agent-1" },
      }),
    );

  let action!: Promise<boolean>;
  act(() => {
    action = sendActionMessage("production");
    dispatchPhase("migrating");
  });

  await finishFirstTurn();
  expect(sentTexts).toEqual(["deploy my app"]);

  await act(async () => {
    dispatchPhase("failed");
    await action;
  });

  expect(sentTexts).toEqual(["deploy my app", "production"]);
});


it("reports an uncertain choice failure without dispatching it again", async () => {
  const choose = vi.fn(async () => { throw new Error("delivery outcome unavailable"); });
  render(<ChoiceWidget id="uncertain" scope="app-create" options={[{ value: "deploy", label: "Deploy" }]} onChoose={choose} />);
  fireEvent.click(screen.getByRole("button", { name: "Deploy" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Could not confirm this choice");
  expect((screen.getByRole("button", { name: "Deploy" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Deploy" }));
  expect(choose).toHaveBeenCalledTimes(1);
});


it("does not move a queued choice into a newly selected conversation", async () => {
  const { sentTexts, finishFirstTurn } = await startStreamingTurn();
  let action!: Promise<boolean>;
  await act(async () => { action = sendActionMessage("production"); });
  act(() => { selectedConversation.current = "conv-2"; });
  await finishFirstTurn();
  expect(await action).toBe(false);
  expect(sentTexts).toEqual(["deploy my app"]);
});


it("does not deduplicate identical choices from different conversations", async () => {
  const { sentTexts, finishFirstTurn } = await startStreamingTurn();
  let oldAction!: Promise<boolean>;
  let newAction!: Promise<boolean>;
  await act(async () => { oldAction = sendActionMessage("production"); });
  act(() => { selectedConversation.current = "conv-2"; });
  await act(async () => { newAction = sendActionMessage("production"); });
  await finishFirstTurn();
  expect(await oldAction).toBe(false);
  expect(await newAction).toBe(true);
  expect(sentTexts).toEqual(["deploy my app", "production"]);
});
