// @vitest-environment jsdom
/** Verifies launcher icon resolution at the rendered consumer boundary. */

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LauncherAppIcon, LauncherAppIconSkeleton } from "./LauncherAppIcon";

afterEach(() => cleanup());

function renderedGlyph(container: HTMLElement): HTMLImageElement {
  const glyph = container.querySelector<HTMLImageElement>(
    "img[data-launcher-glyph]",
  );
  expect(glyph).toBeTruthy();
  return glyph as HTMLImageElement;
}

describe("LauncherAppIcon", () => {
  it("renders a semantic first-party glyph as decorative content", () => {
    const { container } = render(
      <LauncherAppIcon
        entry={{ id: "calendar", label: "Calendar", icon: "CalendarDays" }}
      />,
    );

    const glyph = renderedGlyph(container);
    expect(glyph.dataset.ionicon).toBe("calendar");
    expect(glyph.getAttribute("alt")).toBe("");
    expect(glyph.getAttribute("aria-hidden")).toBe("true");
    expect(glyph.draggable).toBe(false);
  });

  it("keeps Chat on the approved filled message glyph", () => {
    const { container } = render(
      <LauncherAppIcon
        entry={{ id: "chat", label: "Chat", icon: "MessageSquare" }}
      />,
    );

    expect(renderedGlyph(container).dataset.ionicon).toBe(
      "chatbubble-ellipses",
    );
  });

  it("preserves a third-party image URL without presenting it to assistive technology", () => {
    const src = "https://cdn.example.com/partner.png";
    const { container } = render(
      <LauncherAppIcon
        entry={{ id: "partner", label: "Partner", icon: src }}
      />,
    );

    const glyph = renderedGlyph(container);
    expect(glyph.getAttribute("src")).toBe(src);
    expect(glyph.dataset.launcherGlyphKind).toBe("image");
    expect(glyph.hasAttribute("data-ionicon")).toBe(false);
    expect(glyph.getAttribute("alt")).toBe("");
    expect(glyph.getAttribute("aria-hidden")).toBe("true");
  });

  it("renders the same deterministic fallback for unrelated unknown entries", () => {
    const first = render(
      <LauncherAppIcon
        entry={{ id: "acme-tool", label: "Acme Tool", icon: "UnknownIcon" }}
      />,
    );
    const second = render(
      <LauncherAppIcon entry={{ id: "other-tool", label: "Other Tool" }} />,
    );

    const firstGlyph = renderedGlyph(first.container);
    const secondGlyph = renderedGlyph(second.container);
    expect(firstGlyph.dataset.launcherGlyphKind).toBe("ionicon");
    expect(firstGlyph.dataset.ionicon).toBe(secondGlyph.dataset.ionicon);
    expect(firstGlyph.getAttribute("src")).toBe(
      secondGlyph.getAttribute("src"),
    );
  });

  it("keeps loading placeholders decorative", () => {
    const { container } = render(<LauncherAppIconSkeleton />);
    const skeleton = container.querySelector<HTMLElement>(
      "[data-launcher-icon]",
    );
    expect(skeleton?.getAttribute("aria-hidden")).toBe("true");
    expect(skeleton?.querySelector("img")).toBeNull();
  });
});
