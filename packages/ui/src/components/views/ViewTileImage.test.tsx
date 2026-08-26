// @vitest-environment jsdom
/**
 * Verifies catalog preview imagery remains independent from launcher styling.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ViewEntry } from "../../hooks/view-catalog";
import { ViewTileImage } from "./ViewTileImage";

afterEach(() => cleanup());

function entry(overrides: Partial<ViewEntry> = {}): ViewEntry {
  return {
    key: "view:calendar",
    id: "calendar",
    label: "Calendar",
    icon: "CalendarDays",
    imageUrl: "https://cdn.example.com/calendar-hero.png",
    fallbackImageUrl: "https://cdn.example.com/calendar-fallback.png",
    hasHero: true,
    modality: "gui",
    state: "loaded",
    kind: "view",
    viewKind: "release",
    ...overrides,
  };
}

describe("ViewTileImage catalog previews", () => {
  it("delegates launcher tiles to the shared Ionicon plate without probing hero art", () => {
    const { container } = render(
      <ViewTileImage
        entry={entry()}
        source="launcher"
        containerClassName="launcher-icon"
        imageTestId="catalog-hero"
      />,
    );

    expect(screen.queryByTestId("catalog-hero")).toBeNull();
    expect(
      container.querySelector('[data-launcher-icon-variant="ionicon"]'),
    ).toBeTruthy();
    expect(container.querySelector('[data-ionicon="calendar"]')).toBeTruthy();
  });

  it("keeps catalog hero imagery independent from launcher glyph styling", () => {
    render(
      <ViewTileImage
        entry={entry()}
        source="view-catalog"
        containerClassName="preview"
        imageTestId="catalog-hero"
      />,
    );

    const image = screen.getByTestId("catalog-hero");
    expect(image.getAttribute("src")).toBe(
      "https://cdn.example.com/calendar-hero.png",
    );
    expect(image.getAttribute("loading")).toBe("lazy");
    expect(image.getAttribute("decoding")).toBe("async");
  });

  it("retains the catalog fallback image after a primary load failure", () => {
    render(
      <ViewTileImage
        entry={entry()}
        source="view-catalog"
        containerClassName="preview"
        imageTestId="catalog-hero"
      />,
    );

    fireEvent.error(screen.getByTestId("catalog-hero"));
    expect(screen.getByTestId("catalog-hero").getAttribute("src")).toBe(
      "https://cdn.example.com/calendar-fallback.png",
    );
  });

  it("falls back to the deterministic glyph after every catalog image fails", () => {
    const { container } = render(
      <ViewTileImage
        entry={entry()}
        source="view-catalog"
        containerClassName="preview"
        imageTestId="catalog-hero"
      />,
    );

    fireEvent.error(screen.getByTestId("catalog-hero"));
    fireEvent.error(screen.getByTestId("catalog-hero"));

    expect(screen.queryByTestId("catalog-hero")).toBeNull();
    expect(
      container.querySelector('[data-view-visual="calendar"]'),
    ).toBeTruthy();
    expect(container.querySelector("svg.lucide-calendar-days")).toBeTruthy();
  });
});
