// @vitest-environment jsdom
//
/**
 * Behavior and material checks for the shared per-message action plate. The
 * real controls render directly so callback, confirmation, neutral glass, and
 * the absence of a destructive message action stay locked together.
 */

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
    render(
      <ChatMessageActions appearance="glass-row" copied onCopy={vi.fn()} />,
    );
    const copy = screen.getByRole("button", { name: "Copied!" });
    expect(copy).toBeTruthy();
    expect(copy.className.split(" ")).toContain("bg-transparent");
    expect(copy.className.split(" ")).not.toContain("bg-white/10");
    expect(copy.className.split(" ")).toContain("hover:bg-white/10");
    expect(screen.getByTestId("copy-status-icon").dataset.state).toBe("copied");
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

  it("renders every action on one neutral liquid-glass plate", () => {
    render(
      <ChatMessageActions
        appearance="glass-row"
        canEdit
        canPlay
        canReply
        onCopy={vi.fn()}
        onEdit={vi.fn()}
        onPlay={vi.fn()}
        onReply={vi.fn()}
      />,
    );

    const surface = screen.getByTestId("thread-line-action-surface");
    expect(surface.className).toContain("bg-black/55");
    expect(surface.className).toContain("border-white/25");
    expect(surface.style.backgroundImage).toContain("radial-gradient");
    expect(surface.style.backdropFilter).toContain("blur");

    for (const button of screen.getAllByRole("button")) {
      expect(button.className).toContain("bg-transparent");
      expect(button.className).not.toContain("rounded-full");
      expect(button.className).not.toContain("text-[rgb(255");
    }
    expect(screen.queryByRole("button", { name: /delete/i })).toBeNull();
  });
});
