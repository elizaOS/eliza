/** Composed first-send ownership coverage for the local-turn overlay. */
// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import type { MutableRefObject } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChatToolCallEvent,
  CodingAgentSession,
  Conversation,
  ConversationMessage,
  ImageAttachment,
} from "../api";
import type { AutonomyEventStore, AutonomyRunHealthMap } from "./autonomy";
import { type UseChatSendDeps, useChatSend } from "./useChatSend";
import { type DataLoadersDeps, useDataLoaders } from "./useDataLoaders";

const mocks = vi.hoisted(() => ({
  client: {
    abortConversationTurn: vi.fn(async () => ({ aborted: true })),
    createConversation: vi.fn(),
    getBaseUrl: vi.fn(() => ""),
    getConfig: vi.fn(async () => ({ ui: {} })),
    getConversationMessages: vi.fn(),
    listCustomActions: vi.fn(),
    listConversations: vi.fn(async () => ({ conversations: [] })),
    renameConversation: vi.fn(async () => undefined),
    sendConversationMessageStream: vi.fn(),
    sendWsMessage: vi.fn(),
    stopCodingAgent: vi.fn(async () => undefined),
    truncateConversationMessages: vi.fn(async () => undefined),
  },
}));

vi.mock("../api", () => ({ client: mocks.client }));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false, getPlatform: () => "web" },
  CapacitorHttp: { get: vi.fn(), post: vi.fn(), request: vi.fn() },
}));

function conversation(id: string): Conversation {
  return {
    id,
    roomId: `room-${id}`,
    title: "New Chat",
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
  };
}

interface Harness {
  activeConversationIdRef: MutableRefObject<string | null>;
  chatInputRef: MutableRefObject<string>;
  conversationMessagesRef: MutableRefObject<ConversationMessage[]>;
  setConversationMessages: UseChatSendDeps["setConversationMessages"];
  loaderDeps: DataLoadersDeps;
  sendDepsBase: Omit<
    UseChatSendDeps,
    | "loadConversations"
    | "loadConversationMessages"
    | "claimConversationMessagesOwnership"
    | "isConversationMessagesOwnershipCurrent"
    | "registerConversationMessageOverlay"
    | "applyConversationMessageOverlayModification"
    | "removeConversationMessageStateMessages"
    | "discardConversationMessageState"
  >;
}

function makeHarness(): Harness {
  const activeConversationIdRef: MutableRefObject<string | null> = {
    current: null,
  };
  const conversationMessagesRef: MutableRefObject<ConversationMessage[]> = {
    current: [],
  };
  const conversationsRef: MutableRefObject<Conversation[]> = { current: [] };
  const greetingFiredRef: MutableRefObject<boolean> = { current: false };
  const chatInputRef: MutableRefObject<string> = { current: "" };
  const chatPendingImagesRef: MutableRefObject<ImageAttachment[]> = {
    current: [],
  };
  const setConversationMessages: UseChatSendDeps["setConversationMessages"] = (
    value,
  ) => {
    conversationMessagesRef.current =
      typeof value === "function"
        ? value(conversationMessagesRef.current)
        : value;
  };
  const setConversations: UseChatSendDeps["setConversations"] = (value) => {
    conversationsRef.current =
      typeof value === "function" ? value(conversationsRef.current) : value;
  };
  const setActiveConversationId: UseChatSendDeps["setActiveConversationId"] = (
    value,
  ) => {
    activeConversationIdRef.current = value;
  };
  const autonomousStoreRef: MutableRefObject<AutonomyEventStore> = {
    current: { eventsById: {}, eventOrder: [], runIndex: {}, watermark: null },
  };
  const autonomousRunHealthByRunIdRef: MutableRefObject<AutonomyRunHealthMap> =
    { current: {} };

  const loaderDeps: DataLoadersDeps = {
    autonomousStoreRef,
    autonomousEventsRef: { current: [] },
    autonomousLatestEventIdRef: { current: null },
    autonomousRunHealthByRunIdRef,
    autonomousReplayInFlightRef: { current: false },
    setAutonomousEvents: vi.fn(),
    setAutonomousLatestEventId: vi.fn(),
    setAutonomousRunHealthByRunId: vi.fn(),
    activeConversationIdRef,
    conversationMessagesRef,
    greetingFiredRef,
    setConversations,
    setActiveConversationId,
    setConversationMessages,
    loadWalletConfig: vi.fn(async () => undefined),
    agentStatus: null,
    characterData: null,
    characterDraft: null,
    loadCharacter: vi.fn(async () => undefined),
    selectedVrmIndex: 0,
    firstRunComplete: false,
    uiLanguage: "en",
    setOwnerNameState: vi.fn(),
  };

  const sendDepsBase: Harness["sendDepsBase"] = {
    t: (key) => key,
    uiLanguage: "en",
    tab: "chat",
    activeConversationId: null,
    ptySessionsRef: { current: [] } as MutableRefObject<CodingAgentSession[]>,
    setChatInput: vi.fn((value: string) => {
      chatInputRef.current = value;
    }),
    setChatSending: vi.fn(),
    setChatFirstTokenReceived: vi.fn(),
    setServerTurnStatus: vi.fn(),
    setChatLastUsage: vi.fn(),
    setChatPendingImages: vi.fn((value: ImageAttachment[]) => {
      chatPendingImagesRef.current = value;
    }),
    setConversations,
    setActiveConversationId,
    setCompanionMessageCutoffTs: vi.fn(),
    setConversationMessages,
    setUnreadConversations: vi.fn(),
    setChatReplyTarget: vi.fn(),
    setActionNotice: vi.fn(),
    activeConversationIdRef,
    chatInputRef,
    chatPendingImagesRef,
    chatReplyTargetRef: { current: null },
    conversationsRef,
    conversationMessagesRef,
    conversationHydrationEpochRef: { current: 0 },
    chatAbortRef: { current: null },
    chatSendBusyRef: { current: false },
    chatSendNonceRef: { current: 0 },
    elizaCloudEnabled: false,
    elizaCloudConnected: false,
    pollCloudCredits: vi.fn(async () => true),
  };

  return {
    activeConversationIdRef,
    chatInputRef,
    conversationMessagesRef,
    setConversationMessages,
    loaderDeps,
    sendDepsBase,
  };
}

