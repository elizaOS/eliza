// @vitest-environment jsdom
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  source?: string;
};

interface ChatViewContextStub {
  agentStatus: {
    agentName: string;
    state?: "starting" | "restarting" | "running" | "paused";
  } | null;
  activeConversationId: string | null;
  chatInput: string;
  chatSending: boolean;
  chatFirstTokenReceived: boolean;
  companionMessageCutoffTs: number;
  conversationMessages: ChatMessage[];
  handleChatSend: (channelType?: string) => Promise<void>;
  handleChatStop: () => void;
  handleChatRetry: (id: string) => void;
  handleChatEdit: (id: string, text: string) => Promise<boolean>;
  handleNewConversation: () => Promise<void>;
  setState: (key: string, value: unknown) => void;
  droppedFiles: string[];
  shareIngestNotice: string;
  chatMode: "simple" | "power";
  chatAgentVoiceMuted: boolean;
  elizaCloudConnected: boolean;
  selectedVrmIndex: number;
  uiLanguage: "en" | "zh-CN";
  t: (k: string) => string;
}

const { mockClient, mockUseApp, mockUseVoiceChat } = vi.hoisted(() => ({
  mockClient: {
    getConfig: vi.fn(),
  },
  mockUseApp: vi.fn(),
  mockUseVoiceChat: vi.fn(),
}));

vi.mock("@elizaos/app-core/state", () => ({
  useApp: () => mockUseApp(),
  getVrmPreviewUrl: () => null,
}));

vi.mock("@elizaos/app-core/platform", () => ({
  isDesktopPlatform: () => false,
}));

vi.mock("@elizaos/app-core/hooks", async () => {
  const actual = await vi.importActual<
    typeof import("@elizaos/app-core/hooks")
  >("@elizaos/app-core/hooks");
  return {
    ...actual,
    useVoiceChat: (...args: unknown[]) => mockUseVoiceChat(...args),
  };
});

vi.mock("../../src/components/MessageContent", () => ({
  MessageContent: ({ message }: { message: { text: string } }) =>
    React.createElement("span", null, message.text),
}));

vi.mock("@elizaos/app-core/api", () => ({
  client: mockClient,
}));

import { ChatView } from "../../src/components/ChatView";

function createContext(
  overrides?: Partial<ChatViewContextStub>,
): ChatViewContextStub {
  return {
    agentStatus: { agentName: "Milady", state: "running" },
    activeConversationId: "conv-1",
    chatInput: "Hello",
    chatSending: false,
    chatFirstTokenReceived: false,
    companionMessageCutoffTs: 0,
    conversationMessages: [],
    handleChatSend: vi.fn(async () => { }),
    handleChatStop: vi.fn(),
    handleChatRetry: vi.fn(),
    handleChatEdit: vi.fn(async () => true),
    handleNewConversation: vi.fn(async () => { }),
    setState: vi.fn(),
    droppedFiles: [],
    shareIngestNotice: "",
    chatMode: "simple",
    chatAgentVoiceMuted: false,
    elizaCloudConnected: false,
    selectedVrmIndex: 0,
    uiLanguage: "en",
    chatPendingImages: [],
    setChatPendingImages: vi.fn(),
    t: (k: string) => k,
    ...overrides,
  };
}

function textOf(node: TestRenderer.ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : textOf(child)))
    .join("");
}

