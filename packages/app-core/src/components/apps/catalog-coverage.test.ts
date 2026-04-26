import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { RegistryAppInfo } from "../../api";
import {
  DEFAULT_BOOT_CONFIG,
  setBootConfig,
} from "../../config/boot-config-store";
import {
  APPS_VIEW_HIDDEN_APP_NAMES,
  filterAppsForCatalog,
  groupAppsForCatalog,
  isHiddenFromAppsView,
} from "./helpers";
import { getInternalToolApps } from "./internal-tool-apps";

const here = path.dirname(fileURLToPath(import.meta.url));
const upstreamAppsDir = path.resolve(here, "../../../../../apps");
const rendererPublicDir = path.resolve(upstreamAppsDir, "app/public");

function makeCatalogCandidate(
  name: string,
  category: RegistryAppInfo["category"] = "utility",
): RegistryAppInfo {
  return {
    name,
    displayName: name,
    description: "",
    category,
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

function readUpstreamAppPackages(): Array<{
  dir: string;
  name: string;
  packageJson: {
    elizaos?: {
      app?: {
        heroImage?: unknown;
      };
    };
  };
}> {
  return fs
    .readdirSync(upstreamAppsDir)
    .sort()
    .flatMap((entry) => {
      const packageJsonPath = path.join(upstreamAppsDir, entry, "package.json");
      if (!fs.existsSync(packageJsonPath)) {
        return [];
      }
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
      return typeof packageJson.name === "string"
        ? [{ dir: path.dirname(packageJsonPath), name: packageJson.name, packageJson }]
        : [];
    });
}

function isPackageLocalHeroPath(value: string): boolean {
  return !/^(https?:|data:image\/|blob:|file:|capacitor:|electrobun:|app:|\/)/i.test(
    value,
  );
}

describe("apps catalog coverage", () => {
  afterEach(() => {
    setBootConfig(DEFAULT_BOOT_CONFIG);
  });

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
        { showAllApps: true },
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

  it("backs every upstream catalog app package with a package-local hero", () => {
    const missing = readUpstreamAppPackages()
      .filter(({ name }) => name !== "@elizaos/app")
      .flatMap(({ dir, name, packageJson }) => {
        const heroImage = packageJson.elizaos?.app?.heroImage;
        if (typeof heroImage !== "string" || !heroImage.trim()) {
          return [{ name, reason: "missing elizaos.app.heroImage" }];
        }
        if (!isPackageLocalHeroPath(heroImage)) {
          return [{ name, reason: `non-local hero path: ${heroImage}` }];
        }
        const heroPath = path.resolve(dir, heroImage);
        const packageRoot = `${path.resolve(dir)}${path.sep}`;
        if (!heroPath.startsWith(packageRoot)) {
          return [{ name, reason: `hero escapes package: ${heroImage}` }];
        }
        if (!fs.existsSync(heroPath)) {
          return [{ name, reason: `missing file: ${heroImage}` }];
        }
        return [];
      });

    expect(missing).toEqual([]);
  });

  it("points every internal tool app at an existing hero source", () => {
    const missing = getInternalToolApps().flatMap((app) => {
      const heroImage = app.heroImage?.trim();
      if (!heroImage) {
        return [{ name: app.name, reason: "missing heroImage" }];
      }
      if (heroImage.startsWith("/api/apps/hero/")) {
        return [];
      }
      if (heroImage.startsWith("/app-heroes/")) {
        const publicPath = path.join(rendererPublicDir, heroImage.slice(1));
        return fs.existsSync(publicPath)
          ? []
          : [{ name: app.name, reason: `missing static file: ${heroImage}` }];
      }
      return [{ name: app.name, reason: `unsupported hero source: ${heroImage}` }];
    });

    expect(missing).toEqual([]);
  });

  it("hides non-primary game apps and the finance section by default", () => {
    const visibleNames = filterAppsForCatalog([
      makeCatalogCandidate("@elizaos/app-lifeops"),
      makeCatalogCandidate("@elizaos/app-companion", "game"),
      makeCatalogCandidate("@elizaos/app-defense-of-the-agents", "game"),
      makeCatalogCandidate("@clawville/app-clawville", "game"),
      makeCatalogCandidate("@elizaos/app-babylon", "game"),
      makeCatalogCandidate("@elizaos/app-2004scape", "game"),
      makeCatalogCandidate("@elizaos/app-scape", "game"),
      makeCatalogCandidate("@hyperscape/plugin-hyperscape", "game"),
      makeCatalogCandidate("@elizaos/app-vincent", "platform"),
      makeCatalogCandidate("@elizaos/app-shopify", "platform"),
      makeCatalogCandidate("@elizaos/app-steward"),
      makeCatalogCandidate("@elizaos/app-elizamaker"),
    ]).map((app) => app.name);

    expect(visibleNames).toEqual(
      expect.arrayContaining([
        "@elizaos/app-lifeops",
        "@elizaos/app-companion",
        "@elizaos/app-defense-of-the-agents",
        "@clawville/app-clawville",
      ]),
    );
    expect(visibleNames).not.toEqual(
      expect.arrayContaining([
        "@elizaos/app-babylon",
        "@elizaos/app-2004scape",
        "@elizaos/app-scape",
        "@hyperscape/plugin-hyperscape",
        "@elizaos/app-vincent",
        "@elizaos/app-shopify",
        "@elizaos/app-steward",
        "@elizaos/app-elizamaker",
      ]),
    );
  });

  it("surfaces the current flagship apps in the featured section", () => {
    const sections = groupAppsForCatalog(
      filterAppsForCatalog([
        makeCatalogCandidate("@elizaos/app-lifeops"),
        makeCatalogCandidate("@elizaos/app-companion", "game"),
        makeCatalogCandidate("@elizaos/app-defense-of-the-agents", "game"),
        makeCatalogCandidate("@clawville/app-clawville", "game"),
      ]),
    );

    expect(sections[0]).toMatchObject({
      key: "featured",
      apps: [
        { name: "@elizaos/app-lifeops" },
        { name: "@elizaos/app-companion" },
        { name: "@elizaos/app-defense-of-the-agents" },
        { name: "@clawville/app-clawville" },
      ],
    });
  });

  it("filters starred flagship apps out of the featured section", () => {
    const sections = groupAppsForCatalog(
      filterAppsForCatalog([
        makeCatalogCandidate("@elizaos/app-lifeops"),
        makeCatalogCandidate("@elizaos/app-companion", "game"),
        makeCatalogCandidate("@elizaos/app-defense-of-the-agents", "game"),
        makeCatalogCandidate("@clawville/app-clawville", "game"),
      ]),
      {
        favoriteAppNames: new Set([
          "@elizaos/app-lifeops",
          "@elizaos/app-companion",
          "@elizaos/app-defense-of-the-agents",
        ]),
      },
    );

    expect(sections[0]).toMatchObject({
      key: "favorites",
      apps: [
        { name: "@elizaos/app-lifeops" },
        { name: "@elizaos/app-companion" },
        { name: "@elizaos/app-defense-of-the-agents" },
      ],
    });
    expect(sections[1]).toMatchObject({
      key: "featured",
      apps: [{ name: "@clawville/app-clawville" }],
    });
  });

  it("surfaces configured default apps in the featured section", () => {
    setBootConfig({
      ...DEFAULT_BOOT_CONFIG,
      defaultApps: ["@example/app-default"],
    });

    const sections = groupAppsForCatalog(
      filterAppsForCatalog([makeCatalogCandidate("@example/app-default")], {
        showAllApps: true,
      }),
    );

    expect(sections[0]).toMatchObject({
      key: "featured",
      apps: [{ name: "@example/app-default" }],
    });
  });
});
