/**
 * Exercises the distribution-profile resolver driven by
 * ELIZA_DISTRIBUTION_PROFILE: resolveDistributionProfile defaults to
 * "unrestricted" on unset/blank input, accepts known profiles
 * case-insensitively, and throws on unknown values rather than silently
 * defaulting; plus the isDistributionProfile guard and the canonical
 * DISTRIBUTION_PROFILES list.
 */
import { describe, expect, it } from "vitest";

import {
  DISTRIBUTION_PROFILE_ENV_KEY,
  DISTRIBUTION_PROFILES,
  isDistributionProfile,
  isStoreDistributionProfile,
  isUnrestrictedDistributionProfile,
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

  it("exposes the canonical profile list and env key", () => {
    expect([...DISTRIBUTION_PROFILES]).toEqual(["store", "unrestricted"]);
    expect(DISTRIBUTION_PROFILE_ENV_KEY).toBe("ELIZA_DISTRIBUTION_PROFILE");
  });

  it("checks isStoreDistributionProfile and isUnrestrictedDistributionProfile", () => {
    expect(isStoreDistributionProfile("store")).toBe(true);
    expect(isStoreDistributionProfile("unrestricted")).toBe(false);
    expect(isStoreDistributionProfile("other")).toBe(false);

    expect(isUnrestrictedDistributionProfile("unrestricted")).toBe(true);
    expect(isUnrestrictedDistributionProfile("store")).toBe(false);
    expect(isUnrestrictedDistributionProfile(null)).toBe(false);
  });

  it("falls back to process.env when env argument is nullish", () => {
    expect(
      resolveDistributionProfile(null as unknown as NodeJS.ProcessEnv),
    ).toBeDefined();
  });
});
