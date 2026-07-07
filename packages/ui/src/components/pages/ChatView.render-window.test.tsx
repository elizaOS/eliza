// @vitest-environment jsdom
//
// Render-window coverage for ChatView (#15281): a long thread must mount at most
// MAX_RENDERED_SHELL_MESSAGES transcript rows (not every loaded turn), keep the
// top sentinel mounted for scroll-up paging, and grow to the full loaded set
// (capped at MAX_LOADED_SHELL_WINDOW) when the sidebar search-jump emits
// CHAT_TRANSCRIPT_REVEAL_WINDOW_EVENT. It mounts the REAL ChatView with the real
// useConversationRenderWindow + useViewEvent engines; only the voice/game-modal
// companion hooks and the app-state/context providers are mocked (they are
// orthogonal to windowing). jsdom has no IntersectionObserver, so
// useLoadOlderOnScroll self-bails — scroll-driven growth is covered by the hook
// unit tests + the real-Chromium e2e; this asserts the mount + reveal contract.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConversationMessage } from "../../api/client-types-chat";
import { CHAT_TRANSCRIPT_REVEAL_WINDOW_EVENT } from "../../hooks/useConversationRenderWindow";
import { emitViewEvent } from "../../views/view-event-bus";
import {
  MAX_LOADED_SHELL_WINDOW,
  MAX_RENDERED_SHELL_MESSAGES,
} from "../shell/shell-state";

const THREAD_LENGTH = 450;

function seedMessages(count: number): ConversationMessage[] {
  const now = Date.now();
  const msgs: ConversationMessage[] = [];
  for (let i = 0; i < count; i += 1) {
    msgs.push({
      id: `msg-${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      text: `Message ${i}`,
      timestamp: now - (count - i) * 1000,
      source: "eliza",
    });
  }
  return msgs;
}

const seeded = seedMessages(THREAD_LENGTH);

const appState = {
  agentStatus: { state: "running", canRespond: true },
  activeConversationId: "conv-1",
  activeInboxChat: null,
  activeTerminalSessionId: null,
  characterData: { name: "Eliza" },
  chatFirstTokenReceived: false,
  companionMessageCutoffTs: null,
  handleChatSend: vi.fn(async () => {}),
  handleChatStop: vi.fn(),
  handleChatEdit: vi.fn(async () => true),
  handleChatDelete: vi.fn(async () => {}),
  elizaCloudConnected: false,
  elizaCloudVoiceProxyAvailable: false,
  elizaCloudHasPersistedKey: false,
  setState: vi.fn(),
  copyToClipboard: vi.fn(async () => {}),
  droppedFiles: [],
  analysisMode: false,
  shareIngestNotice: "",
  chatAgentVoiceMuted: true,
  uiLanguage: "en",
  sendChatText: vi.fn(async () => {}),
  t: (key: string, opts?: { defaultValue?: string }) =>
    opts?.defaultValue ?? key,
  setActionNotice: vi.fn(),
};

vi.mock("../../state/app-store", () => ({
  useAppSelectorShallow: (selector: (s: typeof appState) => unknown) =>
    selector(appState),
  useAppSelector: (selector: (s: typeof appState) => unknown) =>
    selector(appState),
  useApp: () => appState,
}));

vi.mock("../../state/ConversationMessagesContext.hooks", () => ({
  useConversationMessages: () => ({
    conversationMessages: seeded,
    removeConversationMessage: vi.fn(),
    prependConversationMessages: vi.fn(),
    setConversationMessages: vi.fn(),
  }),
}));

vi.mock("../../state/ChatComposerContext.hooks", () => ({
  useChatComposer: () => ({
    chatInput: "",
    chatSending: false,
    chatPendingImages: [],
    chatReplyTarget: null,
    setChatInput: vi.fn(),
    setChatPendingImages: vi.fn(),
    setChatReplyTarget: vi.fn(),
  }),
}));

vi.mock("../../state/PtySessionsContext.hooks", () => ({
  usePtySessions: () => ({ ptySessions: [] }),
}));

vi.mock("../../api/client", () => ({ client: {} }));

vi.mock("../../hooks/useChatAvatarVoiceBridge", () => ({
  useChatAvatarVoiceBridge: () => {},
}));

// Voice + game-modal companion hooks are orthogonal to the render window — an
// inert voice controller (unsupported, no TTS error → the voice status bar stays
// hidden) and an empty game-modal bridge keep the default surface rendering.
vi.mock("./chat-view-hooks", () => ({
  useChatVoiceController: () => ({
    beginVoiceCapture: vi.fn(),
    endVoiceCapture: vi.fn(),
    continuous: {
      status: "idle",
      interimTranscript: "",
      latency: null,
      needsAudioUnlock: false,
      unlockAudio: vi.fn(),
      micReconnected: false,
      ttsError: null,
    },
    handleEditMessage: vi.fn(),
    handleSpeakMessage: vi.fn(),
    stopSpeaking: vi.fn(),
    voice: {
      supported: false,
      isListening: false,
      isSpeaking: false,
      captureMode: "idle",
      interimTranscript: "",
      assistantTtsQuality: undefined,
      mouthOpen: 0,
    },
    voiceLatency: null,
    voiceSpeaker: null,
  }),
  useGameModalMessages: () => ({
    companionCarryover: null,
    gameModalCarryoverOpacity: 1,
    gameModalVisibleMsgs: [],
  }),
}));

import { ChatView } from "./ChatView";

// ChatView's default (non-glass) transcript rows carry data-testid="chat-message"
// (the "thread-line" testid is the overlay's glass row). Attribute-equality, so
// it counts rows only — not "chat-message-action-rail" / "chat-message-reply".
function threadRowCount(container: HTMLElement): number {
  return container.querySelectorAll('[data-testid="chat-message"]').length;
}

afterEach(cleanup);

describe("ChatView transcript render window (#15281)", () => {
  beforeEach(() => {
    appState.activeConversationId = "conv-1";
  });

  it("mounts at most MAX_RENDERED_SHELL_MESSAGES rows for a long thread, with the top sentinel present", () => {
    const { container } = render(<ChatView hideComposer />);

    // The bounded window renders only the newest page, never all 450 turns.
    expect(threadRowCount(container)).toBe(MAX_RENDERED_SHELL_MESSAGES);
    expect(
      container.querySelector('[data-testid="chat-transcript-top-sentinel"]'),
    ).not.toBeNull();
  });

  it("reveals the full loaded set (capped at the DOM bound) on the search-jump event", () => {
    const { container } = render(<ChatView hideComposer />);
    expect(threadRowCount(container)).toBe(MAX_RENDERED_SHELL_MESSAGES);

    act(() => {
      emitViewEvent(CHAT_TRANSCRIPT_REVEAL_WINDOW_EVENT);
    });

    // 450 loaded turns → the window opens to the hard DOM bound (400), not all
    // 450, so the far-back search pivot mounts without unbounding the DOM.
    expect(threadRowCount(container)).toBe(
      Math.min(THREAD_LENGTH, MAX_LOADED_SHELL_WINDOW),
    );
  });
});
