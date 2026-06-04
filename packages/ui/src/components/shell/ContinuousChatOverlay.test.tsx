// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// The resting overlay's suggestion strip fetches model suggestions via the
// shared client; stub it so the strip stays on its static fallback in tests.
vi.mock("../../api/client", () => ({
  client: { fetch: vi.fn().mockRejectedValue(new Error("no api in test")) },
}));

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

  it("reveals the thread when the composer input is focused", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    expect(document.getElementById("continuous-thread")).toBeNull();
    fireEvent.focus(screen.getByLabelText("message"));
    expect(document.getElementById("continuous-thread")).toBeTruthy();
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

  it("collapses the expanded thread on Escape", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const input = screen.getByLabelText("message");
    fireEvent.focus(input);
    expect(document.getElementById("continuous-thread")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(document.getElementById("continuous-thread")).toBeNull();
  });

  it("toggles a full-screen takeover with an opaque focus backdrop", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const root = screen.getByTestId("continuous-chat-overlay");
    const backdrop = screen.getByTestId("chat-fullscreen-backdrop");
    expect(root.getAttribute("data-fullscreen")).toBeNull();
    // Resting: backdrop is transparent + click-through (view stays visible).
    expect(backdrop.className).toContain("opacity-0");
    expect(backdrop.className).toContain("pointer-events-none");

    // Far-left button enters full screen and opens the thread over the view.
    fireEvent.click(screen.getByLabelText("expand to full screen"));
    expect(root.getAttribute("data-fullscreen")).toBe("true");
    expect(document.getElementById("continuous-thread")).toBeTruthy();
    // Backdrop becomes a solid theme-colored screen that blocks the view.
    expect(backdrop.className).toContain("bg-bg");
    expect(backdrop.className).toContain("opacity-100");
    expect(backdrop.className).toContain("pointer-events-auto");

    // Pressing it again returns to normal (ambient) mode.
    fireEvent.click(screen.getByLabelText("exit full screen"));
    expect(root.getAttribute("data-fullscreen")).toBeNull();
    expect(document.getElementById("continuous-thread")).toBeNull();
    expect(backdrop.className).toContain("opacity-0");
  });

  it("shows only the last 2 turns with no scroll while typing, full history in fullscreen", () => {
    const controller = makeController({
      messages: [
        { id: "a", role: "assistant", content: "one", createdAt: 1 },
        { id: "b", role: "user", content: "two", createdAt: 2 },
        { id: "c", role: "assistant", content: "three", createdAt: 3 },
      ],
    } as unknown as Partial<ShellController>);
    render(<ContinuousChatOverlay controller={controller} />);

    // Typing (partial): only the last 2 turns, no scroll.
    fireEvent.focus(screen.getByLabelText("message"));
    const log = document.getElementById("continuous-thread");
    expect(log?.querySelectorAll('[data-testid="thread-line"]').length).toBe(2);
    expect(log?.className).toContain("overflow-hidden");
    expect(log?.textContent).not.toContain("one");
    expect(log?.textContent).toContain("three");

    // Fullscreen: full history + scroll.
    fireEvent.click(screen.getByLabelText("expand to full screen"));
    const fsLog = document.getElementById("continuous-thread");
    expect(fsLog?.querySelectorAll('[data-testid="thread-line"]').length).toBe(
      3,
    );
    expect(fsLog?.className).toContain("overflow-y-auto");
    expect(fsLog?.textContent).toContain("one");
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

  it("toggles recording when the mic is pressed", () => {
    const controller = makeController();
    render(<ContinuousChatOverlay controller={controller} />);
    fireEvent.click(screen.getByLabelText("talk"));
    expect(controller.toggleRecording).toHaveBeenCalled();
  });

  it("shows a connecting placeholder and read-only input while booting", () => {
    render(
      <ContinuousChatOverlay
        controller={makeController({ phase: "booting", canSend: false })}
      />,
    );
    const input = screen.getByLabelText("message");
    expect(input.getAttribute("placeholder")).toContain("connecting");
    expect(input.hasAttribute("readonly")).toBe(true);
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

  it("shows exactly three resting prompt suggestions", () => {
    render(
      <ContinuousChatOverlay
        controller={makeController({
          messages: [],
        } as unknown as Partial<ShellController>)}
      />,
    );
    const strip = screen.getByTestId("chat-suggestions");
    expect(
      strip.querySelectorAll('[data-testid^="chat-suggestion-"]'),
    ).toHaveLength(3);
  });

  it("scrolls to the latest line when a new message arrives in fullscreen", () => {
    const base = [{ id: "a", role: "assistant", content: "hi", createdAt: 1 }];
    const { rerender } = render(
      <ContinuousChatOverlay
        controller={makeController({
          messages: base,
        } as unknown as Partial<ShellController>)}
      />,
    );
    // Only the fullscreen transcript scrolls; the resting/typing view does not.
    fireEvent.click(screen.getByLabelText("expand to full screen"));
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

  it("collapses the thread on a pointer-down outside the bubbles and composer", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    fireEvent.focus(screen.getByLabelText("message"));
    expect(document.getElementById("continuous-thread")).toBeTruthy();
    // A click on the live view behind (here, the bare document body) closes it.
    fireEvent.pointerDown(document.body);
    expect(document.getElementById("continuous-thread")).toBeNull();
  });

  it("keeps the thread open when a message bubble is clicked", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    fireEvent.focus(screen.getByLabelText("message"));
    const bubble = document.querySelector('[data-testid="thread-line"]');
    expect(bubble).toBeTruthy();
    fireEvent.pointerDown(bubble as Element);
    expect(document.getElementById("continuous-thread")).toBeTruthy();
  });

  it("keeps the thread open when the composer is clicked", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const input = screen.getByLabelText("message");
    fireEvent.focus(input);
    fireEvent.pointerDown(input);
    expect(document.getElementById("continuous-thread")).toBeTruthy();
  });
});
