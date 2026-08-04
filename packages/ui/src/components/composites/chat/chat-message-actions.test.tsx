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
});
