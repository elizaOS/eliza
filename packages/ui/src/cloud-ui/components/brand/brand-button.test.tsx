// @vitest-environment jsdom

/**
 * BrandButton disabled-state regression (#13406, finding 3).
 *
 * The "Buy credits" button (BrandButton variant="primary") read as a broken
 * gray when disabled: under `.theme-cloud`, `--accent` is white, so
 * `bg-accent` at `disabled:opacity-50` ghosted the white pill into an
 * accidental muddy gray. The disabled state must be an INTENTIONAL muted
 * surface (muted token bg + muted text + reduced opacity), not a ghosted
 * accent fill.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BrandButton } from "./brand-button";

afterEach(cleanup);

describe("BrandButton primary disabled state (#13406 finding 3)", () => {
  it("renders disabled primary with muted token surface, not a ghosted accent fill", () => {
    render(
      <BrandButton variant="primary" disabled>
        Buy credits
      </BrandButton>,
    );
    const btn = screen.getByRole("button", { name: "Buy credits" });
    const cls = btn.className;

    // Intentional disabled surface: muted bg + muted text (theme-aware tokens).
    expect(cls).toContain("disabled:bg-bg-muted");
    expect(cls).toContain("disabled:text-muted");

    // Must NOT rely on a raw-white or accent fill for the disabled look.
    expect(cls).not.toContain("disabled:bg-white");
    expect(cls).not.toContain("disabled:bg-accent");
  });

  it("keeps the branded accent fill for the enabled primary button", () => {
    render(<BrandButton variant="primary">Buy credits</BrandButton>);
    const btn = screen.getByRole("button", { name: "Buy credits" });
    expect(btn.className).toContain("bg-accent");
    expect(btn.className).toContain("text-accent-foreground");
  });
});
