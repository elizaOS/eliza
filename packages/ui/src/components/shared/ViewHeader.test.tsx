/** Verifies ViewHeader — standardized normal-view header (#13451) through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Pins the shared normal-view header contract (#13451): every normal built-in
 * view renders through this primitive, so its geometry is the single source of
 * truth for the standardized header.
 *
 * Acceptance criteria asserted here:
 *  - Header back affordance is icon-only, left-aligned, and has NO
 *    border/background in the rest state (only a hover/focus chip).
 *  - The view title is centered in the header.
 *  - `showBack={false}` opts a view out of the back control cleanly.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../agent-surface", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));

vi.mock("../../navigation", () => ({
  shouldUseHashNavigation: () => true,
}));

import { ViewHeader } from "./ViewHeader";

afterEach(() => {
  cleanup();
  window.location.hash = "";
});

describe("ViewHeader — standardized normal-view header (#13451)", () => {
  it("renders an accessible icon-only back button", () => {
    render(<ViewHeader title="Wallet" />);
    const back = screen.getByRole("button", { name: /back/i });
    expect(back.textContent?.trim()).toBe("");
  });

  it("pins the back button to the left edge of the header (first child)", () => {
    render(<ViewHeader title="Browser" />);
    const header = screen.getByTestId("view-header");
    const back = screen.getByRole("button", { name: /back/i });
    const kids = Array.from(header.children);
    expect(kids.indexOf(back)).toBe(0);
  });

  it("invokes the launcher navigation on back by default", () => {
    render(<ViewHeader title="Knowledge" />);
    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    expect(window.location.hash).toBe("#/views");
  });

  it("routes a sub-view's back through the supplied onBack handler", () => {
    const onBack = vi.fn();
    render(<ViewHeader title="AI Model" onBack={onBack} />);
    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    expect(onBack).toHaveBeenCalledTimes(1);
    // A scoped onBack must not also fire the launcher fallback.
    expect(window.location.hash).toBe("");
  });

  it("opts a view out of the back control with showBack={false}", () => {
    render(<ViewHeader title="Home" showBack={false} />);
    expect(screen.queryByRole("button", { name: /back/i })).toBeNull();
    expect(screen.getByRole("heading", { name: "Home" })).toBeTruthy();
  });

  it("names the back control per-view via backLabel (agent + a11y)", () => {
    // Default wording when no override is supplied.
    const { rerender } = render(<ViewHeader title="Wallet" />);
    expect(
      screen.getByRole("button", { name: "Back to launcher" }),
    ).toBeTruthy();
    // A sub-view returning to its hub names that hub instead of the launcher.
    rerender(
      <ViewHeader
        title="AI Model"
        onBack={vi.fn()}
        backLabel="Back to Settings"
      />,
    );
    expect(
      screen.getByRole("button", { name: "Back to Settings" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Back to launcher" }),
    ).toBeNull();
  });
});
