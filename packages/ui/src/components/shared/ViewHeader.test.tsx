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

const goLauncherMock = vi.hoisted(() => vi.fn());
vi.mock("../../state/shell-surface-store", () => ({
  goLauncher: goLauncherMock,
}));

vi.mock("../../navigation", () => ({
  shouldUseHashNavigation: () => true,
}));

import { ViewHeader } from "./ViewHeader";

afterEach(() => {
  cleanup();
  goLauncherMock.mockClear();
});

describe("ViewHeader — standardized normal-view header (#13451)", () => {
  it("centers the title across the full header width", () => {
    render(<ViewHeader title="Settings" />);
    const title = screen.getByRole("heading", { name: "Settings" });
    // Centered over the full header (absolute inset-x-0 + mx-auto + centered
    // text), NOT within a side-dependent grid track, so it stays centered
    // regardless of back/right control widths.
    expect(title.className).toContain("absolute");
    expect(title.className).toContain("inset-x-0");
    expect(title.className).toContain("mx-auto");
    expect(title.className).toContain("text-center");
    // Regression guards: never re-introduce the track-local alignment that
    // shifted the title when actions were wider than the back button.
    expect(title.className).not.toContain("justify-self-start");
    expect(title.className).not.toContain("sm:justify-self-start");
  });

  it("renders an icon-only back button with no rest-state border or fill", () => {
    render(<ViewHeader title="Wallet" />);
    const back = screen.getByRole("button", { name: /back/i });
    // Chromeless at rest: transparent background, no border.
    expect(back.className).toContain("bg-transparent");
    expect(back.className).not.toContain("border");
    // Rest state has no accent/neutral chip fill (regression guard for the
    // old `bg-bg` fill that read as a chip).
    expect(back.className).not.toContain("bg-bg ");
    expect(back.className).not.toMatch(/\bbg-bg\b(?!-)/);
    // Hover/focus is the ONLY place a chip appears.
    expect(back.className).toContain("hover:bg-bg-hover");
    // Icon-only: no visible text label in the button.
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
    expect(goLauncherMock).toHaveBeenCalledTimes(1);
  });

  it("routes a sub-view's back through the supplied onBack handler", () => {
    const onBack = vi.fn();
    render(<ViewHeader title="AI Model" onBack={onBack} />);
    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    expect(onBack).toHaveBeenCalledTimes(1);
    // A scoped onBack must not also fire the launcher fallback.
    expect(goLauncherMock).not.toHaveBeenCalled();
  });

  it("opts a view out of the back control with showBack={false}", () => {
    render(<ViewHeader title="Home" showBack={false} />);
    expect(screen.queryByRole("button", { name: /back/i })).toBeNull();
    // Title still present and centered even with no back control.
    const title = screen.getByRole("heading", { name: "Home" });
    expect(title.className).toContain("text-center");
    expect(title.className).toContain("mx-auto");
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
    expect(screen.queryByRole("button", { name: "Back to launcher" })).toBeNull();
  });

  it("keeps the title centered even when the right action is wide", () => {
    render(
      <ViewHeader
        title="Wallet"
        right={<button type="button">A very wide refresh action</button>}
      />,
    );
    const header = screen.getByTestId("view-header");
    const title = screen.getByRole("heading", { name: "Wallet" });
    // Centering is anchored to the full header, not a side-dependent track, so
    // a wide right action cannot shift the title (the earlier grid-track
    // regression). No fixed/asymmetric grid tracks remain.
    expect(title.className).toContain("absolute");
    expect(title.className).toContain("inset-x-0");
    expect(title.className).toContain("mx-auto");
    expect(header.className).not.toContain("grid-cols-");
  });

  it("renders trailing actions at the right edge, above the centered title", () => {
    render(
      <ViewHeader
        title="Wallet"
        right={<button type="button">Refresh</button>}
      />,
    );
    const refresh = screen.getByRole("button", { name: "Refresh" });
    const title = screen.getByRole("heading", { name: "Wallet" });
    // Actions render (rightmost edge) and stay clickable above the centered
    // title layer; the title itself is pointer-events-none so it never eats
    // clicks meant for the controls.
    expect(refresh).toBeTruthy();
    expect(title.className).toContain("pointer-events-none");
    expect(title.className).toContain("text-center");
  });
});
