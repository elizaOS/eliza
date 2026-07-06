/**
 * Deterministic response-handler shortcut for APP/VIEWS create choice replies.
 *
 * The create flows persist a pending intent task after showing a [CHOICE] block.
 * A later bare reply like "cancel" or "edit-1" is therefore domain input, not
 * a chat message to paraphrase. Force it back through the owning action so the
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
import { hasPendingViewsCreateIntent } from "../actions/views-create.js";

const APP_ACTION_NAME = "APP";
const VIEWS_ACTION_NAME = "VIEWS";
const GENERAL_CONTEXT = "general";

function messageText(context: ResponseHandlerEvaluatorContext): string {
	return typeof context.message.content?.text === "string"
		? context.message.content.text
		: "";
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
): Promise<typeof APP_ACTION_NAME | typeof VIEWS_ACTION_NAME | null> {
	if (context.messageHandler.processMessage === "STOP") return null;
	const choice = messageText(context).trim();
	if (!isAppCreateChoiceReply(choice)) return null;
	const id = roomId(context);
	const [appPending, viewsPending] = await Promise.all([
		hasRegisteredAction(context, APP_ACTION_NAME)
			? hasPendingIntent(context.runtime, id)
			: Promise.resolve(false),
		hasRegisteredAction(context, VIEWS_ACTION_NAME)
			? hasPendingViewsCreateIntent(context.runtime, id)
			: Promise.resolve(false),
	]);
	if (appPending === viewsPending) return null;
	return appPending ? APP_ACTION_NAME : VIEWS_ACTION_NAME;
}

export const createChoiceShortcutEvaluator: ResponseHandlerEvaluator = {
	name: "app-control.create-choice-shortcut",
	description:
		"Deterministically routes APP/VIEWS create [CHOICE] replies back through the pending create action.",
	priority: 12,
	shouldRun: async (context) =>
		(await resolvePendingChoiceAction(context)) !== null,
	evaluate: async (context) => {
		const actionName = await resolvePendingChoiceAction(context);
		if (!actionName) return undefined;
		const choice = messageText(context).trim().toLowerCase();
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
				params: { action: "create", choice },
			},
			debug: [
				`pending ${actionName} create choice "${choice}" routed deterministically`,
			],
		};
	},
};
