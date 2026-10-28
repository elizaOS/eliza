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

function Harness() {
  const [, setMessages] = useState<ConversationMessage[]>([]);
  const conversationMessagesRef = useRef<ConversationMessage[]>([]);
  const deps: UseChatSendDeps = {
    t: (key) => key,
    uiLanguage: "en",
    tab: "chat",
    activeConversationId: "conv-1",
    ptySessionsRef: useRef([]),
    setChatInput: () => {},
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
    chatInputRef: useRef(""),
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
  sendActionMessage = chat.sendActionMessage;
  stopChat = chat.handleChatStop;
  const ctx = useInlineWidgetContext(chat.sendActionMessage, () => {});
  return (
    <ChoiceWidget
      id="deploy"
      scope="app-create"
      options={[
        { value: "staging", label: "Staging" },
        { value: "production", label: "Production" },
      ]}
      onChoose={(value) => ctx.sendAction(value)}
    />
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
  const sentTexts: string[] = [];
  vi.spyOn(client, "sendConversationMessageStream").mockImplementation(
    async (_conversationId, text, onToken) => {
      sentTexts.push(text);
      if (sentTexts.length === 1) {
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

  render(<Harness />);
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
  return { sentTexts, finishFirstTurn };
}

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
