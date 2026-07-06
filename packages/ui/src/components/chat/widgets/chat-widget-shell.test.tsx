// @vitest-environment jsdom

/**
 * Contract tests for {@link ChatWidgetShell} (#14412) — the standardized
 * collapsible shell every chat widget wraps. Pins the lifecycle contract:
 * starts expanded while incomplete, mounts collapsed when already complete,
 * auto-collapses/auto-expands on `complete` transitions, and stays
 * re-expandable via the chevron with user toggles sticking between
 * transitions. Also pins the repaint design: the collapsed body remains
 * MOUNTED (field state survives a collapse/expand round-trip) but carries
 * `display:none` + `content-visibility:hidden` so it costs no layout.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __setAppValueForTests } from "../../../state/app-store";
import { ChatWidgetShell } from "./chat-widget-shell";

beforeEach(() => {
  // The shell reads only `t` from the app store (chevron aria-labels).
  __setAppValueForTests({
    t: (key: string, vars?: Record<string, unknown>) =>
      String(vars?.defaultValue ?? key),
  } as never);
});

afterEach(() => {
  cleanup();
  __setAppValueForTests(null);
});

function shell(complete: boolean) {
  return (
    <ChatWidgetShell
      testId="shell"
      title="Discord Configuration"
      status={<span>Inactive</span>}
      summary="Discord is enabled."
      complete={complete}
    >
      <input data-testid="shell-field" defaultValue="" />
    </ChatWidgetShell>
  );
}

function body() {
  return screen.getByTestId("shell-body");
}

function chevron() {
  return screen.getByTestId("shell-chevron");
}

describe("ChatWidgetShell — initial expansion", () => {
  it("starts expanded while incomplete: visible body, no summary row", () => {
    render(shell(false));
    expect(chevron().getAttribute("aria-expanded")).toBe("true");
    expect(body().style.display).toBe("");
    expect(body().getAttribute("aria-hidden")).toBe("false");
    expect(screen.queryByTestId("shell-summary")).toBeNull();
  });

  it("mounts collapsed when already complete: summary row + hidden body", () => {
    render(shell(true));
    expect(chevron().getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByTestId("shell-summary").textContent).toContain(
      "Discord is enabled.",
    );
    // The body is hidden, not unmounted: display none removes it from layout
    // universally, content-visibility documents the render-skip intent.
    expect(body().style.display).toBe("none");
    expect(body().style.contentVisibility).toBe("hidden");
    expect(body().getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByTestId("shell-field")).toBeTruthy();
  });
});

describe("ChatWidgetShell — complete transitions", () => {
  it("auto-collapses on incomplete → complete and preserves body field state", () => {
    const { rerender } = render(shell(false));
    fireEvent.change(screen.getByTestId("shell-field"), {
      target: { value: "draft token" },
    });

    rerender(shell(true));

    expect(chevron().getAttribute("aria-expanded")).toBe("false");
    expect(body().style.display).toBe("none");
    // The in-progress edit survived the collapse because the body never
    // unmounted.
    expect((screen.getByTestId("shell-field") as HTMLInputElement).value).toBe(
      "draft token",
    );
  });

  it("auto-expands on complete → incomplete (disconnect reopens setup)", () => {
    const { rerender } = render(shell(true));
    expect(chevron().getAttribute("aria-expanded")).toBe("false");

    rerender(shell(false));

    expect(chevron().getAttribute("aria-expanded")).toBe("true");
    expect(body().style.display).toBe("");
    expect(screen.queryByTestId("shell-summary")).toBeNull();
  });
});

describe("ChatWidgetShell — chevron toggle", () => {
  it("re-expands a collapsed complete widget and collapses it back", () => {
    render(shell(true));

    fireEvent.click(chevron());
    expect(chevron().getAttribute("aria-expanded")).toBe("true");
    expect(body().style.display).toBe("");
    expect(screen.queryByTestId("shell-summary")).toBeNull();

    fireEvent.click(chevron());
    expect(chevron().getAttribute("aria-expanded")).toBe("false");
    expect(body().style.display).toBe("none");
    expect(screen.getByTestId("shell-summary")).toBeTruthy();
  });

  it("a user toggle sticks across re-renders that do not change `complete`", () => {
    const { rerender } = render(shell(true));
    fireEvent.click(chevron());
    expect(chevron().getAttribute("aria-expanded")).toBe("true");

    // Unrelated parent re-render (same complete value) must not undo the
    // user's expansion — only a `complete` transition resets it.
    rerender(shell(true));
    expect(chevron().getAttribute("aria-expanded")).toBe("true");
  });
});
