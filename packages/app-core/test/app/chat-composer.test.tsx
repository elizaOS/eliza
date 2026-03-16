// @vitest-environment jsdom

import React, { createRef } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatComposer } from "../../src/components/ChatComposer";

function createVoiceState(
  overrides?: Partial<React.ComponentProps<typeof ChatComposer>["voice"]>,
) {
  return {
    supported: true,
    isListening: false,
    captureMode: "idle" as const,
    interimTranscript: "",
    isSpeaking: false,
    toggleListening: vi.fn(),
    startListening: vi.fn(),
    stopListening: vi.fn(),
    ...overrides,
  };
}

function renderComposer(
  overrides?: Partial<React.ComponentProps<typeof ChatComposer>>,
) {
  const voice = createVoiceState(overrides?.voice);
  const { voice: _voiceOverride, ...restOverrides } = overrides ?? {};
  const props: React.ComponentProps<typeof ChatComposer> = {
    variant: "default",
    textareaRef: createRef<HTMLTextAreaElement>(),
    chatInput: "",
    chatPendingImagesCount: 0,
    isComposerLocked: false,
    isAgentStarting: false,
    chatSending: false,
    agentVoiceEnabled: true,
    t: (key) => key,
    onAttachImage: vi.fn(),
    onChatInputChange: vi.fn(),
    onKeyDown: vi.fn(),
    onSend: vi.fn(),
    onStop: vi.fn(),
    onStopSpeaking: vi.fn(),
    onToggleAgentVoice: vi.fn(),
    ...restOverrides,
    voice,
  };

  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(React.createElement(ChatComposer, props));
  });
  const buttons = renderer.root.findAllByType("button" as React.ElementType);
  const micButton = buttons.find(
    (button) =>
      typeof button.props.onPointerDown === "function" &&
      typeof button.props.onPointerUp === "function",
  );
  const speakerButton = buttons.find(
    (button) => button.props["aria-label"] === "Agent voice on",
  );

  if (!micButton) {
    throw new Error("Expected mic button to be present");
  }

  return { renderer, props, voice, micButton, speakerButton };
}

function findTextarea(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findByProps({
    "data-testid": "chat-composer-textarea",
  });
}

describe("ChatComposer mic controls", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts compose dictation on a quick click", async () => {
    const { voice, micButton } = renderComposer();

    await act(async () => {
      micButton.props.onClick();
    });

    expect(voice.startListening).toHaveBeenCalledWith("compose");
  });

  it("starts push-to-talk on hold and sends on release", async () => {
    vi.useFakeTimers();
    const { voice, micButton } = renderComposer();

    await act(async () => {
      micButton.props.onPointerDown({});
      vi.advanceTimersByTime(200);
    });

    expect(voice.startListening).toHaveBeenCalledWith("push-to-talk");

    await act(async () => {
      micButton.props.onPointerUp();
      vi.runAllTimers();
    });

    expect(voice.stopListening).toHaveBeenCalledWith({ submit: true });
  });

  it("toggles agent voice from the speaker button", async () => {
    const { props, speakerButton } = renderComposer();
    if (!speakerButton) {
      throw new Error("Expected speaker button to be present");
    }

    await act(async () => {
      speakerButton.props.onClick();
    });

    expect(props.onToggleAgentVoice).toHaveBeenCalledOnce();
  });

  it("can hide the agent voice toggle for desktop chat", () => {
    const { speakerButton } = renderComposer({
      showAgentVoiceToggle: false,
    });

    expect(speakerButton).toBeUndefined();
  });

  it("renders the default mic button like the paperclip button when idle", () => {
    const { micButton } = renderComposer();
    const icon = micButton.findByType("svg" as React.ElementType);

    expect(String(micButton.props.className)).not.toContain("border");
    expect(String(micButton.props.className)).toContain("text-muted");
    expect(String(micButton.props.className)).toContain("hover:bg-black/5");
    expect(String(icon.props.className)).toContain("w-4 h-4");
  });

  it("turns the default mic button solid red when active", () => {
    const { micButton } = renderComposer({
      voice: {
        isListening: true,
      },
    });

    expect(String(micButton.props.className)).toContain("bg-[#ff6b70]");
    expect(String(micButton.props.className)).toContain("text-white");
    expect(String(micButton.props.className)).not.toContain("shadow-[0_0_");
  });

  it("keeps the default chat input neutral while listening", () => {
    const { renderer } = renderComposer({
      voice: {
        isListening: true,
      },
    });
    const textarea = findTextarea(renderer);
    const container = textarea.parent;

    expect(String(container.props.className)).toContain("border-border/40");
    expect(String(container.props.className)).toContain("bg-card/60");
    expect(String(container.props.className)).not.toContain("border-[#ff5a5f]");
    expect(String(container.props.className)).not.toContain("bg-[#2a0f13]");
  });

  it("shows Listening... in an empty default chat input while listening", () => {
    const { renderer } = renderComposer({
      chatInput: "",
      voice: {
        isListening: true,
        captureMode: "compose",
      },
    });
    const textarea = findTextarea(renderer);

    expect(textarea.props.placeholder).toBe("Listening...");
  });
});