describe("ChatView game-modal variant", () => {
  beforeEach(() => {
    mockUseApp.mockReset();
    mockUseVoiceChat.mockReset();
    mockClient.getConfig.mockReset();
    Object.defineProperty(window, "dispatchEvent", {
      value: vi.fn(),
      configurable: true,
      writable: true,
    });

    mockUseVoiceChat.mockReturnValue({
      supported: true,
      isListening: false,
      captureMode: "idle",
      interimTranscript: "",
      toggleListening: vi.fn(),
      startListening: vi.fn(),
      stopListening: vi.fn(),
      mouthOpen: 0,
      isSpeaking: false,
      usingAudioAnalysis: false,
      speak: vi.fn(),
      queueAssistantSpeech: vi.fn(),
      stopSpeaking: vi.fn(),
    });
    mockClient.getConfig.mockResolvedValue({});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("hides source tags in game-modal bubbles", async () => {
    mockUseApp.mockReturnValue(
      createContext({
        conversationMessages: [
          {
            id: "assistant-1",
            role: "assistant",
            text: "Acknowledged",
            timestamp: Date.now(),
            source: "discord",
          },
        ],
      }),
    );

    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(
        React.createElement(ChatView, { variant: "game-modal" }),
      );
    });

    const text = textOf(tree?.root).toLowerCase();
    expect(text).toContain("acknowledged");
    expect(text).not.toContain("via discord");
    expect(text).not.toContain("milady");
  });

  it("shows only the last two companion messages", async () => {
    mockUseApp.mockReturnValue(
      createContext({
        conversationMessages: [
          { id: "m1", role: "assistant", text: "one", timestamp: 1 },
          { id: "m2", role: "user", text: "two", timestamp: 2 },
          { id: "m3", role: "assistant", text: "three", timestamp: 3 },
          { id: "m4", role: "user", text: "four", timestamp: 4 },
          { id: "m5", role: "assistant", text: "five", timestamp: 5 },
          { id: "m6", role: "user", text: "six", timestamp: 6 },
          { id: "m7", role: "assistant", text: "seven", timestamp: 7 },
        ],
      }),
    );

    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(
        React.createElement(ChatView, { variant: "game-modal" }),
      );
    });

    const text = textOf(tree?.root).toLowerCase();
    expect(text).not.toContain("one");
    expect(text).not.toContain("two");
    expect(text).toContain("six");
    expect(text).toContain("seven");
    expect(text).not.toContain("three");
    expect(text).not.toContain("four");
    expect(text).not.toContain("five");
  });

  it("stays idle instead of showing starter prompts when companion chat is empty", async () => {
    mockUseApp.mockReturnValue(createContext({ conversationMessages: [] }));

    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(
        React.createElement(ChatView, { variant: "game-modal" }),
      );
    });

    const text = textOf(tree?.root).toLowerCase();
    expect(text).not.toContain("milady");
    expect(text).not.toContain("startaconversation");
    expect(text).not.toContain("tell me a joke");
  });

  it("queues assistant speech in companion mode while a response is streaming", async () => {
    const queueAssistantSpeech = vi.fn();
    mockUseVoiceChat.mockReturnValue({
      supported: true,
      isListening: false,
      captureMode: "idle",
      interimTranscript: "",
      toggleListening: vi.fn(),
      startListening: vi.fn(),
      stopListening: vi.fn(),
      mouthOpen: 0,
      isSpeaking: false,
      usingAudioAnalysis: false,
      speak: vi.fn(),
      queueAssistantSpeech,
      stopSpeaking: vi.fn(),
    });
    mockUseApp.mockReturnValue(
      createContext({
        chatSending: true,
        conversationMessages: [
          { id: "assistant-1", role: "assistant", text: "hello", timestamp: 1 },
        ],
      }),
    );

    await act(async () => {
      TestRenderer.create(
        React.createElement(ChatView, { variant: "game-modal" }),
      );
    });

    expect(queueAssistantSpeech).toHaveBeenCalledWith(
      "assistant-1",
      "hello",
      false,
    );
  });

  it("hides companion messages older than the cutoff timestamp", async () => {
    mockUseApp.mockReturnValue(
      createContext({
        companionMessageCutoffTs: 4,
        conversationMessages: [
          { id: "m1", role: "assistant", text: "one", timestamp: 1 },
          { id: "m2", role: "user", text: "two", timestamp: 2 },
          { id: "m3", role: "assistant", text: "three", timestamp: 3 },
          { id: "m4", role: "user", text: "four", timestamp: 4 },
          { id: "m5", role: "assistant", text: "five", timestamp: 5 },
        ],
      }),
    );

    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(
        React.createElement(ChatView, { variant: "game-modal" }),
      );
    });

    const text = textOf(tree?.root).toLowerCase();
    expect(text).not.toContain("one");
    expect(text).not.toContain("two");
    expect(text).not.toContain("three");
    expect(text).toContain("four");
    expect(text).toContain("five");
  });

  it("falls back to the active thread when the cutoff hides every message", async () => {
    mockUseApp.mockReturnValue(
      createContext({
        companionMessageCutoffTs: 999,
        conversationMessages: [
          { id: "m1", role: "assistant", text: "one", timestamp: 1 },
          { id: "m2", role: "user", text: "two", timestamp: 2 },
          { id: "m3", role: "assistant", text: "three", timestamp: 3 },
        ],
      }),
    );

    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(
        React.createElement(ChatView, { variant: "game-modal" }),
      );
    });

    const text = textOf(tree?.root).toLowerCase();
    expect(text).not.toContain("one");
    expect(text).toContain("two");
    expect(text).toContain("three");
  });

  it("keeps mic and send controls usable in game-modal", async () => {
    const handleChatSend = vi.fn(async () => { });
    mockUseApp.mockReturnValue(
      createContext({
        handleChatSend,
        chatInput: "test",
        conversationMessages: [
          {
            id: "user-1",
            role: "user",
            text: "test",
            timestamp: Date.now(),
          },
        ],
      }),
    );

    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(
        React.createElement(ChatView, { variant: "game-modal" }),
      );
    });

    // Find mic button by aria-label
    const micButton = tree?.root.findByProps({
      "aria-label": "chat.voiceInput",
    });
    expect(micButton).toBeTruthy();

    // Find send button - in game-modal it's the one with the Send icon and no text,
    // but it has handleChatSend in onClick.
    const buttons = tree?.root.findAllByType("button" as React.ElementType);
    const sendButton = buttons.find((b) =>
      b.props.onClick?.toString().includes("handleChatSend"),
    );
    expect(sendButton).toBeTruthy();

    await act(async () => {
      sendButton?.props.onClick();
    });
    expect(handleChatSend).toHaveBeenCalled();
  });

  it("passes cloud auth into the voice hook for companion defaults", async () => {
    mockUseApp.mockReturnValue(
      createContext({
        elizaCloudConnected: true,
      }),
    );

    await act(async () => {
      TestRenderer.create(
        React.createElement(ChatView, { variant: "game-modal" }),
      );
    });

    expect(mockUseVoiceChat).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudConnected: true,
        interruptOnSpeech: true,
      }),
    );
  });

  it("defaults companion voice back on when the shared chat state is muted", async () => {
    const setState = vi.fn();
    mockUseApp.mockReturnValue(
      createContext({
        chatAgentVoiceMuted: true,
        setState,
      }),
    );

    await act(async () => {
      TestRenderer.create(
        React.createElement(ChatView, { variant: "game-modal" }),
      );
    });

    expect(setState).toHaveBeenCalledWith("chatAgentVoiceMuted", false);
  });

  it("disables composer controls while agent is starting", async () => {
    mockUseApp.mockReturnValue(
      createContext({
        agentStatus: { agentName: "Milady", state: "starting" },
      }),
    );

    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(
        React.createElement(ChatView, { variant: "game-modal" }),
      );
    });

    const textarea = tree?.root.findByType("textarea");
    expect(textarea.props.disabled).toBe(true);
    expect(textarea.props.placeholder).toBe("chat.agentStarting");

    // Mic button should also be disabled and have the correct aria-label
    const micButton = tree?.root.findByProps({
      "aria-label": "chat.agentStarting",
    });
    expect(micButton.props.disabled).toBe(true);
  });

  it("renders the game-modal composer unfocused with level control sizing", async () => {
    const focus = vi.fn();

    mockUseApp.mockReturnValue(createContext({ chatInput: "" }));

    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(
        React.createElement(ChatView, { variant: "game-modal" }),
        {
          createNodeMock: (element) => {
            const node = element as {
              type: unknown;
              props: Record<string, unknown>;
            };
            if (node.type === "textarea") {
              return {
                style: { height: "", overflowY: "" },
                scrollHeight: 38,
                focus,
              };
            }
            return {};
          },
        },
      );
    });

    const textarea = tree?.root.findByType("textarea");
    const actionButton = tree?.root.findByProps({
      "data-testid": "chat-composer-action",
    });
    expect(focus).not.toHaveBeenCalled();
    expect(String(textarea.props.className)).toContain("h-[46px]");
    expect(String(textarea.props.className)).toContain("py-2");
    expect(String(textarea.props.className)).toContain("focus:ring-0");
    expect(String(actionButton.props.className)).not.toContain("mb-1.5");
  });

  it("keeps only the latest two rendered companion rows", async () => {
    mockUseApp.mockReturnValue(
      createContext({
        conversationMessages: [
          { id: "assistant-1", role: "assistant", text: "one", timestamp: 1 },
          { id: "user-1", role: "user", text: "two", timestamp: 2 },
          { id: "assistant-2", role: "assistant", text: "three", timestamp: 3 },
          { id: "user-2", role: "user", text: "four", timestamp: 4 },
          { id: "assistant-3", role: "assistant", text: "five", timestamp: 5 },
        ],
      }),
    );

    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(
        React.createElement(ChatView, { variant: "game-modal" }),
      );
    });

    const rows = tree?.root.findAllByProps({
      "data-testid": "companion-message-row",
    });

    expect(rows).toHaveLength(2);
    const firstRow = rows[0];
    const secondRow = rows[1];
    expect(firstRow).toBeDefined();
    expect(secondRow).toBeDefined();
    expect(textOf(firstRow).toLowerCase()).toContain("four");
    expect(textOf(secondRow).toLowerCase()).toContain("five");
  });

  it("keeps the previous exchange for 30 seconds after a new send, then fades it out", async () => {
    vi.useFakeTimers();

    let currentContext = createContext({
      companionMessageCutoffTs: 10,
      conversationMessages: [
        { id: "user-1", role: "user", text: "hello", timestamp: 10 },
        { id: "assistant-1", role: "assistant", text: "hi", timestamp: 11 },
      ],
    });
    mockUseApp.mockImplementation(() => currentContext);

    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(
        React.createElement(ChatView, { variant: "game-modal" }),
      );
    });

    currentContext = createContext({
      companionMessageCutoffTs: 20,
      conversationMessages: [
        { id: "user-1", role: "user", text: "hello", timestamp: 10 },
        { id: "assistant-1", role: "assistant", text: "hi", timestamp: 11 },
        { id: "user-2", role: "user", text: "new question", timestamp: 20 },
      ],
    });

    await act(async () => {
      tree.update(React.createElement(ChatView, { variant: "game-modal" }));
    });

    let rows = tree.root.findAllByProps({
      "data-testid": "companion-message-row",
    });
    expect(rows).toHaveLength(3);
    expect(textOf(rows[0]).toLowerCase()).toContain("hello");
    expect(textOf(rows[1]).toLowerCase()).toContain("hi");
    expect(textOf(rows[2]).toLowerCase()).toContain("new question");

    await act(async () => {
      vi.advanceTimersByTime(30_250);
    });

    rows = tree.root.findAllByProps({
      "data-testid": "companion-message-row",
    });
    const carryoverRows = tree.root.findAllByProps({
      "data-companion-carryover": "true",
    });
    expect(rows).toHaveLength(3);
    expect(carryoverRows).toHaveLength(2);
    expect(carryoverRows[0]?.props.style.opacity).toBeLessThan(1);

    await act(async () => {
      vi.advanceTimersByTime(5_100);
    });

    rows = tree.root.findAllByProps({
      "data-testid": "companion-message-row",
    });
    expect(rows).toHaveLength(1);
    expect(textOf(rows[0]).toLowerCase()).toContain("new question");
  });

  it("clears companion carryover when a new conversation replaces the active thread", async () => {
    vi.useFakeTimers();

    let currentContext = createContext({
      activeConversationId: "conv-1",
      companionMessageCutoffTs: 10,
      conversationMessages: [
        { id: "user-1", role: "user", text: "hello", timestamp: 10 },
        { id: "assistant-1", role: "assistant", text: "hi", timestamp: 11 },
      ],
    });
    mockUseApp.mockImplementation(() => currentContext);

    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(
        React.createElement(ChatView, { variant: "game-modal" }),
      );
    });

    currentContext = createContext({
      activeConversationId: null,
      companionMessageCutoffTs: 20,
      conversationMessages: [],
    });

    await act(async () => {
      tree.update(React.createElement(ChatView, { variant: "game-modal" }));
    });

    expect(
      tree.root.findAllByProps({ "data-testid": "companion-message-row" }),
    ).toHaveLength(0);
    expect(
      tree.root.findAllByProps({ "data-companion-carryover": "true" }),
    ).toHaveLength(0);

    currentContext = createContext({
      activeConversationId: "conv-2",
      companionMessageCutoffTs: 21,
      conversationMessages: [
        {
          id: "greeting-1",
          role: "assistant",
          text: "Hey, I'm back.",
          timestamp: 21,
          source: "agent_greeting",
        },
      ],
    });

    await act(async () => {
      tree.update(React.createElement(ChatView, { variant: "game-modal" }));
    });

    const rows = tree.root.findAllByProps({
      "data-testid": "companion-message-row",
    });
    expect(rows).toHaveLength(1);
    expect(textOf(rows[0]).toLowerCase()).toContain("hey, i'm back.");
    expect(textOf(tree.root).toLowerCase()).not.toContain("hello");
    expect(textOf(tree.root).toLowerCase()).not.toContain("hi");
  });

  it("routes transcript drags to companion camera while keeping the composer interactive", async () => {
    mockUseApp.mockReturnValue(
      createContext({
        conversationMessages: [
          {
            id: "assistant-1",
            role: "assistant",
            text: "Acknowledged",
            timestamp: Date.now(),
          },
        ],
      }),
    );

    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(
        React.createElement(ChatView, { variant: "game-modal" }),
      );
    });

    const messages = tree?.root.findByProps({
      "data-testid": "chat-messages-scroll",
    });
    const composer = tree?.root.findByProps({
      "data-no-camera-drag": "true",
    });

    expect(String(messages.props.className)).toContain("pointer-events-none");
    expect(String(messages.props.className)).toContain("select-none");
    expect(String(messages.props.className)).toContain("overflow-hidden");
    expect(messages.props.style.maskImage).toContain("linear-gradient");
    expect(composer).toBeTruthy();
  });
});
