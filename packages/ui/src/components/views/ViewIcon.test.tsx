// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ViewIcon } from "./ViewIcon";

afterEach(() => cleanup());

describe("ViewIcon image sources", () => {
  it("renders an <img> for a data-URI icon", () => {
    const src =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const { container } = render(<ViewIcon icon={src} />);
    const img = container.querySelector("img");
    expect(img).toBeTruthy();
    expect(img?.getAttribute("src")).toBe(src);
    expect(container.querySelector("svg")).toBeNull();
  });

  it("renders an <img> for an absolute path icon", () => {
    const { container } = render(<ViewIcon icon="/api/views/foo/hero" />);
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe("/api/views/foo/hero");
  });

  it("renders an <img> for an http(s) URL icon", () => {
    const { container } = render(
      <ViewIcon icon="https://cdn.example.com/icon.png" />,
    );
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "https://cdn.example.com/icon.png",
    );
  });
});

describe("ViewIcon lucide glyphs", () => {
  it("renders the named Lucide glyph when the icon name is known", () => {
    const { container } = render(<ViewIcon icon="Wallet" />);
    expect(container.querySelector("svg.lucide-wallet")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
  });

  it("applies the passed className to the glyph", () => {
    const { container } = render(
      <ViewIcon icon="Wallet" className="h-7 w-7" />,
    );
    const svg = container.querySelector("svg");
    expect(svg?.classList.contains("h-7")).toBe(true);
    expect(svg?.classList.contains("w-7")).toBe(true);
  });
});

describe("ViewIcon keyword inference (no/unknown icon name)", () => {
  it("guesses a glyph from the label when no icon is given", () => {
    const { container } = render(<ViewIcon label="Crypto Wallet" />);
    expect(container.querySelector("svg.lucide-wallet")).toBeTruthy();
  });

  it("guesses a glyph from the id when label has no keyword", () => {
    const { container } = render(<ViewIcon id="inbox" />);
    expect(container.querySelector("svg.lucide-inbox")).toBeTruthy();
  });

  it("falls through an unknown icon name to keyword inference", () => {
    // "NotARealIcon" isn't in the registry, but the label matches /calendar/.
    const { container } = render(
      <ViewIcon icon="NotARealIcon" label="My Calendar" />,
    );
    expect(container.querySelector("svg.lucide-calendar-days")).toBeTruthy();
  });

  it("falls back to the grid glyph when nothing matches", () => {
    const { container } = render(
      <ViewIcon icon={null} label="Zxqv" id="zxqv" />,
    );
    expect(container.querySelector("svg.lucide-layout-grid")).toBeTruthy();
  });
});
