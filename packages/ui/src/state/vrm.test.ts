/**
 * Unit tests for the bundled VRM avatar resolution helpers in
 * packages/ui/src/state/vrm.ts. Covers slug/URL resolution against configured
 * boot-config assets, the bundled-1 fallback when no assets are declared, and
 * the index-normalization contract (non-finite, fractional, and out-of-range
 * indices never leak into asset lookups). Deterministic: boot config is set
 * per-test and reset to defaults after each.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  type AppBootConfig,
  DEFAULT_BOOT_CONFIG,
  setBootConfig,
} from "../config/boot-config-store";
import {
  getCompanionBackgroundUrl,
  getVrmBackgroundUrl,
  getVrmCount,
  getVrmPreviewUrl,
  getVrmTitle,
  getVrmUrl,
  normalizeAvatarIndex,
  VRM_COUNT,
} from "./vrm";

/** Three distinct slugs keep URL assertions unambiguous per index. */
const VRM_ASSETS: NonNullable<AppBootConfig["vrmAssets"]> = [
  { title: "Aliza", slug: "aliza" },
  { title: "Bento", slug: "bento" },
  { title: "Cairn", slug: "cairn" },
];

/** Four assets so the dark theme's pinned index 4 resolves distinctly. */
const FOUR_VRM_ASSETS: NonNullable<AppBootConfig["vrmAssets"]> = [
  ...VRM_ASSETS,
  { title: "Dune", slug: "dune" },
];

function setVrmAssets(assets: AppBootConfig["vrmAssets"]): void {
  setBootConfig({ ...DEFAULT_BOOT_CONFIG, vrmAssets: assets });
}

