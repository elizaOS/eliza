/** Verifies that dev startup warns only for Bun versions below repository support. */
import { describe, expect, it } from "vitest";

import { getBunVersionAdvisory } from "./bun-version-guard.mjs";

describe("getBunVersionAdvisory", () => {
  it.each(["1.3.0", "1.3.14", "1.4.0-canary.1", "2.0.0"])(
    "accepts supported Bun %s without startup noise",
    (version) => {
      expect(getBunVersionAdvisory(version)).toBeNull();
    },
  );

  it("does not emit an advisory when Bun is unavailable", () => {
    expect(getBunVersionAdvisory(undefined)).toBeNull();
  });

  it.each(["0.8.1", "1.2.22"])(
    "warns for unsupported Bun %s and points to the repository pin",
    (version) => {
      const advisory = getBunVersionAdvisory(version);

      expect(advisory).toContain(`Detected Bun ${version}.`);
      expect(advisory).toContain("repository pin: 1.3.14");
      expect(advisory).not.toContain("canary");
    },
  );

  it("warns when a present version cannot be parsed", () => {
    const advisory = getBunVersionAdvisory("development-build");

    expect(advisory).toContain("Detected Bun development-build.");
    expect(advisory).toContain("repository pin: 1.3.14");
  });
});
