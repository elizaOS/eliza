/** View declaration types carried by plugins; host presentation policies live in shared. */

/** A view's category. See {@link VIEW_KINDS}. */
export type ViewKind = "system" | "release" | "developer" | "preview";

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

/** Presentation/runtime family for a view. */
export type ViewType = "gui" | "tui" | "xr";

/**
 * A surface a view renders on. Same set as {@link ViewType}; named separately
 * because a single view declaration can render on several modalities at once
 * while the shipped view bundle can remain focused on the GUI renderer.
 */
export type ViewModality = ViewType;
