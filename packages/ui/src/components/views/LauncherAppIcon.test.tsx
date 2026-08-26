// @vitest-environment jsdom
/**
 * Verifies the shared launcher icon visual and interaction contract.
 */

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LauncherAppIcon, LauncherAppIconSkeleton } from "./LauncherAppIcon";

afterEach(() => cleanup());

describe("LauncherAppIcon", () => {
  it("renders first-party icons as decorative launcher glyphs", () => {
    const { container } = render(
      <LauncherAppIcon
        entry={{ id: "calendar", label: "Calendar", icon: "CalendarDays" }}
      />,
    );

    const plate = container.querySelector<HTMLElement>("[data-launcher-icon]");
    expect(plate).toBeTruthy();
    expect(plate?.dataset.launcherIconVariant).toBe("ionicon");

    const glyph = container.querySelector<HTMLImageElement>(
      'img[data-ionicon="calendar"]',
    );
    expect(glyph?.src).toMatch(/^(?:data:image\/svg\+xml|https?:|file:)/);
    expect(glyph?.getAttribute("alt")).toBe("");
    expect(glyph?.getAttribute("aria-hidden")).toBe("true");
  });

  it("uses the approved filled Ionicons family for Chat", () => {
    const { container } = render(
      <LauncherAppIcon
        entry={{ id: "chat", label: "Chat", icon: "MessageSquare" }}
      />,
    );

    const plate = container.querySelector<HTMLElement>("[data-launcher-icon]");
    expect(plate?.dataset.launcherIconVariant).toBe("ionicon");
    expect(
      plate?.querySelector('img[data-ionicon="chatbubble-ellipses"]'),
    ).toBeTruthy();
  });

  it("preserves explicit third-party image icons and deterministic fallback", () => {
    const image = render(
      <LauncherAppIcon
        entry={{
          id: "partner",
          label: "Partner",
          icon: "https://cdn.example.com/partner.png",
        }}
      />,
    );
    expect(image.container.querySelector("img")?.getAttribute("src")).toBe(
      "https://cdn.example.com/partner.png",
    );
    expect(
      image.container
        .querySelector("[data-launcher-icon]")
        ?.getAttribute("data-launcher-icon-variant"),
    ).toBe("image");
    image.unmount();

    const fallback = render(
      <LauncherAppIcon
        entry={{ id: "acme-tool", label: "Acme Tool", icon: "UnknownIcon" }}
      />,
    );
    expect(
      fallback.container.querySelector('img[data-ionicon="apps"]'),
    ).toBeTruthy();
  });

  it("marks loading placeholders as launcher icons", () => {
    const { container } = render(<LauncherAppIconSkeleton />);
    const skeleton = container.querySelector<HTMLElement>(
      "[data-launcher-icon]",
    );
    expect(skeleton).toBeTruthy();
  });
});
