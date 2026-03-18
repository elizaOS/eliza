import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Regression test: ensures every subpath used by internal imports
 * has a matching entry in the package.json "exports" map.
 *
 * This prevents Vite / Node resolution errors like:
 *   Missing "./utils/eliza-globals" specifier in "@elizaos/app-core" package
 */
describe("@elizaos/app-core package exports", () => {
  const pkgPath = resolve(__dirname, "../../package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  const exportKeys = Object.keys(pkg.exports ?? {});

  /**
   * Subpaths that are imported with deep paths within the package
   * or by downstream consumers (e.g. @elizaos/home).
   * Each entry should resolve through the exports map.
   */
  const requiredSubpaths = [
    "./api",
    "./bridge",
    "./config",
    "./events",
    "./hooks",
    "./i18n",
    "./navigation",
    "./platform",
    "./state",
    "./types",
    "./utils",
    "./voice",
    "./autonomy",
    "./chat",
    "./coding",
    "./providers",
    "./actions",
    "./onboarding-config",
    "./companion",
    "./components",
    "./styles/base.css",
    "./styles/xterm.css",
    "./styles/anime.css",
    "./styles/onboarding-game.css",
    "./styles/styles.css",
  ];

  for (const subpath of requiredSubpaths) {
    it(`exports "${subpath}"`, () => {
      expect(exportKeys).toContain(subpath);
    });
  }

  /**
   * Deep wildcard subpaths that must resolve (e.g. ./utils/eliza-globals).
   * These rely on wildcard entries like "./utils/*" in the exports map.
   */
  const deepSubpaths = [
    { subpath: "./utils/eliza-globals", wildcard: "./utils/*" },
    { subpath: "./components/StreamView", wildcard: "./components/*" },
  ];

  for (const { subpath, wildcard } of deepSubpaths) {
    it(`resolves "${subpath}" via wildcard "${wildcard}"`, () => {
      expect(exportKeys).toContain(wildcard);
    });
  }
});
