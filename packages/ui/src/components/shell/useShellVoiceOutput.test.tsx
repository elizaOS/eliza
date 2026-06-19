// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationMessage } from "../../api/client-types-chat";

// Hoisted so the vi.mock factories below (which are lifted above imports) can
// reference them. `cfg` lets individual tests vary speaking / bootstrap state.
const hoisted = vi.hoisted(() => ({
  queueAssistantSpeech: vi.fn(),
  stopSpeaking: vi.fn(),
  cfg: { isSpeaking: false, voiceBootstrapTick: 1 },
}));

// The single TTS engine — mocked to capture the output calls the overlay makes.
vi.mock("../../hooks/useVoiceChat", () => ({
  useVoiceChat: () => ({
    queueAssistantSpeech: hoisted.queueAssistantSpeech,
    stopSpeaking: hoisted.stopSpeaking,
    isSpeaking: hoisted.cfg.isSpeaking,
    // Unused by the output hook, present to satisfy the shape.
    isListening: false,
    captureMode: "idle",
    mouthOpen: 0,
    interimTranscript: "",
    supported: true,
    usingAudioAnalysis: false,
    toggleListening: () => {},
    startListening: async () => {},
    stopListening: async () => {},
    speak: () => {},
    voiceUnlockedGeneration: 0,
    assistantTtsQuality: "standard",
  }),
}));

vi.mock("../../voice/useVoiceConfig", () => ({
  useVoiceConfig: () => ({
    voiceConfig: { provider: "local-inference" },
    voiceBootstrapTick: hoisted.cfg.voiceBootstrapTick,
    reloadVoiceConfig: () => {},
  }),
}));

import {
  type ShellVoiceOutputOptions,
  useShellVoiceOutput,
} from "./useShellVoiceOutput";

function userMsg(id: string, text: string): ConversationMessage {
  return { id, role: "user", text, timestamp: 1 };
}
function assistantMsg(id: string, text: string): ConversationMessage {
  return { id, role: "assistant", text, timestamp: 2 };
}

const BASE: ShellVoiceOutputOptions = {
  conversationMessages: [],
  chatSending: false,
  recording: false,
  lastTurnVoice: false,
  uiLanguage: "en",
  cloudConnected: false,
};

function render(initial: ShellVoiceOutputOptions) {
  return renderHook(
    (props: ShellVoiceOutputOptions) => useShellVoiceOutput(props),
    {
      initialProps: initial,
    },
  );
}

beforeEach(() => {
  hoisted.queueAssistantSpeech.mockClear();
  hoisted.stopSpeaking.mockClear();
  hoisted.cfg.isSpeaking = false;
  hoisted.cfg.voiceBootstrapTick = 1;
});

afterEach(cleanup);

