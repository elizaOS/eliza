/**
 * Billing payment-method selected-state regression (#13406, finding 2).
 *
 * The token sweep #13073 (a6de6d6afc52) converted the selected payment-method
 * toggle from `bg-[#FF5800] ... text-white` to `bg-[var(--accent)] ... text-white`.
 * That regressed on the cloud dashboard because the dashboard shell wraps
 * everything in `.theme-cloud`, where `--accent` resolves to `--brand-white`.
 * The result was `bg:white + text-white` — a blank white box (invisible label).
 *
 * The selected fill is the neutral invert pair `bg-txt text-bg` (fill = theme
 * text color, label = theme background color) so the selected label stays
 * readable in every theme scope without depending on `--accent` — which is
 * brand-orange in the app shell and white under `.theme-cloud`. The unselected
 * state keeps theme-aware border/muted tokens (no raw white-opacity ladder).
 *
 * This is a source-contract test (the full BillingTab needs api/router/i18n/
 * wallet providers to render); it guards the exact className regression.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "billing-tab.tsx"), "utf8");

describe("billing payment-method selected state (#13406 finding 2)", () => {
  it("never pairs an accent/white fill with white text (the blank-white-box bug)", () => {
    // The exact regressed signature from the #13073 sweep must be gone.
    expect(source).not.toContain(
      "bg-[var(--accent)] border-[var(--accent)] text-white",
    );
    expect(source).not.toContain("bg-accent border-accent text-white");
  });

  it("uses the theme-inverting txt/bg pair for the selected fill so the label is readable in every theme", () => {
    const selectedMatches = source.match(/bg-txt border-txt text-bg/g);
    // Two toggles: Card + Crypto.
    expect(selectedMatches?.length).toBe(2);
    // No accent-fill dependence remains (orange in-app, white under .theme-cloud).
    expect(source).not.toContain("bg-accent border-accent");
  });

  it("uses theme-aware tokens for the unselected toggle (no raw white-opacity ladder)", () => {
    const unselectedMatches = source.match(
      /bg-transparent border-border text-muted hover:border-border-strong/g,
    );
    expect(unselectedMatches?.length).toBe(2);
    // The old raw-rgba white border/muted ladder is gone from the toggles.
    expect(source).not.toContain(
      "bg-transparent border-[rgba(255,255,255,0.2)] text-white/60",
    );
  });
});
