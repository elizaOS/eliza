// @vitest-environment jsdom

// Behavioural coverage for the ChatComposer's core authoring loop: typing,
// send-gating, keyboard submit, rapid-fire idempotency, attachment add/remove,
// and the large-paste -> attachment intake. The existing chat-composer.test.tsx
// covers inline styling + push-to-talk, and chat-composer.stop.test.tsx covers
// the stop affordance + real abort wiring — none of them exercise the everyday
// compose/send/attach path, so this file fills that gap.
//
// The composer is presentational: it forwards onChange/onKeyDown/onPaste/onSend
// to the host and owns the send-enable gate (hasDraft) + the textarea round-trip.
// The harness below reproduces ChatView's *real* wiring — the same 4-line
// handleKeyDown, the same classifyComposerPaste-driven paste intake, and the
// real ChatAttachmentStrip — so these assertions exercise the true seam a user
// hits, not a stand-in. Only the host state is local; the unit under test
// (ChatComposer) is the real component.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  type ClipboardEvent,
  type KeyboardEvent,
  useRef,
  useState,
} from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImageAttachment } from "../../../api";
import {
  LARGE_PASTE_CHAR_THRESHOLD,
  MAX_CHAT_IMAGES,
  classifyComposerPaste,
} from "../../../utils/image-attachment";
import { ChatAttachmentStrip } from "./chat-attachment-strip";
import { ChatComposer, type ChatComposerVoiceState } from "./chat-composer";
import type { ChatAttachmentItem } from "./chat-types";

afterEach(cleanup);

const idleVoice: ChatComposerVoiceState = {
  captureMode: "idle",
  interimTranscript: "",
  isListening: false,
  isSpeaking: false,
  startListening: vi.fn(),
  stopListening: vi.fn(),
  supported: false,
  toggleListening: vi.fn(),
};

type SendPayload = { text: string; attachmentCount: number };

function ComposerHarness({
  onSend,
  onInputChange,
  locked = false,
}: {
  onSend?: (payload: SendPayload) => void;
  onInputChange?: (value: string) => void;
  locked?: boolean;
}) {
  const [chatInput, setChatInput] = useState("");
  const [pending, setPending] = useState<ImageAttachment[]>([]);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  // Mirrors ChatView.handleChatSend's guard: an empty draft (no text, no
  // attachments) is a no-op; a successful send emits and clears the composer.
  const handleChatSend = () => {
    if (locked) return;
    if (!chatInput.trim() && pending.length === 0) return;
    onSend?.({ text: chatInput, attachmentCount: pending.length });
    setChatInput("");
    setPending([]);
  };

  // Verbatim from ChatView.handleKeyDown.
  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (locked) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleChatSend();
    }
  };

  // Verbatim intent from ChatView.handleComposerPaste (real classifier).
  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const intent = classifyComposerPaste({
      files: Array.from(e.clipboardData?.files ?? []),
      text: e.clipboardData?.getData("text") ?? "",
    });
    if (intent.kind === "text-attachment") {
      e.preventDefault();
      setPending((prev) =>
        [...prev, intent.attachment].slice(0, MAX_CHAT_IMAGES),
      );
    } else if (intent.kind === "files") {
      e.preventDefault();
      setPending((prev) =>
        [
          ...prev,
          ...intent.files.map((f) => ({
            data: "",
            mimeType: f.type,
            name: f.name,
          })),
        ].slice(0, MAX_CHAT_IMAGES),
      );
    }
  };

  const stripItems: ChatAttachmentItem[] = pending.map((att, i) => ({
    id: `att-${i}`,
    alt: att.name,
    name: att.name,
    src: "",
    kind: att.mimeType.startsWith("image/") ? "image" : "document",
  }));

  return (
    <>
      <ChatAttachmentStrip
        items={stripItems}
        onRemove={(_id, index) =>
          setPending((prev) => prev.filter((_, i) => i !== index))
        }
      />
      <ChatComposer
        variant="default"
        layout="default"
        textareaRef={ref}
        chatInput={chatInput}
        chatPendingImagesCount={pending.length}
        isComposerLocked={locked}
        isAgentStarting={false}
        chatSending={false}
        voice={idleVoice}
        agentVoiceEnabled={false}
        showAgentVoiceToggle={false}
        t={(key) => key}
        onAttachImage={() =>
          setPending((prev) =>
            [
              ...prev,
              {
                data: "",
                mimeType: "image/png",
                name: `image-${prev.length}.png`,
              },
            ].slice(0, MAX_CHAT_IMAGES),
          )
        }
        onChatInputChange={(value) => {
          onInputChange?.(value);
          setChatInput(value);
        }}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onSend={handleChatSend}
        onStop={() => {}}
        onStopSpeaking={() => {}}
        onToggleAgentVoice={() => {}}
      />
    </>
  );
}

