// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// The resting overlay's suggestion strip fetches model suggestions via the
// shared client; stub it so the strip stays on its static fallback in tests.
vi.mock("../../api/client", () => ({
  client: {
    fetch: vi.fn().mockRejectedValue(new Error("no api in test")),
    // Transcription archival is best-effort and fire-and-forget; resolve so the
    // attachment path (the user-facing behavior) is what the test asserts.
    createTranscript: vi
      .fn()
      .mockResolvedValue({ transcript: { id: "t1", title: "Transcript" } }),
  },
}));

// The press-and-hold copy path writes to the clipboard; stub it so the gesture
// is assertable (and never throws "Clipboard API unavailable" in jsdom).
vi.mock("../../utils/clipboard", () => ({
  copyTextToClipboard: vi.fn().mockResolvedValue(undefined),
}));

import type { Conversation } from "../../api/client-types-chat";
import { CHAT_PREFILL_EVENT } from "../../events";
import {
  LAYOUT_SHIFT_INTENT_ATTR,
  LAYOUT_SHIFT_INTENT_TRANSIENT,
} from "../../hooks/useLayoutShiftMonitor";
import {
  getShellSurface,
  resetShellSurfaceForTests,
} from "../../state/shell-surface-store";
import { copyTextToClipboard } from "../../utils/clipboard";
import { ContinuousChatOverlay } from "./ContinuousChatOverlay";
import {
  buildConversationNav,
  type ShellController,
} from "./useShellController";

beforeAll(() => {
  // jsdom has no scrollIntoView; the overlay calls it when the thread grows.
  Element.prototype.scrollIntoView = vi.fn();
});

// Unmount between tests so renders don't accumulate in the shared document.
afterEach(() => {
  cleanup();
  resetShellSurfaceForTests();
});

function makeController(
  overrides: Partial<ShellController> = {},
): ShellController {
  return {
    phase: "summoned",
    messages: [
      { id: "a", role: "assistant", content: "hi there", createdAt: 1 },
      // whitespace-only → should be filtered out of the rendered thread
      { id: "b", role: "user", content: "   ", createdAt: 2 },
    ],
    canSend: true,
    responding: false,
    turnStatus: null,
    recording: false,
    transcript: "",
    transcriptionMode: false,
    // Required ShellController surface the overlay reads unconditionally — the
    // real controller always supplies these, so the mock must too.
    modelStatus: { kind: "ready" },
    send: vi.fn(),
    stop: vi.fn(),
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    toggleRecording: vi.fn(),
    handsFree: false,
    toggleHandsFree: vi.fn(),
    toggleTranscriptionMode: vi.fn(),
    // A mic tap while transcribing routes through this master voice control.
    stopTranscriptionAndMic: vi.fn(),
    setDictationSink: vi.fn(),
    setTranscriptSessionSink: vi.fn(),
    setComposerHasDraft: vi.fn(),
    clearConversation: vi.fn(),
    ...overrides,
  } as unknown as ShellController;
}

