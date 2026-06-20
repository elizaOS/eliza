/**
 * Current-view feedback provider.
 *
 * Injects the view the user is CURRENTLY looking at into every reply's prompt,
 * so that after any view switch — by the early shortcut, the VIEWS action, or
 * the contextual evaluator — the next reply is aware of where the user now is
 * ("the user is currently viewing the Settings view"). Reads the live
 * server-side current-view state over loopback (GET /api/views/current), which
 * the navigate endpoint updates on every switch.
 */
import type {
	IAgentRuntime,
	Memory,
	Provider,
	ProviderResult,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import { createViewsClient } from "../actions/views-client.js";

const EMPTY: ProviderResult = { text: "", values: {}, data: {} };

export const currentViewProvider: Provider = {
	name: "current_view",
	description:
		"The UI view the user is currently looking at, so replies stay aware of view switches.",
	// Just after available_apps; always present (not dynamic) so the agent always
	// knows the active view without having to request it.
	position: -7,
	get: async (
		_runtime: IAgentRuntime,
		_message: Memory,
	): Promise<ProviderResult> => {
		try {
			const current = await createViewsClient().getCurrentView();
			if (!current) return EMPTY;
			const where = current.viewPath
				? `${current.viewLabel} view (${current.viewPath})`
				: `${current.viewLabel} view`;
			return {
				text: `The user is currently viewing the ${where}. If they ask to go somewhere else, switch with the VIEWS action.`,
				values: {
					currentViewId: current.viewId,
					currentViewLabel: current.viewLabel,
				},
				data: { currentView: current },
			};
		} catch (error) {
			// A loopback failure must not break prompt composition — degrade silently.
			logger.debug(
				"[current_view] could not resolve current view:",
				error instanceof Error ? error.message : String(error),
			);
			return EMPTY;
		}
	},
};
