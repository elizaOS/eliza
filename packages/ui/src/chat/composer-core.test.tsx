// @vitest-environment jsdom
/**
 * Contract tests for the shared composer core (keydown + paste) — the one
 * keyboard/clipboard implementation behind the overlay, ChatComposer, and
 * ChatSurface composers. jsdom + real DOM events; no mocks of the unit under
 * test.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImageAttachment } from "../api";
import { useChatComposerOrLocal } from "../state/ChatComposerContext.hooks";
import {
  type ComposerPasteOptions,
  type ComposerSlashKeydown,
  useComposerKeydown,
  useComposerPaste,
} from "./composer-core";

afterEach(cleanup);

function KeydownHarness({
  onSend,
  slash,
  onEscape,
  locked,
}: {
  onSend: () => void;
  slash?: ComposerSlashKeydown;
  onEscape?: () => boolean;
  locked?: boolean;
}) {
  const handleKeyDown = useComposerKeydown<HTMLTextAreaElement>({
    onSend,
    slash,
    onEscape,
    locked,
  });
  return <textarea data-testid="input" onKeyDown={handleKeyDown} />;
}

function makeSlash(
  overrides: Partial<ComposerSlashKeydown> = {},
): ComposerSlashKeydown {
  return {
    open: true,
    move: vi.fn(),
    complete: vi.fn(() => true),
    submit: vi.fn(() => true),
    dismiss: vi.fn(),
    ...overrides,
  };
}

describe("useComposerKeydown", () => {
  it("Enter sends; Shift+Enter falls through as a newline", () => {
    const onSend = vi.fn();
    render(<KeydownHarness onSend={onSend} />);
    const input = screen.getByTestId("input");
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("never sends on the Enter that commits an IME composition (#9148)", () => {
    const onSend = vi.fn();
    render(<KeydownHarness onSend={onSend} />);
    const input = screen.getByTestId("input");
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("an IME-commit Enter never runs a slash command either", () => {
    const onSend = vi.fn();
    const slash = makeSlash();
    render(<KeydownHarness onSend={onSend} slash={slash} />);
    fireEvent.keyDown(screen.getByTestId("input"), {
      key: "Enter",
      isComposing: true,
    });
    expect(slash.submit).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("ignores every key while locked", () => {
    const onSend = vi.fn();
    const onEscape = vi.fn(() => true);
    render(<KeydownHarness onSend={onSend} onEscape={onEscape} locked />);
    const input = screen.getByTestId("input");
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onSend).not.toHaveBeenCalled();
    expect(onEscape).not.toHaveBeenCalled();
  });

  it("routes arrows/Tab/Enter/Escape into an open slash menu", () => {
    const onSend = vi.fn();
    const slash = makeSlash();
    render(<KeydownHarness onSend={onSend} slash={slash} />);
    const input = screen.getByTestId("input");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(slash.move).toHaveBeenLastCalledWith(1);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(slash.move).toHaveBeenLastCalledWith(-1);
    fireEvent.keyDown(input, { key: "Tab" });
    expect(slash.complete).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(slash.submit).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(slash.dismiss).toHaveBeenCalledTimes(1);
  });

  it("Enter falls through to send when the open slash menu does not handle it", () => {
    const onSend = vi.fn();
    const slash = makeSlash({ submit: vi.fn(() => false) });
    render(<KeydownHarness onSend={onSend} slash={slash} />);
    fireEvent.keyDown(screen.getByTestId("input"), { key: "Enter" });
    expect(slash.submit).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("a closed slash menu intercepts nothing", () => {
    const onSend = vi.fn();
    const slash = makeSlash({ open: false });
    render(<KeydownHarness onSend={onSend} slash={slash} />);
    fireEvent.keyDown(screen.getByTestId("input"), { key: "Enter" });
    expect(slash.submit).not.toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("Escape reaches the surface hook only with no slash menu open", () => {
    const onEscape = vi.fn(() => true);
    const slash = makeSlash();
    const { rerender } = render(
      <KeydownHarness onSend={vi.fn()} slash={slash} onEscape={onEscape} />,
    );
    const input = screen.getByTestId("input");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(slash.dismiss).toHaveBeenCalledTimes(1);
    expect(onEscape).not.toHaveBeenCalled();
    rerender(
      <KeydownHarness
        onSend={vi.fn()}
        slash={makeSlash({ open: false })}
        onEscape={onEscape}
      />,
    );
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onEscape).toHaveBeenCalledTimes(1);
  });
});

function PasteHarness({ options }: { options?: ComposerPasteOptions }) {
  const handlePaste = useComposerPaste<HTMLTextAreaElement>(options);
  return <textarea data-testid="input" onPaste={handlePaste} />;
}

function pasteEvent(files: File[], text: string) {
  return {
    clipboardData: {
      files,
      getData: (type: string) => (type === "text" ? text : ""),
    },
  };
}

describe("useComposerPaste", () => {
  it("routes pasted files into the attachment pipeline", () => {
    const addFiles = vi.fn();
    const attachText = vi.fn();
    render(<PasteHarness options={{ addFiles, attachText }} />);
    const file = new File(["png-bytes"], "shot.png", { type: "image/png" });
    fireEvent.paste(screen.getByTestId("input"), pasteEvent([file], ""));
    expect(addFiles).toHaveBeenCalledWith([file]);
    expect(attachText).not.toHaveBeenCalled();
  });

  it("attaches an oversized text paste as a text-attachment chip", () => {
    const addFiles = vi.fn();
    const attachText = vi.fn();
    render(<PasteHarness options={{ addFiles, attachText }} />);
    fireEvent.paste(
      screen.getByTestId("input"),
      pasteEvent([], "x".repeat(20_000)),
    );
    expect(addFiles).not.toHaveBeenCalled();
    expect(attachText).toHaveBeenCalledTimes(1);
    const attachment = attachText.mock.calls[0][0] as ImageAttachment;
    expect(attachment.mimeType).toBe("text/markdown");
  });

  it("lets small text fall through to the input as a normal paste", () => {
    const addFiles = vi.fn();
    const attachText = vi.fn();
    render(<PasteHarness options={{ addFiles, attachText }} />);
    fireEvent.paste(screen.getByTestId("input"), pasteEvent([], "hello"));
    expect(addFiles).not.toHaveBeenCalled();
    expect(attachText).not.toHaveBeenCalled();
  });

  it("returns no handler on surfaces without outbound attachments", () => {
    render(<PasteHarness />);
    fireEvent.paste(screen.getByTestId("input"), pasteEvent([], "hello"));
  });
});

function DraftHarness() {
  const { chatInput, setChatInput } = useChatComposerOrLocal();
  return (
    <input
      data-testid="draft"
      value={chatInput}
      onChange={(e) => setChatInput(e.target.value)}
    />
  );
}

describe("useChatComposerOrLocal", () => {
  it("falls back to live local state without a provider (typing works)", () => {
    render(<DraftHarness />);
    const input = screen.getByTestId("draft") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "typed" } });
    expect(input.value).toBe("typed");
  });

  it("binds the shared context slot when a provider is mounted", async () => {
    const { ChatComposerCtx } = await import(
      "../state/ChatComposerContext.hooks"
    );
    function Provider({ children }: { children: React.ReactNode }) {
      const [chatInput, setChatInput] = useState("from-context");
      const [chatPendingImages, setChatPendingImages] = useState<
        ImageAttachment[]
      >([]);
      return (
        <ChatComposerCtx.Provider
          value={{
            chatInput,
            chatSending: false,
            chatPendingImages,
            setChatInput,
            setChatPendingImages,
          }}
        >
          {children}
        </ChatComposerCtx.Provider>
      );
    }
    render(
      <Provider>
        <DraftHarness />
      </Provider>,
    );
    const input = screen.getByTestId("draft") as HTMLInputElement;
    expect(input.value).toBe("from-context");
    fireEvent.change(input, { target: { value: "shared" } });
    expect(input.value).toBe("shared");
  });
});
