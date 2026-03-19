// @vitest-environment jsdom
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface ChatViewContextStub {
  agentStatus: {
    agentName: string;
    state?: string;
  } | null;
  activeConversationId: string | null;
  chatInput: string;
  chatSending: boolean;
  chatFirstTokenReceived: boolean;
  companionMessageCutoffTs: number;
  conversationMessages: Array<{
    id: string;
    role: "user" | "assistant";
    text: string;
    timestamp: number;
    source?: string;
  }>;
  handleChatSend: (channelType?: string) => Promise<void>;
  handleChatStop: () => void;
  setState: (key: string, value: unknown) => void;
  droppedFiles: string[];
  shareIngestNotice: string;
  selectedVrmIndex: number;
  chatPendingImages: Array<{ data: string; mimeType: string; name: string }>;
  setChatPendingImages: (
    updater:
      | Array<{ data: string; mimeType: string; name: string }>
      | ((
        prev: Array<{ data: string; mimeType: string; name: string }>,
      ) => Array<{ data: string; mimeType: string; name: string }>),
  ) => void;
  uiLanguage: "en" | "zh-CN";
  chatMode: "simple" | "power";
  chatAgentVoiceMuted: boolean;
  elizaCloudConnected: boolean;
  t: (k: string) => string;
  handleStart: () => Promise<void>;

  handleRestart: () => Promise<void>;
  handleChatRetry: (id: string) => void;
  handleChatEdit: (id: string, text: string) => Promise<boolean>;
  lifecycleBusy: boolean;
  lifecycleAction: string | null;
  autonomousEvents: unknown[];
  workbench: unknown;
  openEmotePicker: () => void;
  ptySessions: unknown[];
}

const { mockClient, mockUseApp, mockUseVoiceChat, mockIsDesktopPlatform } =
  vi.hoisted(() => ({
    mockClient: {
      getCodingAgentStatus: vi.fn(async () => null),
      getConfig: vi.fn().mockResolvedValue({}),
    },
    mockUseApp: vi.fn(),
    mockUseVoiceChat: vi.fn(),
    mockIsDesktopPlatform: vi.fn(() => false),
  }));

vi.mock("@elizaos/app-core/state", () => ({
  useApp: () => mockUseApp(),
  getVrmPreviewUrl: () => null,
}));

vi.mock("@elizaos/app-core/platform", () => ({
  isDesktopPlatform: () => mockIsDesktopPlatform(),
}));

vi.mock("@elizaos/app-core/hooks", async () => {
  const actual = await vi.importActual<typeof import("@elizaos/app-core/hooks")>(
    "@elizaos/app-core/hooks",
  );
  return {
    ...actual,
    useVoiceChat: (...args: unknown[]) => mockUseVoiceChat(...args),
  };
});

vi.mock("../../src/components/ChatAvatar", () => ({
  ChatAvatar: () => null,
}));

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
    chatInput: "",
    chatSending: false,
    chatFirstTokenReceived: false,
    companionMessageCutoffTs: 0,
    conversationMessages: [],
    handleChatSend: vi.fn(async () => { }),
    handleChatStop: vi.fn(),
    setState: vi.fn(),
    droppedFiles: [],
    shareIngestNotice: "",
    selectedVrmIndex: 0,
    chatPendingImages: [],
    setChatPendingImages: vi.fn(),
    chatMode: "simple",
    chatAgentVoiceMuted: false,
    elizaCloudConnected: false,
    handleStart: vi.fn(async () => { }),

    handleRestart: vi.fn(async () => { }),
    handleChatRetry: vi.fn(),
    handleChatEdit: vi.fn(async () => true),
    lifecycleBusy: false,
    lifecycleAction: null,
    autonomousEvents: [],
    workbench: null,
    openEmotePicker: vi.fn(),
    ptySessions: [],
    uiLanguage: "en" as const,
    t: (k: string) => k,
    ...overrides,
  };
}

