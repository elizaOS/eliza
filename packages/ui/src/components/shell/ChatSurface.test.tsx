// @vitest-environment jsdom
/**
 * ChatSurface composer contract: the glass mini-chat consumes the shared
 * composer core — IME-safe Enter-to-send, the shared usePushToTalk mic hold
 * (hold dictates, tap toggles), and the ChatComposerContext draft slot.
 * Real component in jsdom, real DOM events, fake timers for the hold.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { type ReactNode, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImageAttachment } from "../../api/client-types-chat";
import { PUSH_TO_TALK_HOLD_MS } from "../../gestures";
import { ChatComposerCtx } from "../../state/ChatComposerContext.hooks";
import { ChatSurface } from "./ChatSurface";

// jsdom has no Pointer Capture; stub it so the hold machine's capture calls
// are no-ops that still report "not captured" for the release path.
beforeEach(() => {
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
});

afterEach(cleanup);

function surface(overrides: Partial<Parameters<typeof ChatSurface>[0]> = {}) {
  return <ChatSurface messages={[]} onSend={vi.fn()} canSend {...overrides} />;
}

function composerInput(): HTMLInputElement {
  return screen.getByRole("textbox") as HTMLInputElement;
}

describe("ChatSurface composer (shared core)", () => {
  it("sends the trimmed draft on Enter and clears the input", () => {
    const onSend = vi.fn();
    render(surface({ onSend }));
    const input = composerInput();
    fireEvent.change(input, { target: { value: "  hello there  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("hello there");
    expect(input.value).toBe("");
  });

  it("pins the transcript scroller to vertical-only scroll (#14328)", () => {
    // `overflow-y-auto` coerces the cross axis to `auto`, so without an explicit
    // `overflow-x-hidden` a single over-wide message child turns the transcript
    // into a two-axis scroller a diagonal wheel can pan sideways. Lock it here.
    const { container } = render(
      surface({
        messages: [{ id: "a", role: "assistant", content: "hi", createdAt: 1 }],
      }),
    );
    const scroller = container.querySelector(".overflow-y-auto");
    expect(scroller).not.toBeNull();
    expect(scroller?.className).toContain("overflow-x-hidden");
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
    fireEvent.change(input, { target: { value: "queued" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    rerender(surface({ onSend, canSend: true }));
    fireEvent.change(input, { target: { value: "   " } });
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
            setChatInput,
            setChatPendingImages,
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
});
