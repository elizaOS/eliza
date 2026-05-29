// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationMessage } from "../../api/client-types-chat";
import { ChatView } from "./ChatView";

// ChatView sits on top of a deep provider tree (app context, PTY sessions,
// chat composer, a voice controller). We mock those hook seams — the exact
// boundaries the Q2 data-layer refactor reshapes — and let the real composer
// + transcript children render, so the assertions exercise genuine UI behavior
// (empty state vs transcript, and that sending dispatches the app handler).
const appMock = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const composerMock = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

function t(key: string, options?: { defaultValue?: string }) {
  return options?.defaultValue ?? key;
}

vi.mock("../../state/useApp", () => ({ useApp: () => appMock.value }));
vi.mock("../../state/PtySessionsContext", () => ({
  usePtySessions: () => ({ ptySessions: [] }),
}));
vi.mock("../../state/ChatComposerContext", () => ({
  useChatComposer: () => composerMock.value,
}));

const voiceState = {
  supported: false,
  isListening: false,
  captureMode: "idle" as const,
  interimTranscript: "",
  isSpeaking: false,
  mouthOpen: 0,
  assistantTtsQuality: "enhanced" as const,
  toggleListening: vi.fn(),
};

vi.mock("./chat-view-hooks", () => ({
  __resetCompanionSpeechMemoryForTests: vi.fn(),
  useChatVoiceController: () => ({
    beginVoiceCapture: vi.fn(),
    endVoiceCapture: vi.fn(),
    continuous: { status: "idle", interimTranscript: "", latency: null },
    handleEditMessage: vi.fn(),
    handleSpeakMessage: vi.fn(),
    stopSpeaking: vi.fn(),
    voice: voiceState,
    voiceLatency: null,
    voiceSpeaker: null,
  }),
  useGameModalMessages: () => ({
    companionCarryover: null,
    gameModalCarryoverOpacity: 1,
    gameModalVisibleMsgs: [],
  }),
}));

vi.mock("../../hooks/useChatAvatarVoiceBridge", () => ({
  useChatAvatarVoiceBridge: vi.fn(),
}));
vi.mock("../../hooks/useDocumentVisibility", () => ({
  useIntervalWhenDocumentVisible: vi.fn(),
}));

// The coding-agent preflight fetch must resolve so the mount effect settles.
vi.mock("../../api/csrf-client", () => ({
  fetchWithCsrf: vi.fn(async () => ({
    json: async () => ({ installed: [], available: false }),
  })),
}));

// Task-coordinator slots are host-provided; render inert in the UI package.
vi.mock("../../slots/task-coordinator-slots.js", () => ({
  CodingAgentControlChip: () => null,
  PtyConsoleBase: () => null,
}));

function makeApp(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    agentStatus: { state: "running", model: "test-model" },
    activeConversationId: "conv-1",
    activeInboxChat: null,
    activeTerminalSessionId: null,
    characterData: { name: "Ada" },
    chatFirstTokenReceived: false,
    companionMessageCutoffTs: 0,
    conversationMessages: [] as ConversationMessage[],
    handleChatSend: vi.fn(),
    handleChatStop: vi.fn(),
    handleChatEdit: vi.fn(),
    elizaCloudConnected: false,
    elizaCloudVoiceProxyAvailable: false,
    elizaCloudHasPersistedKey: false,
    setState: vi.fn(),
    copyToClipboard: vi.fn(),
    droppedFiles: [],
    analysisMode: false,
    shareIngestNotice: "",
    chatAgentVoiceMuted: true,
    selectedVrmIndex: 0,
    uiLanguage: "en",
    sendChatText: vi.fn(async () => {}),
    t,
    ...overrides,
  };
}

function makeComposer(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    chatInput: "",
    chatSending: false,
    chatPendingImages: [],
    setChatInput: vi.fn(),
    setChatPendingImages: vi.fn(),
    ...overrides,
  };
}

function makeMessage(
  overrides: Partial<ConversationMessage> = {},
): ConversationMessage {
  return {
    id: "m1",
    role: "user",
    text: "hello there",
    timestamp: 1,
    source: "eliza",
    ...overrides,
  } as ConversationMessage;
}

beforeEach(() => {
  // jsdom lacks these layout APIs the auto-scroll + ResizeObserver effects use.
  Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo;
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
  appMock.value = makeApp();
  composerMock.value = makeComposer();
});

afterEach(() => cleanup());

describe("ChatView", () => {
  it("renders the empty state when there are no messages", async () => {
    render(<ChatView />);

    // No conversation messages → the "Start a Conversation" empty prompt with
    // the agent name, not a transcript.
    await waitFor(() => {
      expect(screen.getByText("Start a Conversation")).toBeTruthy();
    });
    expect(screen.getByText(/Ada/)).toBeTruthy();
  });

  it("renders the transcript once messages arrive", async () => {
    appMock.value = makeApp({
      conversationMessages: [
        makeMessage({ id: "u1", role: "user", text: "ping" }),
        makeMessage({ id: "a1", role: "assistant", text: "pong" }),
      ],
    });

    render(<ChatView />);

    await waitFor(() => {
      expect(screen.getByText("ping")).toBeTruthy();
    });
    expect(screen.getByText("pong")).toBeTruthy();
    // Empty state must be gone once a transcript renders.
    expect(screen.queryByText("Start a Conversation")).toBeNull();
  });

  it("clicking send dispatches the app's handleChatSend handler", async () => {
    appMock.value = makeApp();
    composerMock.value = makeComposer({ chatInput: "draft text" });

    render(<ChatView />);

    const sendButton = await screen.findByTestId("chat-composer-action");
    fireEvent.click(sendButton);

    await waitFor(() => {
      expect(appMock.value.handleChatSend).toHaveBeenCalled();
    });
  });

  it("shows a missing-inference-provider lock when the agent has no model wired", async () => {
    appMock.value = makeApp({
      agentStatus: { state: "running", model: "" },
      conversationMessages: [],
    });

    render(<ChatView />);

    // The composer placeholder switches to the "set up a provider" guidance,
    // proving ChatView derives the composer-locked state from agentStatus.
    const textarea = await screen.findByTestId("chat-composer-textarea");
    await waitFor(() => {
      expect(textarea.getAttribute("placeholder")).toBe(
        "Set up an LLM provider in Settings to start chatting",
      );
    });
  });
});
