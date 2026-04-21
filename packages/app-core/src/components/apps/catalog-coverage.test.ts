import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RegistryAppInfo } from "../../api";
import {
  APPS_VIEW_HIDDEN_APP_NAMES,
  filterAppsForCatalog,
  isHiddenFromAppsView,
} from "./helpers";
import { getInternalToolApps } from "./internal-tool-apps";

const here = path.dirname(fileURLToPath(import.meta.url));
const upstreamAppsDir = path.resolve(here, "../../../../../apps");

function makeCatalogCandidate(name: string): RegistryAppInfo {
  return {
    name,
    displayName: name,
    description: "",
    category: "utility",
    launchType: "local",
    launchUrl: null,
    icon: null,
    heroImage: null,
    capabilities: [],
    stars: 0,
    repository: "",
    latestVersion: null,
    supports: { v0: false, v1: false, v2: true },
    npm: {
      package: name,
      v0Version: null,
      v1Version: null,
      v2Version: null,
    },
  };
}

function readUpstreamAppPackageNames(): string[] {
  return fs
    .readdirSync(upstreamAppsDir)
    .sort()
    .flatMap((entry) => {
      const packageJsonPath = path.join(upstreamAppsDir, entry, "package.json");
      if (!fs.existsSync(packageJsonPath)) {
        return [];
      }
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
      return typeof packageJson.name === "string" ? [packageJson.name] : [];
    });
}

describe("apps catalog coverage", () => {
  it("surfaces every upstream app package under eliza/apps", () => {
    const upstreamPackageNames = readUpstreamAppPackageNames();
    const injectedCatalogNames = new Set(
      getInternalToolApps().map((app) => app.name),
    );
    const filteredCatalogNames = new Set(
      filterAppsForCatalog(
        upstreamPackageNames
          .filter((name) => !injectedCatalogNames.has(name))
          .map(makeCatalogCandidate),
      ).map((app) => app.name),
    );

    const missing = upstreamPackageNames.filter(
      (name) =>
        !isHiddenFromAppsView(name) &&
        !injectedCatalogNames.has(name) &&
        !filteredCatalogNames.has(name),
    );

    expect(missing).toEqual([]);
  });

  it("keeps retired utility packages out of the apps catalog", () => {
    const internalCatalogNames = getInternalToolApps().map((app) => app.name);
    expect(internalCatalogNames).not.toEqual(
      expect.arrayContaining([...APPS_VIEW_HIDDEN_APP_NAMES]),
    );
    expect(
      filterAppsForCatalog(
        APPS_VIEW_HIDDEN_APP_NAMES.map(makeCatalogCandidate),
      ).map((app) => app.name),
    ).toEqual([]);
  });
});
