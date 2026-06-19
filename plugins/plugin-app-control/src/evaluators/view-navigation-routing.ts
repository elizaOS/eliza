import type {
	ResponseHandlerEvaluator,
	ResponseHandlerEvaluatorContext,
} from "@elizaos/core";
import { createViewsClient } from "../actions/views-client.js";
import { resolveIntentView } from "../actions/views-show.js";

const VIEWS_ACTION_NAME = "VIEWS";
const GENERAL_CONTEXT = "general";

function textOf(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function hasRegisteredViewsAction(
	context: ResponseHandlerEvaluatorContext,
): boolean {
	return (context.runtime.actions ?? []).some(
		(action) => action.name?.toUpperCase() === VIEWS_ACTION_NAME,
	);
}

/**
 * Cheap synchronous gate: does the current user message clearly ask to open a
 * known domain surface? Uses the SAME multilingual `resolveIntentView` table the
 * VIEWS handler uses downstream, so detection and view resolution always agree.
 *
 * `resolveIntentView` is high-precision (returns `null` for non-navigation) and
 * deliberately covers the passive/multilingual intents that core's English
 * token matcher (`findViewShellActionName`) misses — "muéstrame mi calendario",
 * "check my messages", "我的钱包". A match means "the user wants view X open".
 */
function navIntentView(
	context: ResponseHandlerEvaluatorContext,
): string | null {
	if (context.messageHandler.processMessage !== "RESPOND") return null;
	if (!hasRegisteredViewsAction(context)) return null;
	const text = textOf(context.message.content?.text).trim();
	if (!text) return null;
	return resolveIntentView(text);
}

/**
 * View switching as a response-handler evaluator (in addition to the VIEWS
 * action). Per the architecture: a weak/local planner (e.g. the 0.8B eliza
 * model) frequently fails to *select* VIEWS for a navigation request even though
 * the VIEWS handler resolves the target view deterministically once chosen. This
 * evaluator closes that gap: when the message is unambiguous navigation intent
 * and the target view is actually registered (i.e. we are in a view-capable app
 * surface), it pins the plan to the VIEWS action so the planner can't drift to a
 * bare text reply. The model never has to *guess* the surface — `resolveIntentView`
 * supplies it and the VIEWS handler re-derives it from the message text.
 *
 * Narrowing (`clearCandidateActions` + `addCandidateActions:["VIEWS"]`) is the
 * strong lever that makes this work on models that otherwise default to REPLY;
 * it is safe here because the gate (`resolveIntentView` + a registered-view
 * confirmation) is high-precision.
 */
export const viewNavigationRoutingEvaluator: ResponseHandlerEvaluator = {
	name: "app-control.view-navigation-routing",
	description:
		"Routes clear (multilingual) view-navigation intent through the VIEWS action so weak/local planners reliably open the right surface.",
	// Run before the mutation-follow-up router (priority 20): a fresh navigation
	// intent should pin VIEWS first; follow-up mutation phrasing never matches
	// resolveIntentView, so the two do not contend.
	priority: 18,
	shouldRun: (context) => navIntentView(context) !== null,
	evaluate: async (context) => {
		const view = navIntentView(context);
		if (!view) return undefined;
		// Confirm we are in a view-capable (app) surface AND the resolved view is
		// a real registered view before hijacking the plan. A loopback failure or
		// an unknown id => no route, so non-app channels and stale ids fall back to
		// the agent's normal reply rather than a dead navigation + canned "On it.".
		try {
			const client = createViewsClient();
			const views = await client.listViews();
			if (!views.some((summary) => summary.id === view)) return undefined;
		} catch {
			return undefined;
		}
		return {
			requiresTool: true,
			clearReply: true,
			reply: "On it.",
			addContexts: [GENERAL_CONTEXT],
			clearCandidateActions: true,
			addCandidateActions: [VIEWS_ACTION_NAME],
			addParentActionHints: [VIEWS_ACTION_NAME],
			debug: [`navigation intent → view ${view}; pinned plan to VIEWS`],
		};
	},
};
