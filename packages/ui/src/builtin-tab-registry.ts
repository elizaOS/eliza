import {
  type AppShellBackgroundPolicy,
  IMMERSIVE_WALLPAPER_SURFACE,
  type ResolvedSurfaceManifest,
  resolveSurfaceBackgroundPolicy,
  resolveSurfaceManifest,
  type SurfaceManifest,
} from "@elizaos/core";

/**
 * Declarative registry for the app's builtin (host-owned) tab surfaces.
 *
 * Historically `App.tsx` routed builtin surfaces through TWO parallel,
 * hand-maintained name-keyed enumerations that could silently drift:
 *
 *  1. `renderStaticViewRouterTab` — a `directViews` object literal plus a chain
 *     of `if (tab === "...")` branches deciding which component + wrapper each
 *     builtin tab renders (App.tsx item #34, target line ~1218).
 *  2. `builtinRouteBackgroundPolicy` — a second `if (tab === "...")` chain
 *     deciding each builtin tab's screen background policy (target line ~770).
 *
 * A tab present in one chain but absent (or aliased differently) in the other
 * was an unobservable drift bug: e.g. a builtin surface that renders fine but
 * paints the wrong background layer, or an alias (`advanced` -> `fine-tuning`)
 * honored by the router but not the background resolver.
 *
 * This module is the single source of truth for builtin-tab METADATA: the
 * canonical id, any legacy aliases that resolve onto it, and its background
 * policy declaration. Both the router and the background resolver in `App.tsx`
 * derive from it, so adding/renaming a builtin surface is a one-line data edit
 * that both consumers pick up — no second list to keep in sync.
 *
 * The React render functions themselves stay co-located in `App.tsx` (they
 * close over many local view components), but they are keyed off the canonical
 * ids declared here, and alias resolution is owned here too.
 */

/**
 * How a builtin tab declares its surface manifest across its routes.
 *
 *  - A single {@link SurfaceManifest} — one manifest for every route under the
 *    tab (e.g. chat/background always paint the shared wallpaper).
 *  - `{ shared: (path) => boolean }` — the tab paints the shared wallpaper only
 *    when the live navigation path satisfies the predicate (e.g. the launcher
 *    root of a tab that owns opaque sub-routes), otherwise it falls through to
 *    the caller's downstream resolution. Matches the two path-conditional
 *    surfaces (`views`, `apps`) whose launcher root is immersive but whose
 *    sub-routes are opaque.
 *
 * Either form is resolved through the grant-gated {@link resolveSurfaceManifest}
 * so a builtin tab paints the wallpaper only when its manifest explicitly grants
 * `wallpaper` — the same accidental-opt-in guard the per-view manifest enforces
 * (#13452). A tab with no `surface` field declares no builtin-level policy and
 * falls through to the caller's downstream resolution (registered views etc.).
 */
export type BuiltinTabSurfaceDecl =
  | SurfaceManifest
  | { readonly shared: (trimmedNavigationPath: string) => boolean };

export interface BuiltinTabMetadata {
  /** Canonical builtin tab id (the id the render map is keyed by). */
  readonly id: string;
  /**
   * Legacy tab ids that resolve onto this canonical id. Kept as an explicit,
   * tested host-owned alias table (e.g. `advanced` -> `fine-tuning`,
   * `triggers` -> `automations`) rather than duplicated if-branches.
   */
  readonly aliases?: readonly string[];
  /**
   * Builtin-level surface manifest (or path predicate for tabs whose launcher
   * root differs from their sub-routes). Omitted = no builtin policy (fall
   * through to downstream resolution).
   */
  readonly surface?: BuiltinTabSurfaceDecl;
}

/**
 * The canonical builtin-tab table. IDs here are the keys the `App.tsx` render
 * map uses; aliases and surface manifests are consumed by the resolvers below.
 *
 * Only tabs that need an alias or a non-default surface manifest carry those
 * fields; the rest declare id-only, which is the common case and keeps drift
 * surface minimal. The wallpaper-painting tabs reuse
 * {@link IMMERSIVE_WALLPAPER_SURFACE}, the one manifest that pairs
 * `background: "shared"` with the `wallpaper` grant — so the wallpaper opt-in
 * lives in exactly one place, not re-spelled per tab.
 */
