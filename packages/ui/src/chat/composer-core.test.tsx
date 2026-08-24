/** Verifies useComposerKeydown through the package's configured test harness. */
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

function HistoryKeydownHarness({
  onSend,
  slash,
  onHistory,
}: {
  onSend: () => void;
  slash?: ComposerSlashKeydown;
  onHistory?: (direction: -1 | 1) => boolean;
}) {
  const handleKeyDown = useComposerKeydown<HTMLTextAreaElement>({
    onSend,
    slash,
    onHistory,
  });
  return <textarea data-testid="input" onKeyDown={handleKeyDown} />;
}

function NestedKeydownHarness({
  onSend,
  slash,
  onOuterKeyDown,
}: {
  onSend: () => void;
  slash?: ComposerSlashKeydown;
  onOuterKeyDown: () => void;
}) {
  const handleKeyDown = useComposerKeydown<HTMLTextAreaElement>({
    onSend,
    slash,
  });
  return (
    <div>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: harness observes
          React synthetic propagation, not real DOM interactivity */}
      <div data-testid="outer" onKeyDown={onOuterKeyDown}>
        <textarea data-testid="input" onKeyDown={handleKeyDown} />
      </div>
    </div>
  );
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

  it("sent-history consumes physical ArrowUp/ArrowDown and preventDefaults them", () => {
    const onSend = vi.fn();
    const onHistory = vi.fn((_direction: -1 | 1) => true);
    render(<HistoryKeydownHarness onSend={onSend} onHistory={onHistory} />);
    const input = screen.getByTestId("input");
    const up = new KeyboardEvent("keydown", {
      key: "ArrowUp",
      bubbles: true,
      cancelable: true,
    });
    fireEvent(input, up);
    const down = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
    });
    fireEvent(input, down);
    expect(onHistory.mock.calls.map((call) => call[0])).toEqual([-1, 1]);
    expect(up.defaultPrevented).toBe(true);
    expect(down.defaultPrevented).toBe(true);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("sent-history receives the raw event and may decline the arrow", () => {
    const onSend = vi.fn();
    const onHistory = vi.fn(() => false);
    render(<HistoryKeydownHarness onSend={onSend} onHistory={onHistory} />);
    const input = screen.getByTestId("input");
    const up = new KeyboardEvent("keydown", {
      key: "ArrowUp",
      bubbles: true,
      cancelable: true,
    });
    fireEvent(input, up);
    expect(onHistory).toHaveBeenCalledTimes(1);
    expect(onHistory).toHaveBeenCalledWith(-1, expect.anything());
    expect(up.defaultPrevented).toBe(false);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("an open slash menu outranks sent-history for the arrows", () => {
    const onSend = vi.fn();
    const slash = makeSlash();
    const onHistory = vi.fn(() => true);
    render(
      <HistoryKeydownHarness
        onSend={onSend}
        slash={slash}
        onHistory={onHistory}
      />,
    );
    fireEvent.keyDown(screen.getByTestId("input"), { key: "ArrowDown" });
    expect(slash.move).toHaveBeenCalledWith(1);
    expect(onHistory).not.toHaveBeenCalled();
  });

  it("an uncompleted Tab (no active item) falls through to the browser focus move", () => {
    const onSend = vi.fn();
    const slash = makeSlash({ complete: vi.fn(() => false) });
    render(<KeydownHarness onSend={onSend} slash={slash} />);
    const input = screen.getByTestId("input");
    const tab = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    fireEvent(input, tab);
    expect(slash.complete).toHaveBeenCalledTimes(1);
    expect(tab.defaultPrevented).toBe(false);
    expect(slash.submit).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("a declined surface Escape stays with the browser", () => {
    const onSend = vi.fn();
    const onEscape = vi.fn(() => false);
    render(
      <KeydownHarness
        onSend={onSend}
        onEscape={onEscape}
        slash={makeSlash({ open: false })}
      />,
    );
    const input = screen.getByTestId("input");
    const esc = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    fireEvent(input, esc);
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(esc.defaultPrevented).toBe(false);
  });

  it("reads fresh option closures every render (stale callbacks never fire)", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<KeydownHarness onSend={first} />);
    rerender(<KeydownHarness onSend={second} />);
    fireEvent.keyDown(screen.getByTestId("input"), { key: "Enter" });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("the slash-menu Escape stops propagation so outer handlers stay cold", () => {
    const onSend = vi.fn();
    const slash = makeSlash();
    const outer = vi.fn();
    render(
      <NestedKeydownHarness
        onSend={onSend}
        slash={slash}
        onOuterKeyDown={outer}
      />,
    );
    const input = screen.getByTestId("input");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(slash.dismiss).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "a" });
    expect(outer).toHaveBeenCalledTimes(1);
  });

  it("legacy-engine arrows (keyCode 229) still drive an open slash menu", () => {
    const onSend = vi.fn();
    const slash = makeSlash();
    render(<KeydownHarness onSend={onSend} slash={slash} />);
    fireEvent.keyDown(screen.getByTestId("input"), {
      key: "ArrowDown",
      keyCode: 229,
    });
    expect(slash.move).toHaveBeenCalledWith(1);
    expect(onSend).not.toHaveBeenCalled();
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

function PasteProbeHarness({ options }: { options?: ComposerPasteOptions }) {
  const handlePaste = useComposerPaste<HTMLTextAreaElement>(options);
  return (
    <textarea
      data-testid="input"
      data-paste-handler={handlePaste ? "attached" : "none"}
      onPaste={handlePaste}
    />
  );
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

  it("gives surfaces without outbound attachments no paste handler at all", () => {
    render(<PasteProbeHarness />);
    const input = screen.getByTestId("input");
    expect(input.dataset.pasteHandler).toBe("none");
    expect(() =>
      fireEvent.paste(input, pasteEvent([], "irrelevant")),
    ).not.toThrow();
  });

  it("falls through safely when the paste carries no clipboardData", () => {
    const addFiles = vi.fn();
    const attachText = vi.fn();
    render(<PasteHarness options={{ addFiles, attachText }} />);
    fireEvent.paste(screen.getByTestId("input"), {});
    expect(addFiles).not.toHaveBeenCalled();
    expect(attachText).not.toHaveBeenCalled();
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
            chatReplyTarget: null,
            setChatInput,
            setChatPendingImages,
            setChatReplyTarget: () => {},
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
