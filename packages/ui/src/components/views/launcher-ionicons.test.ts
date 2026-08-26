/** Verifies canonical Ionicons coverage and launcher icon asset resolution. */
import { describe, expect, it } from "vitest";
import {
  LAUNCHER_AOSP_ONLY_IDS,
  LAUNCHER_APPS_ORDER,
  LAUNCHER_DEVELOPER_ORDER,
} from "../pages/launcher-curation";
import { resolveLauncherIconAsset } from "./launcher-ionicons";

const FIRST_PARTY_MAPPINGS = [
  ["settings", "settings"],
  ["wallet", "wallet"],
  ["tasks", "folder-open"],
  ["calendar", "calendar"],
  ["simple-calendar", "calendar"],
  ["notes", "document-text"],
  ["automations", "time"],
  ["browser", "compass"],
  ["cloud", "cloud"],
  ["character", "person-circle"],
  ["documents", "library"],
  ["memories", "hardware-chip"],
  ["stream", "radio"],
  ["pendant-transcript", "mic-circle"],
  ["trajectories", "git-branch"],
  ["database", "server"],
  ["runtime", "terminal"],
  ["logs", "reader"],
  ["skills", "sparkles"],
  ["plugins", "extension-puzzle"],
  ["phone", "call"],
  ["messages", "chatbubble-ellipses"],
  ["contacts", "people"],
  ["camera", "camera"],
  ["files", "folder"],
] as const;

describe("launcher Ionicons resolver", () => {
  it("covers every curated first-party launcher destination", () => {
    const curatedIds = [
      ...LAUNCHER_APPS_ORDER,
      ...LAUNCHER_DEVELOPER_ORDER,
      ...LAUNCHER_AOSP_ONLY_IDS,
    ].sort();
    const mappedIds = FIRST_PARTY_MAPPINGS.map(([id]) => id).sort();

    expect(mappedIds).toEqual(curatedIds);
  });

  it.each(FIRST_PARTY_MAPPINGS)(
    "maps first-party %s to the filled %s asset",
    (id, expected) => {
      const asset = resolveLauncherIconAsset({
        id,
        label: id,
        icon: "NoSuchLegacyIcon",
      });

      expect(asset.kind).toBe("ionicon");
      expect(asset.name).toBe(expected);
      expect(asset.src).toContain(`/view-icons/ionicons/${expected}.svg`);
    },
  );

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
