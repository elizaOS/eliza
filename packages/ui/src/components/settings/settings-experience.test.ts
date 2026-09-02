/** Verifies that Settings product curation stays separate from host capabilities. */
import { describe, expect, it } from "vitest";
import {
  resolveSettingsExperience,
  settingsSectionMatchesExperience,
} from "./settings-experience";

describe("Settings experience policy", () => {
  it("keeps shared sections in standard and managed-cloud products", () => {
    const shared = {};

    expect(settingsSectionMatchesExperience(shared, "standard")).toBe(true);
    expect(settingsSectionMatchesExperience(shared, "managed-cloud")).toBe(
      true,
    );
  });

  it("curates only sections with an explicit managed-cloud policy", () => {
    expect(
      settingsSectionMatchesExperience({ cloudOnly: true }, "standard"),
    ).toBe(false);
    expect(
      settingsSectionMatchesExperience({ cloudOnly: true }, "managed-cloud"),
    ).toBe(true);
    expect(
      settingsSectionMatchesExperience(
        { hideOnManagedCloud: true },
        "managed-cloud",
      ),
    ).toBe(false);
  });

  it("derives product experience without encoding Android or desktop", () => {
    expect(resolveSettingsExperience(false)).toBe("standard");
    expect(resolveSettingsExperience(true)).toBe("managed-cloud");
  });
});
