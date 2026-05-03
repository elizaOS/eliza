import { createElement } from "react";
import { describe, expect, it } from "vitest";
import {
  getAvailableOverlayApps,
  registerOverlayApp,
} from "./overlay-app-registry";

function registerTestOverlayApp(args: {
  name: string;
  androidOnly?: boolean;
}): void {
  registerOverlayApp({
    name: args.name,
    displayName: args.name,
    description: "Test overlay app",
    category: "utility",
    icon: null,
    androidOnly: args.androidOnly,
    Component: () => createElement("div"),
  });
}

describe("overlay app registry availability", () => {
  it("hides androidOnly overlay apps on stock Android", () => {
    const name = "@test/stock-android-hidden-overlay";
    registerTestOverlayApp({ name, androidOnly: true });

    expect(
      getAvailableOverlayApps({
        platform: "android",
        miladyOS: false,
        userAgent: "Mozilla/5.0 (Linux; Android 16)",
      }).some((app) => app.name === name),
    ).toBe(false);
  });

  it("shows androidOnly overlay apps on MiladyOS Android", () => {
    const name = "@test/miladyos-visible-overlay";
    registerTestOverlayApp({ name, androidOnly: true });

    expect(
      getAvailableOverlayApps({
        platform: "android",
        userAgent: "Mozilla/5.0 (Linux; Android 16) MiladyOS/aosp",
      }).some((app) => app.name === name),
    ).toBe(true);
  });

  it("keeps cross-platform overlay apps visible outside Android", () => {
    const name = "@test/web-visible-overlay";
    registerTestOverlayApp({ name });

    expect(
      getAvailableOverlayApps({ platform: "web" }).some(
        (app) => app.name === name,
      ),
    ).toBe(true);
  });
});
