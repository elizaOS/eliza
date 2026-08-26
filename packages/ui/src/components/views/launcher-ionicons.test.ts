/** Verifies canonical Ionicons coverage and launcher icon asset resolution. */
import { describe, expect, it } from "vitest";
import { resolveLauncherIconAsset } from "./launcher-ionicons";

describe("launcher Ionicons resolver", () => {
  it("preserves a supplied third-party image inside the shared plate", () => {
    expect(
      resolveLauncherIconAsset({
        id: "partner",
        label: "Partner",
        icon: "https://cdn.example.com/partner.svg",
      }),
    ).toEqual({
      kind: "image",
      name: "custom-image",
      src: "https://cdn.example.com/partner.svg",
    });
  });

  it("keeps first-party apps in the chosen family even if catalog data supplies an image", () => {
    expect(
      resolveLauncherIconAsset({
        id: "settings",
        label: "Settings",
        icon: "https://cdn.example.com/legacy-settings.png",
      }).name,
    ).toBe("settings");
  });

  it("uses explicit legacy names, keyword semantics, then one deterministic fallback", () => {
    expect(
      resolveLauncherIconAsset({
        id: "legacy",
        label: "Legacy",
        icon: "TrendingUp",
      }).name,
    ).toBe("trending-up");
    expect(
      resolveLauncherIconAsset({
        id: "marketplace-view",
        label: "Trading Desk",
      }).name,
    ).toBe("trending-up");
    expect(
      resolveLauncherIconAsset({
        id: "@elizaos/plugin-hyperliquid",
        label: "Hyperliquid",
        icon: "LayoutGrid",
      }).name,
    ).toBe("trending-up");
    expect(
      resolveLauncherIconAsset({
        id: "release-calendar",
        label: "Trading Calendar",
        icon: "CalendarDays",
      }).name,
    ).toBe("calendar");
    expect(resolveLauncherIconAsset({ id: "acme", label: "Acme" }).name).toBe(
      "apps",
    );
  });
});
