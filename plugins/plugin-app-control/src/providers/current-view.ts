/**
 * Current-view state provider.
 *
 * Carries two related signals into the prompt:
 *  - **Ambient state** — the view the user is currently looking at, so replies
 *    stay aware of where they are ("the user is currently viewing Settings").
 *  - **Pending target** — when this turn explicitly requests another view, the
 *    requested target supersedes the renderer's still-current view.
 *
 * Same-turn target selection for explicit commands is the hard case: at
 * response-compose time the server still reports the *previous* view because the
 * VIEWS action has not executed yet. We detect the imminent switch the same
 * deterministic way the early shortcut does — `resolveIntentView(message.text)`
 * — and report the target as a fact. The action result owns the visible reply;
 * prompt context must never ask a later turn to respond to a prior switch.
 * Reads live server state over loopback (GET /api/views/current).
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
import { getUserMessageText, logger } from "@elizaos/core";
import {
	createViewsClient,
	readViewClientId,
} from "../actions/views-client.js";
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
			// The renderer still reports the previous view until VIEWS completes. Keep
			// the requested target authoritative so a rapid switch cannot inherit stale
			// active-view language from the prior turn.
			const intentTargetId = resolveIntentView(text);

			const current = await createViewsClient({
				clientId: readViewClientId(message),
			}).getCurrentView();

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
				text: `The user is currently viewing the ${where}.${current.views && current.views.length > 1 ? ` Visible panes: ${current.views.join(", ")}${current.layout ? ` (${current.layout} layout)` : ""}; ${current.viewId} is primary.` : ""} If they ask to go somewhere else, switch with the VIEWS action.`,
				values: {
					currentViewId: current.viewId,
					currentViewLabel: current.viewLabel,
					...(current.subview ? { currentViewSubview: current.subview } : {}),
				},
				data: { currentView: current },
			};
		} catch (error) {
			// error-policy:J7 provider diagnostics must not break prompt composition,
			// but the agent and owner must be able to observe the missing state.
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
