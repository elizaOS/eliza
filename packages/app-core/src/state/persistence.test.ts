// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_BOOT_CONFIG,
  setBootConfig,
} from "../config/boot-config-store";
import { loadFavoriteApps, saveFavoriteApps } from "./persistence";

describe("favorite app persistence", () => {
  beforeEach(() => {
    localStorage.clear();
    setBootConfig({
      ...DEFAULT_BOOT_CONFIG,
      defaultApps: ["@elizaos/app-lifeops"],
    });
  });

  afterEach(() => {
    localStorage.clear();
    setBootConfig(DEFAULT_BOOT_CONFIG);
  });

  it("uses configured default apps when no user preference is saved", () => {
    expect(loadFavoriteApps()).toEqual(["@elizaos/app-lifeops"]);
  });

  it("keeps an explicitly saved empty favorite list", () => {
    saveFavoriteApps([]);

    expect(loadFavoriteApps()).toEqual([]);
  });

  it("sanitizes saved favorite app names", () => {
    saveFavoriteApps(["@elizaos/app-lifeops", "", "@elizaos/app-lifeops"]);

    expect(loadFavoriteApps()).toEqual(["@elizaos/app-lifeops"]);
  });
});
