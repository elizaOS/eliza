// @vitest-environment jsdom

// Edit-and-resend coverage for the chat transcript's per-message edit action
// wired to the REAL useChatSend.handleChatEdit. This is the seam ChatView wires
// (ChatTranscript onEdit={handleEditMessage} -> handleChatEdit): editing a user
// turn truncates the conversation from that message (inclusive) and resends the
// new text, so the assistant re-answers the edited prompt.
//
// It mounts the real ChatMessage row (the transcript element that renders the
// edit UI + action rail) with onEdit bound to the real hook, so the test drives
// the actual edit textarea + "Save and resend" button, not a mock.

import {
  act,
  fireEvent,
  render,
  renderHook,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CodingAgentSession,
  Conversation,
  ConversationMessage,
  ImageAttachment,
} from "../../api";
import type { LoadConversationMessagesResult } from "../../state/internal";
import { type UseChatSendDeps, useChatSend } from "../../state/useChatSend";
import { ChatMessage } from "../composites/chat/chat-message";

const mocks = vi.hoisted(() => ({
  client: {
    abortConversationTurn: vi.fn(),
    createConversation: vi.fn(),
    sendConversationMessageStream: vi.fn(),
    sendWsMessage: vi.fn(),
    stopCodingAgent: vi.fn(),
    truncateConversationMessages: vi.fn(),
  },
}));

vi.mock("../../api", () => ({ client: mocks.client }));

function conversation(id: string, roomId: string): Conversation {
  return {
    id,
    roomId,
    title: "Edit smoke",
    createdAt: "2026-05-15T00:00:00.000Z",
    updatedAt: "2026-05-15T00:00:00.000Z",
  };
}

function userMessage(id: string, text: string): ConversationMessage {
  return { id, role: "user", text, timestamp: 1, source: "eliza" };
}

function makeDeps(messages: ConversationMessage[]): UseChatSendDeps {
  const conversationsRef = { current: [conversation("conv-1", "room-1")] };
  const conversationMessagesRef = { current: messages };
  return {
    t: (key) => key,
    uiLanguage: "en",
    tab: "chat",
    activeConversationId: "conv-1",
    ptySessionsRef: { current: [] as CodingAgentSession[] },
    setChatInput: vi.fn(),
    setChatSending: vi.fn(),
    setChatFirstTokenReceived: vi.fn(),
    setServerTurnStatus: vi.fn(),
    setChatLastUsage: vi.fn(),
    setChatPendingImages: vi.fn(),
    setConversations: vi.fn(),
    setActiveConversationId: vi.fn(),
    setCompanionMessageCutoffTs: vi.fn(),
    setConversationMessages: (value) => {
      conversationMessagesRef.current =
        typeof value === "function"
          ? value(conversationMessagesRef.current)
          : value;
    },
    setUnreadConversations: vi.fn(),
    setChatReplyTarget: vi.fn(),
    setActionNotice: vi.fn(),
    activeConversationIdRef: { current: "conv-1" },
    chatInputRef: { current: "" },
    chatPendingImagesRef: { current: [] as ImageAttachment[] },
    chatReplyTargetRef: { current: null },
    conversationsRef,
    conversationMessagesRef,
    chatAbortRef: { current: null },
    chatSendBusyRef: { current: false },
    chatSendNonceRef: { current: 0 },
    loadConversations: vi.fn(async () => conversationsRef.current),
    loadConversationMessages: vi.fn(
      async (): Promise<LoadConversationMessagesResult> => ({ ok: true }),
    ),
    elizaCloudEnabled: false,
    elizaCloudConnected: false,
    pollCloudCredits: vi.fn(async () => true),
  };
}

describe("chat transcript edit-and-resend (useChatSend.handleChatEdit)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.client.truncateConversationMessages.mockResolvedValue({
      ok: true,
      deletedCount: 2,
    });
    mocks.client.sendConversationMessageStream.mockResolvedValue({
      text: "Re-answered the edited prompt.",
      agentName: "Eliza",
      completed: true,
    });
  });

  it("truncates inclusive from the edited user message then resends the new text", async () => {
    const original = userMessage("user-1", "original question");
    const deps = makeDeps([
      original,
      {
        id: "assistant-1",
        role: "assistant",
        text: "first answer",
        timestamp: 2,
      },
    ]);
    const { result } = renderHook(() => useChatSend(deps));

    const { getByLabelText, getByRole } = render(
      <ChatMessage
        message={original}
        agentName="Eliza"
        onEdit={result.current.handleChatEdit}
      />,
    );

    // Open the edit UI via the action rail's "Edit message" button.
    act(() => {
      fireEvent.click(getByLabelText("Edit message"));
    });

    // Change the text and Save (the button is "Save and resend").
    const editArea = getByLabelText("Edit message") as HTMLTextAreaElement;
    act(() => {
      fireEvent.change(editArea, { target: { value: "edited question" } });
    });
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Save and resend" }));
    });

    // The real handleChatEdit truncates inclusive from the edited message id,
    // then resends the new text through the stream endpoint.
    await waitFor(() => {
      expect(mocks.client.truncateConversationMessages).toHaveBeenCalledWith(
        "conv-1",
        "user-1",
        { inclusive: true },
      );
    });
    expect(mocks.client.sendConversationMessageStream).toHaveBeenCalledTimes(1);
    const streamCall = mocks.client.sendConversationMessageStream.mock.calls[0];
    expect(streamCall[0]).toBe("conv-1"); // conversation id
    expect(streamCall[1]).toBe("edited question"); // resent text

    // Truncate must happen before the resend.
    const truncateOrder =
      mocks.client.truncateConversationMessages.mock.invocationCallOrder[0];
    const streamOrder =
      mocks.client.sendConversationMessageStream.mock.invocationCallOrder[0];
    expect(truncateOrder).toBeLessThan(streamOrder);
  });
});
