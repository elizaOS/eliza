/**
 * Behavioural coverage for registry-client-app-meta: sandbox token allowlisting
 * (empty, whitespace, duplicates, untrusted tokens, first-match rejection),
 * RegistryAppMeta merge (missing sides, empty vs nonempty capabilities, nullish
 * optional fields, nested viewer embedParams, session feature replacement), and
 * the hardcoded @elizaos/app-hyperfy local override. Drives the real module —
 * logger.warn is observed, never substituted for the sanitizer.
 */

import { logger } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LOCAL_APP_DEFAULT_SANDBOX,
  mergeAppMeta,
  resolveAppOverride,
  sanitizeSandbox,
} from "./registry-client-app-meta.ts";
import type {
  RegistryAppMeta,
  RegistryAppSessionMeta,
  RegistryAppViewerMeta,
} from "./registry-client-types.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

function appMeta(
  overrides: {
    displayName?: string;
    category?: string;
    launchType?: string;
    launchUrl?: string | null;
    icon?: string | null;
    heroImage?: string | null;
    capabilities?: string[];
    minPlayers?: number | null;
    maxPlayers?: number | null;
    runtimePlugin?: string;
    bridgeExport?: string;
    uiExtension?: { detailPanelId: string };
    viewer?: RegistryAppViewerMeta;
    session?: RegistryAppSessionMeta;
    developerOnly?: boolean;
    visibleInAppStore?: boolean;
    mainTab?: boolean;
    catalogSection?: string;
    featured?: boolean;
    defaultHidden?: boolean;
    scope?: string;
  } = {},
): RegistryAppMeta {
  const meta: RegistryAppMeta = {
    displayName: overrides.displayName ?? "Base App",
    category: overrides.category ?? "productivity",
    launchType: overrides.launchType ?? "url",
    launchUrl:
      overrides.launchUrl === undefined
        ? "https://example.test/app"
        : overrides.launchUrl,
    icon: overrides.icon === undefined ? null : overrides.icon,
    heroImage: overrides.heroImage === undefined ? null : overrides.heroImage,
    capabilities: overrides.capabilities ?? ["chat"],
    minPlayers:
      overrides.minPlayers === undefined ? null : overrides.minPlayers,
    maxPlayers:
      overrides.maxPlayers === undefined ? null : overrides.maxPlayers,
  };
  if (overrides.runtimePlugin !== undefined) {
    meta.runtimePlugin = overrides.runtimePlugin;
  }
  if (overrides.bridgeExport !== undefined) {
    meta.bridgeExport = overrides.bridgeExport;
  }
  if (overrides.uiExtension !== undefined) {
    meta.uiExtension = overrides.uiExtension;
  }
  if (overrides.viewer !== undefined) {
    meta.viewer = overrides.viewer;
  }
  if (overrides.session !== undefined) {
    meta.session = overrides.session;
  }
  if (overrides.developerOnly !== undefined) {
    meta.developerOnly = overrides.developerOnly;
  }
  if (overrides.visibleInAppStore !== undefined) {
    meta.visibleInAppStore = overrides.visibleInAppStore;
  }
  if (overrides.mainTab !== undefined) {
    meta.mainTab = overrides.mainTab;
  }
  if (overrides.catalogSection !== undefined) {
    meta.catalogSection = overrides.catalogSection;
  }
  if (overrides.featured !== undefined) {
    meta.featured = overrides.featured;
  }
  if (overrides.defaultHidden !== undefined) {
    meta.defaultHidden = overrides.defaultHidden;
  }
  if (overrides.scope !== undefined) {
    meta.scope = overrides.scope;
  }
  return meta;
}

describe("LOCAL_APP_DEFAULT_SANDBOX", () => {
  it("is the three-token local-app default", () => {
    expect(LOCAL_APP_DEFAULT_SANDBOX).toBe(
      "allow-scripts allow-same-origin allow-popups",
    );
  });
});

