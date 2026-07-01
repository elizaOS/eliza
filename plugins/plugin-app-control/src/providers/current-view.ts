/**
 * Current-view acknowledgement provider.
 *
 * Carries two related signals into the prompt:
 *  - **Ambient state** — the view the user is currently looking at, so replies
 *    stay aware of where they are ("the user is currently viewing Settings").
 *  - **Just-switched acknowledgement** — when a switch just happened (or is
 *    *about* to happen this turn), the text is phrased so the agent acknowledges
 *    the move in its reply ("opening your calendar now").
 *
 * Same-turn acknowledgement for explicit commands is the hard case: at
 * response-compose time the server still reports the *previous* view because the
 * VIEWS action has not executed yet. We detect the imminent switch the same
 * deterministic way the early shortcut does — `resolveIntentView(message.text)`
 * — and phrase forward-looking. Already-executed switches (the contextual
 * evaluator, or a prior turn's action) are caught via the server `justSwitched`
 * stamp. Reads the live server state over loopback (GET /api/views/current).
 *
 * This provider is intentionally NOT `alwaysInResponseState`: it is injected
 * into the Stage-1 response state only on switch turns by the
 * `compose_state_providers` hook (see `index.ts`), so non-switch turns pay no
 * extra prompt/token cost.
 */
import type {
	IAgentRuntime,
	Memory,
	Provider,
	ProviderResult,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
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
		"The UI view the user is currently looking at — and whether the agent just switched it — so replies acknowledge the move and stay aware of view switches.",
	// Just after available_apps. Composed in the planner state by default; pulled
	// into the Stage-1 response state on switch turns by the compose hook.
	position: -7,
	get: async (
		_runtime: IAgentRuntime,
		message: Memory,
	): Promise<ProviderResult> => {
		try {
			const text =
				typeof message?.content?.text === "string" ? message.content.text : "";
			// Imminent explicit switch: the early shortcut will force VIEWS for this
			// exact phrase, so the reply being generated now can acknowledge it.
			const intentTargetId = resolveIntentView(text);

			const current = await createViewsClient().getCurrentView();

			if (intentTargetId && intentTargetId !== current?.viewId) {
				const label = humanizeViewId(intentTargetId);
				return {
					text: `The user asked to open the ${label} view and you are switching them there now. Acknowledge the switch in your reply (e.g. "opening your ${label} now").`,
					values: {
						currentViewId: current?.viewId,
						switchingToViewId: intentTargetId,
						viewJustSwitched: true,
						viewSwitchSource: "agent",
					},
					data: { currentView: current, switchingTo: intentTargetId },
				};
			}

			if (!current) return EMPTY;

			const section = current.subview ? ` — ${current.subview} section` : "";
			const where = current.viewPath
				? `${current.viewLabel} view (${current.viewPath})${section}`
				: `${current.viewLabel} view${section}`;

			if (current.justSwitched) {
				const agentInitiated = current.source !== "user";
				const ackText = agentInitiated
					? `You just switched the user to the ${where}. Acknowledge the switch in your reply (e.g. "opening your ${current.viewLabel} now").`
					: `The user just switched to the ${where} themselves. Refer to it if it helps; you did not move them.`;
				return {
					text: ackText,
					values: {
						currentViewId: current.viewId,
						currentViewLabel: current.viewLabel,
						...(current.subview ? { currentViewSubview: current.subview } : {}),
						viewJustSwitched: true,
						viewSwitchSource: current.source ?? "agent",
					},
					data: { currentView: current },
				};
			}

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
			// A loopback failure must not break prompt composition — degrade silently.
			logger.debug(
				"[current_view] could not resolve current view:",
				error instanceof Error ? error.message : String(error),
			);
			return EMPTY;
		}
	},
};