function getTextarea(): HTMLTextAreaElement {
  return screen.getByTestId("chat-composer-textarea") as HTMLTextAreaElement;
}

function getSendButton(): HTMLButtonElement {
  return screen.getByTestId("chat-composer-action") as HTMLButtonElement;
}

function getAttachButton(): HTMLButtonElement {
  return screen.getByRole("button", {
    name: "aria.attachImage",
  }) as HTMLButtonElement;
}

describe("ChatComposer — compose & send", () => {
  it("streams each keystroke to onChatInputChange with the accumulated value and round-trips into the textarea", async () => {
    const user = userEvent.setup();
    const onInputChange = vi.fn();
    render(<ComposerHarness onInputChange={onInputChange} />);

    await user.type(getTextarea(), "hi");

    // The composer emits the full textarea value on every change (not a diff),
    // so the callback sees the growing string keystroke-by-keystroke.
    expect(onInputChange.mock.calls.map((c) => c[0])).toEqual(["h", "hi"]);
    // Controlled round-trip: the rendered value reflects the committed state.
    expect(getTextarea().value).toBe("hi");
  });

  it("disables send for empty and whitespace-only drafts and enables it once real text is present", async () => {
    const user = userEvent.setup();
    render(<ComposerHarness />);

    // Empty draft: nothing to send.
    expect(getSendButton().disabled).toBe(true);

    // Whitespace only is not a draft — trim() collapses it to empty.
    await user.type(getTextarea(), "   ");
    expect(getTextarea().value).toBe("   ");
    expect(getSendButton().disabled).toBe(true);

    // A real character flips the gate open.
    await user.type(getTextarea(), "x");
    expect(getSendButton().disabled).toBe(false);
  });

  it("emits the exact draft payload on send and then clears + re-disables the composer", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<ComposerHarness onSend={onSend} />);

    await user.type(getTextarea(), "hello world");
    await user.click(getSendButton());

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith({
      text: "hello world",
      attachmentCount: 0,
    });
    // Post-send the composer is empty again and the gate has re-closed.
    expect(getTextarea().value).toBe("");
    expect(getSendButton().disabled).toBe(true);
  });

  // NOTE: ChatComposer is presentational — it only forwards the raw keydown to
  // the `onKeyDown` prop and owns NO Enter/Shift+Enter routing. This test drives
  // the composer wired with a keydown handler that MIRRORS ChatView.handleKeyDown
  // (see the harness). It verifies that wiring end-to-end (composer forwards →
  // handler submits on Enter / newlines on Shift+Enter → onSend + clear), NOT
  // ChatView's own handler, which is verbatim-copied here. The authoritative
  // Enter/Shift+Enter routing + preventDefault is exercised on a real component
  // in ChatSurface.test.tsx ("sends on Enter … and swallows the keystroke").
  it("submits on Enter / newlines on Shift+Enter when wired with a ChatView-style keydown handler", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<ComposerHarness onSend={onSend} />);

    const textarea = getTextarea();

    // Plain Enter submits and clears.
    await user.type(textarea, "first");
    await user.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenLastCalledWith({ text: "first", attachmentCount: 0 });
    expect(textarea.value).toBe("");

    // Shift+Enter is a newline, not a submit — the draft grows across lines.
    await user.type(textarea, "line1{Shift>}{Enter}{/Shift}line2");
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(textarea.value).toBe("line1\nline2");

    // A final plain Enter ships the multi-line draft intact.
    await user.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(onSend).toHaveBeenLastCalledWith({
      text: "line1\nline2",
      attachmentCount: 0,
    });
  });

  it("does not double-send when the send button is clicked twice rapidly", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<ComposerHarness onSend={onSend} />);

    await user.type(getTextarea(), "once");
    const button = getSendButton();
    expect(button.disabled).toBe(false);

    // First click sends and empties the composer; the hasDraft gate then
    // disables the button, so the immediate second click is inert.
    await user.click(button);
    expect(getSendButton().disabled).toBe(true);
    await user.click(getSendButton());

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith({ text: "once", attachmentCount: 0 });
  });
});

