/**
 * Deterministic response-handler shortcut for persisted app-control choices.
 *
 * App/view creation and model-target clarification persist room-scoped
 * AWAITING_CHOICE tasks. A later bare reply is therefore domain input, not a
 * chat message to paraphrase. Force it back through the owning action so the
 * model cannot answer with REPLY and leave the task stranded.
 */

import type {
	ResponseHandlerEvaluator,
	ResponseHandlerEvaluatorContext,
} from "@elizaos/core";
import {
	hasPendingIntent,
	isChoiceReply as isAppCreateChoiceReply,
} from "../actions/app-create.js";
import {
	hasPendingModelSwitchTarget,
	isModelSwitchTargetChoice,
} from "../actions/model-switch.js";
import { hasPendingViewsCreateIntent } from "../actions/views-create.js";
import { userRequestMessageText } from "../params.js";

const APP_ACTION_NAME = "APP";
const MODEL_SWITCH_ACTION_NAME = "MODEL_SWITCH";
const VIEWS_ACTION_NAME = "VIEWS";
const GENERAL_CONTEXT = "general";

function messageText(context: ResponseHandlerEvaluatorContext): string {
	// Security-unwrapped user words — a choice reply ("cancel", "edit-1") must
	// be read from the payload, never from envelope armor.
	return userRequestMessageText(context.message);
}

function roomId(context: ResponseHandlerEvaluatorContext): string {
	return typeof context.message.roomId === "string"
		? context.message.roomId
		: context.runtime.agentId;
}

function hasRegisteredAction(
	context: ResponseHandlerEvaluatorContext,
	actionName: string,
): boolean {
	const normalized = actionName.toUpperCase();
	return (context.runtime.actions ?? []).some(
		(action) => action.name?.toUpperCase() === normalized,
	);
}

async function resolvePendingChoiceAction(
	context: ResponseHandlerEvaluatorContext,
): Promise<
	| typeof APP_ACTION_NAME
	| typeof MODEL_SWITCH_ACTION_NAME
	| typeof VIEWS_ACTION_NAME
	| null
> {
	if (context.messageHandler.processMessage === "STOP") return null;
	const choice = messageText(context).trim();
	const id = roomId(context);
	const appChoice = isAppCreateChoiceReply(choice);
	const modelChoice = isModelSwitchTargetChoice(choice);
	if (!appChoice && !modelChoice) return null;
	const [appPending, viewsPending, modelPending] = await Promise.all([
		appChoice && hasRegisteredAction(context, APP_ACTION_NAME)
			? hasPendingIntent(context.runtime, id)
			: Promise.resolve(false),
		appChoice && hasRegisteredAction(context, VIEWS_ACTION_NAME)
			? hasPendingViewsCreateIntent(context.runtime, id)
			: Promise.resolve(false),
		modelChoice && hasRegisteredAction(context, MODEL_SWITCH_ACTION_NAME)
			? hasPendingModelSwitchTarget(context.runtime, id)
			: Promise.resolve(false),
	]);
	const pending: Array<
		| typeof APP_ACTION_NAME
		| typeof MODEL_SWITCH_ACTION_NAME
		| typeof VIEWS_ACTION_NAME
	> = [];
	if (appPending) pending.push(APP_ACTION_NAME);
	if (viewsPending) pending.push(VIEWS_ACTION_NAME);
	if (modelPending) pending.push(MODEL_SWITCH_ACTION_NAME);
	return pending.length === 1 ? pending[0] : null;
}

export const createChoiceShortcutEvaluator: ResponseHandlerEvaluator = {
	name: "app-control.create-choice-shortcut",
	description:
		"Deterministically routes app-control choice replies back through the action that persisted the pending choice.",
	priority: 12,
	shouldRun: async (context) =>
		(await resolvePendingChoiceAction(context)) !== null,
	evaluate: async (context) => {
		const actionName = await resolvePendingChoiceAction(context);
		if (!actionName) return undefined;
		const choice = messageText(context).trim().toLowerCase();
		const params: Record<string, string> =
			actionName === MODEL_SWITCH_ACTION_NAME
				? { target: choice }
				: { action: "create", choice };
		return {
			requiresTool: true,
			clearReply: true,
			clearCandidateActions: true,
			addCandidateActions: [actionName],
			clearParentActionHints: true,
			addParentActionHints: [actionName],
			addContexts: [GENERAL_CONTEXT],
			deterministicToolCall: {
				name: actionName,
				params,
			},
			debug: [
				`pending ${actionName} choice "${choice}" routed deterministically`,
			],
		};
	},
};