describe("sanitizeSandbox", () => {
  it("returns the default for undefined, empty, and whitespace-only input", () => {
    expect(sanitizeSandbox(undefined)).toBe(LOCAL_APP_DEFAULT_SANDBOX);
    expect(sanitizeSandbox("")).toBe(LOCAL_APP_DEFAULT_SANDBOX);
    expect(sanitizeSandbox("   \t\n  ")).toBe(LOCAL_APP_DEFAULT_SANDBOX);
  });

  it("returns a single allowed token unchanged", () => {
    expect(sanitizeSandbox("allow-scripts")).toBe("allow-scripts");
  });

  it("keeps first-seen order while dropping duplicate tokens", () => {
    expect(
      sanitizeSandbox("allow-forms allow-scripts allow-forms allow-modals"),
    ).toBe("allow-forms allow-scripts allow-modals");
  });

  it("splits on any whitespace and trims each token", () => {
    expect(
      sanitizeSandbox("  allow-scripts \t allow-forms \n allow-modals  "),
    ).toBe("allow-scripts allow-forms allow-modals");
  });

  it("rejects the entire string on the first untrusted token and logs it", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    expect(
      sanitizeSandbox("allow-scripts allow-top-navigation allow-forms"),
    ).toBe(LOCAL_APP_DEFAULT_SANDBOX);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "[registry-client] rejecting untrusted sandbox token: allow-top-navigation",
    );
  });

  it("treats allowlist membership as case-sensitive", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    expect(sanitizeSandbox("Allow-Scripts")).toBe(LOCAL_APP_DEFAULT_SANDBOX);
    expect(warn).toHaveBeenCalledWith(
      "[registry-client] rejecting untrusted sandbox token: Allow-Scripts",
    );
  });

  it("accepts every allowlisted token in declaration order", () => {
    const tokens = [
      "allow-downloads",
      "allow-forms",
      "allow-modals",
      "allow-orientation-lock",
      "allow-pointer-lock",
      "allow-popups",
      "allow-popups-to-escape-sandbox",
      "allow-presentation",
      "allow-same-origin",
      "allow-scripts",
      "allow-storage-access-by-user-activation",
      "allow-top-navigation-by-user-activation",
    ];
    expect(sanitizeSandbox(tokens.join(" "))).toBe(tokens.join(" "));
  });
});

