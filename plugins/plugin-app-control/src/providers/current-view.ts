/**
 * Exposes the renderer's current view and the explicit target requested in the
 * current turn. Navigation actions expose internal receipts and post-tool
 * evaluation owns visible wording, so a server-side "just switched" stamp is
 * state only and never instructs a later message to repeat an old completion.
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
		"The UI view the user is currently looking at, plus any explicit target requested on this turn.",
	contexts: ["general"],
	// Just after available_apps. Composed in the planner state by default; pulled
	// into the Stage-1 response state on switch turns by the compose hook.
	position: -7,
	get: async (
		runtime: IAgentRuntime,
		message: Memory,
	): Promise<ProviderResult> => {
		try {
			const current = await createViewsClient().getCurrentView();

			if (!current) return EMPTY;

			const section = current.subview ? ` — ${current.subview} section` : "";
			const where = current.viewPath
				? `${current.viewLabel} view (${current.viewPath})${section}`
				: `${current.viewLabel} view${section}`;

			return {
				text: `The user is currently viewing the ${where}. If they ask to go somewhere else, switch with the VIEWS action.`,
				values: {
					currentViewId: current.viewId,
					currentViewLabel: current.viewLabel,
					...(current.subview ? { currentViewSubview: current.subview } : {}),
					viewJustSwitched: false,
				},
				data: { currentView: current },
			};
		} catch (error) {
			// error-policy:J7 prompt diagnostics must not break the reply loop, but
			// the missing renderer state must remain observable to the agent and owner.
			runtime.reportError("app-control.current-view", error, {
				messageId: message.id,
				roomId: message.roomId,
			});
			logger.debug(
				"[current_view] could not resolve current view:",
				error instanceof Error ? error.message : String(error),
			);
			return EMPTY;
		}
	},
};
