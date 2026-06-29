/**
 * @module plugin-app-control/actions/settings-subviews
 *
 * Addressable sub-sections per view, so the planner can discover valid
 * `subview` values for the VIEWS action. Sourced from the canonical UI
 * settings-section metadata (`SETTINGS_SECTION_META`) — the single source of
 * truth for built-in settings section ids/labels — rather than a divergent
 * hand-maintained list. Settings is the only view with addressable sections
 * today; every other view returns `undefined`.
 */

import { SETTINGS_SECTION_META } from "@elizaos/ui/components/settings/settings-section-meta";

export interface ViewSubview {
	id: string;
	label: string;
}

/** The addressable sub-sections of a view, or `undefined` if it has none. */
export function subviewsForView(viewId: string): ViewSubview[] | undefined {
	if (viewId !== "settings") return undefined;
	return SETTINGS_SECTION_META.map((meta) => ({
		id: meta.id,
		label: meta.defaultLabel,
	}));
}
