/**
 * Exposes the renderer's current view and the explicit target requested in the
 * current turn. Navigation callbacks own visible acknowledgements, so a
 * server-side "just switched" stamp is state only and never instructs a later
 * message to repeat an old completion.
 */
import type {
	IAgentRuntime,
	Memory,
	Provider,
	ProviderResult,
} from "@elizaos/core";
import { getUserMessageText, logger } from "@elizaos/core";
import { createViewsClient } from "../actions/views-client.js";
import { resolveIntentView } from "../actions/views-show.js";

const EMPTY: ProviderResult = { text: "", values: {}, data: {} };

/** Humanize a view id ("task-coordinator" → "Task Coordinator") for phrasing. */
function humanizeViewId(viewId: string): string {
	return viewId
		.split(/[-_]/)
		.filter(Boolean)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");
}

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
			const text = getUserMessageText(message);
			// The early shortcut will force VIEWS for this exact phrase. Until that
			// action completes, the renderer still reports the previous view, so the
			// requested target must be the authoritative state for this turn.
			const intentTargetId = resolveIntentView(text);

			const current = await createViewsClient().getCurrentView();

			if (intentTargetId && intentTargetId !== current?.viewId) {
				const label = humanizeViewId(intentTargetId);
				return {
					text: `Requested view target: ${label} (id: ${intentTargetId}). The renderer${current ? ` is still on ${current.viewLabel} (id: ${current.viewId}) until navigation completes` : " has no active view yet"}. The requested target is authoritative for this turn.`,
					values: {
						currentViewId: current?.viewId,
						switchingToViewId: intentTargetId,
						viewSwitchPending: true,
					},
					data: { currentView: current, switchingTo: intentTargetId },
				};
			}

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
