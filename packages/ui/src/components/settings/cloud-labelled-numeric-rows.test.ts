/**
 * Source guard: remaining labelled 1:1 number settings use SettingsInputRow.
 * Auto Top-Up amount/threshold and affiliates markup. Reads shipped files.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const uiSrc = join(dirname(fileURLToPath(import.meta.url)), "../..");

function read(rel: string): string {
  return readFileSync(join(uiSrc, rel), "utf8");
}

describe("labelled numeric settings rows", () => {
  it("removes the NumericField helper", () => {
    expect(
      existsSync(join(uiSrc, "cloud/billing/components/numeric-field.tsx")),
    ).toBe(false);
  });

  it("Auto Top-Up amount and threshold are SettingsInputRows", () => {
    const source = read("cloud/billing/components/auto-top-up-card.tsx");
    expect(source).toContain('agentId="cloud-billing-auto-top-up-amount"');
    expect(source).toContain('agentId="cloud-billing-auto-top-up-threshold"');
    expect(source).toContain('type="number"');
    expect(source).not.toContain("NumericField");
    expect(source).toContain("BrandCard");
  });

  it("affiliates markup is a SettingsInputRow, not a raw number Input", () => {
    const source = read(
      "cloud/monetization/affiliates/AffiliatesPageClient.tsx",
    );
    expect(source).toContain('agentId="cloud-affiliates-markup-percent"');
    expect(source).toContain("<SettingsInputRow");
    expect(source).not.toMatch(/<Input[\s>]/);
    expect(source).toContain("BrandCard");
    expect(source).toContain("Save markup");
  });
});
