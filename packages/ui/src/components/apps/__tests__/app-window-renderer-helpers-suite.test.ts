/**
 * Unit tests for AppWindowRenderer overlay component creation and caching helpers.
 * Validates loader existence checks and WeakMap memoization.
 */
import { describe, expect, it } from "vitest";
import { getOverlayAppLazyComponent } from "../AppWindowRenderer.helpers.ts";
import type { OverlayApp } from "../overlay-app-api.ts";

describe("AppWindowRenderer.helpers", () => {
  it("returns null when app has no loader defined", () => {
    const app: OverlayApp = {
      name: "no-loader-app",
      icon: "test-icon",
      defaultTitle: "No Loader App",
    };

    expect(getOverlayAppLazyComponent(app)).toBeNull();
  });

  it("creates and caches lazy component when loader is present", () => {
    const loader = async () => ({ default: () => null });
    const app: OverlayApp = {
      name: "sample-app",
      icon: "sample-icon",
      defaultTitle: "Sample App",
      loader,
    };

    const component1 = getOverlayAppLazyComponent(app);
    expect(component1).not.toBeNull();

    const component2 = getOverlayAppLazyComponent(app);
    expect(component2).toBe(component1);
  });
});
