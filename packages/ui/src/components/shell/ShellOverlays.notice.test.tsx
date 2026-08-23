// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ActionNoticeToast } from "./ShellOverlays";

afterEach(cleanup);

describe("ActionNoticeToast", () => {
  it("exposes a close control that dismisses the notice", () => {
    const onDismiss = vi.fn();
    render(
      <ActionNoticeToast
        notice={{ tone: "error", text: "Voice transcription failed." }}
        onDismiss={onDismiss}
      />,
    );

    expect(screen.getByRole("status").textContent).toContain(
      "Voice transcription failed.",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss notification" }),
    );
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("keeps only the close control pointer-interactive", () => {
    render(
      <ActionNoticeToast
        notice={{ tone: "info", text: "Working", busy: true }}
        onDismiss={() => {}}
      />,
    );

    expect(
      screen.getByTestId("shell-action-notice").parentElement?.className,
    ).toContain("pointer-events-none");
    expect(
      screen.getByRole("button", { name: "Dismiss notification" }).className,
    ).toContain("pointer-events-auto");
    expect(screen.getByRole("status").getAttribute("aria-busy")).toBe("true");
  });
});
