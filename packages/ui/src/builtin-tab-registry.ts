/**
 * Declares host-owned tabs and resolves their shared render and background
 * policies so the app shell does not maintain parallel routing tables.
 */

import type {
  AppShellBackgroundPolicy,
  PageLayoutManifest,
  ResolvedSurfaceManifest,
} from "@elizaos/core";
import {
  resolveSurfaceBackgroundPolicy,
  resolveSurfaceManifest,
} from "@elizaos/core/protocol";
import {
  BUILTIN_ROUTE_IDS,
  type BuiltinRouteSurfaceDeclaration,
  resolveBuiltinRouteDescriptor,
} from "./navigation/builtin-route-descriptors";

export type BuiltinTabSurfaceDecl = BuiltinRouteSurfaceDeclaration;

export interface BuiltinTabMetadata {
  /** Canonical builtin tab id (the id the render map is keyed by). */
  readonly id: string;
  /** Semantic page topology consumed by canonical shell implementations. */
  readonly layout: PageLayoutManifest;
  /**
   * Builtin-level surface manifest (or path predicate for tabs whose launcher
   * root differs from their sub-routes). Omitted = no builtin policy (fall
   * through to downstream resolution).
   */
  readonly surface?: BuiltinTabSurfaceDecl;
}

export const BUILTIN_TAB_METADATA: readonly BuiltinTabMetadata[] =
  BUILTIN_ROUTE_IDS.map((id) => {
    const descriptor = resolveBuiltinRouteDescriptor(id);
    if (!descriptor) throw new Error(`Builtin tab "${id}" has no descriptor`);
    return {
      id,
      layout: descriptor.layout,
      ...(descriptor.surface ? { surface: descriptor.surface } : {}),
    };
  });

const BUILTIN_TAB_BY_ID = new Map(
  BUILTIN_TAB_METADATA.map((entry) => [entry.id, entry]),
);

/** The semantic page layout for a built-in tab. */
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
  return layout ? { ...manifest, layout } : manifest;
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
  const manifest = resolveSurfaceManifest({
    surface: layout ? { ...decl, layout } : decl,
  });
  return layout ? { ...manifest, layout } : manifest;
}
