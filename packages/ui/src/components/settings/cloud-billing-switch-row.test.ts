/**
 * Source guard: the Auto Top-Up enable control is a SettingsSwitchRow, not
 * a raw Switch with a custom ON color. The BrandCard editor around it stays.
 * Reads the shipped file off disk.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const uiSrc = join(dirname(fileURLToPath(import.meta.url)), "../..");

describe("cloud billing auto-top-up enable switch", () => {
  const source = readFileSync(
    join(uiSrc, "cloud/billing/components/auto-top-up-card.tsx"),
    "utf8",
  );

  it("uses SettingsSwitchRow with the shared billing agent id", () => {
    expect(source).toContain("<SettingsSwitchRow");
    expect(source).toContain('agentId="cloud-billing-auto-top-up"');
    expect(source).toContain('group="cloud-billing"');
  });

  it("does not keep a raw Switch or a text-token ON track", () => {
    expect(source).not.toMatch(/<Switch[\s>]/);
    expect(source).not.toContain("data-[state=checked]:bg-txt");
  });

  it("leaves the multi-field BrandCard editor in place", () => {
    expect(source).toContain("BrandCard");
    expect(source).toContain("CornerBrackets");
    expect(source).toContain("<SettingsInputRow");
    expect(source).toMatch(/Save/);
  });
});
