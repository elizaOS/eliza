// @vitest-environment jsdom
/**
 * Verifies the shared launcher icon visual and interaction contract.
 */

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LauncherAppIcon, LauncherAppIconSkeleton } from "./LauncherAppIcon";

afterEach(() => cleanup());

describe("LauncherAppIcon", () => {
  it("owns the shared continuous-corner plate and static interaction contract", () => {
    const { container } = render(
      <LauncherAppIcon
        entry={{ id: "calendar", label: "Calendar", icon: "CalendarDays" }}
      />,
    );

    const plate = container.querySelector<HTMLElement>("[data-launcher-icon]");
    expect(plate).toBeTruthy();
    expect(plate?.classList.contains("rounded-[22.37%]")).toBe(true);
    expect(plate?.classList.contains("bg-[rgba(16,17,20,0.68)]")).toBe(true);
    expect(plate?.classList.contains("border-white/24")).toBe(true);
    expect(plate?.classList.contains("backdrop-blur-[18px]")).toBe(true);
    expect(plate?.className).not.toContain("shadow-[0_");
    expect(plate?.dataset.launcherIconVariant).toBe("ionicon");

    const classContract = Array.from(
      container.querySelectorAll<HTMLElement>("[class]"),
      (node) => node.className,
    ).join(" ");
    expect(classContract).not.toMatch(
      /(?:active:|group-active:|transform|filter|transition-\[.*(?:filter|transform))/,
    );

    const glyph = container.querySelector<HTMLImageElement>(
      'img[data-ionicon="calendar"]',
    );
    expect(glyph?.src).toMatch(/^(?:data:image\/svg\+xml|https?:|file:)/);
    expect(glyph?.classList.contains("!size-[52%]")).toBe(true);
    expect(glyph?.classList.contains("brightness-0")).toBe(true);
    expect(glyph?.classList.contains("invert")).toBe(true);
    expect(glyph?.classList.contains("opacity-[0.92]")).toBe(true);
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
    expect(image.container.querySelector("img")?.classList).not.toContain(
      "brightness-0",
    );
    expect(image.container.querySelector("img")?.classList).not.toContain(
      "invert",
    );
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

  it("keeps loading placeholders on the identical squircle", () => {
    const { container } = render(<LauncherAppIconSkeleton />);
    const skeleton = container.querySelector<HTMLElement>(
      "[data-launcher-icon]",
    );
    expect(skeleton?.classList.contains("rounded-[22.37%]")).toBe(true);
    expect(skeleton?.classList.contains("bg-[rgba(16,17,20,0.68)]")).toBe(true);
  });
});
