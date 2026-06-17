// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DocumentsView } from "../src/components/documents/DocumentsView.js";

// DocumentsView is a static stub (dataSource: none). Every render value below
// is hardcoded JSX / a module-level SECTIONS const in the component, so these
// assertions pin the exact populated text and the only interactive behavior
// (tab switching via setActiveSection). There is no external API to contract-test.
//
// jest-dom matchers are NOT installed in this repo, so we use plain Vitest
// matchers over real DOM nodes (matching packages/ui DynamicViewLoader.test.tsx).

const RECENT_DESC = "Recently ingested or modified documents.";
const SEARCH_DESC = "Semantic + keyword search across the document store.";
const QUEUE_DESC =
  "Owner-gated signature and approval requests awaiting action.";
const PLACEHOLDER = "Placeholder — full UI will be ported from plugin-lifeops.";

const ORANGE = "rgb(249, 115, 22)"; // #f97316

afterEach(cleanup);

describe("DocumentsView", () => {
  it("renders the static header, subtitle, and all three tabs in default state", () => {
    render(<DocumentsView />);

    expect(screen.getByRole("heading", { name: "Documents" })).toBeTruthy();
    expect(
      screen.getByText(
        "Browse, search, and triage owner-gated document requests.",
      ),
    ).toBeTruthy();

    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual([
      "Recent",
      "Search",
      "Signature Queue",
    ]);
  });

  it("defaults to the Recent section active with its description and placeholder shown", () => {
    render(<DocumentsView />);

    expect(
      screen.getByRole("tab", { name: "Recent" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      screen.getByRole("tab", { name: "Search" }).getAttribute("aria-selected"),
    ).toBe("false");
    expect(
      screen
        .getByRole("tab", { name: "Signature Queue" })
        .getAttribute("aria-selected"),
    ).toBe("false");

    // The active tabpanel is Recent's content.
    const panel = screen.getByRole("tabpanel");
    expect(panel.getAttribute("aria-label")).toBe("Recent");
    expect(screen.getByText(RECENT_DESC)).toBeTruthy();
    expect(screen.getByText(PLACEHOLDER)).toBeTruthy();

    // Only the active section's description is rendered (inactive panels return null).
    expect(screen.queryByText(SEARCH_DESC)).toBeNull();
    expect(screen.queryByText(QUEUE_DESC)).toBeNull();
  });

  it("active tab styling reflects the orange selected state", () => {
    render(<DocumentsView />);

    const recent = screen.getByRole("tab", { name: "Recent" });
    const search = screen.getByRole("tab", { name: "Search" });
    // Active tab: orange background + white text. Inactive: transparent.
    expect(recent.style.background).toBe(ORANGE);
    expect(recent.style.color).toBe("rgb(255, 255, 255)");
    expect(search.style.background).toBe("transparent");
  });

  it("clicking the Search tab swaps the active section content and aria-selected", () => {
    render(<DocumentsView />);

    fireEvent.click(screen.getByRole("tab", { name: "Search" }));

    expect(
      screen.getByRole("tab", { name: "Search" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      screen.getByRole("tab", { name: "Recent" }).getAttribute("aria-selected"),
    ).toBe("false");

    const panel = screen.getByRole("tabpanel");
    expect(panel.getAttribute("aria-label")).toBe("Search");
    expect(screen.getByText(SEARCH_DESC)).toBeTruthy();
    // Recent's content is gone after the swap.
    expect(screen.queryByText(RECENT_DESC)).toBeNull();

    // Active styling moved to the clicked tab.
    expect(screen.getByRole("tab", { name: "Search" }).style.background).toBe(
      ORANGE,
    );
    expect(screen.getByRole("tab", { name: "Recent" }).style.background).toBe(
      "transparent",
    );
  });

  it("clicking the Signature Queue tab swaps to its content and aria-selected", () => {
    render(<DocumentsView />);

    fireEvent.click(screen.getByRole("tab", { name: "Signature Queue" }));

    expect(
      screen
        .getByRole("tab", { name: "Signature Queue" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      screen.getByRole("tab", { name: "Recent" }).getAttribute("aria-selected"),
    ).toBe("false");

    const panel = screen.getByRole("tabpanel");
    expect(panel.getAttribute("aria-label")).toBe("Signature Queue");
    expect(screen.getByText(QUEUE_DESC)).toBeTruthy();
    expect(screen.queryByText(RECENT_DESC)).toBeNull();
    expect(screen.queryByText(SEARCH_DESC)).toBeNull();
  });

  it("initialSection='signature-queue' seeds the Signature Queue tab as active on mount", () => {
    render(<DocumentsView initialSection="signature-queue" />);

    expect(
      screen
        .getByRole("tab", { name: "Signature Queue" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      screen.getByRole("tab", { name: "Recent" }).getAttribute("aria-selected"),
    ).toBe("false");

    expect(screen.getByRole("tabpanel").getAttribute("aria-label")).toBe(
      "Signature Queue",
    );
    expect(screen.getByText(QUEUE_DESC)).toBeTruthy();
    expect(screen.queryByText(RECENT_DESC)).toBeNull();
  });

  it("initialSection='search' seeds the Search tab as active on mount", () => {
    render(<DocumentsView initialSection="search" />);

    expect(
      screen.getByRole("tab", { name: "Search" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByRole("tabpanel").getAttribute("aria-label")).toBe(
      "Search",
    );
    expect(screen.getByText(SEARCH_DESC)).toBeTruthy();
  });
});
