import type { ViewDeclaration } from "../types/plugin.js";

/** View declaration types carried by plugins; host presentation policies live in shared. */

/** A view's category. See {@link VIEW_KINDS}. */
import type { ViewKind } from "../types/view-kind.js";

export type { ViewKind } from "../types/view-kind.js";

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
	/** Four-tier visibility category; absent values default to release. */
	viewKind?: ViewKind;
}

/** Presentation/runtime family for a view. */
export type ViewType = "gui" | "tui" | "xr";

/**
 * A surface a view renders on. Same set as {@link ViewType}; named separately
 * because a single view declaration can render on several modalities at once
 * while the shipped view bundle can remain focused on the GUI renderer.
 */
export type ViewModality = ViewType;

/** Resolves host view presentation policy without loading the Node runtime. */

/** The four view kinds, in escalating "exposure" order. */
export const VIEW_KINDS = [
	"system",
	"release",
	"developer",
	"preview",
] as const;

/** Missing kinds default to release; system views must opt in explicitly. */
export function resolveViewKind(
	decl: ViewKindBearer | null | undefined,
): ViewKind {
	if (decl?.viewKind) return decl.viewKind;
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

export type { ViewDeclaration } from "../types/plugin.js";

/**
 * The surfaces a view declaration renders on: the explicit `modalities` list
 * when set, otherwise the single `viewType` (default "gui").
 */
export function getViewModalities(
	view: Pick<ViewDeclaration, "modalities" | "viewType">,
): ViewModality[] {
	if (view.modalities && view.modalities.length > 0) {
		return dedupeModalities(view.modalities);
	}
	return [view.viewType ?? "gui"];
}