describe("ChatComposer — attachments", () => {
  it("adds an attachment via the attach button, which enables send on an empty draft and marks the button active", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<ComposerHarness onSend={onSend} />);

    // Empty + no attachments: send is closed and the attach button is neutral.
    expect(getSendButton().disabled).toBe(true);
    expect(getAttachButton().className).not.toContain("text-accent");
    expect(screen.queryByRole("button", { name: "Remove image-0.png" })).toBeNull();

    await user.click(getAttachButton());

    // A pending attachment is a draft even with empty text.
    expect(getSendButton().disabled).toBe(false);
    expect(getAttachButton().className).toContain("text-accent");
    expect(
      screen.getByRole("button", { name: "Remove image-0.png" }),
    ).toBeTruthy();

    await user.click(getSendButton());
    expect(onSend).toHaveBeenCalledWith({ text: "", attachmentCount: 1 });
    // Sending clears the pending attachment strip too.
    expect(getSendButton().disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Remove image-0.png" })).toBeNull();
  });

  it("removing the only attachment re-closes the send gate on an empty draft", async () => {
    const user = userEvent.setup();
    render(<ComposerHarness />);

    await user.click(getAttachButton());
    expect(getSendButton().disabled).toBe(false);

    await user.click(screen.getByRole("button", { name: "Remove image-0.png" }));

    expect(getSendButton().disabled).toBe(true);
    expect(getAttachButton().className).not.toContain("text-accent");
    expect(screen.queryByRole("button", { name: "Remove image-0.png" })).toBeNull();
  });

  it("converts a huge plain-text paste into a collapsed attachment instead of flooding the textarea", () => {
    render(<ComposerHarness />);
    const textarea = getTextarea();

    const bigText = `${"word ".repeat(LARGE_PASTE_CHAR_THRESHOLD)}end`;
    fireEvent.paste(textarea, {
      clipboardData: {
        files: [],
        getData: (type: string) => (type === "text" ? bigText : ""),
      },
    });

    // The paste was intercepted: the textarea stays empty, and the text landed
    // as a single "pasted-text.md" attachment chip.
    expect(textarea.value).toBe("");
    expect(screen.getByText("pasted-text.md")).toBeTruthy();
    expect(getSendButton().disabled).toBe(false);
  });

  it("lets a short paste pass through without creating an attachment", () => {
    render(<ComposerHarness />);
    const textarea = getTextarea();

    fireEvent.paste(textarea, {
      clipboardData: {
        files: [],
        getData: (type: string) => (type === "text" ? "just a bit" : ""),
      },
    });

    // Below the threshold nothing is intercepted — no attachment chip appears.
    expect(screen.queryByText("pasted-text.md")).toBeNull();
    expect(getSendButton().disabled).toBe(true);
  });
});
