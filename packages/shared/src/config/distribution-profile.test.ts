/**
 * Coverage for distribution-profile helpers.
 */
import { describe, expect, it } from "vitest";

import {
  DISTRIBUTION_PROFILES,
  isDistributionProfile,
  resolveDistributionProfile,
} from "./distribution-profile.js";

describe("isDistributionProfile", () => {
  it("accepts store and unrestricted", () => {
    expect(isDistributionProfile("store")).toBe(true);
    expect(isDistributionProfile("unrestricted")).toBe(true);
  });

  it("rejects unknown strings", () => {
    expect(isDistributionProfile("Store")).toBe(false);
    expect(isDistributionProfile("")).toBe(false);
    expect(isDistributionProfile("other")).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isDistributionProfile(undefined)).toBe(false);
    expect(isDistributionProfile(null)).toBe(false);
    expect(isDistributionProfile(42)).toBe(false);
    expect(isDistributionProfile({})).toBe(false);
  });

  it("exposes the tuple", () => {
    expect([...DISTRIBUTION_PROFILES]).toEqual(["store", "unrestricted"]);
  });
});

describe("resolveDistributionProfile", () => {
  it("defaults to unrestricted when env missing", () => {
    expect(resolveDistributionProfile({})).toBe("unrestricted");
  });

  it("defaults when not a string", () => {
    expect(
      resolveDistributionProfile({
        ELIZA_DISTRIBUTION_PROFILE: 42 as unknown as string,
      }),
    ).toBe("unrestricted");
  });

  it("trims and lowercases", () => {
    expect(
      resolveDistributionProfile({ ELIZA_DISTRIBUTION_PROFILE: "  STORE  " }),
    ).toBe("store");
    expect(
      resolveDistributionProfile({
        ELIZA_DISTRIBUTION_PROFILE: "Unrestricted",
      }),
    ).toBe("unrestricted");
  });

  it("returns unrestricted for blank", () => {
    expect(
      resolveDistributionProfile({ ELIZA_DISTRIBUTION_PROFILE: "   " }),
    ).toBe("unrestricted");
  });

  it("throws on invalid non-empty value", () => {
    expect(() =>
      resolveDistributionProfile({ ELIZA_DISTRIBUTION_PROFILE: "beta" }),
    ).toThrow(/Invalid ELIZA_DISTRIBUTION_PROFILE/);
  });

  it("uses process.env by default", () => {
    const prev = process.env.ELIZA_DISTRIBUTION_PROFILE;
    process.env.ELIZA_DISTRIBUTION_PROFILE = "store";
    try {
      expect(resolveDistributionProfile()).toBe("store");
    } finally {
      if (prev === undefined) delete process.env.ELIZA_DISTRIBUTION_PROFILE;
      else process.env.ELIZA_DISTRIBUTION_PROFILE = prev;
    }
  });
});
