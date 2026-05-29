// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AssistantOverlay } from "../AssistantOverlay";

afterEach(() => cleanup());

describe("AssistantOverlay", () => {
  it("renders nothing when phase=idle", () => {
    render(
      <AssistantOverlay phase="idle" onClose={() => {}}>
        <div>inner</div>
      </AssistantOverlay>,
    );
    expect(screen.queryByText("inner")).toBeNull();
  });

  it("renders nothing when phase=booting", () => {
    render(
      <AssistantOverlay phase="booting" onClose={() => {}}>
        <div>inner</div>
      </AssistantOverlay>,
    );
    expect(screen.queryByText("inner")).toBeNull();
  });

  it("renders children when phase=summoned", () => {
    render(
      <AssistantOverlay phase="summoned" onClose={() => {}}>
        <div>inner</div>
      </AssistantOverlay>,
    );
    expect(screen.getByText("inner")).toBeTruthy();
  });

  it("renders children when phase=listening", () => {
    render(
      <AssistantOverlay phase="listening" onClose={() => {}}>
        <div>inner</div>
      </AssistantOverlay>,
    );
    expect(screen.getByText("inner")).toBeTruthy();
  });

  it("renders children when phase=responding", () => {
    render(
      <AssistantOverlay phase="responding" onClose={() => {}}>
        <div>inner</div>
      </AssistantOverlay>,
    );
    expect(screen.getByText("inner")).toBeTruthy();
  });

  it("calls onClose when Escape is pressed while open", () => {
    const onClose = vi.fn();
    render(
      <AssistantOverlay phase="summoned" onClose={onClose}>
        <div>inner</div>
      </AssistantOverlay>,
    );
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("offers a visible close button for pointer users", () => {
    const onClose = vi.fn();
    render(
      <AssistantOverlay phase="summoned" onClose={onClose}>
        <button type="button">inside</button>
      </AssistantOverlay>,
    );

    fireEvent.click(screen.getByRole("button", { name: /close assistant/i }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not call onClose when Escape is pressed while phase=idle", () => {
    const onClose = vi.fn();
    render(
      <AssistantOverlay phase="idle" onClose={onClose}>
        <div>inner</div>
      </AssistantOverlay>,
    );
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("exposes role=dialog and aria-modal=true when open", () => {
    render(
      <AssistantOverlay phase="summoned" onClose={() => {}}>
        <div>inner</div>
      </AssistantOverlay>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
  });

  it("removes the Escape listener on unmount", () => {
    const onClose = vi.fn();
    const { unmount } = render(
      <AssistantOverlay phase="summoned" onClose={onClose}>
        <div>inner</div>
      </AssistantOverlay>,
    );
    unmount();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("moves focus into the dialog when it opens", () => {
    const triggerButton = document.createElement("button");
    triggerButton.textContent = "open";
    document.body.appendChild(triggerButton);
    triggerButton.focus();
    expect(document.activeElement).toBe(triggerButton);

    render(
      <AssistantOverlay phase="summoned" onClose={() => {}}>
        <button type="button">first-inside</button>
        <button type="button">second-inside</button>
      </AssistantOverlay>,
    );

    // Focus moves to the first focusable control inside the dialog.
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: /close assistant/i }),
    );

    triggerButton.remove();
  });

  it("restores focus to the previously focused element on unmount/close", () => {
    const triggerButton = document.createElement("button");
    triggerButton.textContent = "trigger";
    document.body.appendChild(triggerButton);
    triggerButton.focus();

    const { unmount } = render(
      <AssistantOverlay phase="summoned" onClose={() => {}}>
        <button type="button">inside</button>
      </AssistantOverlay>,
    );

    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: /close assistant/i }),
    );
    unmount();
    expect(document.activeElement).toBe(triggerButton);
    triggerButton.remove();
  });

  it("traps Tab inside the dialog (Shift+Tab from first wraps to last)", () => {
    render(
      <AssistantOverlay phase="summoned" onClose={() => {}}>
        <button type="button">alpha</button>
        <button type="button">omega</button>
      </AssistantOverlay>,
    );

    // After open the first descendant has focus.
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: /close assistant/i }),
    );

    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement?.textContent).toBe("omega");

    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: /close assistant/i }),
    );
  });
});
