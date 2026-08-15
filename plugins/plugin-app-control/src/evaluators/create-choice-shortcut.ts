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
	inferModelSwitchRequest,
	isModelSwitchIntent,
	isModelSwitchTargetChoice,
} from "../actions/model-switch.js";
import { hasPendingViewsCreateIntent } from "../actions/views-create.js";
import { userRequestMessageText } from "../params.js";

const APP_ACTION_NAME = "APP";
const MODEL_SWITCH_ACTION_NAME = "MODEL_SWITCH";
const VIEWS_ACTION_NAME = "VIEWS";
const GENERAL_CONTEXT = "general";

interface ChoiceShortcut {
	actionName:
		| typeof APP_ACTION_NAME
		| typeof MODEL_SWITCH_ACTION_NAME
		| typeof VIEWS_ACTION_NAME;
	params: Record<string, string>;
	debug: string;
}

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

async function resolveChoiceShortcut(
	context: ResponseHandlerEvaluatorContext,
): Promise<ChoiceShortcut | null> {
	if (context.messageHandler.processMessage === "STOP") return null;
	const choice = messageText(context).trim();
	if (
		hasRegisteredAction(context, MODEL_SWITCH_ACTION_NAME) &&
		isModelSwitchIntent(choice)
	) {
		const request = inferModelSwitchRequest(choice);
		return {
			actionName: MODEL_SWITCH_ACTION_NAME,
			params: request ?? {},
			debug: `explicit model-switch request "${choice}" routed deterministically`,
		};
	}
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
	if (pending.length !== 1) return null;
	const actionName = pending[0];
	return {
		actionName,
		params:
			actionName === MODEL_SWITCH_ACTION_NAME
				? { target: choice.toLowerCase() }
				: { action: "create", choice },
		debug: `pending ${actionName} choice "${choice}" routed deterministically`,
	};
}

export const createChoiceShortcutEvaluator: ResponseHandlerEvaluator = {
	name: "app-control.create-choice-shortcut",
	description:
		"Deterministically routes explicit model-switch requests and app-control choice replies through their owning action.",
	priority: 12,
	shouldRun: async (context) => (await resolveChoiceShortcut(context)) !== null,
	evaluate: async (context) => {
		const shortcut = await resolveChoiceShortcut(context);
		if (!shortcut) return undefined;
		return {
			requiresTool: true,
			clearReply: true,
			clearCandidateActions: true,
			addCandidateActions: [shortcut.actionName],
			clearParentActionHints: true,
			addParentActionHints: [shortcut.actionName],
			addContexts: [GENERAL_CONTEXT],
			deterministicToolCall: {
				name: shortcut.actionName,
				params: shortcut.params,
			},
			debug: [shortcut.debug],
		};
	},
};
