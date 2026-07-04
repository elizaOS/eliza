/**
 * Unit coverage for path→tab resolution against the app-shell registry. In-memory
 * registry, no runtime.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerAppShellPage } from "../app-shell-registry";
import { resetUiRegistryHostForTests } from "../registry-host";
import {
  ALL_TAB_GROUPS,
  LEGACY_PREFIX_TAB_ALIASES,
  TAB_PATHS,
  tabFromPath,
} from "./index";

beforeEach(() => {
  resetUiRegistryHostForTests();
});

afterEach(() => {
  resetUiRegistryHostForTests();
});

describe("navigation tabFromPath", () => {
  it("uses app-shell tab affinity for registered plugin pages", () => {
    registerAppShellPage({
      id: "test.wallet.inventory",
      pluginId: "@elizaos/plugin-wallet-ui",
      label: "Wallet",
      path: "/test/inventory",
      tabAffinity: "inventory",
      loader: async () => ({ default: () => null }),
    });

    expect(tabFromPath("/test/inventory")).toBe("inventory");
  });

  it("falls back to the app-shell page id when no tab affinity is declared", () => {
    registerAppShellPage({
      id: "test.unaffiliated",
      pluginId: "test-plugin",
      label: "Unaffiliated",
      path: "/test/unaffiliated",
      loader: async () => ({ default: () => null }),
    });

    expect(tabFromPath("/test/unaffiliated")).toBe("test.unaffiliated");
  });

  it("routes phone companion from its registration metadata", () => {
    registerAppShellPage({
      id: "test.phone-companion",
      pluginId: "@elizaos/plugin-phone",
      label: "Phone Companion",
      path: "/test/phone-companion",
      tabAffinity: "test.phone-companion",
      loader: async () => ({ default: () => null }),
    });

    expect(tabFromPath("/test/phone-companion")).toBe("test.phone-companion");
  });

  it("builds wallet launcher grouping from app-shell page group metadata", () => {
    registerAppShellPage({
      id: "test.wallet",
      pluginId: "test-wallet",
      label: "Wallet",
      path: "/inventory",
      tabAffinity: "inventory",
      group: "wallet",
      order: 10,
      loader: async () => ({ default: () => null }),
    });
    registerAppShellPage({
      id: "test.perps",
      pluginId: "test-perps",
      label: "Perps",
      path: "/perps",
      tabAffinity: "inventory",
      group: "wallet",
      order: 20,
      loader: async () => ({ default: () => null }),
    });

    const walletGroup = ALL_TAB_GROUPS.find(
      (group) => group.label === "Wallet",
    );
    expect(walletGroup?.tabs).toEqual(["inventory", "test.perps"]);
  });
});

describe("navigation prefix sub-tab resolution is registry-derived", () => {
  // Built-in `/apps/<sub>` and `/character/<sub>` routes must resolve to the
  // tab declared for that exact path in TAB_PATHS, so the routing table never
  // drifts from the canonical path registry. Every case below is derived from
  // TAB_PATHS, not from a second hand-maintained alias record.
  it("resolves /apps/<sub> tool routes from the TAB_PATHS registry", () => {
    expect(tabFromPath("/apps/plugins")).toBe("plugins");
    expect(tabFromPath("/apps/skills")).toBe("skills");
    expect(tabFromPath("/apps/trajectories")).toBe("trajectories");
    expect(tabFromPath("/apps/transcripts")).toBe("transcripts");
    expect(tabFromPath("/apps/relationships")).toBe("relationships");
    expect(tabFromPath("/apps/memories")).toBe("memories");
    expect(tabFromPath("/apps/files")).toBe("files");
    expect(tabFromPath("/apps/runtime")).toBe("runtime");
    expect(tabFromPath("/apps/database")).toBe("database");
    expect(tabFromPath("/apps/logs")).toBe("logs");
    expect(tabFromPath("/apps/tasks")).toBe("tasks");
    // advanced + fine-tuning share /apps/fine-tuning; the registry resolves it
    // to the canonical fine-tuning tab exactly as the old record did.
    expect(tabFromPath("/apps/fine-tuning")).toBe("fine-tuning");
  });

  it("resolves /character/<sub> hub routes from the TAB_PATHS registry", () => {
    expect(tabFromPath("/character/documents")).toBe("documents");
    expect(tabFromPath("/character/select")).toBe("character-select");
    expect(tabFromPath("/character/experience")).toBe("experience");
    expect(tabFromPath("/character/skills")).toBe("character-skills");
  });

  it("defaults unknown sub-paths to their prefix owner", () => {
    // Unknown /apps/<sub> is an app slug catch-all; unknown /character/<sub>
    // falls back to the character hub; a nested /apps/<sub>/<x> is a view.
    expect(tabFromPath("/apps/some-unknown-slug")).toBe("apps");
    expect(tabFromPath("/apps/plugins/nested")).toBe("views");
    expect(tabFromPath("/character/unknown-section")).toBe("character");
  });

  it("keeps only the two irreducible legacy prefix aliases", () => {
    // /apps/inventory (canonical tab path is /wallet) and
    // /character/relationships (canonical tab path is /apps/relationships) are
    // the ONLY paths whose target tab lives under a different prefix, so they
    // stay as an explicitly-marked host-owned fallback.
    expect(tabFromPath("/apps/inventory")).toBe("inventory");
    expect(tabFromPath("/character/relationships")).toBe("relationships");
  });

  it("legacy alias table holds no path already derivable from TAB_PATHS (drift guard)", () => {
    const canonicalPaths = new Set(Object.values(TAB_PATHS));
    for (const aliasPath of Object.keys(LEGACY_PREFIX_TAB_ALIASES)) {
      // If a legacy-alias path were also a canonical TAB_PATHS value, the
      // registry would already own it and the alias would be dead duplication.
      expect(canonicalPaths.has(aliasPath)).toBe(false);
    }
  });
});

describe("navigation index: no reintroduced hardcoded prefix alias record", () => {
  it("has no APPS_SUB_TABS record or inline /character/<sub> if-chain (grep guard)", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./index.ts", import.meta.url)),
      "utf8",
    );
    // The old hand-maintained record declaration and the inline character sub
    // if-chain are gone from executable paths; resolution is registry-driven.
    expect(source).not.toMatch(/(?:const|let|var)\s+APPS_SUB_TABS\b/);
    expect(source).not.toMatch(/if\s*\(\s*sub\s*===\s*"documents"\s*\)/);
    expect(source).not.toMatch(/if\s*\(\s*sub\s*===\s*"select"\s*\)/);
  });
});
