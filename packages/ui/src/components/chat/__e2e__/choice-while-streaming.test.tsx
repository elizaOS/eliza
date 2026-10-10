// @vitest-environment jsdom
/** A CHOICE pick made while an assistant reply is still streaming reaches the agent. */
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
  const chat = useChatSend(deps);
  sendChatText = (text) => chat.sendChatText(text, { conversationId: "conv-1" });
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

it("delivers a choice picked while the previous reply is still streaming", async () => {
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

  fireEvent.click(screen.getByRole("button", { name: "Production" }));
  expect(screen.getByRole("status").textContent).toBe("Selected: Production");

  await act(async () => {
    finishFirstReply();
    await firstTurn;
  });

  await waitFor(() =>
    expect(sentTexts).toEqual(["deploy my app", "production"]),
  );
});
