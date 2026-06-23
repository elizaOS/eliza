/**
 * Register the Social Alpha leaderboard view for terminal rendering.
 *
 * The agent terminal mounts plugin views by id from the `@elizaos/ui/spatial/tui`
 * terminal registry. This makes the leaderboard's `tui` modality render for real
 * in the terminal (the unified {@link SocialAlphaSpatialView}) rather than only
 * navigating a GUI shell. A module-level snapshot lets a host push live data;
 * absent a push it defaults to the loading state.
 */

import { registerSpatialTerminalView } from "@elizaos/ui/spatial/tui";
import { createElement } from "react";
import {
	EMPTY_SOCIAL_ALPHA_SNAPSHOT,
	type SocialAlphaSnapshot,
	SocialAlphaSpatialView,
} from "./frontend/SocialAlphaSpatialView.tsx";

let current: SocialAlphaSnapshot = EMPTY_SOCIAL_ALPHA_SNAPSHOT;

/** Update the snapshot the registered terminal view renders from. */
export function setSocialAlphaTerminalSnapshot(
	next: SocialAlphaSnapshot,
): void {
	current = next;
}

/** Register the Social Alpha terminal view; returns an unregister function. */
export function registerSocialAlphaTerminalView(): () => void {
	return registerSpatialTerminalView("social-alpha", () =>
		createElement(SocialAlphaSpatialView, { snapshot: current }),
	);
}
