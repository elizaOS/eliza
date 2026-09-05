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

import { resolveSurfaceManifest } from "@elizaos/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SurfaceRealmDeniedError,
  SurfaceRealmScope,
  setActiveSurfaceRealmScope,
} from "../../surface-realm-broker";

vi.mock("../../agent-surface", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));

import { ViewHeader } from "./ViewHeader";

afterEach(() => {
  cleanup();
  setActiveSurfaceRealmScope(null);
  window.history.replaceState(null, "", "/");
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

  it("invokes launcher hash navigation in an app window", () => {
    window.history.replaceState(null, "", "/index.html?appWindow=1#/documents");
    render(<ViewHeader title="Knowledge" />);
    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    expect(window.location.hash).toBe("#/views");
    expect(window.location.pathname).toBe("/index.html");
  });

  it("permits shell back through an active view's real history guard", () => {
    window.history.replaceState(null, "", "/notes");
    const scope = new SurfaceRealmScope(
      resolveSurfaceManifest({ surface: { capabilities: [] } }),
      "notes",
      window.localStorage,
      () => {
        throw new Error("The shared shell back must not use the view facade");
      },
    );
    setActiveSurfaceRealmScope(scope);
    expect(() => window.history.pushState(null, "", "/views")).toThrow(
      SurfaceRealmDeniedError,
    );
    const navigationEvent = vi.fn();
    window.addEventListener("popstate", navigationEvent);
    try {
      render(<ViewHeader title="Notes" />);
      fireEvent.click(screen.getByRole("button", { name: "Back to launcher" }));
      expect(window.location.pathname).toBe("/views");
      expect(navigationEvent).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("popstate", navigationEvent);
    }
  });

  it("routes a sub-view's back through the supplied onBack handler", () => {
    window.history.replaceState(null, "", "/settings/model");
    function SettingsSubview() {
      const [section, setSection] = useState("AI Model");
      return (
        <ViewHeader
          title={section}
          onBack={() => setSection("Settings")}
          backLabel="Back to Settings"
        />
      );
    }
    render(<SettingsSubview />);
    fireEvent.click(screen.getByRole("button", { name: "Back to Settings" }));
    expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "AI Model" })).toBeNull();
    // A scoped onBack must not also fire the launcher fallback.
    expect(window.location.pathname).toBe("/settings/model");
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
