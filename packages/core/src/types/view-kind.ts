/**
 * View kinds — the four-tier categorization every view-like surface is sorted
 * into so the shell can decide what to show by build and by user preference.
 *
 *  - `system`    — core views that are always present (chat, settings, …). Not
 *                  toggleable; always visible on every build.
 *  - `release`   — public, production-ready views meant for everyone. Always
 *                  visible on every build.
 *  - `developer` — developer-only tooling (logs, database, trajectory viewer)
 *                  so devs can verify the app is working. Hidden by default on
 *                  every build — dev builds included — until enabled in
 *                  Settings; there is no build-variant bypass.
 *  - `preview`   — unfinished / alpha / experimental views. Hidden by default
 *                  on every build until enabled in Settings.
 *
 * The taxonomy lives in `@elizaos/core` so the agent server (view registry,
 * built-in views) and every front-end (the dashboard shell, the view manager,
 * settings) share one definition. The *enabled* set is owned by the client —
 * which kinds are on follows the user's persisted Settings toggles, which the
 * server can't know.
 */

/** The four view kinds, in escalating "exposure" order. */
export const VIEW_KINDS = [
	"system",
	"release",
	"developer",
	"preview",
] as const;

/** A view's category. See {@link VIEW_KINDS}. */
export type ViewKind = (typeof VIEW_KINDS)[number];

/**
 * The two user-controllable toggles. `system` and `release` are always on, so
 * they are not represented here.
 */
export interface EnabledViewKinds {
	/** Show `developer`-kind views. Default: off on every build. */
	developer: boolean;
	/** Show `preview`-kind views. Default: off on every build. */
	preview: boolean;
}

/** A declaration that can be sorted into a {@link ViewKind}. */
export interface ViewKindBearer {
	/** Explicit kind. When set, it wins over the legacy `developerOnly` flag. */
	viewKind?: ViewKind;
	/**
	 * Legacy gate predating {@link viewKind}. `true` is equivalent to
	 * `viewKind: "developer"`. Kept so existing declarations keep working.
	 */
	developerOnly?: boolean;
}

/**
 * Resolve the effective kind of a view-like declaration. Explicit `viewKind`
 * wins; a legacy `developerOnly: true` maps to `"developer"`; everything else
 * defaults to `"release"` (public). `"system"` is always explicit — a view is
 * never silently promoted to always-on.
 */
export function resolveViewKind(
	decl: ViewKindBearer | null | undefined,
): ViewKind {
	if (decl?.viewKind) return decl.viewKind;
	if (decl?.developerOnly) return "developer";
	return "release";
}

/**
 * Whether a given kind is visible under the current enabled set. `system` and
 * `release` are always visible; `developer` and `preview` follow their toggles.
 */
export function isViewKindEnabled(
	kind: ViewKind,
	enabled: EnabledViewKinds,
): boolean {
	switch (kind) {
		case "system":
		case "release":
			return true;
		case "developer":
			return enabled.developer;
		case "preview":
			return enabled.preview;
		default:
			return false;
	}
}

/**
 * Whether a view-like declaration is visible under the current enabled set.
 * Combines {@link resolveViewKind} + {@link isViewKindEnabled} — the single
 * predicate every visibility filter should call.
 */
export function isViewVisible(
	decl: ViewKindBearer | null | undefined,
	enabled: EnabledViewKinds,
): boolean {
	return isViewKindEnabled(resolveViewKind(decl), enabled);
}

/** Whether a kind is always on (not user-toggleable). */
export function isAlwaysOnViewKind(kind: ViewKind): boolean {
	return kind === "system" || kind === "release";
}

/** Presentation metadata for each kind — labels/descriptions for Settings. */
export const VIEW_KIND_META: Record<
	ViewKind,
	{ label: string; description: string; alwaysOn: boolean }
> = {
	system: {
		label: "System",
		description: "Core views that are always available.",
		alwaysOn: true,
	},
	release: {
		label: "Release",
		description: "Public, production-ready views for everyone.",
		alwaysOn: true,
	},
	developer: {
		label: "Developer",
		description:
			"Developer tooling to verify the app is working — logs, database, trajectories.",
		alwaysOn: false,
	},
	preview: {
		label: "Preview",
		description: "Unfinished, alpha, or experimental views still in progress.",
		alwaysOn: false,
	},
};
