// @vitest-environment jsdom

/**
 * Browser view uniform-header contract (#13451/#13596).
 *
 * `BrowserWorkspaceView` historically shipped NO `ViewHeader` — its toolbar
 * (URL bar + tab control) stood in for the header, so the browser broke the
 * uniform top-bar doctrine every other built-in view follows. #13596's redesign
 * spec item 2 requires the standard `ViewHeader` (bare-icon back, centered
 * "Browser" title) rendered ABOVE the toolbar, never replacing it.
 *
 * The full view mounts a native `<electrobun-webview>` OOPIF, localStorage, and
 * a large hook graph, so a full jsdom mount is neither cheap nor stable. This
 * test pins the contract in two complementary, real ways:
 *
 *  1. Render the SHARED `ViewHeader` with the exact title expression the browser
 *     view uses ("Browser") and assert it produces the standardized header —
 *     centered title + icon-only chromeless back. This is the real primitive the
 *     view renders, so a regression in the header contract is caught here.
 *  2. A static source-scan guard (same pattern as
 *     `settings/no-native-select.test.ts`) asserting `BrowserWorkspaceView.tsx`
 *     imports `ViewHeader` and stacks it ABOVE `WorkspaceLayout`, so the
 *     integration cannot silently regress back to a header-less toolbar.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../agent-surface", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));

vi.mock("../../state/shell-surface-store", () => ({
  goLauncher: vi.fn(),
}));

vi.mock("../../navigation", () => ({
  shouldUseHashNavigation: () => true,
}));

import { ViewHeader } from "../shared/ViewHeader";

// The exact default the browser view passes to `ViewHeader`
// (`t("browserworkspace.ViewTitle", { defaultValue: "Browser" })`).
const BROWSER_VIEW_TITLE = "Browser";

afterEach(() => {
  cleanup();
});

describe("BrowserWorkspaceView uniform header (#13596)", () => {
  it("renders the standardized centered 'Browser' title", () => {
    render(<ViewHeader title={BROWSER_VIEW_TITLE} />);
    const title = screen.getByRole("heading", { name: BROWSER_VIEW_TITLE });
    // Centered over the full header width, matching every other view.
    expect(title.className).toContain("absolute");
    expect(title.className).toContain("inset-x-0");
    expect(title.className).toContain("text-center");
  });

  it("renders an icon-only chromeless back control (returns to launcher)", () => {
    render(<ViewHeader title={BROWSER_VIEW_TITLE} />);
    const back = screen.getByRole("button", { name: /back/i });
    // Chromeless at rest — no border/fill; hover-only chip.
    expect(back.className).toContain("bg-transparent");
    expect(back.className).not.toContain("border");
    expect(back.className).toContain("hover:bg-bg-hover");
    // Icon-only: no visible text label.
    expect(back.textContent?.trim()).toBe("");
  });

  describe("integration wiring (static source guard)", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "BrowserWorkspaceView.tsx"),
      "utf8",
    );

    it("imports the shared ViewHeader primitive", () => {
      expect(source).toContain(
        'import { ViewHeader } from "../shared/ViewHeader"',
      );
    });

    it("renders ViewHeader with the Browser title", () => {
      expect(source).toContain("<ViewHeader");
      expect(source).toContain('t("browserworkspace.ViewTitle"');
      expect(source).toContain('defaultValue: "Browser"');
    });

    it("stacks the header ABOVE the toolbar (WorkspaceLayout below ViewHeader)", () => {
      const headerIdx = source.indexOf("<ViewHeader");
      const layoutIdx = source.indexOf("<WorkspaceLayout");
      expect(headerIdx).toBeGreaterThan(-1);
      expect(layoutIdx).toBeGreaterThan(-1);
      // The header must appear before the layout in the mainNode composition:
      // uniform header on top, toolbar (contentHeader) + surface below it.
      expect(headerIdx).toBeLessThan(layoutIdx);
    });

    it("does NOT let the toolbar replace the header (contentHeader still hosts the toolbar)", () => {
      // The URL bar / tab control stays inside WorkspaceLayout's contentHeader —
      // the ViewHeader is additive, not a toolbar swap.
      expect(source).toContain("contentHeader={navNode}");
    });
  });
});
