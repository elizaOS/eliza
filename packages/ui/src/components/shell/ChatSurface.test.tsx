/**
 * Exercises shell transcript, composer and capability controls in jsdom.
 * Real components share the app fixture; only mic-hold timing uses fake timers.
 */
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { type ReactNode, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImageAttachment } from "../../api/client-types-chat";
import { PUSH_TO_TALK_HOLD_MS } from "../../gestures";
import { __setAppValueForTests } from "../../state/app-store";
import { ChatComposerCtx } from "../../state/ChatComposerContext.hooks";
import { MockAppProvider } from "../../storybook/mock-providers";
import { ChatSurface } from "./ChatSurface";
import type { ShellMessage } from "./shell-state";

// jsdom has no Pointer Capture; stub it so the hold machine's capture calls
// are no-ops that still report "not captured" for the release path.
beforeEach(() => {
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
});

afterEach(() => {
  cleanup();
  __setAppValueForTests(null);
});

function surface(overrides: Partial<Parameters<typeof ChatSurface>[0]> = {}) {
  return (
    <MockAppProvider>
      <ChatSurface messages={[]} onSend={vi.fn()} canSend {...overrides} />
    </MockAppProvider>
  );
}

function composerInput(): HTMLInputElement {
  return screen.getByRole("textbox") as HTMLInputElement;
}

