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
  client: { fetch: vi.fn().mockRejectedValue(new Error("no api in test")) },
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
    recording: false,
    transcript: "",
    send: vi.fn(),
    toggleRecording: vi.fn(),
    handsFree: false,
    toggleHandsFree: vi.fn(),
    setDictationSink: vi.fn(),
    setComposerHasDraft: vi.fn(),
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

  it("shows a disabled, no-op send control while a reply is pending (canSend false)", () => {
    const controller = makeController({ canSend: false });
    render(<ContinuousChatOverlay controller={controller} />);
    fireEvent.change(screen.getByLabelText("message"), {
      target: { value: "hello" },
    });
    // The control still swaps to send, but is labelled + guarded as waiting.
    const send = screen.getByLabelText("send (waiting for reply)");
    expect(send).toBeTruthy();
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

  it("opens straight to FULL when sending (not the stepped HALF)", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const input = screen.getByLabelText("message");
    fireEvent.change(input, { target: { value: "ping" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(sheet.getAttribute("data-detent")).toBe("full");
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
        controller={makeController({ phase: "responding" })}
      />,
    );
    const typing = screen.getByTestId("typing-dots");
    expect(typing.className).toContain("w-full");
    expect(typing.className).toContain("justify-start");
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

    const interactiveRegions = root.querySelectorAll(".pointer-events-auto");
    expect(interactiveRegions.length).toBeGreaterThan(0);
    expect(Array.from(interactiveRegions)).not.toContain(root);
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

  it("does NOT close on a pointer-down outside the sheet (no click-out dismiss)", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    fireEvent.focus(screen.getByLabelText("message"));
    expect(sheet.getAttribute("data-variant")).toBe("open");
    // Clicking the live view behind (here, the bare body) must NOT close it —
    // the only dismiss paths are a pull-down drag and Escape.
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
        controller={makeController({ phase: "responding" })}
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
    // The input is fully gone in pill mode.
    expect(screen.queryByTestId("chat-composer-textarea")).toBeNull();
  });

  it("recovers from the pill back to the input on tap", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");
    fireEvent.pointerDown(grabber, { clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(grabber, { clientY: 380, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 380, pointerId: 1 });
    const pill = screen.getByTestId("chat-pill");
    fireEvent.click(pill);
    expect(sheet.getAttribute("data-detent")).toBe("collapsed");
    expect(screen.getByTestId("chat-composer-textarea")).toBeTruthy();
  });

  it("flicks UP from the pill to recover the input", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");
    fireEvent.pointerDown(grabber, { clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(grabber, { clientY: 380, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 380, pointerId: 1 });
    const pill = screen.getByTestId("chat-pill");
    // A quick upward flick on the pill brings the input back.
    fireEvent.pointerDown(pill, { clientY: 400, pointerId: 1 });
    fireEvent.pointerMove(pill, { clientY: 360, pointerId: 1 });
    fireEvent.pointerUp(pill, { clientY: 360, pointerId: 1 });
    expect(sheet.getAttribute("data-detent")).toBe("collapsed");
    expect(screen.getByTestId("chat-composer-textarea")).toBeTruthy();
  });
});
