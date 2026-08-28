/** Verifies <SlashCommandMenu> closed-state three-state degrade (#12784) through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Three-state degrade contract for <SlashCommandMenu> (#12784 split of #12267).
 *
 * When the menu is not open, the closed branch must render three DISTINGUISHABLE
 * states rather than collapsing a failed catalog load into a silent empty menu:
 *  - loading      -> the "loading commands…" status row
 *  - error        -> a distinct "couldn't load commands" status row
 *  - idle/success -> nothing (the menu simply does not mount)
 *
 * A failed catalog fetch previously rendered identically to "no commands"
 * (nothing), so a network/5xx/parse failure was indistinguishable from a
 * genuinely empty catalog. This pins the visible error affordance.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SlashCommandMenu, type SlashMenuState } from "./SlashCommandMenu";

function closedState(): SlashMenuState {
  return {
    open: false,
    mode: "none",
    items: [],
    activeIndex: 0,
    headerLabel: "",
    setActiveIndex: () => {},
    move: () => {},
    complete: () => null,
    resolve: () => null,
  };
}

afterEach(() => cleanup());

describe("<SlashCommandMenu> closed-state three-state degrade (#12784)", () => {
  it("renders nothing when idle (not loading, no error, closed)", () => {
    const { container } = render(
      <SlashCommandMenu state={closedState()} onPick={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId("slash-menu-loading")).toBeNull();
    expect(screen.queryByTestId("slash-menu-error")).toBeNull();
  });

  it("renders the loading state while the catalog is loading", () => {
    render(
      <SlashCommandMenu state={closedState()} onPick={() => {}} loading />,
    );
    expect(screen.getByTestId("slash-menu-loading")).toBeTruthy();
    expect(screen.queryByTestId("slash-menu-error")).toBeNull();
  });

  it("renders loading text in the fixed wallpaper white ladder, never tone-inverse black", () => {
    // The loading card rides the near-black wallpaper overlay; its old
    // tone="inverse" resolved to black-on-black and rendered the row
    // invisible (story-gate blank-render for the Loading story). The white
    // ladder is owned by the atom's visualStyle paint channel via semantic
    // wallpaper-overlay variables, not a painted text-* class.
    render(
      <SlashCommandMenu state={closedState()} onPick={() => {}} loading />,
    );
    const card = screen.getByTestId("slash-menu-loading");
    expect(card.style.color).toBe("var(--txt-wallpaper-overlay)");
    expect(card.style.borderColor).toBe("var(--border-wallpaper-overlay)");
    expect(card.className).not.toContain("text-inverse-foreground");
  });

  it("renders a DISTINCT error state when the catalog load failed", () => {
    render(<SlashCommandMenu state={closedState()} onPick={() => {}} error />);
    const err = screen.getByTestId("slash-menu-error");
    expect(err).toBeTruthy();
    expect(err.textContent).toContain("couldn't load commands");
    // Must not be mistaken for loading or an empty/absent menu.
    expect(screen.queryByTestId("slash-menu-loading")).toBeNull();
  });

  it("loading takes precedence over error while both are set", () => {
    render(
      <SlashCommandMenu
        state={closedState()}
        onPick={() => {}}
        loading
        error
      />,
    );
    expect(screen.getByTestId("slash-menu-loading")).toBeTruthy();
    expect(screen.queryByTestId("slash-menu-error")).toBeNull();
  });

  it("an OPEN menu with a partial load failure surfaces a degraded banner (commands present + error)", () => {
    const open: SlashMenuState = {
      ...closedState(),
      open: true,
      mode: "command",
      headerLabel: "Commands",
      items: [
        {
          id: "settings",
          primary: "/settings",
          secondary: "Open settings",
          isCommand: true,
          hasArgs: false,
        },
      ],
    };
    render(<SlashCommandMenu state={open} onPick={() => {}} error />);
    // The closed-only "couldn't load commands" row does not apply, but a
    // degraded affordance MUST render inside the open list so a partial load
    // (#12784: commands non-empty while error is true) is distinguishable from
    // a healthy complete catalog.
    expect(screen.queryByTestId("slash-menu-error")).toBeNull();
    expect(screen.getByTestId("slash-command-menu")).toBeTruthy();
    const partial = screen.getByTestId("slash-menu-partial-error");
    expect(partial.textContent).toContain("some commands couldn't load");
  });

  it("an OPEN menu with a healthy load shows NO degraded banner", () => {
    const open: SlashMenuState = {
      ...closedState(),
      open: true,
      mode: "command",
      headerLabel: "Commands",
      items: [
        {
          id: "settings",
          primary: "/settings",
          secondary: "Open settings",
          isCommand: true,
          hasArgs: false,
        },
      ],
    };
    render(<SlashCommandMenu state={open} onPick={() => {}} />);
    expect(screen.getByTestId("slash-command-menu")).toBeTruthy();
    // No false-positive degrade on a healthy catalog.
    expect(screen.queryByTestId("slash-menu-partial-error")).toBeNull();
  });
});