function text(node: TestRenderer.ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : ""))
    .join("")
    .trim();
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("ChatView", () => {
  beforeEach(() => {
    mockUseApp.mockReset();
    mockUseVoiceChat.mockReset();
    mockIsDesktopPlatform.mockReset();
    mockClient.getConfig.mockReset();
    Object.defineProperty(window, "dispatchEvent", {
      value: vi.fn(),
      configurable: true,
      writable: true,
    });

    const queueAssistantSpeech = vi.fn();
    mockUseVoiceChat.mockReturnValue({
      supported: false,
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
    mockClient.getConfig.mockResolvedValue({});
    mockIsDesktopPlatform.mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not render duplicate assistant headers before first token", async () => {
    mockUseApp.mockReturnValue(
      createContext({
        chatSending: true,
        chatFirstTokenReceived: false,
        conversationMessages: [
          { id: "u1", role: "user", text: "hello", timestamp: 1 },
          { id: "a-temp", role: "assistant", text: "", timestamp: 2 },
        ],
      }),
    );

    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(ChatView));
    });
    await flush();

    const root = tree?.root;
    const headerCount = root.findAll(
      (node) => node.type === "div" && text(node) === "Milady",
    ).length;
    expect(headerCount).toBe(1);
  });

  it("keeps optimistic user text visible before the first assistant token", async () => {
    mockUseApp.mockReturnValue(
      createContext({
        chatSending: true,
        chatFirstTokenReceived: false,
        conversationMessages: [
          { id: "u1", role: "user", text: "stream me", timestamp: 1 },
          { id: "a-temp", role: "assistant", text: "", timestamp: 2 },
        ],
      }),
    );

    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(ChatView));
    });
    await flush();

    const root = tree?.root;
    const userTextNodes = root.findAll(
      (node) => node.type === "span" && text(node) === "stream me",
    );
    expect(userTextNodes.length).toBe(1);
  });

  it("does not auto-play assistant speech while stream is active in default chat", async () => {
    const queueAssistantSpeech = vi.fn();
    mockUseVoiceChat.mockReturnValue({
      supported: false,
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
          { id: "a1", role: "assistant", text: "Hello world.", timestamp: 1 },
        ],
      }),
    );

    await act(async () => {
      TestRenderer.create(React.createElement(ChatView));
    });
    await flush();

    expect(queueAssistantSpeech).not.toHaveBeenCalled();
  });

  it("does not auto-play assistant speech after stream completes in default chat", async () => {
    const queueAssistantSpeech = vi.fn();
    mockUseVoiceChat.mockReturnValue({
      supported: false,
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
        chatSending: false,
        conversationMessages: [
          { id: "a1", role: "assistant", text: "Hello world.", timestamp: 1 },
        ],
      }),
    );

    await act(async () => {
      TestRenderer.create(React.createElement(ChatView));
    });
    await flush();

    expect(queueAssistantSpeech).not.toHaveBeenCalled();
  });

  it("does not auto-play assistant speech in desktop chat view", async () => {
    const queueAssistantSpeech = vi.fn();
    mockIsDesktopPlatform.mockReturnValue(true);
    mockUseVoiceChat.mockReturnValue({
      supported: false,
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
        chatSending: false,
        conversationMessages: [
          { id: "a1", role: "assistant", text: "Hello world.", timestamp: 1 },
        ],
      }),
    );

    await act(async () => {
      TestRenderer.create(React.createElement(ChatView));
    });
    await flush();

    expect(queueAssistantSpeech).not.toHaveBeenCalled();
  });

  it("does not render top-center voice or new chat controls in desktop chat view", async () => {
    mockIsDesktopPlatform.mockReturnValue(true);
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
    mockUseApp.mockReturnValue(createContext());

    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(ChatView));
    });
    await flush();

    const voiceButtons = tree?.root.findAll(
      (node) =>
        node.type === "button" &&
        (node.props["aria-label"] === "Agent voice on" ||
          node.props["aria-label"] === "Agent voice off"),
    );
    const newChatButtons = tree?.root.findAll(
      (node) =>
        node.type === "button" && node.props["aria-label"] === "+ New Chat",
    );

    expect(voiceButtons?.length ?? 0).toBe(0);
    expect(newChatButtons.length).toBe(0);
  });

  it("does not render a global agent voice toggle in default chat", async () => {
    mockIsDesktopPlatform.mockReturnValue(false);
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
    mockUseApp.mockReturnValue(createContext());

    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(ChatView));
    });
    await flush();

    const voiceButtons = tree?.root.findAll(
      (node) =>
        node.type === "button" &&
        (node.props["aria-label"] === "Agent voice on" ||
          node.props["aria-label"] === "Agent voice off"),
    );

    expect(voiceButtons?.length ?? 0).toBe(0);
  });

  it("pins the native scrollbar to the edge while keeping message text inset", async () => {
    mockUseApp.mockReturnValue(
      createContext({
        conversationMessages: [
          { id: "u1", role: "user", text: "hello", timestamp: 1 },
        ],
      }),
    );

    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(ChatView));
    });
    await flush();

    const scroller = tree?.root.findByProps({
      "data-testid": "chat-messages-scroll",
    });
    expect(String(scroller.props.className)).toContain("chat-native-scrollbar");
    expect(scroller.props.style?.scrollbarGutter).toBeUndefined();
  });

  it("auto-scrolls again when conversation messages update", async () => {
    const scrollTo = vi.fn();
    // Include scrollTop and clientHeight so the instant-vs-smooth branch
    // is exercised correctly (nearBottom = scrollHeight - scrollTop - clientHeight < 150).
    const scrollerMock = {
      scrollHeight: 240,
      scrollTop: 100,
      clientHeight: 140,
      scrollTo,
    };
    const textareaMock = {
      style: { height: "", overflowY: "" },
      scrollHeight: 38,
      focus: vi.fn(),
    };
    const fileInputMock = { click: vi.fn() };

    let currentContext = createContext({
      conversationMessages: [
        { id: "u1", role: "user", text: "hello", timestamp: 1 },
      ],
    });
    mockUseApp.mockImplementation(() => currentContext);

    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(ChatView), {
        createNodeMock: (element) => {
          const node = element as {
            type: unknown;
            props: Record<string, unknown>;
          };
          if (
            node.type === "div" &&
            node.props["data-testid"] === "chat-messages-scroll"
          ) {
            return scrollerMock;
          }
          if (node.type === "textarea") {
            return textareaMock;
          }
          if (node.type === "input" && node.props.type === "file") {
            return fileInputMock;
          }
          return {};
        },
      });
    });
    await flush();

    const callsAfterMount = scrollTo.mock.calls.length;
    expect(callsAfterMount).toBeGreaterThan(0);

    currentContext = createContext({
      conversationMessages: [
        { id: "u1", role: "user", text: "hello", timestamp: 1 },
        { id: "a1", role: "assistant", text: "Hi there!", timestamp: 2 },
      ],
    });

    await act(async () => {
      tree?.update(React.createElement(ChatView));
    });
    await flush();

    expect(scrollTo.mock.calls.length).toBeGreaterThan(callsAfterMount);
  });

  it("uses instant scroll when near bottom, smooth when scrolled up", async () => {
    const scrollTo = vi.fn();
    // Near bottom: distance = 500 - 400 - 90 = 10 (< 150 → instant)
    const scrollerMock = {
      scrollHeight: 500,
      scrollTop: 400,
      clientHeight: 90,
      scrollTo,
    };
    const textareaMock = {
      style: { height: "", overflowY: "" },
      scrollHeight: 38,
      focus: vi.fn(),
    };
    const fileInputMock = { click: vi.fn() };

    let currentContext = createContext({
      conversationMessages: [
        { id: "u1", role: "user", text: "hello", timestamp: 1 },
      ],
    });
    mockUseApp.mockImplementation(() => currentContext);

    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(ChatView), {
        createNodeMock: (element) => {
          const node = element as {
            type: unknown;
            props: Record<string, unknown>;
          };
          if (
            node.type === "div" &&
            node.props["data-testid"] === "chat-messages-scroll"
          ) {
            return scrollerMock;
          }
          if (node.type === "textarea") return textareaMock;
          if (node.type === "input" && node.props.type === "file")
            return fileInputMock;
          return {};
        },
      });
    });
    await flush();

    // Near bottom → should use instant
    const lastCall = scrollTo.mock.calls[scrollTo.mock.calls.length - 1];
    expect(lastCall[0]).toMatchObject({ behavior: "instant" });

    // Now simulate user scrolled up: distance = 500 - 50 - 90 = 360 (> 150 → smooth)
    scrollerMock.scrollTop = 50;
    scrollTo.mockClear();

    currentContext = createContext({
      conversationMessages: [
        { id: "u1", role: "user", text: "hello", timestamp: 1 },
        { id: "a1", role: "assistant", text: "Hi!", timestamp: 2 },
      ],
    });

    await act(async () => {
      tree?.update(React.createElement(ChatView));
    });
    await flush();

    const smoothCall = scrollTo.mock.calls[scrollTo.mock.calls.length - 1];
    expect(smoothCall[0]).toMatchObject({ behavior: "smooth" });
  });

  it("auto-scrolls when content changes but length and trailing text stay the same", async () => {
    const scrollTo = vi.fn();
    const scrollerMock = {
      scrollHeight: 240,
      scrollTop: 100,
      clientHeight: 140,
      scrollTo,
    };
    const textareaMock = {
      style: { height: "", overflowY: "" },
      scrollHeight: 38,
      focus: vi.fn(),
    };
    const fileInputMock = { click: vi.fn() };

    let currentContext = createContext({
      conversationMessages: [
        { id: "u1", role: "user", text: "first draft", timestamp: 1 },
        { id: "a1", role: "assistant", text: "same tail", timestamp: 2 },
      ],
    });
    mockUseApp.mockImplementation(() => currentContext);

    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(ChatView), {
        createNodeMock: (element) => {
          const node = element as {
            type: unknown;
            props: Record<string, unknown>;
          };
          if (
            node.type === "div" &&
            node.props["data-testid"] === "chat-messages-scroll"
          ) {
            return scrollerMock;
          }
          if (node.type === "textarea") {
            return textareaMock;
          }
          if (node.type === "input" && node.props.type === "file") {
            return fileInputMock;
          }
          return {};
        },
      });
    });
    await flush();

    const callsAfterMount = scrollTo.mock.calls.length;
    expect(callsAfterMount).toBeGreaterThan(0);

    currentContext = createContext({
      conversationMessages: [
        { id: "u2", role: "user", text: "updated body", timestamp: 101 },
        { id: "a2", role: "assistant", text: "same tail", timestamp: 102 },
      ],
    });

    await act(async () => {
      tree?.update(React.createElement(ChatView));
    });
    await flush();

    expect(scrollTo.mock.calls.length).toBeGreaterThan(callsAfterMount);
  });

  it("renders aria labels for chat composer controls", async () => {
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

    mockUseApp.mockReturnValue(createContext());

    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(ChatView));
    });
    await flush();

    const textarea = tree?.root.find((node) => node.type === "textarea");
    expect(textarea).toBeDefined();

    const buttons = tree?.root.findAllByType("button" as React.ElementType);

    const attachButton = buttons.find(
      (node) => node.props["aria-label"] === "Attach image",
    );
    expect(attachButton).toBeDefined();

    const micButton = buttons.find(
      (node) => node.props["aria-label"] === "chat.voiceInput",
    );
    expect(micButton).toBeDefined();
    expect(micButton?.props["aria-pressed"]).toBe(false);
  });

  it("does not render the native fast/pro toggle", async () => {
    mockUseApp.mockReturnValue(createContext({ chatMode: "power" }));

    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(ChatView));
    });
    await flush();

    expect(
      tree?.root.findAllByProps({ "data-testid": "chat-mode-toggle-native" }),
    ).toHaveLength(0);
  });

  it("disables send when chat input is empty or whitespace", async () => {
    mockUseApp.mockReturnValue(createContext({ chatInput: "   " }));

    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(ChatView));
    });
    await flush();

    // Find send button by aria-label since we now use an icon instead of text
    const buttons = tree?.root.findAllByType("button" as React.ElementType);
    const sendButton = buttons.find(
      (node) => node.props["aria-label"] === "chat.send",
    );
    expect(sendButton?.props.disabled).toBe(true);
  });

  it("uses vertical-only overflow for the native transcript pane", async () => {
    mockUseApp.mockReturnValue(
      createContext({
        conversationMessages: [
          { id: "assistant-1", role: "assistant", text: "hello", timestamp: 1 },
        ],
      }),
    );

    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(ChatView));
    });
    await flush();

    const scrollRegion = tree?.root.findByProps({
      "data-testid": "chat-messages-scroll",
    });
    expect(String(scrollRegion?.props.className)).toContain("overflow-y-auto");
    expect(String(scrollRegion?.props.className)).toContain(
      "overflow-x-hidden",
    );
  });

  it("keeps the native composer action button level with the input row", async () => {
    mockUseApp.mockReturnValue(createContext({ chatInput: "hello" }));

    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(ChatView));
    });
    await flush();

    const actionButton = tree?.root.findByProps({
      "data-testid": "chat-composer-action",
    });
    expect(String(actionButton?.props.className)).not.toContain("mb-1.5");
  });

  it("renders a labeled pending-image remove button that stays visible on mobile", async () => {
    mockUseApp.mockReturnValue(
      createContext({
        chatPendingImages: [
          { data: "abc123", mimeType: "image/png", name: "receipt.png" },
        ],
      }),
    );

    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(ChatView));
    });
    await flush();

    const removeButton = tree?.root.find(
      (node) =>
        node.type === "button" &&
        node.props["aria-label"] === "Remove image receipt.png",
    );

    expect(removeButton.props["aria-label"]).toBe("Remove image receipt.png");
    expect(String(removeButton.props.className)).toContain("opacity-100");
    expect(String(removeButton.props.className)).toContain("sm:opacity-0");
  });
});

