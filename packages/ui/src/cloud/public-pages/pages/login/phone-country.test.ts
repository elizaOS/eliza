/** Verifies locale inference and country-aware phone normalization. */

import { describe, expect, it } from "vitest";
import { inferPhoneCountry, normalizePhoneForCountry } from "./phone-country";

describe("phone country helpers", () => {
  it("uses an explicit browser locale region without requesting location", () => {
    expect(inferPhoneCountry(["en-GB", "en"])).toBe("GB");
    expect(inferPhoneCountry(["fr-CA"])).toBe("CA");
  });

  it("falls back to US when the browser exposes no usable region", () => {
    expect(inferPhoneCountry(["en", "not-a-locale-"])).toBe("US");
  });

  it("normalizes national numbers through the selected country", () => {
    expect(normalizePhoneForCountry("925 334 4955", "US")).toBe("+19253344955");
    expect(normalizePhoneForCountry("020 7946 0018", "GB")).toBe(
      "+442079460018",
    );
  });

  it("honors an explicit international prefix and rejects incomplete input", () => {
    expect(normalizePhoneForCountry("+44 20 7946 0018", "US")).toBe(
      "+442079460018",
    );
    expect(normalizePhoneForCountry("555", "US")).toBeNull();
  });
});
