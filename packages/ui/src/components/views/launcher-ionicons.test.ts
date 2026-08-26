/** Verifies launcher icon resolution precedence and fallback behavior. */
import { describe, expect, it } from "vitest";
import {
  LAUNCHER_AOSP_ONLY_IDS,
  LAUNCHER_APPS_ORDER,
  LAUNCHER_DEVELOPER_ORDER,
} from "../pages/launcher-curation";
import { resolveLauncherIconAsset } from "./launcher-ionicons";

const CURATED_FIRST_PARTY_IDS = [
  ...LAUNCHER_APPS_ORDER,
  ...LAUNCHER_DEVELOPER_ORDER,
  ...LAUNCHER_AOSP_ONLY_IDS,
];

describe("launcher Ionicons resolver", () => {
  it.each(CURATED_FIRST_PARTY_IDS)(
    "resolves curated first-party destination %s to a real Ionicon asset",
    (id) => {
      const asset = resolveLauncherIconAsset({
        id,
        label: id,
        icon: "UnknownLegacyIcon",
      });

      expect(asset.kind).toBe("ionicon");
      expect(asset.name).not.toBe("apps");
      expect(asset.src).toMatch(/\/view-icons\/ionicons\/[^/]+\.svg$/);
    },
  );

  it("preserves a supplied third-party image URL", () => {
    const src = "https://cdn.example.com/partner.svg";
    const asset = resolveLauncherIconAsset({
      id: "partner",
      label: "Partner",
      icon: src,
    });

    expect(asset.kind).toBe("image");
    expect(asset.src).toBe(src);
  });

  it("gives first-party identity precedence over catalog image metadata", () => {
    const canonical = resolveLauncherIconAsset({
      id: "settings",
      label: "Settings",
    });
    const withCatalogImage = resolveLauncherIconAsset({
      id: "settings",
      label: "Renamed in catalog",
      icon: "https://cdn.example.com/legacy-settings.png",
    });

    expect(withCatalogImage.kind).toBe("ionicon");
    expect(withCatalogImage).toEqual(canonical);
  });

  it("uses a semantic named icon before conflicting label keywords", () => {
    const named = resolveLauncherIconAsset({
      id: "marketplace-view",
      label: "Calendar",
      icon: "TrendingUp",
    });
    const matchingSemantics = resolveLauncherIconAsset({
      id: "marketplace-view",
      label: "Trading Desk",
    });
    const conflictingSemantics = resolveLauncherIconAsset({
      id: "marketplace-view",
      label: "Calendar",
    });

    expect(named).toEqual(matchingSemantics);
    expect(named).not.toEqual(conflictingSemantics);
  });

  it("lets generic catalog placeholders defer to entry semantics", () => {
    const genericCatalogIcon = resolveLauncherIconAsset({
      id: "@elizaos/plugin-hyperliquid",
      label: "Hyperliquid",
      icon: "LayoutGrid",
    });
    const semanticResolution = resolveLauncherIconAsset({
      id: "@elizaos/plugin-hyperliquid",
      label: "Hyperliquid",
    });

    expect(genericCatalogIcon).toEqual(semanticResolution);
  });

  it.each([
    ["chat", "Chat", "MessageSquare", "chatbubble-ellipses"],
    ["settings", "Settings", "LayoutGrid", "settings"],
    ["release-calendar", "Trading Calendar", "CalendarDays", "calendar"],
    ["marketplace-view", "Trading Desk", undefined, "trending-up"],
  ])(
    "keeps representative destination %s on the approved %s asset",
    (id, label, icon, expectedName) => {
      expect(resolveLauncherIconAsset({ id, label, icon }).name).toBe(
        expectedName,
      );
    },
  );

  it("returns one stable family fallback for unrelated unknown entries", () => {
    const first = resolveLauncherIconAsset({
      id: "acme",
      label: "Acme",
      icon: "UnknownIcon",
    });
    const second = resolveLauncherIconAsset({
      id: "other",
      label: "Other",
    });

    expect(first.kind).toBe("ionicon");
    expect(first).toEqual(second);
    expect(first.name).toBe("apps");
  });
});
