/**
 * Covers the manifest-driven catalog curation in `helpers.ts`
 * (`shouldShowAppInAppsView`, `getAppCatalogSectionKey`, `groupAppsForCatalog`)
 * over in-memory `RegistryAppInfo` fixtures — pure functions, no I/O.
 */

import { describe, expect, it } from "vitest";
import type { RegistryAppInfo } from "../../api";
import {
  getAppCatalogSectionKey,
  groupAppsForCatalog,
  shouldShowAppInAppsView,
} from "./helpers";

// Curation is driven entirely by manifest-declared fields
// (`package.json` → `elizaos.app.{catalogSection,featured,defaultHidden,scope}`),
// not by hardcoded package-name sets. These cases assert the declared metadata
// yields the expected section/visibility classifications.

function app(overrides: Partial<RegistryAppInfo>): RegistryAppInfo {
  return {
    category: "utility",
    description: "",
    displayName: "Demo",
    name: "@elizaos/plugin-demo",
    ...overrides,
  } as RegistryAppInfo;
}

describe("getAppCatalogSectionKey — declared curation", () => {
  it("promotes apps declaring featured into the Featured section", () => {
    expect(
      getAppCatalogSectionKey(app({ featured: true, category: "utility" })),
    ).toBe("featured");
  });

  it("honors a declared catalogSection over the category heuristic", () => {
    // Finance apps historically declared category "game" but were forced into
    // finance by a name switch — now they declare catalogSection directly.
    expect(
      getAppCatalogSectionKey(
        app({ catalogSection: "finance", category: "game" }),
      ),
    ).toBe("finance");
    expect(
      getAppCatalogSectionKey(app({ catalogSection: "games", category: "" })),
    ).toBe("games");
  });

  it("falls back to the category heuristic when no section is declared", () => {
    expect(getAppCatalogSectionKey(app({ category: "game" }))).toBe("games");
    expect(getAppCatalogSectionKey(app({ category: "utility" }))).toBe(
      "developerUtilities",
    );
  });

  it("ignores a non-declarable section value (featured/favorites are dynamic)", () => {
    // A non-declarable value must be ignored — the section is then identical
    // to what the category/keyword heuristic yields with no declaration.
    const base = { name: "@elizaos/app-widget", category: "misc" };
    expect(
      getAppCatalogSectionKey(app({ ...base, catalogSection: "favorites" })),
    ).toBe(getAppCatalogSectionKey(app(base)));
  });
});

describe("groupAppsForCatalog — declared curation", () => {
  it("groups a featured app and a finance app into their sections", () => {
    const sections = groupAppsForCatalog([
      app({ name: "@elizaos/plugin-featured", featured: true }),
      app({
        name: "@elizaos/plugin-money",
        catalogSection: "finance",
        category: "game",
      }),
    ]);
    const byKey = new Map(
      sections.map((s) => [s.key, s.apps.map((a) => a.name)]),
    );
    expect(byKey.get("featured")).toEqual(["@elizaos/plugin-featured"]);
    expect(byKey.get("finance")).toEqual(["@elizaos/plugin-money"]);
  });
});

describe("shouldShowAppInAppsView — declared default-hidden + wallet scope", () => {
  // Curated app names pass the "curated / configured / internal" visibility
  // gate, letting us exercise the defaultHidden + scope branch directly.
  const walletApp = (overrides: Partial<RegistryAppInfo> = {}) =>
    app({
      name: "@elizaos/plugin-hyperliquid",
      catalogSection: "finance",
      defaultHidden: true,
      scope: "wallet",
      ...overrides,
    });

  it("hides a wallet-scoped default-hidden app when the wallet is off", () => {
    expect(
      shouldShowAppInAppsView(walletApp(), {
        showAllApps: false,
        walletEnabled: false,
      }),
    ).toBe(false);
  });

  it("reveals a wallet-scoped default-hidden app when the wallet is on", () => {
    expect(
      shouldShowAppInAppsView(walletApp(), {
        showAllApps: false,
        walletEnabled: true,
      }),
    ).toBe(true);
  });

  it("keeps a default-hidden app without wallet scope hidden even with wallet on", () => {
    expect(
      shouldShowAppInAppsView(
        app({
          name: "@elizaos/plugin-shopify",
          catalogSection: "finance",
          defaultHidden: true,
        }),
        { showAllApps: false, walletEnabled: true },
      ),
    ).toBe(false);
  });

  it("shows a plain (not default-hidden) catalog app", () => {
    expect(
      shouldShowAppInAppsView(
        app({
          name: "@elizaos/plugin-hyperliquid",
          catalogSection: "finance",
        }),
        { showAllApps: false, walletEnabled: false },
      ),
    ).toBe(true);
  });
});