describe("vrm avatar resolution", () => {
  afterEach(() => {
    setBootConfig(DEFAULT_BOOT_CONFIG);
  });

  describe("VRM_COUNT", () => {
    it("exports the legacy bundled-avatar count constant", () => {
      expect(VRM_COUNT).toBe(8);
    });
  });

  describe("getVrmCount", () => {
    it("returns the declared asset count", () => {
      setVrmAssets(VRM_ASSETS);
      expect(getVrmCount()).toBe(3);
    });

    it("is 0 when no assets are declared", () => {
      setVrmAssets(undefined);
      expect(getVrmCount()).toBe(0);
    });

    it("is 0 when the declared list is empty", () => {
      setVrmAssets([]);
      expect(getVrmCount()).toBe(0);
    });

    it("is 0 for a non-array declaration instead of throwing", () => {
      // Boot config is host-supplied input; a malformed shape must degrade to
      // the no-assets fallback rather than crash the resolver.
      setVrmAssets("not-a-list" as unknown as AppBootConfig["vrmAssets"]);
      expect(getVrmCount()).toBe(0);
    });
  });

  describe("normalizeAvatarIndex", () => {
    it.each([1, 2, 3])("keeps in-range index %d", (index) => {
      setVrmAssets(VRM_ASSETS);
      expect(normalizeAvatarIndex(index)).toBe(index);
    });

    it.each([NaN, Infinity, -Infinity])("maps non-finite %s to 1", (bad) => {
      setVrmAssets(VRM_ASSETS);
      expect(normalizeAvatarIndex(bad)).toBe(1);
    });

    it("truncates fractional indices toward zero", () => {
      setVrmAssets(VRM_ASSETS);
      expect(normalizeAvatarIndex(2.9)).toBe(2);
      // 0.9 truncates to 0, and the zero sentinel early-returns before the
      // out-of-range fallback — fractional values below 1 resolve to 0.
      expect(normalizeAvatarIndex(0.9)).toBe(0);
    });

    it("passes through index 0 (the custom-avatar sentinel)", () => {
      setVrmAssets(VRM_ASSETS);
      expect(normalizeAvatarIndex(0)).toBe(0);
    });

    it.each([-1, 4, 99])("maps out-of-range %d to fallback 1", (bad) => {
      setVrmAssets(VRM_ASSETS);
      expect(normalizeAvatarIndex(bad)).toBe(1);
    });

    it("maps every invalid input to 1 when no assets are declared", () => {
      setVrmAssets(undefined);
      expect(normalizeAvatarIndex(2)).toBe(1);
      expect(normalizeAvatarIndex(0)).toBe(0); // 0 stays 0 regardless of catalog
      expect(normalizeAvatarIndex(NaN)).toBe(1);
    });
  });

  describe("getVrmUrl / getVrmPreviewUrl / getVrmBackgroundUrl", () => {
    it("resolves each declared asset by 1-based index", () => {
      setVrmAssets(VRM_ASSETS);
      expect(getVrmUrl(1)).toBe("/vrms/aliza.vrm.gz");
      expect(getVrmUrl(2)).toBe("/vrms/bento.vrm.gz");
      expect(getVrmUrl(3)).toBe("/vrms/cairn.vrm.gz");
      expect(getVrmPreviewUrl(2)).toBe("/vrms/previews/bento.png");
      expect(getVrmBackgroundUrl(3)).toBe("/vrms/backgrounds/cairn.png");
    });

    it("falls back to the first asset for invalid indices", () => {
      setVrmAssets(VRM_ASSETS);
      expect(getVrmUrl(NaN)).toBe("/vrms/aliza.vrm.gz");
      expect(getVrmUrl(0)).toBe("/vrms/aliza.vrm.gz");
      expect(getVrmUrl(99)).toBe("/vrms/aliza.vrm.gz");
      expect(getVrmPreviewUrl(-5)).toBe("/vrms/previews/aliza.png");
      expect(getVrmBackgroundUrl(Infinity)).toBe("/vrms/backgrounds/aliza.png");
    });

    it("uses the bundled-1 fallback slug when no assets are declared", () => {
      setVrmAssets(undefined);
      expect(getVrmUrl(1)).toBe("/vrms/bundled-1.vrm.gz");
      expect(getVrmPreviewUrl(2)).toBe("/vrms/previews/bundled-1.png");
      expect(getVrmBackgroundUrl(99)).toBe("/vrms/backgrounds/bundled-1.png");
    });
  });

  describe("getCompanionBackgroundUrl", () => {
    it("maps themes to their pinned background assets by literal URL", () => {
      setVrmAssets(FOUR_VRM_ASSETS);
      // Literal URLs (not relative assertions) so a wrong pinned index
      // (light↔dark swap, off-by-one) cannot pass via a shared fallback.
      expect(getCompanionBackgroundUrl("light")).toBe(
        "/vrms/backgrounds/cairn.png",
      );
      expect(getCompanionBackgroundUrl("dark")).toBe(
        "/vrms/backgrounds/dune.png",
      );
    });

    it("falls back to the first asset when a pinned index is out of range", () => {
      setVrmAssets(VRM_ASSETS); // only 3 assets — dark's pinned 4 is out of range
      expect(getCompanionBackgroundUrl("dark")).toBe(
        "/vrms/backgrounds/aliza.png",
      );
    });

    it("uses the bundled-1 fallback when no assets are declared", () => {
      setVrmAssets(undefined);
      expect(getCompanionBackgroundUrl("light")).toBe(
        "/vrms/backgrounds/bundled-1.png",
      );
      expect(getCompanionBackgroundUrl("dark")).toBe(
        "/vrms/backgrounds/bundled-1.png",
      );
    });
  });

  describe("getVrmTitle", () => {
    it("returns the title of the resolved asset", () => {
      setVrmAssets(VRM_ASSETS);
      expect(getVrmTitle(2)).toBe("Bento");
      expect(getVrmTitle(NaN)).toBe("Aliza"); // fallback to first asset
    });

    it('returns "Avatar" when no assets are declared', () => {
      setVrmAssets(undefined);
      expect(getVrmTitle(1)).toBe("Avatar");
    });

    it("uses literal fallbacks when entries lack slug/title keys", () => {
      // Chain order: assets[n]?.slug ?? assets[0]?.slug ?? "default" — a
      // missing key on a later entry falls back to the FIRST asset's slug...
      setVrmAssets([
        { title: "Partial", slug: "partial" },
        {} as { title: string; slug: string },
      ]);
      expect(getVrmUrl(2)).toBe("/vrms/partial.vrm.gz");
      expect(getVrmTitle(2)).toBe("Partial");
      // ...and the "default"/"Avatar" literals fire only when the first
      // entry itself lacks the key (all indices share the fallback).
      setVrmAssets([{} as { title: string; slug: string }]);
      expect(getVrmUrl(1)).toBe("/vrms/default.vrm.gz");
      expect(getVrmPreviewUrl(1)).toBe("/vrms/previews/default.png");
      expect(getVrmBackgroundUrl(1)).toBe("/vrms/backgrounds/default.png");
      expect(getVrmTitle(1)).toBe("Avatar");
    });
  });
});
