/**
 * Regression guard for the labeled Divider affordance across GUI + TUI renders.
 * Static-markup + line renders, no live terminal.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Divider, SpatialSurface } from "../index.ts";

/**
 * Regression guard for the labeled `<Divider label="…" />` affordance.
 *
 * The DOM `Divider` primitive has three render branches: vertical rule,
 * labeled horizontal rule, and plain horizontal rule. The `label` prop is a
 * documented section-separator used by 20+ spatial views (health,
 * steward, phone, training, contacts, wallet, and market views). A "declutter"
 * pass that drops the labeled branch makes those section headers silently
 * vanish while still type-checking (the prop stays on `DividerProps`). These
 * tests assert the label actually reaches the DOM so such a regression fails
 * CI instead of shipping.
 */
describe("spatial Divider — labeled rule renders its label", () => {
  it("GUI: a <Divider label> renders the label text in the DOM", () => {
    const html = renderToStaticMarkup(
      <SpatialSurface modality="gui">
        <Divider label="Account section" />
      </SpatialSurface>,
    );
    expect(html).toContain('data-spatial-kind="divider"');
    expect(html).toContain("Account section");
  });

  it("GUI: an unlabeled <Divider> renders a plain rule with no label text", () => {
    const html = renderToStaticMarkup(
      <SpatialSurface modality="gui">
        <Divider />
      </SpatialSurface>,
    );
    expect(html).toContain('data-spatial-kind="divider"');
    expect(html).not.toContain("Account section");
  });
});
