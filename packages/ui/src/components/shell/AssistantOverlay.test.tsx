// @vitest-environment jsdom

// AssistantOverlay: the shell dialog container that shows the assistant chat
// when the shell phase is open ({summoned, listening, responding}) and unmounts
// otherwise. This test drives the real component via its `phase`/`onClose`
// props and asserts the open/close semantic, the close-button + Escape paths,
// and that children mount only when open. ContinuousChatOverlay (the actual
// chat surface passed as children) is intentionally NOT exercised here — a
// sentinel child stands in for it.

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ShellPhase } from "./shell-state";
import { AssistantOverlay } from "./AssistantOverlay";

afterEach(cleanup);

const OPEN_PHASES: ShellPhase[] = ["summoned", "listening", "responding"];
const CLOSED_PHASES: ShellPhase[] = ["booting", "idle"];

function renderOverlay(phase: ShellPhase, onClose = vi.fn()) {
  const utils = render(
    <AssistantOverlay phase={phase} onClose={onClose}>
      <div data-testid="chat-child">chat surface</div>
    </AssistantOverlay>,
  );
  return { onClose, ...utils };
}

describe("AssistantOverlay phase gating", () => {
  it.each(OPEN_PHASES)("renders the dialog + children when phase=%s", (phase) => {
    const { container } = renderOverlay(phase);
    const dialog = container.querySelector<HTMLElement>(
      '[data-testid="shell-assistant-overlay"]',
    );
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("role")).toBe("dialog");
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(dialog?.getAttribute("data-phase")).toBe(phase);
    // Children mount only when open.
    expect(
      container.querySelector('[data-testid="chat-child"]'),
    ).not.toBeNull();
  });

  it.each(CLOSED_PHASES)(
    "renders nothing (returns null) when phase=%s",
    (phase) => {
      const { container } = renderOverlay(phase);
      expect(
        container.querySelector('[data-testid="shell-assistant-overlay"]'),
      ).toBeNull();
      // Children must not mount when closed.
      expect(container.querySelector('[data-testid="chat-child"]')).toBeNull();
    },
  );

  it("unmounts the dialog + children when phase transitions open -> closed", () => {
    const onClose = vi.fn();
    const { container, rerender } = render(
      <AssistantOverlay phase="summoned" onClose={onClose}>
        <div data-testid="chat-child">chat surface</div>
      </AssistantOverlay>,
    );
    expect(
      container.querySelector('[data-testid="shell-assistant-overlay"]'),
    ).not.toBeNull();

    rerender(
      <AssistantOverlay phase="idle" onClose={onClose}>
        <div data-testid="chat-child">chat surface</div>
      </AssistantOverlay>,
    );
    expect(
      container.querySelector('[data-testid="shell-assistant-overlay"]'),
    ).toBeNull();
    expect(container.querySelector('[data-testid="chat-child"]')).toBeNull();
  });
});

describe("AssistantOverlay close paths", () => {
  it("close button fires onClose exactly once", () => {
    const { container, onClose } = renderOverlay("summoned");
    const closeBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Close assistant"]',
    );
    expect(closeBtn).not.toBeNull();
    fireEvent.click(closeBtn as HTMLButtonElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape on document fires onClose", () => {
    const { onClose } = renderOverlay("listening");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not fire onClose while closed (no Escape listener when phase=idle)", () => {
    const { onClose } = renderOverlay("idle");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("non-Escape keys do not fire onClose", () => {
    const { onClose } = renderOverlay("summoned");
    fireEvent.keyDown(document, { key: "a" });
    fireEvent.keyDown(document, { key: "Enter" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("rapid-fire: repeated Escape fires onClose once per press (no swallow, no dedupe)", () => {
    const { onClose } = renderOverlay("responding");
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("Escape listener is torn down after close (no stale onClose after unmount)", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <AssistantOverlay phase="summoned" onClose={onClose}>
        <div data-testid="chat-child">chat surface</div>
      </AssistantOverlay>,
    );
    rerender(
      <AssistantOverlay phase="idle" onClose={onClose}>
        <div data-testid="chat-child">chat surface</div>
      </AssistantOverlay>,
    );
    onClose.mockClear();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
