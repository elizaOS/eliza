// @vitest-environment jsdom
//
// The desktop hover action rail's Copy button fires `onCopy` (which the
// ChatView wires to the clipboard helper) and reflects the copied state in its
// label. This closes the coverage gap called out in #9148 — the overlay copy
// was tested but the desktop ChatMessageActions copy was not.

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatMessageActions } from "./chat-message-actions";

afterEach(cleanup);

describe("ChatMessageActions copy", () => {
  it("invokes onCopy when the copy button is clicked", async () => {
    const onCopy = vi.fn();
    render(<ChatMessageActions onCopy={onCopy} />);
    await userEvent.click(screen.getByRole("button", { name: "Copy message" }));
    expect(onCopy).toHaveBeenCalledTimes(1);
  });

  it("reflects the copied state in the button label", () => {
    render(<ChatMessageActions copied onCopy={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: "Copied to clipboard" }),
    ).toBeTruthy();
  });

  it("uses provided copy labels when supplied", () => {
    render(
      <ChatMessageActions
        onCopy={vi.fn()}
        labels={{ copy: "Copy text", copiedAria: "Done" }}
      />,
    );
    expect(screen.getByRole("button", { name: "Copy text" })).toBeTruthy();
  });

  it("invokes onDelete when the delete button is enabled and clicked", async () => {
    const onDelete = vi.fn();
    render(<ChatMessageActions canDelete onDelete={onDelete} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Delete message" }),
    );
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("renders glass-row actions as unframed icons", () => {
    render(
      <ChatMessageActions
        appearance="glass-row"
        canDelete
        canEdit
        canReply
        onCopy={vi.fn()}
        onDelete={vi.fn()}
        onEdit={vi.fn()}
        onReply={vi.fn()}
      />,
    );

    for (const button of screen.getAllByRole("button")) {
      expect(button.className).toContain("bg-transparent");
      expect(button.className).toContain("rounded-none");
      expect(button.className).not.toContain("bg-white/10");
      expect(button.className).not.toContain("rounded-full");
    }
  });
});