function mountComposed(harness: Harness) {
  return renderHook(() => {
    const loaders = useDataLoaders(harness.loaderDeps);
    const send = useChatSend({
      ...harness.sendDepsBase,
      loadConversations: loaders.loadConversations,
      loadConversationMessages: loaders.loadConversationMessages,
      claimConversationMessagesOwnership:
        loaders.claimConversationMessagesOwnership,
      isConversationMessagesOwnershipCurrent:
        loaders.isConversationMessagesOwnershipCurrent,
      registerConversationMessageOverlay:
        loaders.registerConversationMessageOverlay,
      applyConversationMessageOverlayModification:
        loaders.applyConversationMessageOverlayModification,
      removeConversationMessageStateMessages:
        loaders.removeConversationMessageStateMessages,
      discardConversationMessageState: loaders.discardConversationMessageState,
    });
    return { loaders, send };
  });
}

async function flushPendingWork(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  mocks.client.getBaseUrl.mockReturnValue("");
  mocks.client.listConversations.mockResolvedValue({ conversations: [] });
  mocks.client.listCustomActions.mockResolvedValue([]);
});

describe("useChatSend + useDataLoaders explicit overlay ownership", () => {
  it("performs a true cold first-send handoff without assigning loadedConversationIdRef in the test", async () => {
    mocks.client.createConversation.mockResolvedValue({
      conversation: conversation("conv-a"),
    });
    mocks.client.getConversationMessages.mockResolvedValue({ messages: [] });
    mocks.client.sendConversationMessageStream.mockResolvedValue({
      text: "terminal answer",
      completed: true,
      userMessageId: "server-user-a",
      messageId: "server-assistant-a",
    });
    const harness = makeHarness();
    const { result } = mountComposed(harness);

    await act(async () => {
      await result.current.send.sendChatText("hello", {
        clientMessageId: "first-send",
      });
    });
    expect(harness.activeConversationIdRef.current).toBe("conv-a");
    expect(
      harness.conversationMessagesRef.current.map((message) => message.id),
    ).toEqual(["server-user-a", "server-assistant-a"]);

    await act(async () => {
      await result.current.loaders.loadConversationMessages("conv-a");
    });
    expect(result.current.loaders.loadedConversationIdRef.current).toBe(
      "conv-a",
    );
    expect(
      harness.conversationMessagesRef.current.map((message) => message.id),
    ).toEqual(["server-user-a", "server-assistant-a"]);
  });

  it("keeps delayed A terminal rows with A when a real B selection wins creation", async () => {
    let resolveCreate:
      | ((value: { conversation: Conversation }) => void)
      | undefined;
    mocks.client.createConversation.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
    );
    mocks.client.getConversationMessages.mockImplementation(
      async (id: string) => ({
        messages:
          id === "conv-b"
            ? [
                {
                  id: "b-only",
                  role: "user",
                  text: "B only",
                  timestamp: 20,
                },
              ]
            : [],
      }),
    );
    mocks.client.sendConversationMessageStream.mockImplementation(
      async (...args: unknown[]) => {
        const onToken = args[2] as (
          token: string,
          accumulatedText?: string,
          provisional?: boolean,
        ) => void;
        const onTool = args[8] as (event: ChatToolCallEvent) => void;
        onToken("partial", "A partial answer", false);
        onTool({ phase: "call", callId: "tool-a", toolName: "search" });
        return {
          text: "A terminal answer",
          completed: true,
          userMessageId: "server-user-a",
          messageId: "server-assistant-a",
        };
      },
    );
    const harness = makeHarness();
    const { result } = mountComposed(harness);

    let firstSend: Promise<void>;
    act(() => {
      firstSend = result.current.send.sendChatText("A question", {
        clientMessageId: "delayed-a",
      });
    });
    await flushPendingWork();
    expect(mocks.client.createConversation).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.loaders.claimConversationMessagesOwnership("conv-b");
      harness.activeConversationIdRef.current = "conv-b";
    });
    await act(async () => {
      await result.current.loaders.loadConversationMessages("conv-b");
    });
    await act(async () => {
      resolveCreate?.({ conversation: conversation("conv-a") });
      await firstSend;
    });
    expect(harness.activeConversationIdRef.current).toBe("conv-b");
    expect(harness.conversationMessagesRef.current).toEqual([
      {
        id: "b-only",
        role: "user",
        text: "B only",
        timestamp: 20,
      },
    ]);

    act(() => {
      result.current.loaders.claimConversationMessagesOwnership("conv-a");
      harness.activeConversationIdRef.current = "conv-a";
    });
    await act(async () => {
      await result.current.loaders.loadConversationMessages("conv-a");
    });
    expect(harness.conversationMessagesRef.current).toMatchObject([
      { id: "server-user-a", text: "A question" },
      {
        id: "server-assistant-a",
        text: "A terminal answer",
        toolEvents: [
          {
            id: "tool-a",
            callId: "tool-a",
            toolName: "search",
            type: "tool_call",
            status: "running",
          },
        ],
      },
    ]);
  });

  it("does not let B's newer visible user row retire A's off-screen ephemeral terminal", async () => {
    let resolveCreate:
      | ((value: { conversation: Conversation }) => void)
      | undefined;
    mocks.client.createConversation.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
    );
    mocks.client.getConversationMessages.mockImplementation(
      async (id: string) => ({
        messages:
          id === "conv-b"
            ? [
                {
                  id: "b-newer-user",
                  role: "user",
                  text: "newer B turn",
                  timestamp: Number.MAX_SAFE_INTEGER,
                },
              ]
            : [],
      }),
    );
    mocks.client.sendConversationMessageStream.mockResolvedValue({
      text: "A terminal failure",
      completed: true,
      assistantEphemeral: true,
      failureKind: "provider_issue",
      userMessageId: "server-user-a-ephemeral",
      messageId: "server-assistant-a-ephemeral",
    });
    const harness = makeHarness();
    const { result } = mountComposed(harness);

    let firstSend: Promise<void>;
    act(() => {
      firstSend = result.current.send.sendChatText("A question", {
        clientMessageId: "delayed-a-ephemeral",
      });
    });
    await flushPendingWork();
    act(() => {
      result.current.loaders.claimConversationMessagesOwnership("conv-b");
      harness.activeConversationIdRef.current = "conv-b";
    });
    await act(async () => {
      await result.current.loaders.loadConversationMessages("conv-b");
      resolveCreate?.({ conversation: conversation("conv-a-ephemeral") });
      await firstSend;
    });

    expect(harness.conversationMessagesRef.current).toMatchObject([
      { id: "b-newer-user", text: "newer B turn" },
    ]);
    expect(mocks.client.renameConversation).not.toHaveBeenCalled();

    act(() => {
      result.current.loaders.claimConversationMessagesOwnership(
        "conv-a-ephemeral",
      );
      harness.activeConversationIdRef.current = "conv-a-ephemeral";
    });
    await act(async () => {
      await result.current.loaders.loadConversationMessages("conv-a-ephemeral");
    });
    expect(harness.conversationMessagesRef.current).toMatchObject([
      { id: "server-user-a-ephemeral", text: "A question" },
      {
        id: "server-assistant-a-ephemeral",
        text: "A terminal failure",
        assistantEphemeral: true,
        failureKind: "provider_issue",
      },
    ]);
  });

  it("does not reactivate or repaint a delayed cold create after a real null-to-null transition", async () => {
    let resolveCreate:
      | ((value: { conversation: Conversation }) => void)
      | undefined;
    mocks.client.createConversation.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
    );
    mocks.client.getConversationMessages.mockResolvedValue({ messages: [] });
    mocks.client.sendConversationMessageStream.mockResolvedValue({
      text: "terminal after reset",
      completed: true,
      userMessageId: "server-user-reset",
      messageId: "server-assistant-reset",
    });
    const harness = makeHarness();
    const { result } = mountComposed(harness);

    let firstSend: Promise<void>;
    act(() => {
      firstSend = result.current.send.sendChatText("before reset", {
        clientMessageId: "reset-race",
      });
    });
    await flushPendingWork();
    act(() => {
      result.current.loaders.claimConversationMessagesOwnership(null);
      harness.activeConversationIdRef.current = null;
      harness.setConversationMessages([]);
    });
    await act(async () => {
      resolveCreate?.({ conversation: conversation("conv-reset-race") });
      await firstSend;
    });

    expect(harness.activeConversationIdRef.current).toBeNull();
    expect(harness.conversationMessagesRef.current).toEqual([]);
    expect(mocks.client.sendWsMessage).not.toHaveBeenCalledWith({
      type: "active-conversation",
      conversationId: "conv-reset-race",
    });

    act(() => {
      result.current.loaders.claimConversationMessagesOwnership(
        "conv-reset-race",
      );
      harness.activeConversationIdRef.current = "conv-reset-race";
    });
    await act(async () => {
      await result.current.loaders.loadConversationMessages("conv-reset-race");
    });
    expect(harness.conversationMessagesRef.current).toMatchObject([
      { id: "server-user-reset", text: "before reset" },
      { id: "server-assistant-reset", text: "terminal after reset" },
    ]);
  });

  it("keeps an unowned cold turn through null reset then B selection without leaking into B", async () => {
    let resolveCreate:
      | ((value: { conversation: Conversation }) => void)
      | undefined;
    mocks.client.createConversation.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
    );
    mocks.client.getConversationMessages.mockImplementation(
      async (id: string) => ({
        messages:
          id === "conv-b"
            ? [
                {
                  id: "b-only",
                  role: "user",
                  text: "B only",
                  timestamp: 20,
                },
              ]
            : [],
      }),
    );
    mocks.client.sendConversationMessageStream.mockResolvedValue({
      text: "terminal A",
      completed: true,
      userMessageId: "server-user-a",
      messageId: "server-assistant-a",
    });
    const harness = makeHarness();
    const { result } = mountComposed(harness);

    let firstSend: Promise<void>;
    act(() => {
      firstSend = result.current.send.sendChatText("A before reset", {
        clientMessageId: "null-then-b",
      });
    });
    await flushPendingWork();
    act(() => {
      result.current.loaders.claimConversationMessagesOwnership(null);
      harness.setConversationMessages([]);
      result.current.loaders.claimConversationMessagesOwnership("conv-b");
      harness.activeConversationIdRef.current = "conv-b";
    });
    await act(async () => {
      await result.current.loaders.loadConversationMessages("conv-b");
      resolveCreate?.({ conversation: conversation("conv-a") });
      await firstSend;
    });
    expect(harness.conversationMessagesRef.current).toMatchObject([
      { id: "b-only", text: "B only" },
    ]);

    act(() => {
      result.current.loaders.claimConversationMessagesOwnership("conv-a");
      harness.activeConversationIdRef.current = "conv-a";
    });
    await act(async () => {
      await result.current.loaders.loadConversationMessages("conv-a");
    });
    expect(harness.conversationMessagesRef.current).toMatchObject([
      { id: "server-user-a", text: "A before reset" },
      { id: "server-assistant-a", text: "terminal A" },
    ]);
  });

  it("drops a delayed local-command result after a newer null draft transition", async () => {
    let resolveCommands: ((value: never[]) => void) | undefined;
    mocks.client.listCustomActions.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCommands = resolve;
        }),
    );
    const harness = makeHarness();
    const { result } = mountComposed(harness);

    let commandSend: Promise<void>;
    act(() => {
      commandSend = result.current.send.sendChatText("/commands", {
        clientMessageId: "command-reset",
      });
    });
    await flushPendingWork();
    act(() => {
      result.current.loaders.claimConversationMessagesOwnership(null);
      harness.setConversationMessages([]);
    });
    await act(async () => {
      resolveCommands?.([]);
      await commandSend;
    });

    expect(harness.activeConversationIdRef.current).toBeNull();
    expect(harness.conversationMessagesRef.current).toEqual([]);
    expect(mocks.client.createConversation).not.toHaveBeenCalled();
    expect(mocks.client.sendConversationMessageStream).not.toHaveBeenCalled();
  });

  it("seeds exact action rows off-screen when B wins a delayed cold create", async () => {
    let resolveCreate:
      | ((value: { conversation: Conversation }) => void)
      | undefined;
    mocks.client.createConversation.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
    );
    mocks.client.getConversationMessages.mockImplementation(
      async (id: string) => ({
        messages:
          id === "conv-b"
            ? [
                {
                  id: "b-only",
                  role: "user",
                  text: "B only",
                  timestamp: 20,
                },
              ]
            : [],
      }),
    );
    mocks.client.sendConversationMessageStream.mockResolvedValue({
      text: "action terminal",
      completed: true,
      userMessageId: "server-action-user",
      messageId: "server-action-assistant",
    });
    const harness = makeHarness();
    const { result } = mountComposed(harness);

    let actionSend: Promise<void>;
    act(() => {
      actionSend = result.current.send.sendActionMessage("run action");
    });
    await flushPendingWork();
    act(() => {
      result.current.loaders.claimConversationMessagesOwnership("conv-b");
      harness.activeConversationIdRef.current = "conv-b";
    });
    await act(async () => {
      await result.current.loaders.loadConversationMessages("conv-b");
      resolveCreate?.({ conversation: conversation("conv-action-a") });
      await actionSend;
    });
    expect(harness.activeConversationIdRef.current).toBe("conv-b");
    expect(harness.conversationMessagesRef.current).toMatchObject([
      { id: "b-only", text: "B only" },
    ]);
    expect(mocks.client.sendWsMessage).not.toHaveBeenCalledWith({
      type: "active-conversation",
      conversationId: "conv-action-a",
    });

    act(() => {
      result.current.loaders.claimConversationMessagesOwnership(
        "conv-action-a",
      );
      harness.activeConversationIdRef.current = "conv-action-a";
    });
    await act(async () => {
      await result.current.loaders.loadConversationMessages("conv-action-a");
    });
    expect(harness.conversationMessagesRef.current).toMatchObject([
      { id: "server-action-user", text: "run action" },
      { id: "server-action-assistant", text: "action terminal" },
    ]);
  });

  it("drops an empty off-screen action placeholder when A's stream fails after B wins", async () => {
    let resolveCreate:
      | ((value: { conversation: Conversation }) => void)
      | undefined;
    mocks.client.createConversation.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
    );
    mocks.client.getConversationMessages.mockImplementation(
      async (id: string) => ({
        messages:
          id === "conv-b"
            ? [
                {
                  id: "b-only",
                  role: "user",
                  text: "B only",
                  timestamp: 20,
                },
              ]
            : [],
      }),
    );
    mocks.client.sendConversationMessageStream.mockRejectedValue(
      new Error("action transport failed"),
    );
    const harness = makeHarness();
    const { result } = mountComposed(harness);

    let actionSend: Promise<void>;
    act(() => {
      actionSend = result.current.send.sendActionMessage("failing action");
    });
    await flushPendingWork();
    act(() => {
      result.current.loaders.claimConversationMessagesOwnership("conv-b");
      harness.activeConversationIdRef.current = "conv-b";
    });
    await act(async () => {
      await result.current.loaders.loadConversationMessages("conv-b");
      resolveCreate?.({ conversation: conversation("conv-action-failed") });
      await actionSend;
    });
    expect(harness.conversationMessagesRef.current).toMatchObject([
      { id: "b-only", text: "B only" },
    ]);

    act(() => {
      result.current.loaders.claimConversationMessagesOwnership(
        "conv-action-failed",
      );
      harness.activeConversationIdRef.current = "conv-action-failed";
    });
    await act(async () => {
      await result.current.loaders.loadConversationMessages(
        "conv-action-failed",
      );
    });
    expect(harness.conversationMessagesRef.current).toMatchObject([
      { role: "user", text: "failing action" },
    ]);
    expect(
      harness.conversationMessagesRef.current.some(
        (message) => message.role === "assistant" && message.text === "",
      ),
    ).toBe(false);
  });

  it("does not restore A's validation-rejected draft into B's composer", async () => {
    let rejectStream: ((error: unknown) => void) | undefined;
    mocks.client.getConversationMessages.mockImplementation(
      async (id: string) => ({
        messages:
          id === "conv-b"
            ? [
                {
                  id: "b-only",
                  role: "user",
                  text: "B only",
                  timestamp: 20,
                },
              ]
            : [],
      }),
    );
    mocks.client.sendConversationMessageStream.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectStream = reject;
        }),
    );
    const harness = makeHarness();
    const { result } = mountComposed(harness);

    act(() => {
      result.current.loaders.claimConversationMessagesOwnership("conv-a");
      harness.activeConversationIdRef.current = "conv-a";
    });
    await act(async () => {
      await result.current.loaders.loadConversationMessages("conv-a");
    });
    let sendA: Promise<void>;
    act(() => {
      sendA = result.current.send.sendChatText("rejected A", {
        conversationId: "conv-a",
      });
    });
    await flushPendingWork();

    act(() => {
      result.current.loaders.claimConversationMessagesOwnership("conv-b");
      harness.activeConversationIdRef.current = "conv-b";
      harness.chatInputRef.current = "B draft";
    });
    await act(async () => {
      await result.current.loaders.loadConversationMessages("conv-b");
      rejectStream?.(
        Object.assign(new Error("attachment is too large"), {
          status: 400,
          kind: "http",
        }),
      );
      await sendA;
    });

    expect(harness.activeConversationIdRef.current).toBe("conv-b");
    expect(harness.chatInputRef.current).toBe("B draft");
    expect(harness.conversationMessagesRef.current).toMatchObject([
      { id: "b-only", text: "B only" },
    ]);
  });

  it("removes exact unowned lineages when delayed first-conversation creation fails after selecting B", async () => {
    let rejectCreate: ((error: unknown) => void) | undefined;
    mocks.client.createConversation.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectCreate = reject;
        }),
    );
    mocks.client.getConversationMessages.mockImplementation(
      async (id: string) => ({
        messages:
          id === "conv-b"
            ? [
                {
                  id: "b-only",
                  role: "user",
                  text: "B only",
                  timestamp: 20,
                },
              ]
            : [],
      }),
    );
    const harness = makeHarness();
    const { result } = mountComposed(harness);

    let failedSend: Promise<void>;
    act(() => {
      failedSend = result.current.send.sendChatText("failed A", {
        clientMessageId: "failed-a",
      });
    });
    await flushPendingWork();
    act(() => {
      result.current.loaders.claimConversationMessagesOwnership("conv-b");
      harness.activeConversationIdRef.current = "conv-b";
    });
    await act(async () => {
      await result.current.loaders.loadConversationMessages("conv-b");
    });
    await act(async () => {
      rejectCreate?.(new Error("offline"));
      await failedSend;
    });

    // If the failed turn were still orphaned in the unowned registry, this
    // exact-lineage re-home would move it into C and the empty GET would paint
    // the failed A bubbles. Their explicit failure cleanup makes it a no-op.
    act(() => {
      result.current.loaders.registerConversationMessageOverlay("conv-c", [
        "temp-failed-a",
        "temp-resp-failed-a",
      ]);
      result.current.loaders.claimConversationMessagesOwnership("conv-c");
      harness.activeConversationIdRef.current = "conv-c";
      harness.setConversationMessages([]);
    });
    await act(async () => {
      await result.current.loaders.loadConversationMessages("conv-c");
    });
    expect(harness.conversationMessagesRef.current).toEqual([]);
  });

  it("keeps an off-screen partial when A aborts after selecting B", async () => {
    let rejectStream: ((error: unknown) => void) | undefined;
    mocks.client.getConversationMessages.mockImplementation(
      async (id: string) => ({
        messages:
          id === "conv-b"
            ? [
                {
                  id: "b-only",
                  role: "user",
                  text: "B only",
                  timestamp: 20,
                },
              ]
            : [],
      }),
    );
    mocks.client.sendConversationMessageStream.mockImplementation(
      async (...args: unknown[]) => {
        const onToken = args[2] as (
          token: string,
          accumulatedText?: string,
          provisional?: boolean,
        ) => void;
        onToken("partial", "A partial survives", false);
        return new Promise((_resolve, reject) => {
          rejectStream = reject;
        });
      },
    );
    const harness = makeHarness();
    harness.activeConversationIdRef.current = "conv-a";
    const { result } = mountComposed(harness);
    act(() => {
      result.current.loaders.claimConversationMessagesOwnership("conv-a");
    });
    await act(async () => {
      await result.current.loaders.loadConversationMessages("conv-a");
    });

    let sendA: Promise<void>;
    act(() => {
      sendA = result.current.send.sendChatText("A question", {
        conversationId: "conv-a",
        clientMessageId: "partial-a",
      });
    });
    await flushPendingWork();
    expect(harness.conversationMessagesRef.current).toMatchObject([
      { id: "temp-partial-a", text: "A question" },
      { id: "temp-resp-partial-a", text: "A partial survives" },
    ]);

    act(() => {
      result.current.loaders.claimConversationMessagesOwnership("conv-b");
      harness.activeConversationIdRef.current = "conv-b";
    });
    await act(async () => {
      await result.current.loaders.loadConversationMessages("conv-b");
      rejectStream?.(
        Object.assign(new Error("aborted"), { name: "AbortError" }),
      );
      await sendA;
    });

    act(() => {
      result.current.loaders.claimConversationMessagesOwnership("conv-a");
      harness.activeConversationIdRef.current = "conv-a";
    });
    await act(async () => {
      await result.current.loaders.loadConversationMessages("conv-a");
    });
    expect(harness.conversationMessagesRef.current).toMatchObject([
      { id: "temp-partial-a", text: "A question" },
      { id: "temp-resp-partial-a", text: "A partial survives" },
    ]);
  });

  it("keeps an async local command valid across a same-id reload", async () => {
    let resolveCommands: ((value: never[]) => void) | undefined;
    mocks.client.getConversationMessages.mockResolvedValue({ messages: [] });
    mocks.client.listCustomActions.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCommands = resolve;
        }),
    );
    const harness = makeHarness();
    harness.activeConversationIdRef.current = "conv-a";
    const { result } = mountComposed(harness);
    act(() => {
      result.current.loaders.claimConversationMessagesOwnership("conv-a");
    });
    await act(async () => {
      await result.current.loaders.loadConversationMessages("conv-a");
    });
    const commandOwnerGeneration =
      result.current.loaders.claimConversationMessagesOwnership("conv-a");

    let commandSend: Promise<void>;
    act(() => {
      commandSend = result.current.send.sendChatText("/commands", {
        conversationId: "conv-a",
        clientMessageId: "same-id-command",
      });
    });
    await flushPendingWork();
    await vi.waitFor(() => {
      expect(mocks.client.listCustomActions).toHaveBeenCalledTimes(1);
    });
    expect(harness.conversationMessagesRef.current).toEqual([]);
    await act(async () => {
      await result.current.loaders.loadConversationMessages("conv-a");
    });
    expect(
      result.current.loaders.isConversationMessagesOwnershipCurrent(
        "conv-a",
        commandOwnerGeneration,
      ),
    ).toBe(true);
    act(() => {
      resolveCommands?.([]);
    });
    await act(async () => {
      await commandSend;
    });
    expect(mocks.client.sendConversationMessageStream).not.toHaveBeenCalled();

    expect(
      harness.conversationMessagesRef.current.map((message) => message.role),
    ).toEqual(["user", "assistant"]);
    expect(harness.conversationMessagesRef.current[0]?.text).toBe("/commands");
    expect(harness.conversationMessagesRef.current[1]?.text).toContain(
      "Use #remember",
    );
  });
});
