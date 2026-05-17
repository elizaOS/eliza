import { describe, expect, it } from "vitest";

import {
  DISTRIBUTION_PROFILES,
  isDistributionProfile,
  resolveDistributionProfile,
} from "../distribution-profile";

describe("distribution profile", () => {
  it("defaults to unrestricted when env is unset or empty", () => {
    expect(resolveDistributionProfile({})).toBe("unrestricted");
    expect(resolveDistributionProfile({ ELIZA_DISTRIBUTION_PROFILE: "" })).toBe(
      "unrestricted",
    );
    expect(
      resolveDistributionProfile({ ELIZA_DISTRIBUTION_PROFILE: "   " }),
    ).toBe("unrestricted");
  });

  it("accepts known profiles case-insensitively", () => {
    expect(
      resolveDistributionProfile({ ELIZA_DISTRIBUTION_PROFILE: "store" }),
    ).toBe("store");
    expect(
      resolveDistributionProfile({ ELIZA_DISTRIBUTION_PROFILE: "STORE" }),
    ).toBe("store");
    expect(
      resolveDistributionProfile({
        ELIZA_DISTRIBUTION_PROFILE: "Unrestricted",
      }),
    ).toBe("unrestricted");
  });

  it("throws on unknown profiles rather than silently defaulting", () => {
    expect(() =>
      resolveDistributionProfile({ ELIZA_DISTRIBUTION_PROFILE: "yolo" }),
    ).toThrow(/Invalid ELIZA_DISTRIBUTION_PROFILE=yolo/);
  });

  it("isDistributionProfile only accepts canonical values", () => {
    expect(isDistributionProfile("store")).toBe(true);
    expect(isDistributionProfile("unrestricted")).toBe(true);
    expect(isDistributionProfile("STORE")).toBe(false);
    expect(isDistributionProfile(undefined)).toBe(false);
  });

  it("exposes the canonical profile list", () => {
    expect([...DISTRIBUTION_PROFILES]).toEqual(["store", "unrestricted"]);
  });
});
