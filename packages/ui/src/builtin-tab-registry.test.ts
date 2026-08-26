/**
 * Unit + drift-guard coverage for the builtin static-tab registry that owns
 * (a) the router's canonical-id / alias resolution and (b) the builtin-level
 * screen background policy — the two enumerations that used to live as parallel
 * name-keyed if-chains in App.tsx (audit item #34, #12680).
 *
 * These tests pin the exact legacy behavior of `builtinRouteBackgroundPolicy`
 * and the router's alias handling, and a grep-guard proves the old central
 * if-chains are gone from App.tsx's executable paths.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveSurfaceManifest } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_TAB_METADATA,
  resolveBuiltinBackgroundPolicy,
  resolveBuiltinPageLayout,
  resolveBuiltinRoutedViewManifest,
  resolveBuiltinSurfaceManifest,
  resolveBuiltinTabId,
} from "./builtin-tab-registry";

describe("builtin-tab-registry: resolveBuiltinSurfaceManifest", () => {
  it("resolves the Browser view to the native-webview isolation level", () => {
    // The Browser view's tab renderer reads this to drive its native child
    // web-content embedding (#14181); the level must stay native-webview.
    expect(resolveBuiltinSurfaceManifest("browser").isolation).toBe(
      "native-webview",
    );
    expect(resolveBuiltinSurfaceManifest("browser").background).toBe("opaque");
  });

  it("throws for a tab that declares no full surface manifest", () => {
    // `views`/`apps` declare a path-predicate `shared` form, not a full
    // manifest — asking for their resolved isolation is a misuse to surface,
    // not a silent default.
    expect(() => resolveBuiltinSurfaceManifest("views")).toThrow();
    expect(() => resolveBuiltinSurfaceManifest("settings")).toThrow();
    expect(() => resolveBuiltinSurfaceManifest("does-not-exist")).toThrow();
  });
});

describe("builtin-tab-registry: table integrity", () => {
  it("has unique canonical ids and no id/alias collisions", () => {
    const seen = new Set<string>();
    for (const entry of BUILTIN_TAB_METADATA) {
      expect(seen.has(entry.id), `duplicate id ${entry.id}`).toBe(false);
      seen.add(entry.id);
      for (const alias of entry.aliases ?? []) {
        expect(
          seen.has(alias),
          `alias ${alias} collides with an existing id/alias`,
        ).toBe(false);
        seen.add(alias);
      }
    }
  });

  it("every alias resolves to its canonical owner id", () => {
    for (const entry of BUILTIN_TAB_METADATA) {
      for (const alias of entry.aliases ?? []) {
        expect(resolveBuiltinTabId(alias)).toBe(entry.id);
      }
    }
  });

  it("classifies every canonical entry and inherits aliases from its owner", () => {
    for (const entry of BUILTIN_TAB_METADATA) {
      expect(resolveBuiltinPageLayout(entry.id)).toBe(entry.layout);
      for (const alias of entry.aliases ?? []) {
        expect(resolveBuiltinPageLayout(alias)).toBe(entry.layout);
      }
    }
    expect(resolveBuiltinPageLayout("some-plugin-tab")).toBeNull();
  });
});

describe("resolveBuiltinTabId: alias resolution", () => {
  it("maps the known legacy aliases onto canonical ids", () => {
    expect(resolveBuiltinTabId("triggers")).toBe("automations");
  });

  it("returns canonical ids unchanged", () => {
    expect(resolveBuiltinTabId("automations")).toBe("automations");
    expect(resolveBuiltinTabId("settings")).toBe("settings");
  });

  it("passes non-builtin / plugin tab ids straight through", () => {
    expect(resolveBuiltinTabId("some-plugin-tab")).toBe("some-plugin-tab");
    expect(resolveBuiltinTabId("")).toBe("");
  });
});

describe("resolveBuiltinBackgroundPolicy: legacy parity", () => {
  // Golden table covering the builtinRouteBackgroundPolicy table:
  //   chat / background       -> "shared"
  //   views  && path==/views  -> "shared"
  //   apps   && path==/apps   -> "shared"
  //   otherwise               -> null (fall through to downstream resolution)
  it.each([
    ["chat", "/chat", "shared"],
    ["chat", "/anything", "shared"],
    ["background", "/background", "shared"],
  ] as const)("%s @ %s -> %s (unconditional shared)", (tab, path, expected) => {
    expect(resolveBuiltinBackgroundPolicy(tab, path)).toBe(expected);
  });

  it("views is shared only at /views, else null", () => {
    expect(resolveBuiltinBackgroundPolicy("views", "/views")).toBe("shared");
    expect(resolveBuiltinBackgroundPolicy("views", "/views/thing")).toBeNull();
  });

  it("apps is shared only at /apps, else null", () => {
    expect(resolveBuiltinBackgroundPolicy("apps", "/apps")).toBe("shared");
    expect(resolveBuiltinBackgroundPolicy("apps", "/apps/tasks")).toBeNull();
  });

  it.each([
    ["voice", "/voice"],
    ["settings", "/settings"],
    ["files", "/apps/files"],
    ["memories", "/apps/memories"],
    ["some-plugin-tab", "/plugin"],
    ["triggers", "/automations"],
  ] as const)("%s @ %s -> null (no builtin policy)", (tab, path) => {
    expect(resolveBuiltinBackgroundPolicy(tab, path)).toBeNull();
  });
});

describe("browser: native-webview isolation manifest (#13596)", () => {
  const decl = BUILTIN_TAB_METADATA.find(
    (entry) => entry.id === "browser",
  )?.surface;
  // The browser declares a full SurfaceManifest, not the path-predicate variant
  // (`{ shared }`) the wallpaper tabs use — narrow to the manifest shape so the
  // resolver typechecks and a regression to a predicate is caught here.
  const surface = decl && "isolation" in decl ? decl : undefined;

  it("declares a full surface manifest (not id-only, not a path predicate)", () => {
    expect(surface).toBeDefined();
  });

  it("resolves to native-webview isolation (the catalogue's canonical consumer)", () => {
    // The browser hosts arbitrary third-party web content in a native child
    // web-content surface outside the host renderer realm. See
    // surface-isolation.ts's catalogue entry for each platform's guarantee.
    expect(resolveSurfaceManifest({ surface }).isolation).toBe(
      "native-webview",
    );
  });

  it("stays opaque — the browser never paints the shared wallpaper", () => {
    expect(resolveBuiltinBackgroundPolicy("browser", "/browser")).toBe(
      "opaque",
    );
    expect(resolveSurfaceManifest({ surface }).background).toBe("opaque");
  });

  it("declares the fullscreen header so the shell frames it like the other full-surface views", () => {
    // Notes/Calendar register `surface.header: "fullscreen"` as app-shell
    // pages; the Browser is the builtin peer and must take the identical
    // full-bleed shell path (no host top bar, view-owned chrome).
    expect(resolveSurfaceManifest({ surface }).header).toBe("fullscreen");
  });
});

describe("resolveBuiltinRoutedViewManifest: routed-content manifests only", () => {
  it("resolves the browser to its fullscreen native-webview manifest", () => {
    const manifest = resolveBuiltinRoutedViewManifest("browser");
    expect(manifest).not.toBeNull();
    expect(manifest?.header).toBe("fullscreen");
    expect(manifest?.isolation).toBe("native-webview");
    expect(manifest?.background).toBe("opaque");
    expect(manifest?.layout).toBe(resolveBuiltinPageLayout("browser"));
  });

  it("excludes the immersive wallpaper surfaces (structural shell branches)", () => {
    // chat/background declare IMMERSIVE_WALLPAPER_SURFACE for the wallpaper
    // grant; routing them through the full-bleed view path would replace the
    // ambient chat home / transparent background editor with an opaque shell.
    expect(resolveBuiltinRoutedViewManifest("chat")).toBeNull();
    expect(resolveBuiltinRoutedViewManifest("background")).toBeNull();
  });

  it("falls through for path-predicate and undeclared tabs", () => {
    expect(resolveBuiltinRoutedViewManifest("views")).toBeNull();
    expect(resolveBuiltinRoutedViewManifest("apps")).toBeNull();
    expect(resolveBuiltinRoutedViewManifest("settings")).toBeNull();
    expect(resolveBuiltinRoutedViewManifest("does-not-exist")).toBeNull();
  });
});

describe("App.tsx drift guard: legacy central enumerations removed", () => {
  const appSource = readFileSync(
    fileURLToPath(new URL("./App.tsx", import.meta.url)),
    "utf8",
  );

  it("builtinRouteBackgroundPolicy no longer inlines the per-tab if-chain", () => {
    // The background resolver must delegate to the registry, not re-derive
    // policy from `tab === "..."` string branches.
    const fnStart = appSource.indexOf("function builtinRouteBackgroundPolicy(");
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = appSource.slice(fnStart, fnStart + 600);
    expect(fnBody).toContain("resolveBuiltinBackgroundPolicy");
    expect(fnBody).not.toContain('tab === "chat"');
    expect(fnBody).not.toContain('tab === "settings"');
    expect(fnBody).not.toContain('tab === "views"');
    expect(fnBody).not.toContain('tab === "apps"');
  });

  it("renderStaticViewRouterTab routes via a keyed registry, not the alias if-chain", () => {
    const fnStart = appSource.indexOf("function renderStaticViewRouterTab(");
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = appSource.slice(fnStart, fnStart + 900);
    expect(fnBody).toContain("resolveBuiltinRouteDescriptor");
    expect(fnBody).toContain("buildStaticTabRenderers()");
    // The alias / special-surface if-chain that lived at the tail of the old
    // renderStaticViewRouterTab is gone from its body.
    expect(fnBody).not.toContain(
      'tab === "character" || tab === "character-select"',
    );
    expect(fnBody).not.toContain('tab === "views" || tab === "apps"');
  });
});
