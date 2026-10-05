/**
 * Verifies deterministic desktop Cloud target selection without running a package build.
 */

import { describe, expect, it } from "vitest";
import {
  applyDesktopCloudTarget,
  resolveDesktopCloudTarget,
} from "./desktop-cloud-target.ts";

describe("desktop Cloud build target", () => {
  it("preserves the normal renderer default when no target is supplied", () => {
    expect(resolveDesktopCloudTarget([], {})).toBeNull();
  });

  it("maps the staging build flag to the staging marketing origin", () => {
    expect(
      resolveDesktopCloudTarget(["--cloud-target", "staging"], {}),
    ).toEqual({
      target: "staging",
      origin: "https://staging.eliza.app",
    });
  });

  it("accepts the inline production form", () => {
    expect(
      resolveDesktopCloudTarget(["--cloud-target=production"], {}),
    ).toEqual({
      target: "production",
      origin: "https://eliza.app",
    });
  });

  it("uses the environment form for CI builds", () => {
    expect(
      resolveDesktopCloudTarget([], {
        ELIZA_DESKTOP_CLOUD_TARGET: "staging",
      }),
    ).toEqual({
      target: "staging",
      origin: "https://staging.eliza.app",
    });
  });

  it("lets an explicit CLI value override the environment", () => {
    expect(
      resolveDesktopCloudTarget(["--cloud-target=production"], {
        ELIZA_DESKTOP_CLOUD_TARGET: "staging",
      }),
    ).toEqual({
      target: "production",
      origin: "https://eliza.app",
    });
  });

  it("rejects unknown targets instead of silently falling back", () => {
    for (const value of ["preview", "constructor", "__proto__", "toString"]) {
      expect(() =>
        resolveDesktopCloudTarget(["--cloud-target", value], {}),
      ).toThrow(`Unknown desktop Cloud target "${value}"`);
    }
  });

  it("rejects a flag without a value", () => {
    expect(() => resolveDesktopCloudTarget(["--cloud-target"], {})).toThrow(
      "Desktop Cloud target is missing",
    );
  });

  it("bakes staging into the renderer environment", () => {
    const target = resolveDesktopCloudTarget(["--cloud-target=staging"], {});
    expect(
      applyDesktopCloudTarget(
        { VITE_ELIZA_CLOUD_BASE: "https://custom.example" },
        target,
      ),
    ).toEqual({ VITE_ELIZA_CLOUD_BASE: "https://staging.eliza.app" });
  });

  it("preserves an existing renderer override when no target was requested", () => {
    const env = { VITE_ELIZA_CLOUD_BASE: "https://custom.example" };
    expect(applyDesktopCloudTarget(env, null)).toBe(env);
  });
});

it("rejects inherited keys and blank explicit flags instead of changing the target", () => {
  for (const target of ["__proto__", "constructor"]) {
    expect(() =>
      resolveDesktopCloudTarget([`--cloud-target=${target}`], {}),
    ).toThrow("Unknown desktop Cloud target");
  }
  for (const args of [["--cloud-target="], ["--cloud-target", "  "]]) {
    expect(() =>
      resolveDesktopCloudTarget(args, {
        ELIZA_DESKTOP_CLOUD_TARGET: "staging",
      }),
    ).toThrow("Desktop Cloud target is missing");
  }
});

it("rejects duplicate selectors regardless of flag form", () => {
  for (const args of [
    ["--cloud-target=production", "--cloud-target", "staging"],
    ["--cloud-target", "staging", "--cloud-target=production"],
    ["--cloud-target=staging", "--cloud-target=staging"],
  ]) {
    expect(() => resolveDesktopCloudTarget(args, {})).toThrow("more than once");
  }
});