describe("useShellVoiceOutput", () => {
  it("speaks the assistant reply after a voice turn", () => {
    const { rerender } = render({
      ...BASE,
      lastTurnVoice: true,
      conversationMessages: [userMsg("u1", "what's the weather")],
    });
    // No assistant message yet — nothing spoken.
    expect(hoisted.queueAssistantSpeech).not.toHaveBeenCalled();

    rerender({
      ...BASE,
      lastTurnVoice: true,
      conversationMessages: [
        userMsg("u1", "what's the weather"),
        assistantMsg("a1", "It is sunny."),
      ],
    });

    expect(hoisted.queueAssistantSpeech).toHaveBeenCalledTimes(1);
    expect(hoisted.queueAssistantSpeech).toHaveBeenCalledWith(
      "a1",
      "It is sunny.",
      true,
      { replace: true },
    );
  });

  it("stays silent when the latest turn was typed, not voice", () => {
    render({
      ...BASE,
      lastTurnVoice: false,
      conversationMessages: [
        userMsg("u1", "typed question"),
        assistantMsg("a1", "Typed answer."),
      ],
    });
    expect(hoisted.queueAssistantSpeech).not.toHaveBeenCalled();
  });

  it("does not re-speak the same assistant message", () => {
    const messages = [userMsg("u1", "hi"), assistantMsg("a1", "Hello.")];
    const { rerender } = render({
      ...BASE,
      lastTurnVoice: true,
      conversationMessages: messages,
    });
    expect(hoisted.queueAssistantSpeech).toHaveBeenCalledTimes(1);

    // Same content, new array identity (a re-render with no new text).
    rerender({
      ...BASE,
      lastTurnVoice: true,
      conversationMessages: [...messages],
    });
    expect(hoisted.queueAssistantSpeech).toHaveBeenCalledTimes(1);
  });

  it("speaks streaming growth as it arrives, then the final text", () => {
    const { rerender } = render({
      ...BASE,
      lastTurnVoice: true,
      chatSending: true,
      conversationMessages: [userMsg("u1", "hi"), assistantMsg("a1", "Hel")],
    });
    rerender({
      ...BASE,
      lastTurnVoice: true,
      chatSending: true,
      conversationMessages: [
        userMsg("u1", "hi"),
        assistantMsg("a1", "Hello wor"),
      ],
    });
    rerender({
      ...BASE,
      lastTurnVoice: true,
      chatSending: false,
      conversationMessages: [
        userMsg("u1", "hi"),
        assistantMsg("a1", "Hello world."),
      ],
    });

    expect(hoisted.queueAssistantSpeech).toHaveBeenCalledTimes(3);
    // First clip of a new message replaces prior playback; continuations append.
    expect(hoisted.queueAssistantSpeech).toHaveBeenNthCalledWith(
      1,
      "a1",
      "Hel",
      false,
      {
        replace: true,
      },
    );
    expect(hoisted.queueAssistantSpeech).toHaveBeenNthCalledWith(
      3,
      "a1",
      "Hello world.",
      true,
      { replace: false },
    );
  });

  it("barges in — stops speech the instant the mic opens", () => {
    const { rerender } = render({
      ...BASE,
      lastTurnVoice: true,
      conversationMessages: [
        userMsg("u1", "hi"),
        assistantMsg("a1", "Talking…"),
      ],
    });
    hoisted.stopSpeaking.mockClear();

    rerender({
      ...BASE,
      lastTurnVoice: true,
      recording: true,
      conversationMessages: [
        userMsg("u1", "hi"),
        assistantMsg("a1", "Talking…"),
      ],
    });
    expect(hoisted.stopSpeaking).toHaveBeenCalled();
  });

  it("mutes: stops in-flight speech and silences later replies", () => {
    const { result, rerender } = render({
      ...BASE,
      lastTurnVoice: true,
      conversationMessages: [userMsg("u1", "hi"), assistantMsg("a1", "First.")],
    });
    expect(hoisted.queueAssistantSpeech).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.toggleAgentVoiceMute();
    });
    expect(result.current.agentVoiceMuted).toBe(true);
    expect(hoisted.stopSpeaking).toHaveBeenCalled();

    // A new reply arrives while muted — it must not be spoken.
    rerender({
      ...BASE,
      lastTurnVoice: true,
      conversationMessages: [
        userMsg("u1", "hi"),
        assistantMsg("a1", "First."),
        userMsg("u2", "again"),
        assistantMsg("a2", "Second."),
      ],
    });
    expect(hoisted.queueAssistantSpeech).toHaveBeenCalledTimes(1);
  });

  it("waits for the voice config to load before speaking", () => {
    hoisted.cfg.voiceBootstrapTick = 0;
    render({
      ...BASE,
      lastTurnVoice: true,
      conversationMessages: [userMsg("u1", "hi"), assistantMsg("a1", "Ready?")],
    });
    expect(hoisted.queueAssistantSpeech).not.toHaveBeenCalled();
  });

  it("reflects the engine's speaking state", () => {
    hoisted.cfg.isSpeaking = true;
    const { result } = render(BASE);
    expect(result.current.speaking).toBe(true);
  });
});
