// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContinuousChatToggle } from "../../components/composites/chat/ContinuousChatToggle";
import { ChatSurface } from "../../components/shell/ChatSurface";
import { HomePill } from "../../components/shell/HomePill";
import type {
  ShellMessage,
  ShellPhase,
} from "../../components/shell/shell-state";
import { useContinuousChat } from "../../hooks/useContinuousChat";
import { useVoiceChat } from "../../hooks/useVoiceChat";
import type { VoiceContinuousMode } from "../../voice/voice-chat-types";

const WAIT_PHRASE =
  "hmm, okay, that's a good idea, let me think for a second, and then the agent will wait";

type FakeSpeechRecognitionResultEvent = {
  resultIndex: number;
  results: Array<{
    isFinal: boolean;
    0: { transcript: string; confidence: number };
  }>;
};

class FakeSpeechRecognition {
  static instances: FakeSpeechRecognition[] = [];

  continuous = false;
  interimResults = false;
  lang = "en-US";
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onresult: ((event: FakeSpeechRecognitionResultEvent) => void) | null = null;
  started = false;
  stopped = false;

  constructor() {
    FakeSpeechRecognition.instances.push(this);
  }

  start() {
    this.started = true;
    this.onstart?.();
  }

  stop() {
    this.stopped = true;
    this.onend?.();
  }

  abort() {
    this.stopped = true;
    this.onend?.();
  }

  emitResult(transcript: string, isFinal: boolean) {
    this.onresult?.({
      resultIndex: 0,
      results: [
        {
          isFinal,
          0: { transcript, confidence: 0.95 },
        },
      ],
    });
  }
}

class FakeSpeechSynthesisUtterance {
  text: string;
  lang = "";
  rate = 1;
  pitch = 1;
  voice: SpeechSynthesisVoice | null = null;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: SpeechSynthesisErrorEvent) => void) | null = null;

  constructor(text: string) {
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

function installVoiceMocks() {
  FakeSpeechRecognition.instances = [];
  speechSynthesisMock.spoken = [];
  speechSynthesisMock.speaking = false;
  speechSynthesisMock.pending = false;
  speechSynthesisMock.cancel.mockClear();
  speechSynthesisMock.getVoices.mockClear();
  speechSynthesisMock.speak.mockClear();

  Object.defineProperty(window, "SpeechRecognition", {
    configurable: true,
    value: FakeSpeechRecognition,
  });
  Object.defineProperty(window, "webkitSpeechRecognition", {
    configurable: true,
    value: FakeSpeechRecognition,
  });
  Object.defineProperty(window, "SpeechSynthesisUtterance", {
    configurable: true,
    value: FakeSpeechSynthesisUtterance,
  });
  Object.defineProperty(globalThis, "SpeechSynthesisUtterance", {
    configurable: true,
    value: FakeSpeechSynthesisUtterance,
  });
  Object.defineProperty(window, "speechSynthesis", {
    configurable: true,
    value: speechSynthesisMock,
  });
  window.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(performance.now()), 16),
  ) as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = vi.fn((id: number) => {
    clearTimeout(id);
  }) as typeof window.cancelAnimationFrame;
}

function AssistantVoiceHarness() {
  const [phase, setPhase] = React.useState<ShellPhase>("idle");
  const [messages, setMessages] = React.useState<ShellMessage[]>([]);
  const [continuousMode, setContinuousMode] =
    React.useState<VoiceContinuousMode>("off");
  const [preview, setPreview] = React.useState("");
  const voiceTurnIdRef = React.useRef(0);

  const voice = useVoiceChat({
    onTranscriptPreview: (text) => {
      setPreview(text);
    },
    onTranscript: (text) => {
      const turnId = voiceTurnIdRef.current;
      voiceTurnIdRef.current += 1;
      setPreview("");
      setMessages((current) => [
        ...current,
        {
          id: `user-${turnId}`,
          role: "user",
          content: text,
          createdAt: current.length + 1,
        },
        {
          id: `assistant-${turnId}`,
          role: "assistant",
          content: WAIT_PHRASE,
          createdAt: current.length + 2,
        },
      ]);
      voice.queueAssistantSpeech(
        `assistant-wait-${turnId}`,
        WAIT_PHRASE,
        false,
      );
    },
  });
  const continuous = useContinuousChat({
    voice,
    mode: continuousMode,
  });

  async function toggleRecording() {
    if (voice.isListening) {
      await voice.stopListening({ submit: true });
      return;
    }
    await voice.startListening("hands-free");
  }

  return (
    <>
      <HomePill
        phase={phase}
        onOpen={() => setPhase("summoned")}
        onClose={() => setPhase("idle")}
      />
      {phase === "summoned" && (
        <>
          <ContinuousChatToggle
            value={continuousMode}
            onChange={setContinuousMode}
            data-testid="assistant-continuous-toggle"
          />
          <div role="status" aria-label="Voice capture status">
            {continuous.status}
          </div>
          {preview && (
            <div role="status" aria-label="Voice transcript preview">
              {preview}
            </div>
          )}
          <ChatSurface
            messages={messages}
            onSend={() => {}}
            canSend={true}
            recording={voice.isListening}
            onToggleRecording={() => {
              void toggleRecording();
            }}
          />
        </>
      )}
    </>
  );
}

