/** View declaration types carried by plugins; host presentation policies live in shared. */

export type AppShellBackgroundPolicy = "opaque" | "shared";

export type ViewHeaderPolicy = "normal" | "fullscreen" | "modal" | "immersive";

/** A view's isolation level. See {@link SURFACE_ISOLATION_LEVELS}. */
export type SurfaceIsolationLevel =
	| "in-process"
	| "sandboxed-iframe"
	| "native-webview"
	| "immersive";

/** A capability grantable to a view surface. See {@link SURFACE_CAPABILITIES}. */
export type SurfaceCapability =
	| "wallpaper"
	| "background:apply"
	| "navigate"
	| "storage"
	| "agent-surface";

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
 * Semantic page topology carried across hosts with the rest of a view's
 * surface policy. The UI maps these values to canonical page components and
 * responsive rules; transport and plugins never name CSS classes or pixels.
 */
export type PageLayoutManifest =
	| {
			kind: "content";
			topology?: "framed" | "ambient";
			width: "reading" | "standard" | "wide";
			scroll: "shell" | "view";
			gutter?: "standard" | "none";
	  }
	| {
			kind: "workspace";
			topology?: "framed" | "ambient";
			width: "wide" | "full";
			scroll: "view";
			gutter?: "standard" | "none";
	  }
	| {
			kind: "immersive";
			topology?: "framed" | "ambient";
			width: "full";
			scroll: "view";
			gutter: "none";
	  };

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
	/** Page topology, width policy, and scroll ownership. */
	layout?: PageLayoutManifest;
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
	layout: PageLayoutManifest;
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
