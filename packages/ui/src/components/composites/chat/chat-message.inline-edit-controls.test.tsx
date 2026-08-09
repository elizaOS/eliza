/** Verifies ChatMessage glass inline edit controls through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Glass-message inline editing keeps the overlay's action lane visually bare
 * while preserving labelled touch targets, cancel restoration, and save wiring.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ChatMessage } from "./chat-message";

beforeAll(() => {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes("hover: hover"),
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
});

afterEach(cleanup);

function openEditor(onEdit = vi.fn().mockResolvedValue(true)) {
  render(
    <ChatMessage
      appearance="glass"
      message={{ id: "message-1", role: "user", text: "Original message" }}
      onCopy={vi.fn()}
      onReply={vi.fn()}
      onEdit={onEdit}
    />,
  );

  fireEvent.pointerMove(screen.getByTestId("thread-line"), {
    pointerType: "mouse",
  });
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  return onEdit;
}

describe("ChatMessage glass inline edit controls", () => {
  it("keeps the editor above Mobile Safari's focus-zoom threshold", () => {
    openEditor();
    expect(screen.getByLabelText("Edit message").className).toContain(
      "pointer-coarse:text-base",
    );
  });

  it("uses two bare labelled icons instead of the old Cancel and Send plate", () => {
    openEditor();

    const cancel = screen.getByTestId("thread-line-edit-cancel");
    const save = screen.getByTestId("thread-line-edit-save");

    expect(cancel.getAttribute("aria-label")).toBe("Cancel");
    expect(save.getAttribute("aria-label")).toBe("Send");
    expect(cancel.textContent).toBe("");
    expect(save.textContent).toBe("");
  });

  it("restores the message action icons after Cancel", () => {
    openEditor();

    fireEvent.click(screen.getByTestId("thread-line-edit-cancel"));

    expect(screen.queryByLabelText("Edit message")).toBeNull();
    expect(
      screen.getByTestId("thread-line-actions").getAttribute("aria-hidden"),
    ).toBe("false");
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reply" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
  });

  it("submits the edited text from the icon-only Save control", async () => {
    const onEdit = openEditor();
    const input = screen.getByLabelText("Edit message");

    fireEvent.change(input, { target: { value: "Cleaner edited message" } });
    fireEvent.click(screen.getByTestId("thread-line-edit-save"));

    await waitFor(() => {
      expect(onEdit).toHaveBeenCalledWith(
        "message-1",
        "Cleaner edited message",
      );
    });
  });
});
