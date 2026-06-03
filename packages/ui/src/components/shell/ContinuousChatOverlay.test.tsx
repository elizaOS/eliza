// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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

  it("expands the thread from the chat icon and exposes aria-expanded / a log region", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const toggle = screen.getByLabelText("show conversation");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(
      screen.getByLabelText("hide conversation").getAttribute("aria-expanded"),
    ).toBe("true");
    expect(document.getElementById("continuous-thread")).toBeTruthy();
  });

  it("reveals the thread when the composer input is focused", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    expect(document.getElementById("continuous-thread")).toBeNull();
    fireEvent.focus(screen.getByLabelText("message"));
    expect(document.getElementById("continuous-thread")).toBeTruthy();
  });

  it("filters whitespace-only messages from the expanded thread", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    fireEvent.click(screen.getByLabelText("show conversation"));
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
    fireEvent.click(screen.getByLabelText("show conversation"));
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
    fireEvent.click(screen.getByLabelText("show conversation"));
    const input = screen.getByLabelText("message");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.getByLabelText("show conversation")).toBeTruthy();
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
});
