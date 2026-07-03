// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { type ComponentProps, createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatComposer, type ChatComposerVoiceState } from "./chat-composer";

afterEach(cleanup);

const voice: ChatComposerVoiceState = {
  captureMode: "idle",
  interimTranscript: "",
  isListening: false,
  isSpeaking: false,
  startListening: vi.fn(),
  stopListening: vi.fn(),
  supported: false,
  toggleListening: vi.fn(),
};

function renderInlineComposer(
  overrides: Partial<ComponentProps<typeof ChatComposer>> = {},
) {
  const props: ComponentProps<typeof ChatComposer> = {
    agentVoiceEnabled: false,
    chatInput: "",
    chatPendingImagesCount: 0,
    chatSending: false,
    hideAttachButton: true,
    isAgentStarting: false,
    isComposerLocked: false,
    layout: "inline",
    onAttachImage: vi.fn(),
    onChatInputChange: vi.fn(),
    onKeyDown: vi.fn(),
    onSend: vi.fn(),
    onStop: vi.fn(),
    onStopSpeaking: vi.fn(),
    onToggleAgentVoice: vi.fn(),
    placeholder: "Message",
    t: (key) => key,
    textareaRef: createRef<HTMLTextAreaElement>(),
    variant: "default",
    voice,
    ...overrides,
  };
  return render(<ChatComposer {...props} />);
}

describe("ChatComposer", () => {
  it("keeps the inline composer visible on the dark chat surface", () => {
    renderInlineComposer();

    const composer = screen
      .getByTestId("chat-composer-textarea")
      .closest('[data-chat-composer="true"]');

    expect(composer?.className).toContain("border-[color-mix(");
    expect(composer?.className).toContain("bg-[color-mix(");
    expect(composer?.className).not.toContain("ring-");
    expect(composer?.className).not.toContain("border-border/35");
    expect(composer?.className).not.toContain("bg-card/45");
  });

  it("uses a readable placeholder in the inline textarea", () => {
    renderInlineComposer();

    expect(screen.getByTestId("chat-composer-textarea").className).toContain(
      "placeholder:text-muted-strong",
    );
  });

  it("keeps push-to-talk release available after transcript text fills the draft", () => {
    renderInlineComposer({
      chatInput: "push to talk works",
      voice: {
        ...voice,
        captureMode: "push-to-talk",
        interimTranscript: "push to talk works",
        isListening: true,
        supported: true,
      },
    });

    expect(
      screen.getByRole("button", { name: "chat.releaseToSend" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "common.send" })).toBeNull();
  });
});