export const BUILTIN_TAB_METADATA: readonly BuiltinTabMetadata[] = [
  // ── Immersive wallpaper surfaces (grant-backed shared background) ──
  { id: "chat", surface: IMMERSIVE_WALLPAPER_SURFACE },
  { id: "background", surface: IMMERSIVE_WALLPAPER_SURFACE },
  // ── Native-webview isolation surface (arbitrary third-party web content) ──
  // The Browser view is the canonical `native-webview` consumer documented in
  // the isolation catalogue (`surface-isolation.ts`): it hosts arbitrary
  // third-party pages in a native child web-content surface (desktop
  // `WebContentsView` / electrobun OOPIF, iOS `WKWebView`, Android `WebView`)
  // with its own renderer process, so page content never shares the host realm.
  // Declaring the manifest here makes that isolation level authoritative on the
  // view instead of only documented. `background: "opaque"` is the default made
  // explicit — the browser never paints the shared wallpaper (it owns its whole
  // surface). This declares policy only; the native embedding itself lives in
  // the tab renderers, not here (#13596).
  {
    id: "browser",
    surface: { isolation: "native-webview", background: "opaque" },
  },
  // ── Wallpaper only at the tab's launcher root; opaque on sub-routes ──
  {
    id: "views",
    surface: { shared: (path) => path === "/views" },
  },
  {
    id: "apps",
    surface: { shared: (path) => path === "/apps" },
  },
  // ── Aliases (canonical id + legacy id that routes onto it) ──
  { id: "automations", aliases: ["triggers"] },
  { id: "fine-tuning", aliases: ["advanced"] },
] as const;

/** Fast id -> metadata lookup, including alias ids. */
const BUILTIN_TAB_BY_ID: ReadonlyMap<string, BuiltinTabMetadata> = (() => {
  const map = new Map<string, BuiltinTabMetadata>();
  for (const entry of BUILTIN_TAB_METADATA) {
    if (map.has(entry.id)) {
      throw new Error(
        `Duplicate builtin tab id "${entry.id}" in BUILTIN_TAB_METADATA`,
      );
    }
    map.set(entry.id, entry);
    for (const alias of entry.aliases ?? []) {
      if (map.has(alias)) {
        throw new Error(
          `Builtin tab alias "${alias}" (of "${entry.id}") collides with an existing id/alias`,
        );
      }
      map.set(alias, entry);
    }
  }
  return map;
})();

/**
 * Resolve a (possibly aliased) tab id to its canonical builtin id. Tabs that
 * are not declared builtin aliases are returned unchanged, so plugin/dynamic
 * tabs pass straight through.
 */
export function resolveBuiltinTabId(tab: string): string {
  return BUILTIN_TAB_BY_ID.get(tab)?.id ?? tab;
}

/**
 * The builtin-level background policy for a tab/route, or `null` to fall
 * through to downstream resolution. Data-driven over the surface-manifest table:
 * a full manifest resolves through the grant-gated {@link resolveSurfaceManifest}
 * (so `shared` only paints the wallpaper with the `wallpaper` grant), and a path
 * predicate resolves to `shared` at the launcher root and `null` (fall-through)
 * elsewhere.
 */
export function resolveBuiltinBackgroundPolicy(
  tab: string,
  trimmedNavigationPath: string,
): AppShellBackgroundPolicy | null {
  const decl = BUILTIN_TAB_BY_ID.get(tab)?.surface;
  if (decl === undefined) return null;
  if ("shared" in decl) {
    return decl.shared(trimmedNavigationPath) ? "shared" : null;
  }
  return resolveSurfaceBackgroundPolicy({ surface: decl });
}

/**
 * The fully-resolved surface manifest a builtin tab declares — the source the
 * shell reads to enforce a tab's isolation level (not just its background). The
 * Browser view reads this to drive its native-webview embedding selection so
 * the declared isolation is authoritative rather than merely documented
 * (#14181): `resolveBuiltinSurfaceManifest("browser").isolation` is what its tab
 * renderer branches on.
 *
 * Throws for a tab that declares no full manifest (a path-predicate `shared`
 * tab, or an id with no `surface`): a caller asking for a builtin tab's
 * resolved isolation must be asking about a tab that actually declares one, so a
 * miss is a registry misconfiguration to surface loudly, not a silent default.
 */
export function resolveBuiltinSurfaceManifest(
  tab: string,
): ResolvedSurfaceManifest {
  const decl = BUILTIN_TAB_BY_ID.get(tab)?.surface;
  if (decl === undefined || "shared" in decl) {
    throw new Error(
      `Builtin tab "${tab}" declares no full surface manifest — cannot resolve its isolation level`,
    );
  }
  return resolveSurfaceManifest({ surface: decl });
}
