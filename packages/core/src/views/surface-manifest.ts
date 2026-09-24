/** Resolves host view presentation policy without loading the Node runtime. */
import { type AppShellBackgroundPolicy, type PageLayoutManifest, type ResolvedSurfaceManifest, type SurfaceCapability, type SurfaceManifest, type SurfaceManifestBearer } from "../types/surface-manifest.js";

export type {
  AppShellBackgroundPolicy,
  PageLayoutManifest,
  ResolvedSurfaceManifest,
  SurfaceCapability,
  SurfaceIsolationLevel,
  SurfaceLifecyclePolicy,
  SurfaceManifest,
  SurfaceManifestBearer,
  ViewHeaderPolicy,
} from "@elizaos/core";

/**
 * How a view is separated from the host realm and from other views. Ordered
 * from least to most isolated. The catalogue in
 * `packages/ui/src/surface-isolation.ts` states which level each shipped view
 * uses and why, and maps each level to its per-platform embedding
 * (Electron `WebContentsView`, sandboxed `<iframe>`, `WKWebView`/Android
 * `WebView`).
 *
 *  - `in-process`      — trusted built-in shell views run in the host DOM/React
 *                        realm with the full host singleton (React, API client,
 *                        native bridges). No sandbox; trust is the boundary.
 *  - `sandboxed-iframe` — untrusted/plugin web views run in a sandboxed iframe
 *                        with a postMessage capability broker. Never combine
 *                        `allow-scripts` + `allow-same-origin` on same-origin
 *                        content — that is not a real sandbox (MDN).
 *  - `native-webview`  — heavy/untrusted views embed a native child web-content
 *                        surface (desktop `WebContentsView`, iOS `WKWebView`,
 *                        Android `WebView`) with its own renderer process and an
 *                        explicit process/storage-sharing policy.
 *  - `immersive`       — a fullscreen surface that owns its whole window
 *                        (launcher, background editor). Chrome-free and the only
 *                        non-launcher level allowed to paint the shared
 *                        wallpaper, and only when it also grants `wallpaper`.
 */
export const SURFACE_ISOLATION_LEVELS = [
  "in-process",
  "sandboxed-iframe",
  "native-webview",
  "immersive",
] as const;

/**
 * The discrete capabilities a view can be granted. A capability the manifest
 * does not list is denied by the broker — a plugin view only reaches the shell
 * facilities it was granted. Grants are additive and default to none.
 *
 *  - `wallpaper`         — may paint the shared Home/Launcher wallpaper. Gates
 *                          `background: "shared"`: a view without this grant is
 *                          forced opaque no matter what it declares. Restricted
 *                          to the launcher + explicitly immersive views.
 *  - `background:apply`  — may drive the global background-apply broker (change
 *                          the persisted wallpaper for the whole app). The
 *                          background editor holds it; normal views do not.
 *  - `navigate`          — may request shell navigation (open another view).
 *  - `storage`           — may use host-scoped persistent storage.
 *  - `agent-surface`     — may expose its DOM elements to the agent surface so
 *                          the planner can read/click/fill them. Standard
 *                          read-only introspection is always available; this
 *                          grant is for a view opting INTO richer agent control.
 */
export const SURFACE_CAPABILITIES = [
  "wallpaper",
  "background:apply",
  "navigate",
  "storage",
  "agent-surface",
] as const;

function dedupeCapabilities(
  caps: readonly SurfaceCapability[] | undefined,
): ReadonlySet<SurfaceCapability> {
  // `Set`'s constructor treats a missing iterable as empty, so an absent
  // capability list yields an empty set without a `?? []` empty-fallback.
  return new Set(caps);
}

const DEFAULT_PAGE_LAYOUT_MANIFEST: PageLayoutManifest = Object.freeze({
  kind: "content",
  topology: "framed",
  width: "standard",
  scroll: "view",
  gutter: "standard",
});

/**
 * Resolve a (possibly sparse) declaration into a {@link ResolvedSurfaceManifest}
 * with defaults applied and the wallpaper gate enforced.
 *
 * Precedence for each field: `surface.<field>` wins, then the legacy standalone
 * field (`backgroundPolicy` / `headerPolicy`), then the safe default.
 *
 * The one enforced invariant: `background: "shared"` requires the `wallpaper`
 * capability. A view that declares `shared` without the grant resolves to
 * `opaque` — the shell can never surface the wallpaper on a view that was not
 * explicitly granted it, closing the "opt in by accident" gap (#13452). The
 * launcher/immersive surfaces that legitimately paint the wallpaper declare
 * both `background: "shared"` and the `wallpaper` grant.
 */
export function resolveSurfaceManifest(
  decl: SurfaceManifestBearer | null | undefined,
): ResolvedSurfaceManifest {
  const surface = decl?.surface;
  const capabilities = dedupeCapabilities(surface?.capabilities);

  const declaredBackground =
    surface?.background ?? decl?.backgroundPolicy ?? "opaque";
  // Wallpaper gate: "shared" is only honoured with the explicit grant.
  const background: AppShellBackgroundPolicy =
    declaredBackground === "shared" && capabilities.has("wallpaper")
      ? "shared"
      : "opaque";

  return {
    background,
    header: surface?.header ?? decl?.headerPolicy ?? "normal",
    isolation: surface?.isolation ?? "in-process",
    lifecycle: surface?.lifecycle ?? "ephemeral",
    layout: surface?.layout
      ? { topology: "framed", ...surface.layout }
      : DEFAULT_PAGE_LAYOUT_MANIFEST,
    capabilities,
  };
}

/**
 * The resolved screen-background policy for a declaration — the field the shell
 * background resolver reads. A thin projection of {@link resolveSurfaceManifest}
 * so callers that only need the background do not pull the whole manifest.
 */
export function resolveSurfaceBackgroundPolicy(
  decl: SurfaceManifestBearer | null | undefined,
): AppShellBackgroundPolicy {
  return resolveSurfaceManifest(decl).background;
}

/**
 * Whether a resolved manifest grants a capability. The broker's allow-check —
 * a capability not in the manifest is denied.
 */
export function surfaceGrants(
  manifest: ResolvedSurfaceManifest,
  capability: SurfaceCapability,
): boolean {
  return manifest.capabilities.has(capability);
}

/**
 * The canonical manifest for the shared launcher/immersive wallpaper surfaces
 * (Home, Launcher, Background editor). Declares `shared` + the `wallpaper`
 * grant so the resolver actually paints the wallpaper, and marks the surface
 * `immersive`. Built-in shell registrations reuse this instead of hand-repeating
 * the `shared` + grant pair, so the wallpaper opt-in is declared in exactly one
 * place per surface family.
 */
export const IMMERSIVE_WALLPAPER_SURFACE: SurfaceManifest = {
  background: "shared",
  header: "immersive",
  isolation: "immersive",
  layout: {
    kind: "immersive",
    topology: "ambient",
    width: "full",
    scroll: "view",
    gutter: "none",
  },
  capabilities: ["wallpaper", "background:apply"],
};
