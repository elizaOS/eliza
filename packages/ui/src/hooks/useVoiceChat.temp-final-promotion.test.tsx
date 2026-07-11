// @vitest-environment jsdom

/**
 * Regression: temp→final message-id promotion must not re-speak the reply.
 *
 * A streaming assistant reply is first announced to `queueAssistantSpeech`
 * under a provisional client id (`temp-resp-*` from useChatSend), then
 * re-announced with identical (or extended) text under its persisted server
 * id. Resetting the spoken prefix on that id flip re-queued the WHOLE reply,
 * producing an audible second copy of every voice answer (heard live on the
 * Light Phone III batch, #16064). The fix carries the queued prefix and
 * final-queued flag across the promotion when the text continues what was
 * already queued.
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVoiceChat } from "./useVoiceChat";

class FakeSpeechSynthesisUtterance extends EventTarget {
  text: string;
  lang = "";
  rate = 1;
  pitch = 1;
  voice: SpeechSynthesisVoice | null = null;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: SpeechSynthesisErrorEvent) => void) | null = null;

  constructor(text: string) {
    super();
    this.text = text;
  }
}

const speechSynthesisMock = {
  speaking: false,
  pending: false,
  spoken: [] as FakeSpeechSynthesisUtterance[],
  cancel: vi.fn(() => {
    speechSynthesisMock.speaking = false;
    speechSynthesisMock.pending = false;
  }),
  getVoices: vi.fn(() => []),
  speak: vi.fn((utterance: FakeSpeechSynthesisUtterance) => {
    speechSynthesisMock.spoken.push(utterance);
    speechSynthesisMock.speaking = true;
    utterance.onstart?.();
  }),
};

function installBrowserTtsMocks() {
  speechSynthesisMock.spoken = [];
  speechSynthesisMock.speaking = false;
  speechSynthesisMock.pending = false;
  speechSynthesisMock.cancel.mockClear();
  speechSynthesisMock.speak.mockClear();
  speechSynthesisMock.getVoices.mockClear();

  Object.defineProperty(window, "speechSynthesis", {
    configurable: true,
    value: speechSynthesisMock,
  });
  Object.defineProperty(window, "SpeechSynthesisUtterance", {
    configurable: true,
    value: FakeSpeechSynthesisUtterance,
  });
  Object.defineProperty(globalThis, "SpeechSynthesisUtterance", {
    configurable: true,
    value: FakeSpeechSynthesisUtterance,
  });
  window.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
    return window.setTimeout(() => callback(performance.now()), 16);
  }) as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = vi.fn((id: number) => {
    clearTimeout(id);
  }) as typeof window.cancelAnimationFrame;
}

function endCurrentUtterance() {
  const utterance = speechSynthesisMock.spoken.at(-1);
  speechSynthesisMock.speaking = false;
  utterance?.onend?.();
}

describe("useVoiceChat temp→final message promotion", () => {
  beforeEach(() => {
    installBrowserTtsMocks();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not re-speak an identical reply promoted from a temp id to its persisted id", async () => {
    const { result } = renderHook(() =>
      useVoiceChat({ onTranscript: vi.fn() }),
    );

    const replyText =
      "The forecast for tomorrow is sunny with a high of seventy five.";

    // Streaming completes under the provisional client id.
    act(() => {
      result.current.queueAssistantSpeech("temp-resp-123", replyText, true);
    });
    await waitFor(() => {
      expect(speechSynthesisMock.speak).toHaveBeenCalledTimes(1);
    });
    expect(speechSynthesisMock.spoken[0]?.text).toBe(replyText);
    act(() => {
      endCurrentUtterance();
    });

    // Reconciliation re-announces the identical text under the persisted id.
    act(() => {
      result.current.queueAssistantSpeech("srv-msg-456", replyText, true);
    });

    // Nothing new to speak — the whole reply was already queued.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    expect(speechSynthesisMock.speak).toHaveBeenCalledTimes(1);
  });

  it("speaks only the unspoken remainder when the promoted final text extends the temp stream", async () => {
    const { result } = renderHook(() =>
      useVoiceChat({ onTranscript: vi.fn() }),
    );

    const streamedPrefix = "Here is the first part of the answer.";
    const fullReply = `${streamedPrefix} And here is the ending sentence.`;

    // Partial stream under the temp id (sentence boundary → queued).
    act(() => {
      result.current.queueAssistantSpeech(
        "temp-resp-123",
        streamedPrefix,
        false,
      );
    });
    await waitFor(() => {
      expect(speechSynthesisMock.speak).toHaveBeenCalledTimes(1);
    });
    expect(speechSynthesisMock.spoken[0]?.text).toBe(streamedPrefix);
    act(() => {
      endCurrentUtterance();
    });

    // Final text lands under the persisted id, extending the streamed prefix.
    act(() => {
      result.current.queueAssistantSpeech("srv-msg-456", fullReply, true);
    });
    await waitFor(() => {
      expect(speechSynthesisMock.speak).toHaveBeenCalledTimes(2);
    });

    // Only the remainder is spoken — never the already-heard prefix again.
    expect(speechSynthesisMock.spoken[1]?.text).toBe(
      "And here is the ending sentence.",
    );
  });

  it("still resets state for a genuinely new assistant message", async () => {
    const { result } = renderHook(() =>
      useVoiceChat({ onTranscript: vi.fn() }),
    );

    act(() => {
      result.current.queueAssistantSpeech(
        "srv-msg-1",
        "First reply, spoken fully.",
        true,
      );
    });
    await waitFor(() => {
      expect(speechSynthesisMock.speak).toHaveBeenCalledTimes(1);
    });
    act(() => {
      endCurrentUtterance();
    });

    // A different reply with unrelated text must speak from scratch.
    act(() => {
      result.current.queueAssistantSpeech(
        "srv-msg-2",
        "A completely different second reply.",
        true,
      );
    });
    await waitFor(() => {
      expect(speechSynthesisMock.speak).toHaveBeenCalledTimes(2);
    });
    expect(speechSynthesisMock.spoken[1]?.text).toBe(
      "A completely different second reply.",
    );
  });

  it("speaks a new persisted message in full even when it extends the previous reply's text", async () => {
    const { result } = renderHook(() =>
      useVoiceChat({ onTranscript: vi.fn() }),
    );

    // First persisted reply.
    act(() => {
      result.current.queueAssistantSpeech("srv-msg-1", "Sure.", true);
    });
    await waitFor(() => {
      expect(speechSynthesisMock.speak).toHaveBeenCalledTimes(1);
    });
    act(() => {
      endCurrentUtterance();
    });

    // A distinct later reply that happens to share the prefix "Sure." — both
    // ids are persisted (no temp→final promotion), so it must speak in full,
    // not just the remainder.
    act(() => {
      result.current.queueAssistantSpeech(
        "srv-msg-2",
        "Sure. I can help with that.",
        true,
      );
    });
    await waitFor(() => {
      expect(speechSynthesisMock.speak).toHaveBeenCalledTimes(2);
    });
    expect(speechSynthesisMock.spoken[1]?.text).toBe(
      "Sure. I can help with that.",
    );

    act(() => {
      endCurrentUtterance();
    });

    // Identical-text repeat under yet another persisted id must also re-speak.
    act(() => {
      result.current.queueAssistantSpeech(
        "srv-msg-3",
        "Sure. I can help with that.",
        true,
      );
    });
    await waitFor(() => {
      expect(speechSynthesisMock.speak).toHaveBeenCalledTimes(3);
    });
    expect(speechSynthesisMock.spoken[2]?.text).toBe(
      "Sure. I can help with that.",
    );
  });
});
