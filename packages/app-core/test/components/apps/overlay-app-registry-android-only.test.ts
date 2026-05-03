/**
 * `getAvailableOverlayApps()` — pins the platform-gating behaviour for the
 * apps catalog. Apps marked `androidOnly: true` (WiFi, Contacts, Phone)
 * must drop off the catalog on stock Android, iOS, desktop, and web; they
 * appear only when the host runtime is the MiladyOS Android build.
 *
 * Note: the registry is module-global, so each test installs its own
 * fixture apps with unique names. Names are not cleared between tests
 * to avoid races with other suites that register at module scope.
 */

import { describe, expect, it } from "vitest";
import type { OverlayApp } from "../../../src/components/apps/overlay-app-api";
import {
  getAvailableOverlayApps,
  registerOverlayApp,
} from "../../../src/components/apps/overlay-app-registry";

function makeApp(name: string, opts: { androidOnly?: boolean }): OverlayApp {
  return {
    name,
    displayName: name,
    description: "",
    category: "test",
    icon: null,
    androidOnly: opts.androidOnly,
    // Component is required by the type but never called by these tests —
    // we don't render anything, only inspect catalog membership.
    Component: () => {
      throw new Error(`${name} should not render in this test`);
    },
  };
}

describe("getAvailableOverlayApps — androidOnly gating", () => {
  it("hides android-only apps on stock Android", () => {
    const cross = makeApp("test-cross-1", { androidOnly: false });
    const droid = makeApp("test-android-1", { androidOnly: true });
    registerOverlayApp(cross);
    registerOverlayApp(droid);

    const names = getAvailableOverlayApps("android").map((a) => a.name);
    expect(names).toContain("test-cross-1");
    expect(names).not.toContain("test-android-1");
  });

  it("includes android-only apps on MiladyOS Android", () => {
    const cross = makeApp("test-cross-miladyos-1", { androidOnly: false });
    const droid = makeApp("test-android-miladyos-1", { androidOnly: true });
    registerOverlayApp(cross);
    registerOverlayApp(droid);

    const names = getAvailableOverlayApps({
      platform: "android",
      miladyOS: true,
    }).map((a) => a.name);
    expect(names).toContain("test-cross-miladyos-1");
    expect(names).toContain("test-android-miladyos-1");
  });

  it("hides android-only apps on iOS", () => {
    const cross = makeApp("test-cross-2", { androidOnly: false });
    const droid = makeApp("test-android-2", { androidOnly: true });
    registerOverlayApp(cross);
    registerOverlayApp(droid);

    const names = getAvailableOverlayApps("ios").map((a) => a.name);
    expect(names).toContain("test-cross-2");
    expect(names).not.toContain("test-android-2");
  });

  it("hides android-only apps on web", () => {
    const cross = makeApp("test-cross-3", { androidOnly: false });
    const droid = makeApp("test-android-3", { androidOnly: true });
    registerOverlayApp(cross);
    registerOverlayApp(droid);

    const names = getAvailableOverlayApps("web").map((a) => a.name);
    expect(names).toContain("test-cross-3");
    expect(names).not.toContain("test-android-3");
  });

  it("treats undefined androidOnly as cross-platform", () => {
    const undef = makeApp("test-undef-1", {});
    registerOverlayApp(undef);

    expect(getAvailableOverlayApps("ios").map((a) => a.name)).toContain(
      "test-undef-1",
    );
    expect(getAvailableOverlayApps("android").map((a) => a.name)).toContain(
      "test-undef-1",
    );
    expect(getAvailableOverlayApps("web").map((a) => a.name)).toContain(
      "test-undef-1",
    );
  });
});
