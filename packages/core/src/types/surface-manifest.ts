/**
 * Surface manifests — the single declared contract that governs how the app
 * shell isolates one view from every other surface. A view renders into a
 * shared shell tree, so without a declared boundary a view can visually or
 * behaviourally leak into the rest of the app (paint the launcher wallpaper
 * onto an opaque page, keep a global background channel live, reach past the
 * shell into another view's DOM). The manifest makes that boundary explicit and
 * data-driven: background policy, header framing, isolation level, lifecycle
 * expectation, and the capability grants a view is allowed to exercise all live
 * in ONE typed structure hung off the view registration.
 *
 * The manifest is the source of truth every consumer derives from — the shell's
 * background resolver reads {@link SurfaceManifest.background}, the capability
 * broker reads {@link SurfaceManifest.capabilities}, and the isolation doc names
 * each {@link SurfaceIsolationLevel}. A view never opts into the wallpaper by
 * accident: {@link resolveSurfaceManifest} only honours `background: "shared"`
 * when the manifest also grants the `wallpaper` capability, so the launcher and
 * views that explicitly declare immersion are the only surfaces that can paint
 * it (issue #13452 acceptance: "Shared app wallpaper is restricted to
 * Home/Launcher/Background and explicitly marked immersive views ... no view can
 * opt in by accident").
 *
 * Lives in `@elizaos/core` so the agent server (view registry, /api/views) and
 * every front-end (dashboard shell, view manager, DynamicViewLoader capability
 * broker) share one definition — the same reason {@link ViewKind} lives here.
 * Consumers: `packages/ui/src/App.tsx` (background resolver),
 * `packages/ui/src/components/views/DynamicViewLoader.tsx` (capability broker),
 * `packages/ui/src/surface-isolation.ts` (isolation-level catalogue + doc).
 */

import type { AppShellBackgroundPolicy, ViewHeaderPolicy } from "./plugin";

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

/** A view's isolation level. See {@link SURFACE_ISOLATION_LEVELS}. */
export type SurfaceIsolationLevel = (typeof SURFACE_ISOLATION_LEVELS)[number];

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

/** A capability grantable to a view surface. See {@link SURFACE_CAPABILITIES}. */
export type SurfaceCapability = (typeof SURFACE_CAPABILITIES)[number];

/**
 * Lifecycle expectation for a mounted view — how the shell treats it when it is
 * no longer the foreground surface. Purely declarative; the shell's view cache
 * (`DynamicViewLoader`) reads it to decide retention.
 *
 *  - `ephemeral` (default) — dropped/cleaned up when navigated away from, after
 *                            the shell's idle grace window.
 *  - `retained`            — kept warm in the background (e.g. a running
 *                            browser/workbench a user tabs back to). The shell
 *                            still evicts it under real memory pressure.
 */
export type SurfaceLifecyclePolicy = "ephemeral" | "retained";

/**
 * The declared surface contract for a view. Every field is optional at the
 * declaration site — {@link resolveSurfaceManifest} fills defaults and enforces
 * the invariants — so a plugin declares only what differs from the safe default
 * (opaque, in-process, no grants, ephemeral).
 */
export interface SurfaceManifest {
	/**
	 * Screen background policy. `"shared"` is only honoured when
	 * {@link capabilities} also grants `wallpaper`; otherwise the resolver forces
	 * `"opaque"`. Defaults to `"opaque"`.
	 */
	background?: AppShellBackgroundPolicy;
	/** Top-bar framing policy (#13586). Defaults to `"normal"`. */
	header?: ViewHeaderPolicy;
	/** How the view is isolated from the host and other views. Default `"in-process"`. */
	isolation?: SurfaceIsolationLevel;
	/** Retention expectation when backgrounded. Default `"ephemeral"`. */
	lifecycle?: SurfaceLifecyclePolicy;
	/**
	 * Capabilities this view is granted. Anything not listed is denied by the
	 * broker. Empty/omitted = a view with zero shell privileges beyond rendering
	 * its own DOM. Order-insensitive; duplicates are collapsed on resolution.
	 */
	capabilities?: readonly SurfaceCapability[];
}

/**
 * A fully-resolved manifest with every field present and every invariant
 * enforced. This — not the sparse declaration — is what consumers read, so a
 * consumer never has to re-derive a default or re-check the wallpaper gate.
 */
export interface ResolvedSurfaceManifest {
	background: AppShellBackgroundPolicy;
	header: ViewHeaderPolicy;
	isolation: SurfaceIsolationLevel;
	lifecycle: SurfaceLifecyclePolicy;
	/** The granted capabilities, de-duplicated and frozen. */
	capabilities: ReadonlySet<SurfaceCapability>;
}

/**
 * The sparse per-view fields the resolver reads. A view registration
 * (`ViewDeclaration`, `PluginAppNavTab`, `AppShellPageRegistration`, and the
 * `ViewRegistryEntry` transport DTO) carries an optional `surface` manifest plus
 * the legacy `backgroundPolicy` / `headerPolicy` fields that predate it. The
 * manifest wins when present; the legacy fields are the fallback so existing
 * declarations keep resolving to the same policy.
 */
export interface SurfaceManifestBearer {
	/** The declared manifest. Preferred source for every surface field. */
	surface?: SurfaceManifest;
	/**
	 * Legacy standalone background policy, predating {@link surface}. Used only
	 * when `surface.background` is absent.
	 */
	backgroundPolicy?: AppShellBackgroundPolicy;
	/**
	 * Legacy standalone header policy, predating {@link surface}. Used only when
	 * `surface.header` is absent.
	 */
	headerPolicy?: ViewHeaderPolicy;
}

function dedupeCapabilities(
	caps: readonly SurfaceCapability[] | undefined,
): ReadonlySet<SurfaceCapability> {
	// `Set`'s constructor treats a missing iterable as empty, so an absent
	// capability list yields an empty set without a `?? []` empty-fallback.
	return new Set(caps);
}

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
	capabilities: ["wallpaper", "background:apply"],
};
