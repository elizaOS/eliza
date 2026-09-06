// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionNoticeToast } from "./ShellOverlays";

afterEach(cleanup);
describe("action notice", () => {
  it("allows dismissing an error without hiding its explanation", () => {
    const dismiss = vi.fn();
    render(
      <ActionNoticeToast
        notice={{
          text: "Voice transcription is unavailable. Try again in a moment.",
          tone: "error",
        }}
        onDismiss={dismiss}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain(
      "Voice transcription is unavailable",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss notification" }),
    );
    expect(dismiss).toHaveBeenCalledOnce();
  });
  it("keeps long-running notices accessible and dismissible", () => {
    render(
      <ActionNoticeToast
        notice={{ text: "Saving…", tone: "info", busy: true }}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByRole("status").getAttribute("aria-busy")).toBe("true");
    expect(
      screen.getByRole("button", { name: "Dismiss notification" }),
    ).toBeTruthy();
  });
});