describe("mergeAppMeta", () => {
  it("returns undefined when both sides are missing", () => {
    expect(mergeAppMeta(undefined, undefined)).toBeUndefined();
  });

  it("returns the sole side as-is without sanitizing viewer sandbox", () => {
    const base = appMeta({
      displayName: "Only Base",
      viewer: { url: "https://base.test", sandbox: "allow-top-navigation" },
    });
    const patch = appMeta({
      displayName: "Only Patch",
      viewer: { url: "https://patch.test", sandbox: "not-a-token" },
    });

    expect(mergeAppMeta(base, undefined)).toBe(base);
    expect(mergeAppMeta(undefined, patch)).toBe(patch);
    expect(mergeAppMeta(base, undefined)?.viewer?.sandbox).toBe(
      "allow-top-navigation",
    );
    expect(mergeAppMeta(undefined, patch)?.viewer?.sandbox).toBe("not-a-token");
  });

  it("lets nonempty patch capabilities replace base, and empty patch keep base", () => {
    const base = appMeta({ capabilities: ["voice", "files"] });
    expect(
      mergeAppMeta(base, appMeta({ capabilities: ["wallet"] }))?.capabilities,
    ).toEqual(["wallet"]);
    expect(
      mergeAppMeta(base, appMeta({ capabilities: [] }))?.capabilities,
    ).toEqual(["voice", "files"]);
  });

  it("falls back optional scalar fields with ?? so false and empty string win", () => {
    const base = appMeta({
      runtimePlugin: "base-plugin",
      bridgeExport: "base-export",
      uiExtension: { detailPanelId: "base-panel" },
      developerOnly: true,
      visibleInAppStore: true,
      mainTab: true,
      catalogSection: "games",
      featured: true,
      defaultHidden: true,
      scope: "wallet",
    });
    const patchKeepsFalse = appMeta({
      runtimePlugin: "",
      developerOnly: false,
      visibleInAppStore: false,
      mainTab: false,
      featured: false,
      defaultHidden: false,
    });
    const mergedKeep = mergeAppMeta(base, patchKeepsFalse);
    expect(mergedKeep?.runtimePlugin).toBe("");
    expect(mergedKeep?.bridgeExport).toBe("base-export");
    expect(mergedKeep?.uiExtension).toEqual({ detailPanelId: "base-panel" });
    expect(mergedKeep?.developerOnly).toBe(false);
    expect(mergedKeep?.visibleInAppStore).toBe(false);
    expect(mergedKeep?.mainTab).toBe(false);
    expect(mergedKeep?.featured).toBe(false);
    expect(mergedKeep?.defaultHidden).toBe(false);
    expect(mergedKeep?.catalogSection).toBe("games");
    expect(mergedKeep?.scope).toBe("wallet");

    const patchOverrides = appMeta({
      runtimePlugin: "patch-plugin",
      bridgeExport: "patch-export",
      uiExtension: { detailPanelId: "patch-panel" },
      catalogSection: "finance",
      scope: "wallet",
    });
    const mergedOverride = mergeAppMeta(base, patchOverrides);
    expect(mergedOverride?.runtimePlugin).toBe("patch-plugin");
    expect(mergedOverride?.bridgeExport).toBe("patch-export");
    expect(mergedOverride?.uiExtension).toEqual({
      detailPanelId: "patch-panel",
    });
    expect(mergedOverride?.catalogSection).toBe("finance");
  });

  it("overwrites top-level identity fields from the patch via object spread", () => {
    const merged = mergeAppMeta(
      appMeta({
        displayName: "Base",
        category: "productivity",
        launchType: "url",
        launchUrl: "https://base.test",
        icon: "base.png",
        heroImage: "base-hero.png",
        minPlayers: 1,
        maxPlayers: 4,
      }),
      appMeta({
        displayName: "Patch",
        category: "game",
        launchType: "connect",
        launchUrl: null,
        icon: null,
        heroImage: "patch-hero.png",
        minPlayers: 2,
        maxPlayers: null,
      }),
    );
    expect(merged?.displayName).toBe("Patch");
    expect(merged?.category).toBe("game");
    expect(merged?.launchType).toBe("connect");
    expect(merged?.launchUrl).toBeNull();
    expect(merged?.icon).toBeNull();
    expect(merged?.heroImage).toBe("patch-hero.png");
    expect(merged?.minPlayers).toBe(2);
    expect(merged?.maxPlayers).toBeNull();
  });

  it("returns undefined viewer when neither side has one", () => {
    expect(mergeAppMeta(appMeta(), appMeta())?.viewer).toBeUndefined();
  });

  it("normalizes a sole viewer through sanitizeSandbox", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const withViewer = appMeta({
      viewer: { url: "https://only.test", sandbox: "allow-scripts allow-evil" },
    });
    expect(mergeAppMeta(withViewer, appMeta())?.viewer).toEqual({
      url: "https://only.test",
      sandbox: LOCAL_APP_DEFAULT_SANDBOX,
    });
    expect(mergeAppMeta(appMeta(), withViewer)?.viewer).toEqual({
      url: "https://only.test",
      sandbox: LOCAL_APP_DEFAULT_SANDBOX,
    });
    expect(warn).toHaveBeenCalled();
  });

  it("merges viewer fields with patch winning, then sanitizes the result", () => {
    const merged = mergeAppMeta(
      appMeta({
        viewer: {
          url: "https://base.test",
          postMessageAuth: true,
          sandbox: "allow-scripts",
          embedParams: { theme: "dark", room: "alpha" },
        },
      }),
      appMeta({
        viewer: {
          url: "https://patch.test",
          sandbox: "allow-forms allow-forms",
          embedParams: { room: "beta" },
        },
      }),
    );
    expect(merged?.viewer).toEqual({
      url: "https://patch.test",
      postMessageAuth: true,
      sandbox: "allow-forms",
      embedParams: { theme: "dark", room: "beta" },
    });
  });

  it("treats missing embedParams as empty objects during viewer merge", () => {
    const merged = mergeAppMeta(
      appMeta({ viewer: { url: "https://base.test" } }),
      appMeta({
        viewer: { url: "https://patch.test", embedParams: { k: "v" } },
      }),
    );
    expect(merged?.viewer?.embedParams).toEqual({ k: "v" });
  });

  it("returns undefined session when neither side has one", () => {
    expect(mergeAppMeta(appMeta(), appMeta())?.session).toBeUndefined();
  });

  it("returns the sole session without rewriting features", () => {
    const session: RegistryAppSessionMeta = {
      mode: "viewer",
      features: ["pause"],
    };
    expect(mergeAppMeta(appMeta({ session }), appMeta())?.session).toEqual(
      session,
    );
    expect(mergeAppMeta(appMeta(), appMeta({ session }))?.session).toEqual(
      session,
    );
  });

  it("keeps base session features when the patch omits them or supplies an empty list", () => {
    const baseSession: RegistryAppSessionMeta = {
      mode: "viewer",
      features: ["commands", "telemetry"],
    };
    const emptyPatch = mergeAppMeta(
      appMeta({ session: baseSession }),
      appMeta({ session: { mode: "external", features: [] } }),
    );
    expect(emptyPatch?.session).toEqual({
      mode: "external",
      features: ["commands", "telemetry"],
    });

    const omittedPatch = mergeAppMeta(
      appMeta({ session: baseSession }),
      appMeta({ session: { mode: "spectate-and-steer" } }),
    );
    expect(omittedPatch?.session).toEqual({
      mode: "spectate-and-steer",
      features: ["commands", "telemetry"],
    });
  });

  it("replaces session features when the patch supplies a nonempty list", () => {
    const merged = mergeAppMeta(
      appMeta({
        session: { mode: "viewer", features: ["commands"] },
      }),
      appMeta({
        session: { mode: "external", features: ["pause", "resume"] },
      }),
    );
    expect(merged?.session).toEqual({
      mode: "external",
      features: ["pause", "resume"],
    });
  });
});

