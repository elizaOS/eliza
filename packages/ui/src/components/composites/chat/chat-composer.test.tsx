// @vitest-environment jsdom
/**
 * Renders ChatComposer in jsdom (real component, mocked voice state) to cover
 * its input/send/mic wiring and ref forwarding without a live voice pipeline.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

  it("sends on Enter and inserts a newline on Shift+Enter (composer-core keydown)", () => {
    const onSend = vi.fn();
    renderInlineComposer({ onSend });
    const textarea = screen.getByTestId("chat-composer-textarea");

    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("never sends on the Enter that commits an IME composition (#9148)", () => {
    const onSend = vi.fn();
    renderInlineComposer({ onSend });
    const textarea = screen.getByTestId("chat-composer-textarea");

    fireEvent.keyDown(textarea, { key: "Enter", isComposing: true });
    fireEvent.keyDown(textarea, { key: "Enter", keyCode: 229 });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("routes a pasted image into the attachment intake instead of the textarea", () => {
    const addFiles = vi.fn();
    const attachText = vi.fn();
    renderInlineComposer({ pasteAttachments: { addFiles, attachText } });
    const file = new File(["png-bytes"], "shot.png", { type: "image/png" });

    fireEvent.paste(screen.getByTestId("chat-composer-textarea"), {
      clipboardData: { files: [file], getData: () => "" },
    });
    expect(addFiles).toHaveBeenCalledWith([file]);
    expect(attachText).not.toHaveBeenCalled();
  });

  it("attaches an oversized text paste as a text-attachment chip", () => {
    const addFiles = vi.fn();
    const attachText = vi.fn();
    renderInlineComposer({ pasteAttachments: { addFiles, attachText } });

    fireEvent.paste(screen.getByTestId("chat-composer-textarea"), {
      clipboardData: {
        files: [],
        getData: (type: string) => (type === "text" ? "x".repeat(5000) : ""),
      },
    });
    expect(addFiles).not.toHaveBeenCalled();
    expect(attachText).toHaveBeenCalledTimes(1);
  });
});