describe("assistant voice application flow", () => {
  beforeEach(() => {
    installVoiceMocks();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("uses the real mic button to submit browser speech and speak the wait phrase back", async () => {
    render(<AssistantVoiceHarness />);

    fireEvent.click(screen.getByTestId("shell-home-pill"));
    const mic = screen.getByRole("button", { name: "Start voice input" });

    await act(async () => {
      fireEvent.click(mic);
    });

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Stop voice input" }),
      ).toBeTruthy();
    });
    const recognition = FakeSpeechRecognition.instances[0];
    expect(recognition?.started).toBe(true);

    act(() => {
      recognition?.emitResult("create a new remote ledger view", true);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop voice input" }));
    });

    await waitFor(() => {
      expect(screen.getByText("create a new remote ledger view")).toBeTruthy();
      expect(screen.getByText(WAIT_PHRASE)).toBeTruthy();
      expect(speechSynthesisMock.speak).toHaveBeenCalledTimes(1);
    });
    expect(speechSynthesisMock.spoken[0]?.text).toBe(WAIT_PHRASE);
  });

  it("uses the real continuous-chat Live control for always-on passive capture during the wait phrase", async () => {
    render(<AssistantVoiceHarness />);

    fireEvent.click(screen.getByTestId("shell-home-pill"));
    const toggle = screen.getByTestId("assistant-continuous-toggle");
    const liveButton = toggle.querySelector(
      "button[data-mode='always-on']",
    ) as HTMLButtonElement;
    expect(liveButton).toBeTruthy();

    await act(async () => {
      fireEvent.click(liveButton);
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Voice capture status").textContent).toBe(
        "listening",
      );
    });
    const recognition = FakeSpeechRecognition.instances[0];
    expect(recognition?.started).toBe(true);
    expect(recognition?.continuous).toBe(true);
    expect(recognition?.interimResults).toBe(true);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Stop voice input" }),
      ).toBeTruthy();
    });
    act(() => {
      recognition?.emitResult("create a remote ledger view while live", true);
    });

    await waitFor(() => {
      expect(
        screen.getByText("create a remote ledger view while live"),
      ).toBeTruthy();
      expect(screen.getByText(WAIT_PHRASE)).toBeTruthy();
      expect(speechSynthesisMock.speak).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByLabelText("Voice transcript preview")).toBeNull();
    expect(speechSynthesisMock.spoken[0]?.text).toBe(WAIT_PHRASE);
    expect(screen.getByLabelText("Voice capture status").textContent).toMatch(
      /listening|speaking/,
    );
    expect(recognition?.stopped).toBe(false);
    expect(toggle.getAttribute("data-mode")).toBe("always-on");
  });

  it("keeps Live capture open across assistant playback and submits a second spoken turn", async () => {
    render(<AssistantVoiceHarness />);

    fireEvent.click(screen.getByTestId("shell-home-pill"));
    const toggle = screen.getByTestId("assistant-continuous-toggle");
    const liveButton = toggle.querySelector(
      "button[data-mode='always-on']",
    ) as HTMLButtonElement;

    await act(async () => {
      fireEvent.click(liveButton);
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Voice capture status").textContent).toBe(
        "listening",
      );
    });
    const recognition = FakeSpeechRecognition.instances[0];
    expect(recognition?.started).toBe(true);
    expect(recognition?.continuous).toBe(true);

    act(() => {
      recognition?.emitResult("create a remote ledger", false);
    });
    expect(screen.getByLabelText("Voice transcript preview").textContent).toBe(
      "create a remote ledger",
    );

    act(() => {
      recognition?.emitResult("create a remote ledger view while live", true);
    });

    await waitFor(() => {
      expect(
        screen.getByText("create a remote ledger view while live"),
      ).toBeTruthy();
      expect(screen.getByText(WAIT_PHRASE)).toBeTruthy();
      expect(speechSynthesisMock.speak).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByLabelText("Voice transcript preview")).toBeNull();
    expect(recognition?.stopped).toBe(false);

    act(() => {
      speechSynthesisMock.spoken[0]?.onend?.();
      recognition?.emitResult("now create the local notes view", true);
    });

    await waitFor(() => {
      expect(screen.getByText("now create the local notes view")).toBeTruthy();
      expect(speechSynthesisMock.speak).toHaveBeenCalledTimes(2);
    });
    expect(speechSynthesisMock.spoken[1]?.text).toBe(WAIT_PHRASE);
    expect(screen.getAllByText(WAIT_PHRASE).length).toBe(2);
    expect(screen.getByLabelText("Voice capture status").textContent).toMatch(
      /listening|speaking/,
    );
    expect(recognition?.stopped).toBe(false);
    expect(toggle.getAttribute("data-mode")).toBe("always-on");
  });
});