// ---------------------------------------------------------------------------
// addImageFiles — functional updater (stale closure fix)
// ---------------------------------------------------------------------------

describe("addImageFiles functional updater", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("calls setChatPendingImages with a functional updater, not a static array", async () => {
    mockUseVoiceChat.mockReturnValue({
      supported: false,
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

    // Synchronous FileReader mock — calls onload immediately so we don't need
    // to wait for real async I/O inside the test.
    class MockFileReader {
      onload: (() => void) | null = null;
      result: string | ArrayBuffer | null = null;

      readAsDataURL() {
        this.result = "data:image/png;base64,abc123";
        this.onload?.();
      }
    }
    vi.stubGlobal("FileReader", MockFileReader as unknown as typeof FileReader);

    const setChatPendingImages = vi.fn();
    mockUseApp.mockReturnValue(
      createContext({ chatPendingImages: [], setChatPendingImages }),
    );

    let tree: TestRenderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(ChatView));
    });
    await flush();

    // Find the hidden <input type="file"> and fire onChange with a fake File
    if (!tree) {
      throw new Error("ChatView test renderer did not initialize");
    }
    const fileInput = tree.root.find(
      (node: TestRenderer.ReactTestInstance) =>
        node.type === "input" && node.props.accept === "image/*",
    );

    const fakeFile = new Proxy(
      { type: "image/png", name: "test.png" },
      {
        get(target, prop) {
          return (target as Record<string | symbol, unknown>)[prop as string];
        },
      },
    ) as unknown as File;

    await act(async () => {
      fileInput.props.onChange({
        target: { files: [fakeFile], value: "" },
      });
    });
    await flush();

    // The fix: setChatPendingImages must be called with a function (functional
    // updater), not a static array. This ensures rapid consecutive drops
    // accumulate all images instead of overwriting with stale state.
    expect(setChatPendingImages).toHaveBeenCalled();
    const callArg = setChatPendingImages.mock.calls[0]?.[0];
    expect(typeof callArg).toBe("function");

    // Verify the updater correctly appends to the existing array
    const prev = [
      { data: "existing", mimeType: "image/jpeg", name: "prev.jpg" },
    ];
    const next = callArg(prev);
    expect(next).toHaveLength(2);
    expect(next[0]).toEqual(prev[0]);
    expect(next[1]).toMatchObject({ mimeType: "image/png", name: "test.png" });
  });
});
