/**
 * Declares host-owned tabs and resolves their shared render and background
 * policies so the app shell does not maintain parallel routing tables.
 */

import {
  type AppShellBackgroundPolicy,
  type PageLayoutManifest,
  type ResolvedSurfaceManifest,
  resolveSurfaceBackgroundPolicy,
  resolveSurfaceManifest,
} from "@elizaos/core";
import {
  BUILTIN_ROUTE_IDS,
  type BuiltinRouteSurfaceDeclaration,
  resolveBuiltinRouteDescriptor,
} from "./navigation/builtin-route-descriptors";

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
 * paints the wrong background layer, or an alias honored by the router but not
 * the background resolver.
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
export type BuiltinTabSurfaceDecl = BuiltinRouteSurfaceDeclaration;

export interface BuiltinTabMetadata {
  /** Canonical builtin tab id (the id the render map is keyed by). */
  readonly id: string;
  /**
   * Legacy tab ids that resolve onto this canonical id. Kept as an explicit,
   * tested host-owned alias table (e.g. `triggers` -> `automations`) rather
   * than duplicated if-branches.
   */
  readonly aliases?: readonly string[];
  /** Semantic page topology consumed by canonical shell implementations. */
  readonly layout: PageLayoutManifest;
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
 * Every canonical route is represented because layout classification is
 * exhaustive. Optional aliases and surface policies are folded in from the
 * same React-free route descriptor authority.
 */
const BUILTIN_ALIAS_IDS_BY_CANONICAL = new Map<string, string[]>();
for (const id of BUILTIN_ROUTE_IDS) {
  const descriptor = resolveBuiltinRouteDescriptor(id);
  if (descriptor && descriptor.canonicalId !== id) {
    const aliases = BUILTIN_ALIAS_IDS_BY_CANONICAL.get(descriptor.canonicalId);
    if (aliases) aliases.push(id);
    else BUILTIN_ALIAS_IDS_BY_CANONICAL.set(descriptor.canonicalId, [id]);
  }
}

/**
 * Canonical built-in metadata derived from the route descriptors. Alias rows
 * are folded into their owner so every resolver inherits one classification.
 */
export const BUILTIN_TAB_METADATA: readonly BuiltinTabMetadata[] =
  BUILTIN_ROUTE_IDS.flatMap((id) => {
    const descriptor = resolveBuiltinRouteDescriptor(id);
    if (!descriptor || descriptor.canonicalId !== id) return [];

    const aliases = BUILTIN_ALIAS_IDS_BY_CANONICAL.get(id);
    const surface = descriptor.surface;
    const metadata: BuiltinTabMetadata = {
      id,
      layout: descriptor.layout,
      ...(aliases ? { aliases } : {}),
      ...(surface ? { surface } : {}),
    };
    return [metadata];
  });

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
  return resolveBuiltinRouteDescriptor(tab)?.canonicalId ?? tab;
}

/** The semantic page layout for a built-in tab, inherited through aliases. */
export function resolveBuiltinPageLayout(
  tab: string,
): PageLayoutManifest | null {
  return resolveBuiltinRouteDescriptor(tab)?.layout ?? null;
}

/**
 * Whether a route is one of the immersive wallpaper surfaces: designed
 * directly against the raw wallpaper (chat, the /background editor, and the
 * launcher roots) — as opposed to a content view that sits on the wallpaper
 * behind the readability scrim. Derived from the same metadata table as the
 * background policy so a new immersive surface is a one-line data edit, not a
 * second hand-maintained tab list in App.tsx.
 */
export function isImmersiveWallpaperRoute(
  tab: string,
  trimmedNavigationPath: string,
): boolean {
  const decl = BUILTIN_TAB_BY_ID.get(tab)?.surface;
  if (decl === undefined) return false;
  if ("shared" in decl) return decl.shared(trimmedNavigationPath);
  return resolveSurfaceManifest({ surface: decl }).header === "immersive";
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
 * The resolved surface manifest a builtin ROUTED CONTENT view declares, or
 * `null` to fall through to downstream resolution. This is the builtin
 * counterpart of an app-shell page registration's `surface` field: the active
 * view resolver in `App.tsx` consults it so a builtin tab's declared framing
 * (e.g. the Browser's `header: "fullscreen"`) drives the same full-bleed shell
 * path a registered fullscreen page (Notes, Calendar) takes.
 *
 * The immersive wallpaper surfaces (chat, /background) are deliberately
 * excluded: they are STRUCTURAL shell surfaces — their manifests exist for the
 * wallpaper grant/background policy, and the shell composes them through its
 * own dedicated branches (the ambient chat home, the transparent background
 * editor), never through the routed full-bleed view path.
 */
export function resolveBuiltinRoutedViewManifest(
  tab: string,
): ResolvedSurfaceManifest | null {
  const decl = BUILTIN_TAB_BY_ID.get(tab)?.surface;
  if (decl === undefined || "shared" in decl) return null;
  const layout = resolveBuiltinPageLayout(tab);
  const manifest = resolveSurfaceManifest({
    surface: layout ? { ...decl, layout } : decl,
  });
  if (manifest.header === "immersive") return null;
  return manifest;
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
  const layout = resolveBuiltinPageLayout(tab);
  return resolveSurfaceManifest({
    surface: layout ? { ...decl, layout } : decl,
  });
}