describe("resolveAppOverride", () => {
  it("returns the supplied meta unchanged for packages without an override", () => {
    const meta = appMeta({ displayName: "Unlisted" });
    expect(resolveAppOverride("@elizaos/app-unknown", meta)).toBe(meta);
    expect(
      resolveAppOverride("@elizaos/app-unknown", undefined),
    ).toBeUndefined();
  });

  it("builds standalone hyperfy metadata when none is supplied", () => {
    const resolved = resolveAppOverride("@elizaos/app-hyperfy", undefined);
    expect(resolved).toEqual({
      displayName: "Hyperfy",
      category: "game",
      launchType: "connect",
      launchUrl: "http://localhost:3003",
      icon: null,
      heroImage: null,
      capabilities: [],
      minPlayers: null,
      maxPlayers: null,
      runtimePlugin: undefined,
      uiExtension: undefined,
      viewer: {
        url: "http://localhost:3003",
        sandbox: LOCAL_APP_DEFAULT_SANDBOX,
        embedParams: {},
      },
      session: undefined,
      bridgeExport: undefined,
    });
  });

  it("overlays hyperfy launch fields onto existing meta and merges viewers", () => {
    const existing = appMeta({
      displayName: "World Viewer",
      category: "social",
      launchType: "url",
      launchUrl: "https://prod.hyperfy.test",
      capabilities: ["voice"],
      runtimePlugin: "world-plugin",
      bridgeExport: "WorldBridge",
      uiExtension: { detailPanelId: "world-panel" },
      viewer: {
        url: "https://prod.hyperfy.test",
        postMessageAuth: true,
        sandbox: "allow-scripts",
        embedParams: { room: "lobby" },
      },
      session: { mode: "viewer", features: ["telemetry"] },
    });
    const resolved = resolveAppOverride("@elizaos/app-hyperfy", existing);
    expect(resolved?.displayName).toBe("World Viewer");
    expect(resolved?.category).toBe("social");
    expect(resolved?.launchType).toBe("connect");
    expect(resolved?.launchUrl).toBe("http://localhost:3003");
    expect(resolved?.capabilities).toEqual(["voice"]);
    expect(resolved?.runtimePlugin).toBe("world-plugin");
    expect(resolved?.bridgeExport).toBe("WorldBridge");
    expect(resolved?.uiExtension).toEqual({ detailPanelId: "world-panel" });
    expect(resolved?.viewer).toEqual({
      url: "http://localhost:3003",
      postMessageAuth: true,
      sandbox: LOCAL_APP_DEFAULT_SANDBOX,
      embedParams: { room: "lobby" },
    });
    expect(resolved?.session).toEqual({
      mode: "viewer",
      features: ["telemetry"],
    });
  });

  it("lets the hyperfy viewer sandbox replace an untrusted existing sandbox before sanitizing", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const resolved = resolveAppOverride(
      "@elizaos/app-hyperfy",
      appMeta({
        viewer: {
          url: "https://prod.hyperfy.test",
          sandbox: "allow-scripts allow-top-navigation",
        },
      }),
    );
    expect(resolved?.viewer?.url).toBe("http://localhost:3003");
    expect(resolved?.viewer?.sandbox).toBe(LOCAL_APP_DEFAULT_SANDBOX);
    expect(warn).not.toHaveBeenCalled();
  });
});
