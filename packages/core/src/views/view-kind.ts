/** Resolves host view presentation policy without loading the Node runtime. */
import type {
	EnabledViewKinds,
	ViewKind,
	ViewKindBearer,
	ViewModality,
} from "../types/view-kind.js";

export type {
	EnabledViewKinds,
	ViewKind,
	ViewKindBearer,
	ViewModality,
	ViewType,
} from "../types/view-kind.js";

/** The four view kinds, in escalating "exposure" order. */
export const VIEW_KINDS = [
	"system",
	"release",
	"developer",
	"preview",
] as const;

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

const MODALITY_ORDER: readonly ViewModality[] = ["gui", "xr", "tui"];

/** Order + de-duplicate a modality list as gui, xr, tui. */
export function dedupeModalities(
	mods: readonly ViewModality[],
): ViewModality[] {
	const seen = new Set(mods);
	return MODALITY_ORDER.filter((m) => seen.has(m));
}