describe("ContinuousChatOverlay", () => {
  it("shows the mic and no send button when the draft is empty", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    expect(screen.getByLabelText("talk")).toBeTruthy();
    expect(screen.queryByLabelText("send")).toBeNull();
  });

  it("swaps mic → send once the user types (ChatGPT-style)", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    fireEvent.change(screen.getByLabelText("message"), {
      target: { value: "hello" },
    });
    expect(screen.getByLabelText("send")).toBeTruthy();
    expect(screen.queryByLabelText("talk")).toBeNull();
  });

  it("shows a disabled, no-op send control when the agent can't accept input (canSend false)", () => {
    const controller = makeController({ canSend: false });
    render(<ContinuousChatOverlay controller={controller} />);
    fireEvent.change(screen.getByLabelText("message"), {
      target: { value: "hello" },
    });
    // The control still swaps to send, but is labelled + guarded as unavailable
    // (aria-disabled keeps it focusable/announceable; the click is a no-op).
    const send = screen.getByLabelText("send (agent stopped)");
    expect(send.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(send);
    expect(controller.send).not.toHaveBeenCalled();
  });

  it("swaps send → mic again once the draft is cleared", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const input = screen.getByLabelText("message");
    fireEvent.change(input, { target: { value: "hello" } });
    expect(screen.getByLabelText("send")).toBeTruthy();
    fireEvent.change(input, { target: { value: "" } });
    expect(screen.getByLabelText("talk")).toBeTruthy();
    expect(screen.queryByLabelText("send")).toBeNull();
  });

  it("submits the draft on Enter, calls send(), and clears the input", () => {
    const controller = makeController();
    render(<ContinuousChatOverlay controller={controller} />);
    const input = screen.getByLabelText("message") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "ping" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(vi.mocked(controller.send).mock.calls[0]?.[0]).toBe("ping");
    expect(input.value).toBe("");
  });

  it("prefills and focuses the composer from the shared chat prefill event", async () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const input = screen.getByLabelText("message") as HTMLInputElement;

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(CHAT_PREFILL_EVENT, {
          detail: { text: "Show my agent workspace status.", select: true },
        }),
      );
    });

    expect(input.value).toBe("Show my agent workspace status.");
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
  });

  it("cancels pending prefill focus work on unmount", () => {
    const requestFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation(() => 42);
    const cancelFrame = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation(() => undefined);
    try {
      const { unmount } = render(
        <ContinuousChatOverlay controller={makeController()} />,
      );
      requestFrame.mockClear();
      cancelFrame.mockClear();

      act(() => {
        window.dispatchEvent(
          new CustomEvent(CHAT_PREFILL_EVENT, {
            detail: {
              text: "Show my agent workspace status.",
              select: true,
            },
          }),
        );
      });

      expect(requestFrame).toHaveBeenCalled();
      const prefillFrameId =
        requestFrame.mock.results[requestFrame.mock.results.length - 1]?.value;
      unmount();
      expect(cancelFrame).toHaveBeenCalledWith(prefillFrameId);
    } finally {
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
    }
  });

  it("opens the sheet when the composer input is focused (type-to-open)", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    expect(sheet.getAttribute("data-variant")).toBe("closed");
    fireEvent.focus(screen.getByLabelText("message"));
    expect(sheet.getAttribute("data-variant")).toBe("open");
  });

  it("does not move the overlay bottom padding just because the composer is focused", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const overlay = screen.getByTestId("continuous-chat-overlay");
    const initialPadding = overlay.style.paddingBottom;

    fireEvent.focus(screen.getByLabelText("message"));

    expect(screen.getByTestId("chat-sheet").getAttribute("data-variant")).toBe(
      "open",
    );
    expect(overlay.style.paddingBottom).toBe(initialPadding);
  });

  it("blurs the focused composer when the active view leaves chat (drops the iOS accessory bar)", () => {
    const { rerender } = render(
      <ContinuousChatOverlay
        controller={makeController({
          currentTab: "chat",
        } as Partial<ShellController>)}
      />,
    );
    const composer = screen.getByLabelText("message");
    act(() => {
      composer.focus();
    });
    expect(document.activeElement).toBe(composer);

    // Navigate to a non-chat view. The overlay floats over every view, so
    // without an explicit blur the textarea keeps DOM focus on Settings and iOS
    // strands the keyboard input-accessory bar (the ‹ › chevrons + "Done").
    rerender(
      <ContinuousChatOverlay
        controller={makeController({
          currentTab: "settings",
        } as Partial<ShellController>)}
      />,
    );
    expect(document.activeElement).not.toBe(composer);
  });

  it("keeps composer focus when the active view stays on chat (no spurious blur)", () => {
    const { rerender } = render(
      <ContinuousChatOverlay
        controller={makeController({
          currentTab: "chat",
        } as Partial<ShellController>)}
      />,
    );
    const composer = screen.getByLabelText("message");
    act(() => {
      composer.focus();
    });
    // A re-render that does not change the active view must not steal focus.
    rerender(
      <ContinuousChatOverlay
        controller={makeController({
          currentTab: "chat",
        } as Partial<ShellController>)}
      />,
    );
    expect(document.activeElement).toBe(composer);
  });

  it("does not route soft-keyboard visualViewport resize through the drag-settle handler", () => {
    const originalVisualViewport = window.visualViewport;
    const fakeVisualViewport = {
      height: 700,
      offsetTop: 0,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: fakeVisualViewport as unknown as VisualViewport,
    });
    const windowAdd = vi.spyOn(window, "addEventListener");
    try {
      render(<ContinuousChatOverlay controller={makeController()} />);

      const windowResizeHandler = windowAdd.mock.calls.find(
        ([type]) => type === "resize",
      )?.[1];
      const visualResizeHandler =
        fakeVisualViewport.addEventListener.mock.calls.find(
          ([type]) => type === "resize",
        )?.[1];
      const visualScrollHandler =
        fakeVisualViewport.addEventListener.mock.calls.find(
          ([type]) => type === "scroll",
        )?.[1];

      expect(typeof windowResizeHandler).toBe("function");
      expect(typeof visualResizeHandler).toBe("function");
      expect(typeof visualScrollHandler).toBe("function");
      expect(visualResizeHandler).toBe(visualScrollHandler);
      expect(visualResizeHandler).not.toBe(windowResizeHandler);
    } finally {
      windowAdd.mockRestore();
      Object.defineProperty(window, "visualViewport", {
        configurable: true,
        value: originalVisualViewport,
      });
    }
  });

  it("opens the sheet on a pull-up drag of the grabber", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");
    expect(sheet.getAttribute("data-variant")).toBe("closed");
    // A deliberate upward drag past the distance threshold opens it.
    fireEvent.pointerDown(grabber, { clientY: 420, pointerId: 1 });
    fireEvent.pointerMove(grabber, { clientY: 280, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 280, pointerId: 1 });
    expect(sheet.getAttribute("data-variant")).toBe("open");
  });

  it("toggles the sheet open and closed on repeated grabber taps", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");

    expect(sheet.getAttribute("data-detent")).toBe("collapsed");

    fireEvent.pointerDown(grabber, { clientY: 420, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 420, pointerId: 1 });
    expect(sheet.getAttribute("data-detent")).toBe("half");

    fireEvent.pointerDown(grabber, { clientY: 420, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 420, pointerId: 1 });
    expect(sheet.getAttribute("data-detent")).toBe("collapsed");
  });

  it("opens a loading conversation on the first grabber tap", () => {
    render(
      <ContinuousChatOverlay
        controller={makeController({
          messages: [],
          conversationLoading: true,
        })}
      />,
    );
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");

    expect(sheet.getAttribute("data-detent")).toBe("collapsed");

    fireEvent.pointerDown(grabber, { clientY: 420, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 420, pointerId: 1 });
    expect(sheet.getAttribute("data-detent")).toBe("half");
    expect(screen.getByTestId("chat-thread-loading")).toBeTruthy();

    fireEvent.pointerDown(grabber, { clientY: 420, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 420, pointerId: 1 });
    expect(sheet.getAttribute("data-detent")).toBe("collapsed");
  });

  it("routes a horizontal swipe on the collapsed grabber to the launcher rail instead of opening chat", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");

    expect(getShellSurface().page).toBe("home");
    expect(sheet.getAttribute("data-variant")).toBe("closed");

    fireEvent.pointerDown(grabber, {
      clientX: 260,
      clientY: 420,
      pointerId: 1,
    });
    fireEvent.pointerMove(grabber, {
      clientX: 120,
      clientY: 414,
      pointerId: 1,
    });
    fireEvent.pointerUp(grabber, {
      clientX: 120,
      clientY: 414,
      pointerId: 1,
    });

    expect(getShellSurface().page).toBe("springboard");
    expect(sheet.getAttribute("data-variant")).toBe("closed");
  });

  // Regression guard for #9142: the grabber bar was hardcoded `opacity-0`
  // unconditionally, so on desktop/web (no OS home indicator) the handle was
  // grabbable but the bar never painted. It must be visible off-iOS.
  it("paints a visible grabber bar off-iOS (sheet grabber + pill)", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    // The test runtime resolves the Capacitor platform to "web", so isIOS is
    // false and both bars must render visibly (opacity-100, not opacity-0).
    const grabberBar = screen
      .getByTestId("chat-sheet-grabber")
      .querySelector("span[aria-hidden='true']");
    expect(grabberBar).toBeTruthy();
    expect(grabberBar?.className).toContain("opacity-100");
    expect(grabberBar?.className).not.toContain("opacity-0");

    const pillBar = screen
      .getByTestId("chat-pill")
      .querySelector("span[aria-hidden='true']");
    expect(pillBar).toBeTruthy();
    expect(pillBar?.className).toContain("opacity-100");
    expect(pillBar?.className).not.toContain("opacity-0");
  });

  it("steps COLLAPSED→HALF→FULL on successive pull-ups and back down again", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");
    const pull = (fromY: number, toY: number) => {
      fireEvent.pointerDown(grabber, { clientY: fromY, pointerId: 1 });
      fireEvent.pointerMove(grabber, { clientY: toY, pointerId: 1 });
      fireEvent.pointerUp(grabber, { clientY: toY, pointerId: 1 });
    };
    expect(sheet.getAttribute("data-detent")).toBe("collapsed");
    pull(420, 280); // up → HALF (one step, not straight to full)
    expect(sheet.getAttribute("data-detent")).toBe("half");
    pull(420, 280); // up → FULL
    expect(sheet.getAttribute("data-detent")).toBe("full");
    pull(280, 420); // down → HALF
    expect(sheet.getAttribute("data-detent")).toBe("half");
    pull(280, 420); // down → COLLAPSED
    expect(sheet.getAttribute("data-detent")).toBe("collapsed");
  });

  it("lands full when a collapsed drag is released above the half threshold", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");

    expect(sheet.getAttribute("data-detent")).toBe("collapsed");
    fireEvent.pointerDown(grabber, { clientY: 700, pointerId: 1 });
    fireEvent.pointerMove(grabber, { clientY: 80, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 80, pointerId: 1 });

    expect(sheet.getAttribute("data-detent")).toBe("full");
  });

  it("cancels delayed header navigation when unmounted before the close animation finishes", () => {
    vi.useFakeTimers();
    try {
      const navigateHome = vi.fn();
      const { unmount } = render(
        <ContinuousChatOverlay
          controller={makeController({
            currentTab: "settings",
            navigateHome,
          } as unknown as Partial<ShellController>)}
        />,
      );
      const grabber = screen.getByTestId("chat-sheet-grabber");
      const pull = (fromY: number, toY: number) => {
        fireEvent.pointerDown(grabber, { clientY: fromY, pointerId: 1 });
        fireEvent.pointerMove(grabber, { clientY: toY, pointerId: 1 });
        fireEvent.pointerUp(grabber, { clientY: toY, pointerId: 1 });
      };
      pull(420, 280); // collapsed → half
      expect(screen.getByTestId("chat-full-springboard")).toBeTruthy();
      fireEvent.click(screen.getByTestId("chat-full-springboard"));
      unmount();

      act(() => {
        vi.advanceTimersByTime(500);
      });

      expect(navigateHome).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens on a fast flick even below the distance threshold (velocity)", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");
    // 15px travel (< 56px distance threshold) but synchronous → high velocity.
    fireEvent.pointerDown(grabber, { clientY: 420, pointerId: 1 });
    fireEvent.pointerMove(grabber, { clientY: 405, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 405, pointerId: 1 });
    expect(sheet.getAttribute("data-detent")).toBe("half");
  });

  it("springs back to the input when a slow downward drift stays above the pill threshold", () => {
    const now = vi.spyOn(performance, "now");
    try {
      render(<ContinuousChatOverlay controller={makeController()} />);
      const sheet = screen.getByTestId("chat-sheet");
      const grabber = screen.getByTestId("chat-sheet-grabber");

      expect(sheet.getAttribute("data-detent")).toBe("collapsed");
      now.mockReturnValue(0);
      fireEvent.pointerDown(grabber, { clientY: 420, pointerId: 1 });
      fireEvent.pointerMove(grabber, { clientY: 450, pointerId: 1 });
      now.mockReturnValue(800);
      fireEvent.pointerUp(grabber, { clientY: 450, pointerId: 1 });

      expect(sheet.getAttribute("data-detent")).toBe("collapsed");
    } finally {
      now.mockRestore();
    }
  });

  it("collapses to the pill when a slow downward drag crosses the pill threshold", () => {
    const now = vi.spyOn(performance, "now");
    try {
      render(<ContinuousChatOverlay controller={makeController()} />);
      const sheet = screen.getByTestId("chat-sheet");
      const grabber = screen.getByTestId("chat-sheet-grabber");

      expect(sheet.getAttribute("data-detent")).toBe("collapsed");
      now.mockReturnValue(0);
      fireEvent.pointerDown(grabber, { clientY: 420, pointerId: 1 });
      fireEvent.pointerMove(grabber, { clientY: 500, pointerId: 1 });
      now.mockReturnValue(800);
      fireEvent.pointerUp(grabber, { clientY: 500, pointerId: 1 });

      expect(sheet.getAttribute("data-detent")).toBe("pill");
    } finally {
      now.mockRestore();
    }
  });

  it("opens to HALF when sending (conversation above the keyboard, not a full-screen takeover)", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const input = screen.getByLabelText("message");
    fireEvent.change(input, { target: { value: "ping" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(sheet.getAttribute("data-detent")).toBe("half");
  });

  it("exposes the mic control with a stable test id at rest", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    expect(screen.getByTestId("chat-composer-mic")).toBeTruthy();
  });

  it("does not render the resting suggestion strip (feature-flagged off)", () => {
    render(
      <ContinuousChatOverlay controller={makeController({ messages: [] })} />,
    );
    // SHOW_PROMPT_SUGGESTIONS is off — the resting strip must not mount.
    expect(screen.queryByTestId("chat-suggestions")).toBeNull();
    expect(screen.queryByTestId("chat-suggestion-0")).toBeNull();
  });

  it("filters whitespace-only messages from the expanded thread", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    fireEvent.focus(screen.getByLabelText("message"));
    const log = document.getElementById("continuous-thread");
    expect(log?.textContent).toContain("hi there");
    // one real message → exactly one transcript bubble
    expect(log?.querySelectorAll('[data-testid="thread-line"]').length).toBe(1);
  });

  it("aligns the assistant bubble left and the user bubble right", () => {
    render(
      <ContinuousChatOverlay
        controller={makeController({
          messages: [
            { id: "a", role: "assistant", content: "hi there", createdAt: 1 },
            { id: "b", role: "user", content: "hello back", createdAt: 2 },
          ],
        } as unknown as Partial<ShellController>)}
      />,
    );
    fireEvent.focus(screen.getByLabelText("message"));
    const log = document.getElementById("continuous-thread");
    const lines = log?.querySelectorAll('[data-testid="thread-line"]');
    expect(lines?.length).toBe(2);
    const assistant = log?.querySelector('[data-role="assistant"]');
    const user = log?.querySelector('[data-role="user"]');
    expect(assistant?.className).toContain("justify-start");
    expect(user?.className).toContain("justify-end");
  });

  it("anchors typing dots as an assistant-aligned transcript row", () => {
    render(
      <ContinuousChatOverlay
        controller={makeController({ phase: "responding", responding: true })}
      />,
    );
    fireEvent.focus(screen.getByLabelText("message"));
    // The dots sit inside a left-aligned, full-width assistant row.
    const row = screen.getByTestId("typing-dots").closest(".w-full");
    expect(row?.className).toContain("w-full");
    expect(row?.className).toContain("justify-start");
  });

  it("closes the sheet on Escape", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const input = screen.getByLabelText("message");
    const sheet = screen.getByTestId("chat-sheet");
    fireEvent.focus(input);
    expect(sheet.getAttribute("data-variant")).toBe("open");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(sheet.getAttribute("data-variant")).toBe("closed");
  });

  it("collapsing blurs the composer so the mobile keyboard drops", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const input = screen.getByLabelText("message") as HTMLTextAreaElement;
    fireEvent.focus(input); // onFocus → expand → sheetOpen true (flushed by act)
    input.focus(); // also move real activeElement (jsdom fireEvent.focus doesn't)
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: "Escape" }); // sheetOpen → collapse → blur
    expect(document.activeElement).not.toBe(input);
  });

  it("tapping outside the panel blurs the composer (drops the keyboard)", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const input = screen.getByLabelText("message") as HTMLTextAreaElement;
    input.focus();
    expect(document.activeElement).toBe(input);
    // A pointerdown anywhere outside the chat panel dismisses the keyboard.
    fireEvent.pointerDown(document.body);
    expect(document.activeElement).not.toBe(input);
  });

  it("composes multi-line with an auto-growing textarea (Enter still sends)", () => {
    const controller = makeController();
    render(<ContinuousChatOverlay controller={controller} />);
    const input = screen.getByLabelText("message") as HTMLTextAreaElement;
    expect(input.tagName).toBe("TEXTAREA");
    // Shift+Enter must NOT submit (it inserts a newline); plain Enter submits.
    fireEvent.change(input, { target: { value: "line one" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(controller.send).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(vi.mocked(controller.send).mock.calls[0]?.[0]).toBe("line one");
  });

  it("closes the sheet on a pull-down drag of the grabber", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");
    fireEvent.focus(screen.getByLabelText("message"));
    expect(sheet.getAttribute("data-variant")).toBe("open");
    fireEvent.pointerDown(grabber, { clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(grabber, { clientY: 360, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 360, pointerId: 1 });
    expect(sheet.getAttribute("data-variant")).toBe("closed");
  });

  it("fades the backdrop in with the chat and COLLAPSES on a backdrop click", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const backdrop = screen.getByTestId("chat-sheet-backdrop");
    // Collapsed: inactive + click-through (the live view behind stays usable).
    expect(backdrop.getAttribute("data-active")).toBe("false");
    fireEvent.focus(screen.getByLabelText("message"));
    expect(sheet.getAttribute("data-variant")).toBe("open");
    expect(backdrop.getAttribute("data-active")).toBe("true");
    // Clicking the dimmed view behind now collapses the chat back to the input.
    fireEvent.click(backdrop);
    expect(sheet.getAttribute("data-variant")).toBe("closed");
  });

  it("renders the full thread as one scroll log when the sheet is open", () => {
    const controller = makeController({
      messages: [
        { id: "a", role: "assistant", content: "one", createdAt: 1 },
        { id: "b", role: "user", content: "two", createdAt: 2 },
        { id: "c", role: "assistant", content: "three", createdAt: 3 },
      ],
    } as unknown as Partial<ShellController>);
    render(<ContinuousChatOverlay controller={controller} />);
    fireEvent.focus(screen.getByLabelText("message"));

    // The full transcript is one vertical scroll region while open.
    const log = document.getElementById("continuous-thread");
    expect(log?.querySelectorAll('[data-testid="thread-line"]').length).toBe(3);
    expect(log?.className).toContain("overflow-y-auto");
    expect(log?.textContent).toContain("one");
  });

  it("does not mount hidden header or transcript layers while collapsed", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    expect(sheet.getAttribute("data-detent")).toBe("collapsed");
    expect(sheet.getAttribute("data-revealed")).toBe("false");
    expect(sheet.getAttribute("data-header-shown")).toBe("false");
    expect(document.getElementById("continuous-thread")).toBeNull();
    expect(screen.queryByTestId("chat-thread")).toBeNull();
    expect(screen.queryByTestId("chat-full-springboard")).toBeNull();

    const grabber = screen.getByTestId("chat-sheet-grabber");
    expect(grabber.className).toContain("before:-top-4");
    expect(grabber.className).not.toContain("before:-top-16");
  });

  it("mounts an inert transcript preview during an upward drag before release", async () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");

    expect(sheet.getAttribute("data-variant")).toBe("closed");
    expect(screen.queryByTestId("chat-thread")).toBeNull();

    fireEvent.pointerDown(grabber, { clientY: 420, pointerId: 1 });
    fireEvent.pointerMove(grabber, { clientY: 340, pointerId: 1 });

    const thread = await waitFor(() => screen.getByTestId("chat-thread"));
    const log = document.getElementById("continuous-thread");
    expect(sheet.getAttribute("data-variant")).toBe("closed");
    expect(sheet.getAttribute("data-revealed")).toBe("true");
    expect(thread).toBeTruthy();
    expect(log?.getAttribute("aria-hidden")).toBe("true");
    expect(log?.getAttribute("tabindex")).toBe("-1");
  });

  it("shows the attach (+) control", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    expect(screen.getByLabelText("attach image")).toBeTruthy();
  });

  it("attaches an image and enables an image-only send", async () => {
    const controller = makeController({ messages: [] });
    render(<ContinuousChatOverlay controller={controller} />);
    // Empty draft + no image → mic, no send.
    expect(screen.getByLabelText("talk")).toBeTruthy();
    expect(screen.queryByLabelText("send")).toBeNull();

    const fileInput = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const file = new File(["x"], "pic.png", { type: "image/png" });
    fireEvent.change(fileInput, { target: { files: [file] } });

    // Once the read resolves, a thumbnail + send control appear.
    await screen.findByLabelText("send");
    expect(screen.getByLabelText(/remove pic\.png/)).toBeTruthy();

    fireEvent.click(screen.getByLabelText("send"));
    expect(controller.send).toHaveBeenCalledWith(
      "",
      expect.objectContaining({
        images: expect.arrayContaining([
          expect.objectContaining({ name: "pic.png", mimeType: "image/png" }),
        ]),
      }),
    );
  });

  it("toggles hands-free conversation when the mic is tapped", () => {
    const controller = makeController();
    render(<ContinuousChatOverlay controller={controller} />);
    fireEvent.click(screen.getByLabelText("talk"));
    expect(controller.toggleHandsFree).toHaveBeenCalled();
  });

  it("shows a waking-up placeholder while booting (typing allowed)", () => {
    render(
      <ContinuousChatOverlay
        controller={makeController({ phase: "booting", canSend: false })}
      />,
    );
    const input = screen.getByLabelText("message");
    expect(input.getAttribute("placeholder")).toContain("waking up");
    // You can type while the agent boots; the message sends once it's ready.
    expect(input.hasAttribute("readonly")).toBe(false);
  });

  it("renders the live interim transcript while recording", () => {
    render(
      <ContinuousChatOverlay
        controller={makeController({
          phase: "listening",
          recording: true,
          transcript: "tell me about the coast",
        })}
      />,
    );
    expect(screen.getByText(/tell me about the coast/)).toBeTruthy();
  });

  it("keeps the ambient layer non-blocking for controls behind it", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);

    const root = screen.getByTestId("continuous-chat-overlay");
    expect(root.className).toContain("pointer-events-none");
    expect(root.className).not.toContain("pointer-events-auto");

    // The overlay still has a LIVE interactive region: the composer fieldset
    // re-enables pointer events (inline, gated on !pilled) so taps land on the
    // input while the rest of the surface passes through to the view behind it.
    const composer = screen.getByTestId("chat-sheet");
    expect(composer.style.pointerEvents).toBe("auto");
    expect(composer).not.toBe(root);
  });

  it("exposes the canonical chat composer test id on the overlay input only", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);

    expect(screen.getByTestId("chat-composer-textarea")).toBe(
      screen.getByLabelText("message"),
    );
    expect(screen.getAllByTestId("chat-composer-textarea")).toHaveLength(1);
  });

  it("keeps composer controls in one non-wrapping input row inside the constrained panel", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);

    const input = screen.getByTestId("chat-composer-textarea");
    const bar = input.parentElement;
    const panel = screen.getByTestId("chat-sheet");

    expect(screen.queryByTestId("chat-composer-clear-debug")).toBeNull();
    // Width is constrained on the panel's wrapper (which also holds the absolute
    // drag handle); the input row is a single, non-wrapping flex row.
    expect(panel.parentElement?.className).toContain("max-w-3xl");
    expect(bar?.className).toContain("flex");
    expect(bar?.className).not.toContain("flex-wrap");
    expect(input.className).toContain("flex-1");
    expect(input.className).not.toContain("basis-full");
  });

  it("renders no prompt-suggestion chips while the strip is flagged off", () => {
    render(
      <ContinuousChatOverlay
        controller={makeController({
          messages: [],
        } as unknown as Partial<ShellController>)}
      />,
    );
    expect(
      document.querySelectorAll('[data-testid^="chat-suggestion-"]'),
    ).toHaveLength(0);
  });

  it("scrolls to the latest line when a new message arrives while open", () => {
    const base = [{ id: "a", role: "assistant", content: "hi", createdAt: 1 }];
    const { rerender } = render(
      <ContinuousChatOverlay
        controller={makeController({
          messages: base,
        } as unknown as Partial<ShellController>)}
      />,
    );
    fireEvent.focus(screen.getByLabelText("message")); // open the sheet
    const scrollIntoView = Element.prototype.scrollIntoView as ReturnType<
      typeof vi.fn
    >;
    scrollIntoView.mockClear();
    rerender(
      <ContinuousChatOverlay
        controller={makeController({
          messages: [
            ...base,
            { id: "b", role: "user", content: "new line", createdAt: 2 },
          ],
        } as unknown as Partial<ShellController>)}
      />,
    );
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it("marks chat transcript changes as transient layout motion", () => {
    vi.useFakeTimers();
    try {
      const base = [
        { id: "a", role: "assistant", content: "hi", createdAt: 1 },
      ];
      const { rerender } = render(
        <ContinuousChatOverlay
          controller={makeController({
            messages: base,
          } as unknown as Partial<ShellController>)}
        />,
      );
      const root = screen.getByTestId("continuous-chat-overlay");

      act(() => {
        vi.advanceTimersByTime(181);
      });
      expect(root.getAttribute(LAYOUT_SHIFT_INTENT_ATTR)).toBeNull();

      rerender(
        <ContinuousChatOverlay
          controller={makeController({
            messages: [
              ...base,
              { id: "b", role: "user", content: "new line", createdAt: 2 },
            ],
          } as unknown as Partial<ShellController>)}
        />,
      );

      expect(root.getAttribute(LAYOUT_SHIFT_INTENT_ATTR)).toBe(
        LAYOUT_SHIFT_INTENT_TRANSIENT,
      );
      act(() => {
        vi.advanceTimersByTime(181);
      });
      expect(root.getAttribute(LAYOUT_SHIFT_INTENT_ATTR)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT close on an outside pointer-down while the keyboard is DOWN", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    // fireEvent.focus drives the React open state but does NOT move
    // document.activeElement in jsdom — i.e. the composer isn't really focused
    // (no soft keyboard). An outside tap in that state must NOT close the chat;
    // closing is a pull-down, the scrim, or Escape.
    fireEvent.focus(screen.getByLabelText("message"));
    expect(sheet.getAttribute("data-variant")).toBe("open");
    expect(document.activeElement).not.toBe(screen.getByLabelText("message"));
    fireEvent.pointerDown(document.body);
    fireEvent.click(document.body);
    expect(sheet.getAttribute("data-variant")).toBe("open");
  });

  it("does NOT close when the underlying app scrolls", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    fireEvent.focus(screen.getByLabelText("message"));
    expect(sheet.getAttribute("data-variant")).toBe("open");
    fireEvent.scroll(document.body);
    expect(sheet.getAttribute("data-variant")).toBe("open");
  });

  it("shows a stop control while a reply streams (and wires it)", () => {
    const stop = vi.fn();
    render(
      <ContinuousChatOverlay
        controller={makeController({
          phase: "responding",
          responding: true,
          stop,
        } as unknown as Partial<ShellController>)}
      />,
    );
    // No draft + responding → the trailing control is STOP, not mic or send.
    expect(screen.queryByTestId("chat-composer-mic")).toBeNull();
    expect(screen.queryByLabelText("send")).toBeNull();
    const stopBtn = screen.getByTestId("chat-composer-stop");
    expect(stopBtn).toBeTruthy();
    fireEvent.click(stopBtn);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("reverts the trailing control to send the moment a draft exists mid-stream", () => {
    render(
      <ContinuousChatOverlay
        controller={makeController({ phase: "responding", responding: true })}
      />,
    );
    expect(screen.getByTestId("chat-composer-stop")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("message"), {
      target: { value: "queued" },
    });
    expect(screen.queryByTestId("chat-composer-stop")).toBeNull();
    expect(screen.getByLabelText(/send/)).toBeTruthy();
  });

  it("renders the no_provider failure as a recovery gate with a Settings jump", () => {
    const openSettings = vi.fn();
    render(
      <ContinuousChatOverlay
        controller={makeController({
          openSettings,
          messages: [
            {
              id: "np",
              role: "assistant",
              content: "No model provider is configured.",
              createdAt: 1,
              failureKind: "no_provider",
            },
          ],
        } as unknown as Partial<ShellController>)}
      />,
    );
    fireEvent.focus(screen.getByLabelText("message"));
    expect(screen.getByText("Connect a provider to chat")).toBeTruthy();
    const cta = screen.getByTestId("chat-no-provider-settings");
    fireEvent.click(cta);
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  it("press-and-hold copies an assistant message and flashes confirmation", () => {
    vi.useFakeTimers();
    try {
      vi.mocked(copyTextToClipboard).mockClear();
      render(
        <ContinuousChatOverlay
          controller={makeController({
            messages: [
              {
                id: "a",
                role: "assistant",
                content: "the answer is 42",
                createdAt: 1,
              },
            ],
          } as unknown as Partial<ShellController>)}
        />,
      );
      fireEvent.focus(screen.getByLabelText("message"));
      const bubble = screen
        .getByText("the answer is 42")
        .closest('[data-testid="thread-line"]')
        ?.querySelector("div") as HTMLElement;
      fireEvent.pointerDown(bubble, { clientX: 10, clientY: 10, pointerId: 1 });
      act(() => {
        vi.advanceTimersByTime(450); // past the hold threshold
      });
      expect(copyTextToClipboard).toHaveBeenCalledWith("the answer is 42");
      expect(screen.getByTestId("thread-line-copied")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps chat message text selectable for normal highlight/copy", () => {
    render(
      <ContinuousChatOverlay
        controller={makeController({
          messages: [
            {
              id: "u",
              role: "user",
              content: "copy my question",
              createdAt: 1,
            },
            {
              id: "a",
              role: "assistant",
              content: "copy my answer",
              createdAt: 2,
            },
          ],
        } as unknown as Partial<ShellController>)}
      />,
    );
    fireEvent.focus(screen.getByLabelText("message"));

    for (const text of ["copy my question", "copy my answer"]) {
      const textNode = screen.getByText(text);
      const bubble = screen
        .getByText(text)
        .closest('[data-testid="thread-line"]')
        ?.querySelector("div") as HTMLElement;
      expect(bubble.className).toContain("select-text");
      expect(bubble.className).not.toContain("select-none");
      expect(textNode.closest('[data-chat-selectable="true"]')).toBeTruthy();
    }
  });

  it("a quick tap (released before the hold threshold) does NOT copy", () => {
    vi.useFakeTimers();
    try {
      vi.mocked(copyTextToClipboard).mockClear();
      render(
        <ContinuousChatOverlay
          controller={makeController({
            messages: [
              { id: "a", role: "assistant", content: "tap me", createdAt: 1 },
            ],
          } as unknown as Partial<ShellController>)}
        />,
      );
      fireEvent.focus(screen.getByLabelText("message"));
      const bubble = screen
        .getByText("tap me")
        .closest('[data-testid="thread-line"]')
        ?.querySelector("div") as HTMLElement;
      fireEvent.pointerDown(bubble, { clientX: 10, clientY: 10, pointerId: 1 });
      vi.advanceTimersByTime(200);
      fireEvent.pointerUp(bubble, { clientX: 10, clientY: 10, pointerId: 1 });
      vi.advanceTimersByTime(400);
      expect(copyTextToClipboard).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("pulls DOWN from the input to collapse into a recoverable pill", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");
    expect(sheet.getAttribute("data-detent")).toBe("collapsed");
    expect(screen.getByTestId("chat-composer-textarea")).toBeTruthy();
    // A downward drag past the threshold collapses the input away into the pill.
    fireEvent.pointerDown(grabber, { clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(grabber, { clientY: 380, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 380, pointerId: 1 });
    expect(sheet.getAttribute("data-detent")).toBe("pill");
    expect(screen.getByTestId("chat-pill")).toBeTruthy();
    // In pill mode the composer is hidden away: kept mounted for the
    // pill→input morph but made inert (opacity 0 + `inert`) so it's unreachable
    // behind the pill capsule.
    expect(screen.getByTestId("chat-content").hasAttribute("inert")).toBe(true);
  });

  it("keeps the collapsed pill handle non-interactive while the input is formed", () => {
    // The pill handle is always mounted over the (faded) composer so it can
    // crossfade pill→input. Its hit zone (px-16/pt-10) sits over the textarea, so
    // while NOT pilled it must be pointer-events-none — otherwise it intercepts
    // the tap meant for the composer and the mobile keyboard never opens.
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    expect(sheet.getAttribute("data-detent")).toBe("collapsed");

    const pill = screen.getByTestId("chat-pill");
    expect(pill.className).toContain("pointer-events-none");
    expect(pill.className).not.toContain("pointer-events-auto");
    // Kept out of the tab order / a11y tree while it's not the active handle.
    expect(pill.getAttribute("tabindex")).toBe("-1");
    expect(pill.getAttribute("aria-hidden")).toBe("true");
  });

  it("makes the pill handle interactive (drag-to-open) once collapsed to the pill", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");
    // Collapse the input down into the pill.
    fireEvent.pointerDown(grabber, { clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(grabber, { clientY: 380, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 380, pointerId: 1 });
    expect(sheet.getAttribute("data-detent")).toBe("pill");

    const pill = screen.getByTestId("chat-pill");
    // Now the handle owns the gesture: it re-enables pointer events so the user
    // can grab/drag it open (verified by the flick-up recovery test below).
    expect(pill.className).toContain("pointer-events-auto");
    expect(pill.className).not.toContain("pointer-events-none");
    expect(pill.getAttribute("aria-hidden")).toBeNull();
    // Restored to the tab order once it's the active handle — the symmetric half
    // of the collapsed assertion above (tabindex "-1" while NOT pilled). The
    // PillHandle sets tabIndex={pilled ? undefined : -1}, so the attribute is
    // absent (null) when pilled and keyboard users can Tab to + Enter the pill.
    expect(pill.getAttribute("tabindex")).toBeNull();
  });

  it("opens the chat to HALF on a SINGLE pill tap (not the bare input bar)", () => {
    // Regression: a tap on the pill used to land on the bare input bar (the
    // chat "blinked" without opening) and needed a SECOND tap to reach half.
    // With a conversation to show, ONE tap must open straight to half — exactly
    // like a flick-up.
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");
    fireEvent.pointerDown(grabber, { clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(grabber, { clientY: 380, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 380, pointerId: 1 });
    const pill = screen.getByTestId("chat-pill");
    // A tap = pointer down + up with no travel. The pill has no onClick; the
    // pull-gesture binding is the single tap authority (onPointerUp → onTap).
    fireEvent.pointerDown(pill, { clientY: 400, pointerId: 1 });
    fireEvent.pointerUp(pill, { clientY: 400, pointerId: 1 });
    expect(sheet.getAttribute("data-detent")).toBe("half");
    const textarea = screen.getByTestId("chat-composer-textarea");
    expect(textarea).toBeTruthy();
    // The pill tap must focus the composer (so iOS raises the keyboard on the
    // first tap) and clear the `inert` it carried while pilled — without that,
    // the composer silently refuses keyboard input until a second tap.
    expect(document.activeElement).toBe(textarea);
    expect(screen.getByTestId("chat-content").hasAttribute("inert")).toBe(
      false,
    );
  });

  it("opens a thread-less pill tap to the bare input bar (nothing to open into)", () => {
    // With no conversation yet there's no thread to reveal, so a pill tap forms
    // the input bar (and raises the keyboard) rather than an empty half sheet.
    render(
      <ContinuousChatOverlay controller={makeController({ messages: [] })} />,
    );
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");
    fireEvent.pointerDown(grabber, { clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(grabber, { clientY: 380, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 380, pointerId: 1 });
    const pill = screen.getByTestId("chat-pill");
    fireEvent.pointerDown(pill, { clientY: 400, pointerId: 1 });
    fireEvent.pointerUp(pill, { clientY: 400, pointerId: 1 });
    expect(sheet.getAttribute("data-detent")).toBe("collapsed");
    expect(document.activeElement).toBe(
      screen.getByTestId("chat-composer-textarea"),
    );
  });

  it("opens the pill on keyboard activation (Enter)", () => {
    // Keyboard users still open the pill via onKeyDown even though the native
    // onClick was removed in favour of the gesture binding.
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");
    fireEvent.pointerDown(grabber, { clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(grabber, { clientY: 380, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 380, pointerId: 1 });
    expect(sheet.getAttribute("data-detent")).toBe("pill");
    fireEvent.keyDown(screen.getByTestId("chat-pill"), { key: "Enter" });
    expect(sheet.getAttribute("data-detent")).toBe("half");
  });

  it("flicks UP from the pill to recover the input", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");
    fireEvent.pointerDown(grabber, { clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(grabber, { clientY: 380, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 380, pointerId: 1 });
    const pill = screen.getByTestId("chat-pill");
    // A quick upward flick on the pill opens straight into the chat (the thread
    // has history), recovering the composer — a flick reaches the chat rather
    // than stopping at the bare input (that's the tap path; see the test above).
    fireEvent.pointerDown(pill, { clientY: 400, pointerId: 1 });
    fireEvent.pointerMove(pill, { clientY: 360, pointerId: 1 });
    fireEvent.pointerUp(pill, { clientY: 360, pointerId: 1 });
    expect(sheet.getAttribute("data-detent")).toBe("half");
    expect(screen.getByTestId("chat-composer-textarea")).toBeTruthy();
  });

  it("does not render a separate transcribe button in the composer", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    expect(screen.getByTestId("chat-composer-mic")).toBeTruthy();
    expect(screen.queryByTestId("chat-composer-transcribe")).toBeNull();
  });

  it("keeps the composer transcribe button hidden during voice capture", () => {
    render(
      <ContinuousChatOverlay
        controller={makeController({
          handsFree: true,
          phase: "listening",
          recording: true,
        } as unknown as Partial<ShellController>)}
      />,
    );
    expect(screen.getByTestId("chat-composer-mic")).toBeTruthy();
    expect(screen.queryByTestId("chat-composer-transcribe")).toBeNull();
  });

  it("shows transcription status without adding a composer transcribe button", () => {
    render(
      <ContinuousChatOverlay
        controller={makeController({
          transcriptionMode: true,
        } as unknown as Partial<ShellController>)}
      />,
    );
    fireEvent.focus(screen.getByLabelText("message"));
    expect(screen.getByTestId("chat-transcribing-badge")).toBeTruthy();
    expect(screen.queryByTestId("chat-composer-transcribe")).toBeNull();
  });

  it("keeps the mic button ON while transcribing (additive, not a takeover)", () => {
    render(
      <ContinuousChatOverlay
        controller={makeController({
          transcriptionMode: true,
          toggleTranscriptionMode: vi.fn(),
        } as unknown as Partial<ShellController>)}
      />,
    );
    const mic = screen.getByTestId("chat-composer-mic");
    // The mic stays active (lit) the whole time transcription runs.
    expect(mic.getAttribute("aria-pressed")).toBe("true");
  });

  it("a mic tap while transcribing ends transcription, never starts a conversation", () => {
    const stopTranscriptionAndMic = vi.fn();
    const toggleHandsFree = vi.fn();
    render(
      <ContinuousChatOverlay
        controller={makeController({
          transcriptionMode: true,
          stopTranscriptionAndMic,
          toggleHandsFree,
        } as unknown as Partial<ShellController>)}
      />,
    );
    fireEvent.click(screen.getByTestId("chat-composer-mic"));
    // The mic is the master voice control: a tap ends transcription AND the mic
    // (stopTranscriptionAndMic → finished transcript drops into the composer);
    // it must NOT open a hands-free conversation.
    expect(stopTranscriptionAndMic).toHaveBeenCalledTimes(1);
    expect(toggleHandsFree).not.toHaveBeenCalled();
  });

  it("does not enter push-to-talk on a long press while transcribing", () => {
    vi.useFakeTimers();
    try {
      const stopTranscriptionAndMic = vi.fn();
      const startRecording = vi.fn();
      render(
        <ContinuousChatOverlay
          controller={makeController({
            transcriptionMode: true,
            stopTranscriptionAndMic,
            startRecording,
          } as unknown as Partial<ShellController>)}
        />,
      );

      const mic = screen.getByTestId("chat-composer-mic");
      fireEvent.pointerDown(mic, { button: 0, pointerId: 1 });
      act(() => {
        vi.advanceTimersByTime(250);
      });
      fireEvent.pointerUp(mic, { button: 0, pointerId: 1 });
      fireEvent.click(mic);

      expect(startRecording).not.toHaveBeenCalled();
      expect(stopTranscriptionAndMic).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops the finished transcript into the composer as an attachment, not an auto-sent message", () => {
    let sink:
      | ((
          segments: Array<Record<string, unknown>>,
          startedAt: number,
          audioWav: Uint8Array | null,
        ) => void)
      | null = null;
    const controller = makeController({
      setTranscriptSessionSink: ((fn: unknown) => {
        sink = fn as typeof sink;
      }) as unknown as ShellController["setTranscriptSessionSink"],
    });
    render(<ContinuousChatOverlay controller={controller} />);
    expect(typeof sink).toBe("function");

    act(() => {
      sink?.(
        [
          {
            id: "s1",
            startMs: 0,
            endMs: 1000,
            text: "hello world",
            words: [],
          },
        ],
        1_700_000_000_000,
        null,
      );
    });

    // The transcript becomes a composer attachment chip (document kind) …
    expect(screen.getByText(/^Transcript .*\.md$/)).toBeTruthy();
    // … and is NOT auto-sent — the user sends it with their next message.
    expect(controller.send).not.toHaveBeenCalled();
  });

  // ── SheetGrabber inert-while-pilled (the symmetric half of the PillHandle
  // pilled-gating above; #8772). The grabber and the pill capsule occupy the
  // same bottom region; exactly ONE may own the gesture / a11y tree at a time.
  // While the input is formed (not pilled) the GRABBER is live; once collapsed
  // to the pill, the grabber must go fully inert so it can't steal the pill's
  // taps or sit in the tab order behind it.
  it("keeps the sheet grabber live + in the a11y tree while NOT pilled", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    expect(sheet.getAttribute("data-detent")).toBe("collapsed");

    const grabber = screen.getByTestId("chat-sheet-grabber");
    // SheetGrabber: pointerEvents auto, tabIndex undefined (attr absent → in
    // tab order), aria-hidden undefined (attr absent → exposed) while !pilled.
    expect(grabber.style.pointerEvents).toBe("auto");
    expect(grabber.getAttribute("tabindex")).toBeNull();
    expect(grabber.getAttribute("aria-hidden")).toBeNull();
  });

  it("makes the sheet grabber fully inert (pointer/tab/a11y) once collapsed to the pill", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");
    // Collapse the input down into the pill.
    fireEvent.pointerDown(grabber, { clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(grabber, { clientY: 380, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 380, pointerId: 1 });
    expect(sheet.getAttribute("data-detent")).toBe("pill");

    // The (still-mounted) grabber is now invisible behind the pill capsule, so
    // it must not intercept taps meant for the pill or pass them through to the
    // home screen, and must drop out of the tab order + a11y tree.
    // SheetGrabber: pointerEvents none, tabIndex -1, aria-hidden "true" pilled.
    expect(grabber.style.pointerEvents).toBe("none");
    expect(grabber.getAttribute("tabindex")).toBe("-1");
    expect(grabber.getAttribute("aria-hidden")).toBe("true");
  });

  // ── chat-full Springboard launcher. The header row no longer exposes Home /
  // Views / Settings as a mini app nav. It keeps one Springboard icon that
  // returns to the combined Home/Springboard surface; Settings lives in the
  // Springboard favorites dock.
  it("renders only the Springboard launcher in the chat-full header", () => {
    render(
      <ContinuousChatOverlay
        controller={makeController({
          currentTab: "chat",
        } as Partial<ShellController>)}
      />,
    );
    openSheetToHalf();

    const springboard = screen.getByTestId("chat-full-springboard");
    expect((springboard as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId("chat-full-home")).toBeNull();
    expect(screen.queryByTestId("chat-full-views")).toBeNull();
    expect(screen.queryByTestId("chat-full-settings")).toBeNull();
  });

  // Open the sheet to the HALF detent so the chat-full header is revealed and
  // interactive (its wrapper carries `inert` until `headerVisible` flips at the
  // half threshold). A deliberate pull-up of the grabber past the distance
  // threshold lands on half — the same gesture the COLLAPSED→HALF test uses.
  function openSheetToHalf(): void {
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");
    fireEvent.pointerDown(grabber, { clientY: 420, pointerId: 1 });
    fireEvent.pointerMove(grabber, { clientY: 280, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 280, pointerId: 1 });
    expect(sheet.getAttribute("data-detent")).toBe("half");
  }

  it("routes the chat-full Springboard button to the home callback", async () => {
    const navigateHome = vi.fn();
    render(
      <ContinuousChatOverlay
        controller={makeController({
          currentTab: "settings",
          navigateHome,
        } as Partial<ShellController>)}
      />,
    );
    openSheetToHalf();

    // navigateAndClose collapses the sheet then defers the navigation a frame
    // (so the close animates first), so the callback fires on a short timer.
    fireEvent.click(screen.getByTestId("chat-full-springboard"));
    await vi.waitFor(() => expect(navigateHome).toHaveBeenCalledTimes(1));
  });

  // ── Rich turn-status indicator (#8813) ──────────────────────────────────
  describe("turn status indicator", () => {
    it("renders breathing dots without a text label while thinking", () => {
      render(
        <ContinuousChatOverlay
          controller={makeController({
            phase: "responding",
            responding: true,
            turnStatus: { kind: "thinking" },
          } as Partial<ShellController>)}
        />,
      );
      fireEvent.focus(screen.getByLabelText("message"));
      const indicator = screen.getByTestId("turn-status-indicator");
      expect(indicator.getAttribute("data-status-kind")).toBe("thinking");
      expect(indicator.getAttribute("role")).toBe("status");
      expect(indicator.getAttribute("aria-live")).toBe("polite");
      expect(screen.queryByTestId("turn-status-label")).toBeNull();
      // The dots still animate within the indicator.
      expect(screen.getByTestId("typing-dots")).toBeTruthy();
    });

    it("humanizes the action name for a running_action phase", () => {
      render(
        <ContinuousChatOverlay
          controller={makeController({
            phase: "responding",
            responding: true,
            turnStatus: { kind: "running_action", actionName: "SEND_MESSAGE" },
          } as Partial<ShellController>)}
        />,
      );
      fireEvent.focus(screen.getByLabelText("message"));
      expect(screen.getByTestId("turn-status-label").textContent).toBe(
        "Running Send message",
      );
    });

    it("shows dots-only status inside the empty in-flight assistant bubble", () => {
      render(
        <ContinuousChatOverlay
          controller={makeController({
            phase: "responding",
            responding: true,
            // Last turn is an empty assistant bubble (the in-flight placeholder).
            messages: [
              { id: "u", role: "user", content: "do it", createdAt: 1 },
              { id: "a", role: "assistant", content: "", createdAt: 2 },
            ],
            turnStatus: { kind: "waking" },
          } as Partial<ShellController>)}
        />,
      );
      fireEvent.focus(screen.getByLabelText("message"));
      // Exactly one indicator (no double-up between the bubble + standalone row).
      const indicators = screen.getAllByTestId("turn-status-indicator");
      expect(indicators).toHaveLength(1);
      expect(indicators[0].getAttribute("data-status-kind")).toBe("waking");
      expect(screen.queryByTestId("turn-status-label")).toBeNull();
      expect(screen.getByTestId("typing-dots")).toBeTruthy();
    });

    it("hides reasoning disclosure while the latest assistant turn is streaming", () => {
      render(
        <ContinuousChatOverlay
          controller={makeController({
            phase: "responding",
            responding: true,
            messages: [
              { id: "u", role: "user", content: "explain it", createdAt: 1 },
              {
                id: "a",
                role: "assistant",
                content: "Draft answer",
                reasoning: "private chain of thought",
                createdAt: 2,
              },
            ],
            turnStatus: { kind: "running_action", actionName: "OPEN_VIEW" },
          } as Partial<ShellController>)}
        />,
      );
      fireEvent.focus(screen.getByLabelText("message"));

      expect(screen.getByText("Draft answer")).toBeTruthy();
      expect(screen.queryByRole("button", { name: /thinking/i })).toBeNull();
      expect(screen.getByTestId("turn-status-label").textContent).toBe(
        "Running Open view",
      );
    });

    it("shows reasoning disclosure after the assistant turn settles", () => {
      render(
        <ContinuousChatOverlay
          controller={makeController({
            phase: "idle",
            responding: false,
            messages: [
              { id: "u", role: "user", content: "explain it", createdAt: 1 },
              {
                id: "a",
                role: "assistant",
                content: "Final answer",
                reasoning: "compact reasoning summary",
                createdAt: 2,
              },
            ],
          } as Partial<ShellController>)}
        />,
      );

      fireEvent.focus(screen.getByLabelText("message"));
      expect(screen.getByRole("button", { name: /thinking/i })).toBeTruthy();
    });

    it("holds the first label through a fast phase change (min-dwell, no flicker)", () => {
      vi.useFakeTimers();
      try {
        const { rerender } = render(
          <ContinuousChatOverlay
            controller={makeController({
              phase: "responding",
              responding: true,
              turnStatus: { kind: "thinking" },
            } as Partial<ShellController>)}
          />,
        );
        fireEvent.focus(screen.getByLabelText("message"));
        expect(screen.queryByTestId("turn-status-label")).toBeNull();
        // A near-instant change to running_action must NOT flip the label yet —
        // the thinking status is held for the min dwell so words don't strobe in.
        rerender(
          <ContinuousChatOverlay
            controller={makeController({
              phase: "responding",
              responding: true,
              turnStatus: {
                kind: "running_action",
                actionName: "SEND_MESSAGE",
              },
            } as Partial<ShellController>)}
          />,
        );
        expect(screen.queryByTestId("turn-status-label")).toBeNull();
        // After the dwell window elapses the new phase is shown.
        act(() => {
          vi.advanceTimersByTime(400);
        });
        expect(screen.getByTestId("turn-status-label").textContent).toBe(
          "Running Send message",
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

/**
 * Swipe-between-conversations integration (#8929). Drives the REAL overlay with
 * the REAL `usePullGesture` binding and a REAL `conversationNav` (built via the
 * production `buildConversationNav` helper) — not the isolated `__e2e__` fixture
 * mock. A committed horizontal swipe on the thread must (a) light the edge hint
 * with the live drag offset and (b) select the adjacent conversation through
 * `handleSelectConversation`, proving the active conversation actually changes.
 */
describe("ContinuousChatOverlay swipe-nav", () => {
  function conv(id: string): Conversation {
    return {
      id,
      title: id,
      roomId: `room-${id}`,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
  }

  // The list is most-recent-first: [newest "a", "b", oldest "c"]. Active "b" is
  // in the middle so both directions are navigable.
  const CONVERSATIONS = [conv("a"), conv("b"), conv("c")];

  function makeSwipeController() {
    const onSelect = vi.fn<(id: string) => void>();
    const conversationNav = buildConversationNav(CONVERSATIONS, "b", onSelect);
    const controller = makeController({
      conversationNav,
    } as unknown as Partial<ShellController>);
    return { controller, onSelect };
  }

  function openSheet() {
    const grabber = screen.getByTestId("chat-sheet-grabber");
    fireEvent.pointerDown(grabber, { clientY: 420, pointerId: 1 });
    fireEvent.pointerMove(grabber, { clientY: 280, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 280, pointerId: 1 });
  }

  function thread(): HTMLElement {
    const el = document.getElementById("continuous-thread");
    if (!el) throw new Error("thread region not mounted");
    return el;
  }

  it("a committed LEFT swipe selects the next (older) conversation", () => {
    const { controller, onSelect } = makeSwipeController();
    render(<ContinuousChatOverlay controller={controller} />);
    openSheet();

    const el = thread();
    // Drag LEFT: clientX decreases. The first move commits the X axis (>8px);
    // total travel of 120px clears the 64px horizontal distance threshold.
    fireEvent.pointerDown(el, { clientX: 300, clientY: 300, pointerId: 2 });
    fireEvent.pointerMove(el, { clientX: 280, clientY: 302, pointerId: 2 });
    fireEvent.pointerUp(el, { clientX: 180, clientY: 302, pointerId: 2 });

    // "b" → next/older is "c".
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("c");
  });

  it("a committed RIGHT swipe selects the previous (newer) conversation", () => {
    const { controller, onSelect } = makeSwipeController();
    render(<ContinuousChatOverlay controller={controller} />);
    openSheet();

    const el = thread();
    // Drag RIGHT: clientX increases.
    fireEvent.pointerDown(el, { clientX: 180, clientY: 300, pointerId: 2 });
    fireEvent.pointerMove(el, { clientX: 200, clientY: 302, pointerId: 2 });
    fireEvent.pointerUp(el, { clientX: 300, clientY: 302, pointerId: 2 });

    // "b" → prev/newer is "a".
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("a");
  });

  it("lights an edge hint with the live drag offset while swiping", async () => {
    const { controller } = makeSwipeController();
    render(<ContinuousChatOverlay controller={controller} />);
    openSheet();

    const el = thread();
    // Hold mid-drag (no pointerUp) so swipeDx is live and the hint is mounted.
    // Dragging LEFT (clientX decreases) drives swipeDx > 0 — the next/older
    // conversation slides in from the RIGHT edge, so the RIGHT hint lights.
    fireEvent.pointerDown(el, { clientX: 300, clientY: 300, pointerId: 3 });
    fireEvent.pointerMove(el, { clientX: 240, clientY: 302, pointerId: 3 });

    const hint = await waitFor(() =>
      screen.getByTestId("conversation-swipe-hint-right"),
    );
    expect(hint).toBeTruthy();
    // Opacity scales with the drag distance (60px of 96px ≈ 0.625).
    expect(Number.parseFloat(hint.style.opacity)).toBeGreaterThan(0);
    // The opposite (left) hint stays inert while dragging left.
    expect(screen.queryByTestId("conversation-swipe-hint-left")).toBeNull();
  });

  it("does NOT switch conversations on a mostly-vertical drag (axis lock)", () => {
    const { controller, onSelect } = makeSwipeController();
    render(<ContinuousChatOverlay controller={controller} />);
    openSheet();

    const el = thread();
    // Vertical travel dominates → the gesture commits to the Y axis and never
    // fires a swipe, so the active conversation is unchanged.
    fireEvent.pointerDown(el, { clientX: 300, clientY: 300, pointerId: 4 });
    fireEvent.pointerMove(el, { clientX: 290, clientY: 220, pointerId: 4 });
    fireEvent.pointerUp(el, { clientX: 285, clientY: 140, pointerId: 4 });

    expect(onSelect).not.toHaveBeenCalled();
  });

  it("does not bind the swipe gesture while the sheet is collapsed", () => {
    const { controller, onSelect } = makeSwipeController();
    render(<ContinuousChatOverlay controller={controller} />);

    // No openSheet(): the transcript target is not mounted while collapsed, so
    // there is nothing to bind and no hidden layer can catch a swipe.
    expect(document.getElementById("continuous-thread")).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });
});

// The reported bug: clearing the chat dropped all messages, which unmounted the
// whole thread region, collapsing the open sheet to just the header + composer.
// The fix renders the thread whenever the sheet is OPEN (not only when there are
// messages), so an emptied/cleared conversation keeps its size and shows a
// loading state until its greeting lands.
describe("ContinuousChatOverlay — empty thread while the sheet is open", () => {
  function openSheetToHalf(): void {
    const grabber = screen.getByTestId("chat-sheet-grabber");
    fireEvent.pointerDown(grabber, { clientY: 420, pointerId: 1 });
    fireEvent.pointerMove(grabber, { clientY: 280, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 280, pointerId: 1 });
    expect(screen.getByTestId("chat-sheet").getAttribute("data-detent")).toBe(
      "half",
    );
  }

  it("keeps the thread mounted (no collapse) when the open conversation empties, and shows the loading spinner", () => {
    // Open with messages present (the gesture needs a thread to open into).
    const { rerender } = render(
      <ContinuousChatOverlay controller={makeController()} />,
    );
    openSheetToHalf();
    expect(document.getElementById("continuous-thread")).not.toBeNull();

    // Emptying the conversation (a clear in flight, awaiting the greeting) must
    // NOT unmount the thread — the sheet stays open at its size with a spinner.
    rerender(
      <ContinuousChatOverlay
        controller={makeController({
          messages: [],
          conversationLoading: true,
        } as Partial<ShellController>)}
      />,
    );
    expect(document.getElementById("continuous-thread")).not.toBeNull();
    expect(screen.getByTestId("chat-sheet").getAttribute("data-detent")).toBe(
      "half",
    );
    expect(screen.getByTestId("chat-thread-loading")).toBeTruthy();
  });

  it("shows no spinner on an empty open thread that is not loading", () => {
    const { rerender } = render(
      <ContinuousChatOverlay controller={makeController()} />,
    );
    openSheetToHalf();

    rerender(
      <ContinuousChatOverlay
        controller={makeController({
          messages: [],
          conversationLoading: false,
        } as Partial<ShellController>)}
      />,
    );
    // Thread stays mounted, but with no in-flight load there is no spinner.
    expect(document.getElementById("continuous-thread")).not.toBeNull();
    expect(screen.queryByTestId("chat-thread-loading")).toBeNull();
  });
});