describe("ChatSurface composer (shared core)", () => {
  it.each(["Enter", "click"])(
    "sends the trimmed draft by %s and clears the input",
    (method) => {
      const onSend = vi.fn();
      render(surface({ onSend }));
      const input = composerInput();
      fireEvent.change(input, { target: { value: "  hello there  " } });
      if (method === "Enter") fireEvent.keyDown(input, { key: "Enter" });
      else
        fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      expect(onSend).toHaveBeenCalledWith("hello there");
      expect(input.value).toBe("");
    },
  );

  it("renders user form submissions as a compact summary without protocol values", () => {
    const raw =
      '[form:submit reminder] {"title":"Quarterly report","time":"5pm"}';
    const { container } = render(
      surface({
        messages: [{ id: "u1", role: "user", content: raw, createdAt: 1 }],
      }),
    );
    expect(screen.getByTestId("form-submit-receipt").textContent).toBe(
      "Submitted reminder",
    );
    expect(container.textContent ?? "").not.toContain("[form:submit");
    expect(container.textContent ?? "").not.toContain("Quarterly report");
    expect(container.textContent ?? "").not.toContain("5pm");
  });

  it("never sends on the Enter that commits an IME composition (#9148)", () => {
    const onSend = vi.fn();
    render(surface({ onSend }));
    const input = composerInput();
    fireEvent.change(input, { target: { value: "こんにちは" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(onSend).not.toHaveBeenCalled();
    expect(input.value).toBe("こんにちは");
  });

  it("does not send while canSend is false or the draft is empty", () => {
    const onSend = vi.fn();
    const { rerender } = render(surface({ onSend, canSend: false }));
    const input = composerInput();
    expect(input.disabled).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Send message" })
        .disabled,
    ).toBe(true);
    fireEvent.change(input, { target: { value: "queued" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    rerender(surface({ onSend, canSend: true }));
    expect(input.disabled).toBe(false);
    fireEvent.change(input, { target: { value: "   " } });
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Send message" })
        .disabled,
    ).toBe(true);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("mic hold dictates (start on hold, end on release) and suppresses the trailing click", () => {
    vi.useFakeTimers();
    try {
      const onToggleRecording = vi.fn();
      const onDictateStart = vi.fn();
      const onDictateEnd = vi.fn();
      render(surface({ onToggleRecording, onDictateStart, onDictateEnd }));
      const mic = screen.getByRole("button", { name: "Start voice input" });

      fireEvent.pointerDown(mic, { button: 0, pointerId: 7 });
      expect(onDictateStart).not.toHaveBeenCalled();
      vi.advanceTimersByTime(PUSH_TO_TALK_HOLD_MS + 10);
      expect(onDictateStart).toHaveBeenCalledTimes(1);

      fireEvent.pointerUp(mic, { pointerId: 7 });
      expect(onDictateEnd).toHaveBeenCalledTimes(1);

      // The click the browser fires after pointerup must NOT also toggle.
      fireEvent.click(mic);
      expect(onToggleRecording).not.toHaveBeenCalled();
    } finally {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
  });

  it("a quick mic tap toggles recording instead of dictating", () => {
    vi.useFakeTimers();
    try {
      const onToggleRecording = vi.fn();
      const onDictateStart = vi.fn();
      render(surface({ onToggleRecording, onDictateStart }));
      const mic = screen.getByRole("button", { name: "Start voice input" });

      fireEvent.pointerDown(mic, { button: 0, pointerId: 7 });
      vi.advanceTimersByTime(PUSH_TO_TALK_HOLD_MS / 4);
      fireEvent.pointerUp(mic, { pointerId: 7 });
      fireEvent.click(mic);

      expect(onDictateStart).not.toHaveBeenCalled();
      expect(onToggleRecording).toHaveBeenCalledTimes(1);
    } finally {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
  });

  it("edits the shared ChatComposerContext draft slot under a provider", () => {
    function Provider({ children }: { children: ReactNode }) {
      const [chatInput, setChatInput] = useState("");
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
          <span data-testid="shared-draft" hidden>
            {chatInput}
          </span>
          {children}
        </ChatComposerCtx.Provider>
      );
    }
    render(<Provider>{surface()}</Provider>);
    fireEvent.change(composerInput(), { target: { value: "one draft" } });
    expect(screen.getByTestId("shared-draft").textContent).toBe("one draft");
  });

  it("retains a draft on Shift+Enter", () => {
    const onSend = vi.fn();
    render(surface({ onSend }));
    const input = composerInput();
    fireEvent.change(input, { target: { value: "Draft" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    expect(input.value).toBe("Draft");
  });

  it("announces transcript updates without replacing the entire live region", () => {
    render(
      surface({
        messages: [
          { id: "u", role: "user", content: "Hi", createdAt: 0 },
          { id: "a", role: "assistant", content: "Hello", createdAt: 1 },
        ],
      }),
    );
    expect(screen.getByText("Hi")).toBeTruthy();
    expect(screen.getByText("Hello")).toBeTruthy();
    const list = screen.getByRole("list");
    expect(list.getAttribute("aria-live")).toBe("polite");
    expect(list.getAttribute("aria-atomic")).toBe("false");
  });

  it("gates optional voice and vision capabilities through availability and capture state", () => {
    const onVision = vi.fn();
    const { rerender } = render(surface());
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: /voice input/i })
        .disabled,
    ).toBe(true);
    expect(screen.queryByRole("button", { name: /my screen/i })).toBeNull();
    rerender(surface({ onVision }));
    const vision = screen.getByRole<HTMLButtonElement>("button", {
      name: /my screen/i,
    });
    expect(vision.disabled).toBe(false);
    fireEvent.click(vision);
    expect(onVision).toHaveBeenCalledTimes(1);
    rerender(surface({ onVision, visionActive: true }));
    expect(vision.disabled).toBe(true);
    rerender(surface({ onVision, canSend: false }));
    expect(vision.disabled).toBe(true);
  });

  it("does not cover the transcript with a scrollback control", () => {
    const messages: ShellMessage[] = [
      { id: "u", role: "user", content: "Hi", createdAt: 0 },
      { id: "a", role: "assistant", content: "Hello", createdAt: 1 },
    ];
    render(surface({ messages }));
    const scroller = screen
      .getByTestId("shell-chat-surface")
      .querySelector(".overflow-y-auto") as HTMLDivElement;
    // Stub a tall, scrolled-up scroller.
    Object.defineProperty(scroller, "scrollHeight", {
      configurable: true,
      get: () => 2000,
    });
    Object.defineProperty(scroller, "clientHeight", {
      configurable: true,
      get: () => 400,
    });
    let top = 100;
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = v;
      },
    });
    scroller.scrollTo = ((opts: ScrollToOptions) => {
      top = opts.top ?? top;
    }) as HTMLElement["scrollTo"];
    fireEvent.scroll(scroller);
    expect(screen.queryByTestId("chat-surface-jump-to-latest")).toBeNull();
    expect(scroller.scrollTop).toBe(100);
  });
});
