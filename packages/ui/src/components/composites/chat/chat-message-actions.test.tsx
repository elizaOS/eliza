/** Verifies ChatMessageActions copy through the package's configured test harness. */
// @vitest-environment jsdom
//
/**
 * Behavior and presentation checks for shared per-message actions. The real
 * controls render directly so callback, confirmation, panel glass, bare
 * overlay icons, and the absence of destructive actions stay locked together.
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
    expect(copy.className.split(" ")).toContain("hover:bg-transparent");
    expect(screen.getByTestId("copy-status-icon").dataset.state).toBe("copied");
  });

  it("animates copy feedback in place without replacing the action surface", () => {
    const onCopy = vi.fn();
    const { rerender } = render(
      <ChatMessageActions
        appearance="glass-row"
        copied={false}
        onCopy={onCopy}
      />,
    );
    const surface = screen.getByTestId("thread-line-action-surface");
    const copy = screen.getByRole("button", { name: "Copy" });
    expect(
      screen
        .getAllByTestId("copy-status-icon")
        .some((icon) => icon.dataset.state === "idle"),
    ).toBe(true);

    rerender(
      <ChatMessageActions appearance="glass-row" copied onCopy={onCopy} />,
    );
    expect(screen.getByTestId("thread-line-action-surface")).toBe(surface);
    expect(screen.getByRole("button", { name: "Copied!" })).toBe(copy);
    expect(
      screen
        .getAllByTestId("copy-status-icon")
        .some((icon) => icon.dataset.state === "copied"),
    ).toBe(true);

    rerender(
      <ChatMessageActions
        appearance="glass-row"
        copied={false}
        onCopy={onCopy}
      />,
    );
    expect(screen.getByTestId("thread-line-action-surface")).toBe(surface);
    expect(screen.getByRole("button", { name: "Copy" })).toBe(copy);
    expect(
      screen
        .getAllByTestId("copy-status-icon")
        .some((icon) => icon.dataset.state === "idle"),
    ).toBe(true);
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

  it("renders overlay actions as a bare icon lane", () => {
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
    expect(surface.className).not.toContain("bg-black/55");
    expect(surface.className).not.toContain("border-white/25");
    expect(surface.className).not.toContain("rounded-xl");
    expect(surface.style.backgroundImage).toBe("");
    expect(surface.style.backdropFilter).toBe("");

    for (const button of screen.getAllByRole("button")) {
      expect(button.className).toContain("bg-transparent");
      expect(button.className).toContain("rounded-none");
      expect(button.className).toContain("h-5");
      expect(button.className).toContain("hover:bg-transparent");
      expect(button.className).toContain("pointer-coarse:h-11");
      expect(button.className).not.toContain("bg-white/10");
      expect(button.className).toContain("keyboard-focus-emphasis");
      expect(button.className).not.toContain("text-[rgb(255");
    }
    expect(screen.queryByRole("button", { name: /delete/i })).toBeNull();
  });

});
