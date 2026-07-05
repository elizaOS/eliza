// @vitest-environment jsdom
//
// jsdom tests for the Character family section strip (#13591): the fixed
// host-owned tab set (Personality/Relationships/Skills/Experience), the
// centered "Character" ViewHeader, active-tab resolution from the route
// (including the legacy /character/relationships alias), click navigation, and
// isCharacterSectionPath predicate coverage. Deterministic — no network, no
// registry; the strip is a static declaration.

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  CharacterSectionNav,
  isCharacterSectionPath,
} from "./CharacterSectionNav";

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("isCharacterSectionPath", () => {
  it("matches every family section route and the relationships alias", () => {
    for (const path of [
      "/character",
      "/apps/relationships",
      "/character/relationships",
      "/character/skills",
      "/character/experience",
      "/character/skills?focus=1",
    ]) {
      expect(isCharacterSectionPath(path)).toBe(true);
    }
  });

  it("rejects Knowledge (a standalone peer hub) and unrelated routes", () => {
    for (const path of [
      "/character/documents",
      "/documents",
      "/wallet",
      "/apps/logs",
      "/",
    ]) {
      expect(isCharacterSectionPath(path)).toBe(false);
    }
  });
});

describe("CharacterSectionNav", () => {
  it("renders a centered Character title header above the strip with an icon-only back", () => {
    render(<CharacterSectionNav activePath="/character" />);
    const header = screen.getByTestId("view-header");
    expect(
      within(header).getByRole("heading", { name: "Character" }),
    ).toBeTruthy();
    expect(
      within(header).getByRole("button", { name: "Back to launcher" }),
    ).toBeTruthy();
  });

  it("renders the four family tabs in order, and no Knowledge tab", () => {
    render(<CharacterSectionNav activePath="/character" />);
    const strip = screen.getByTestId("section-nav-character");
    const labels = within(strip)
      .getAllByRole("button")
      .map((button) => button.textContent);
    expect(labels).toEqual([
      "Personality",
      "Relationships",
      "Skills",
      "Experience",
    ]);
    expect(
      within(strip).queryByRole("button", { name: "Knowledge" }),
    ).toBeNull();
  });

  it("marks Personality active at the /character root", () => {
    render(<CharacterSectionNav activePath="/character" />);
    const strip = screen.getByTestId("section-nav-character");
    expect(
      within(strip)
        .getByRole("button", { name: "Personality" })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(
      within(strip)
        .getByRole("button", { name: "Skills" })
        .getAttribute("aria-current"),
    ).toBeNull();
  });

  it("marks Relationships active on both its canonical route and the legacy alias", () => {
    for (const path of ["/apps/relationships", "/character/relationships"]) {
      render(<CharacterSectionNav activePath={path} />);
      const strip = screen.getByTestId("section-nav-character");
      expect(
        within(strip)
          .getByRole("button", { name: "Relationships" })
          .getAttribute("aria-current"),
      ).toBe("page");
      cleanup();
    }
  });

  it("navigates to a section route on click", () => {
    render(<CharacterSectionNav activePath="/character" />);
    const strip = screen.getByTestId("section-nav-character");
    fireEvent.click(within(strip).getByRole("button", { name: "Experience" }));
    expect(window.location.pathname).toBe("/character/experience");
  });

  it("does not renavigate when the active tab is clicked", () => {
    window.history.replaceState(null, "", "/character");
    render(<CharacterSectionNav activePath="/character" />);
    const strip = screen.getByTestId("section-nav-character");
    fireEvent.click(within(strip).getByRole("button", { name: "Personality" }));
    expect(window.location.pathname).toBe("/character");
  });
});
