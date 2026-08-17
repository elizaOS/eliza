/**
 * Verifies deterministic desktop Cloud target selection without running a package build.
 */

import { describe, expect, it } from "vitest";
import {
  applyDesktopCloudTarget,
  resolveDesktopCloudTarget,
} from "./desktop-cloud-target.mjs";

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
    expect(() =>
      resolveDesktopCloudTarget(["--cloud-target", "preview"], {}),
    ).toThrow('Unknown desktop Cloud target "preview"');
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
