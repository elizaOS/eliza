// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
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

import { copyTextToClipboard } from "../../utils/clipboard";

import { ContinuousChatOverlay } from "./ContinuousChatOverlay";
import type { ShellController } from "./useShellController";

beforeAll(() => {
  // jsdom has no scrollIntoView; the overlay calls it when the thread grows.
  Element.prototype.scrollIntoView = vi.fn();
});

// Unmount between tests so renders don't accumulate in the shared document.
afterEach(cleanup);

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
    recording: false,
    transcript: "",
    // Required ShellController surface the overlay reads unconditionally — the
    // real controller always supplies these, so the mock must too.
    modelStatus: { kind: "ready" },
    send: vi.fn(),
    stop: vi.fn(),
    toggleRecording: vi.fn(),
    handsFree: false,
    toggleHandsFree: vi.fn(),
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

  it("opens the sheet when the composer input is focused (type-to-open)", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    expect(sheet.getAttribute("data-variant")).toBe("closed");
    fireEvent.focus(screen.getByLabelText("message"));
    expect(sheet.getAttribute("data-variant")).toBe("open");
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

  it("renders the full thread as one always-mounted scroll log", () => {
    const controller = makeController({
      messages: [
        { id: "a", role: "assistant", content: "one", createdAt: 1 },
        { id: "b", role: "user", content: "two", createdAt: 2 },
        { id: "c", role: "assistant", content: "three", createdAt: 3 },
      ],
    } as unknown as Partial<ShellController>);
    render(<ContinuousChatOverlay controller={controller} />);

    // The full transcript is always mounted; the thread is a vertical scroll
    // region whose height collapses to 0 when closed (the outer wrapper clips).
    const log = document.getElementById("continuous-thread");
    expect(log?.querySelectorAll('[data-testid="thread-line"]').length).toBe(3);
    expect(log?.className).toContain("overflow-y-auto");
    expect(log?.textContent).toContain("one");
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

  // ── Transcribe button lives in the composer beside the mic, gated on voice
  // being on (#8789). It's part of the always-present composer trailing cluster,
  // so it shows at any detent (no need to open the sheet header).
  it("hides the transcribe button while voice is off", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    // The mic is present, but with no active voice session the transcribe
    // control is not offered next to it.
    expect(screen.getByTestId("chat-composer-mic")).toBeTruthy();
    expect(screen.queryByTestId("chat-composer-transcribe")).toBeNull();
    expect(screen.queryByTestId("chat-transcribing-badge")).toBeNull();
  });

  it("reveals the transcribe button beside the mic while a hands-free voice session is active", () => {
    render(
      <ContinuousChatOverlay
        controller={makeController({
          handsFree: true,
          transcriptionMode: false,
          toggleTranscriptionMode: vi.fn(),
        } as unknown as Partial<ShellController>)}
      />,
    );
    const btn = screen.getByTestId("chat-composer-transcribe");
    expect(btn.getAttribute("aria-label")).toBe("transcription mode");
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    // It sits next to the mic (both in the composer trailing cluster).
    expect(screen.getByTestId("chat-composer-mic")).toBeTruthy();
  });

  it("reveals the transcribe button while the mic is open (push-to-talk recording)", () => {
    render(
      <ContinuousChatOverlay
        controller={makeController({
          phase: "listening",
          recording: true,
          toggleTranscriptionMode: vi.fn(),
        } as unknown as Partial<ShellController>)}
      />,
    );
    expect(screen.getByTestId("chat-composer-transcribe")).toBeTruthy();
  });

  it("shows the transcribe button as Stop (pressed) while transcribing, and wires the toggle", () => {
    const toggleTranscriptionMode = vi.fn();
    render(
      <ContinuousChatOverlay
        controller={makeController({
          transcriptionMode: true,
          toggleTranscriptionMode,
        } as unknown as Partial<ShellController>)}
      />,
    );
    const btn = screen.getByTestId("chat-composer-transcribe");
    expect(btn.getAttribute("aria-label")).toBe("stop transcription");
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(btn);
    expect(toggleTranscriptionMode).toHaveBeenCalledTimes(1);
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
    const toggleTranscriptionMode = vi.fn();
    const toggleHandsFree = vi.fn();
    render(
      <ContinuousChatOverlay
        controller={makeController({
          transcriptionMode: true,
          toggleTranscriptionMode,
          toggleHandsFree,
        } as unknown as Partial<ShellController>)}
      />,
    );
    fireEvent.click(screen.getByTestId("chat-composer-mic"));
    // Ends transcription (→ composer attachment); does NOT open a second capture.
    expect(toggleTranscriptionMode).toHaveBeenCalledTimes(1);
    expect(toggleHandsFree).not.toHaveBeenCalled();
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
});
