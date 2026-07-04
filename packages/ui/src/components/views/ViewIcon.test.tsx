// @vitest-environment jsdom
//
// ViewIcon resolution paths: image sources render an <img>; known lucide names
// render the named glyph with the passed className; unknown/absent icons fall
// through to keyword inference and finally the grid glyph. Locks the #5
// regression where distinct system views collapsed onto the same placeholder.
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

// Regression for #5: Settings / Files / Tasks all rendered the SAME generic
// 4-square (layout-grid) placeholder because the builtin entries shipped no
// icon and the keyword table matched none of them. Lock BOTH resolution paths.
describe("ViewIcon system views render distinct glyphs (#5)", () => {
  function glyphClass(node: Element | null): string | undefined {
    return Array.from(node?.querySelector("svg")?.classList ?? []).find((c) =>
      c.startsWith("lucide-"),
    );
  }

  it("resolves explicit per-tab icon names to distinct, non-grid glyphs", () => {
    const settings = render(<ViewIcon icon="Settings" />);
    const files = render(<ViewIcon icon="FolderClosed" />);
    const tasks = render(<ViewIcon icon="ListTodo" />);

    expect(
      settings.container.querySelector("svg.lucide-settings"),
    ).toBeTruthy();
    expect(
      files.container.querySelector("svg.lucide-folder-closed"),
    ).toBeTruthy();
    expect(tasks.container.querySelector("svg.lucide-list-todo")).toBeTruthy();

    const glyphs = [
      glyphClass(settings.container),
      glyphClass(files.container),
      glyphClass(tasks.container),
    ];
    expect(new Set(glyphs).size).toBe(3); // all different
    expect(glyphs).not.toContain("lucide-layout-grid"); // none is the placeholder
  });

  it("keyword fallback no longer collapses Settings/Files/Tasks onto the grid", () => {
    // Even when a view ships NO icon name, the label keywords must diverge.
    const settings = render(<ViewIcon label="Settings" id="settings" />);
    const files = render(<ViewIcon label="Files" id="files" />);
    const tasks = render(<ViewIcon label="Tasks" id="tasks" />);

    const glyphs = [
      glyphClass(settings.container),
      glyphClass(files.container),
      glyphClass(tasks.container),
    ];
    expect(glyphs).toEqual([
      "lucide-settings",
      "lucide-folder-closed",
      "lucide-list-todo",
    ]);
    expect(glyphs).not.toContain("lucide-layout-grid");
  });
});
