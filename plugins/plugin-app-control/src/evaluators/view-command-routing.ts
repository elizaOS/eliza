/**
 * Pre-LLM view-command routing helper for explicit navigation utterances.
 */

import { getUserMessageText, type Memory } from "@elizaos/core";
import { matchViewCommand } from "../actions/view-command-matcher.js";

export const VIEWS_ACTION_NAME = "VIEWS";

type ViewCommandRoutingContext = {
	runtime: { actions?: ReadonlyArray<{ name?: string }> };
	message?: Pick<Memory, "content">;
};

function messageText(context: ViewCommandRoutingContext): string {
	return context.message ? getUserMessageText(context.message) : "";
}

function hasRegisteredViewsAction(context: ViewCommandRoutingContext): boolean {
	return hasRegisteredAction(context, VIEWS_ACTION_NAME);
}

function hasRegisteredAction(
	context: ViewCommandRoutingContext,
	actionName: string,
): boolean {
	const normalizedActionName = actionName.toUpperCase();
	return (context.runtime.actions ?? []).some(
		(action) => action.name?.toUpperCase() === normalizedActionName,
	);
}

export function resolveViewCommandShortcut(
	context: ViewCommandRoutingContext,
): string | null {
	if (!hasRegisteredViewsAction(context)) return null;
	const text = messageText(context);
	return matchViewCommand(text);
}
