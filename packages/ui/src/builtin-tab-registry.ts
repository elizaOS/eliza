import type { AppShellBackgroundPolicy } from "@elizaos/core";

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
 * How a builtin tab declares its screen background policy.
 *
 *  - `"shared"` / `"opaque"` — an unconditional policy for every route under
 *    the tab.
 *  - `{ shared: (path) => boolean }` — the tab is `"shared"` only when the
 *    live navigation path satisfies the predicate (e.g. the launcher root of a
 *    tab that owns sub-routes), otherwise it falls through to the caller's
 *    default resolution. This mirrors the two path-conditional branches the
 *    legacy `builtinRouteBackgroundPolicy` encoded for `views` and `apps`.
 *
 * A tab with no `backgroundPolicy` field declares no builtin-level policy and
 * falls through to the caller's downstream resolution (registered views etc.),
 * exactly as the legacy `return null` did.
 */
export type BuiltinTabBackgroundPolicyDecl =
  | AppShellBackgroundPolicy
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
   * Builtin-level background policy declaration. Omitted = no builtin policy
   * (fall through to downstream resolution).
   */
  readonly backgroundPolicy?: BuiltinTabBackgroundPolicyDecl;
}

/**
 * The canonical builtin-tab table. IDs here are the keys the `App.tsx` render
 * map uses; aliases and background policy are consumed by the resolvers below.
 *
 * Only tabs that need an alias or a non-default (`shared` / path-conditional)
 * background policy carry those fields; the rest declare id-only, which is the
 * common case and keeps drift surface minimal.
 */
export const BUILTIN_TAB_METADATA: readonly BuiltinTabMetadata[] = [
  // ── Background policy: unconditionally "shared" (wallpaper shows through) ──
  { id: "chat", backgroundPolicy: "shared" },
  { id: "background", backgroundPolicy: "shared" },
  { id: "settings", backgroundPolicy: "shared" },
  // ── Background policy: "shared" only at the tab's launcher root ──
  {
    id: "views",
    backgroundPolicy: { shared: (path) => path === "/views" },
  },
  {
    id: "apps",
    backgroundPolicy: { shared: (path) => path === "/apps" },
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
 * through to downstream resolution. Direct data-driven replacement for the
 * legacy `builtinRouteBackgroundPolicy` if-chain — same inputs, same outputs.
 */
export function resolveBuiltinBackgroundPolicy(
  tab: string,
  trimmedNavigationPath: string,
): AppShellBackgroundPolicy | null {
  const decl = BUILTIN_TAB_BY_ID.get(tab)?.backgroundPolicy;
  if (decl === undefined) return null;
  if (decl === "shared" || decl === "opaque") return decl;
  return decl.shared(trimmedNavigationPath) ? "shared" : null;
}
