import type {
	ResponseHandlerEvaluator,
	ResponseHandlerEvaluatorContext,
	ViewCapability,
} from "@elizaos/core";
import {
	createViewsClient,
	type ViewSummary,
} from "../actions/views-client.js";

type CapabilityFamily = "create" | "delete" | "update";

const VIEWS_ACTION_NAME = "VIEWS";
const GENERAL_CONTEXT = "general";

const CREATE_TOKENS = new Set(["ADD", "CREATE", "MAKE", "NEW", "PUT", "WRITE"]);
const DELETE_TOKENS = new Set(["DELETE", "REMOVE", "CLEAR"]);
const UPDATE_TOKENS = new Set([
	"CHANGE",
	"EDIT",
	"MODIFY",
	"RENAME",
	"SET",
	"UPDATE",
]);
const REFERENCE_TOKENS = new Set([
	"ANOTHER",
	"IT",
	"ONE",
	"SAME",
	"THAT",
	"THE",
	"THEM",
	"THESE",
	"THIS",
	"THOSE",
]);
// Tokens that signal the follow-up carries NEW content for the active view
// (e.g. "make another one *saying* X", "set the *title* to Y"). These gate
// create/update follow-ups so an ordinary conversational reply that merely
// reuses a mutation verb does not get hijacked into VIEWS. Deliberately
// excludes the bare preposition "with": it co-occurs with too many non-view
// replies ("set it up with them", "go with that") and produced false routes
// that suppressed the real answer with the canned "On it.".
const CONTENT_MARKER_TOKENS = new Set([
	"BODY",
	"CONTENT",
	"DETAIL",
	"DETAILS",
	"NOTE",
	"SAY",
	"SAYING",
	"SAYS",
	"TEXT",
	"TITLE",
]);

function textOf(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function tokenize(text: string): string[] {
	return text.toUpperCase().match(/[A-Z0-9]+/g) ?? [];
}

function hasAny(
	tokens: readonly string[],
	accepted: ReadonlySet<string>,
): boolean {
	return tokens.some((token) => accepted.has(token));
}

function requestFamily(tokens: readonly string[]): CapabilityFamily | null {
	if (hasAny(tokens, DELETE_TOKENS)) return "delete";
	if (hasAny(tokens, UPDATE_TOKENS)) return "update";
	if (hasAny(tokens, CREATE_TOKENS)) return "create";
	return null;
}

function capabilityFamily(capability: ViewCapability): CapabilityFamily | null {
	const tokens = tokenize(
		[
			capability.id,
			capability.description,
			...Object.keys(capability.params ?? {}),
		].join(" "),
	);
	if (hasAny(tokens, DELETE_TOKENS)) return "delete";
	if (hasAny(tokens, UPDATE_TOKENS)) return "update";
	if (hasAny(tokens, CREATE_TOKENS)) return "create";
	return null;
}

function viewSupportsFamily(
	view: ViewSummary,
	family: CapabilityFamily,
): boolean {
	return (view.capabilities ?? []).some(
		(capability) => capabilityFamily(capability) === family,
	);
}

function hasRegisteredViewsAction(context: ResponseHandlerEvaluatorContext) {
	return (context.runtime.actions ?? []).some(
		(action) => action.name?.toUpperCase() === VIEWS_ACTION_NAME,
	);
}

function shouldConsiderViewFollowup(
	context: ResponseHandlerEvaluatorContext,
): CapabilityFamily | null {
	if (context.messageHandler.processMessage === "STOP") return null;
	if (context.messageHandler.plan.requiresTool === true) return null;
	if (!hasRegisteredViewsAction(context)) return null;

	const tokens = tokenize(textOf(context.message.content?.text));
	const family = requestFamily(tokens);
	if (!family) return null;
	if (!hasAny(tokens, REFERENCE_TOKENS)) return null;
	if (family !== "delete" && !hasAny(tokens, CONTENT_MARKER_TOKENS)) {
		return null;
	}
	return family;
}

async function resolveActiveViewForFamily(
	family: CapabilityFamily,
): Promise<ViewSummary | null> {
	// The intent gate (family verb + reference token, plus a content marker for
	// create/update) is enforced in shouldConsiderViewFollowup. Here we only need
	// to confirm a view is actually focused and can perform the requested family.
	// A loopback failure means we can't confirm the active view — degrade to "no
	// route" so the agent's normal reply stands rather than crashing the evaluator.
	try {
		const client = createViewsClient();
		const current = await client.getCurrentView();
		if (!current) return null;

		const views = await client.listViews();
		const activeView = views.find((view) => view.id === current.viewId);
		if (!activeView || !viewSupportsFamily(activeView, family)) {
			return null;
		}
		return activeView;
	} catch {
		return null;
	}
}

export const viewFollowupRoutingEvaluator: ResponseHandlerEvaluator = {
	name: "app-control.view-followup-routing",
	description:
		"Routes context-dependent mutation follow-ups for the active UI view through the VIEWS action.",
	priority: 20,
	shouldRun: (context) => shouldConsiderViewFollowup(context) !== null,
	evaluate: async (context) => {
		const family = shouldConsiderViewFollowup(context);
		if (!family) return undefined;

		const activeView = await resolveActiveViewForFamily(family);
		if (!activeView) return undefined;

		return {
			requiresTool: true,
			clearReply: true,
			reply: "On it.",
			addContexts: [GENERAL_CONTEXT],
			addCandidateActions: [VIEWS_ACTION_NAME],
			addParentActionHints: [VIEWS_ACTION_NAME],
			debug: [
				`active view ${activeView.id} supports ${family}; routing follow-up through VIEWS`,
			],
		};
	},
};
