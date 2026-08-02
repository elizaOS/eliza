/**
 * Pre-LLM view-command routing helper for explicit navigation utterances.
 */

import { SHARED_NAV_TARGETS } from "@elizaos/shared/views/shared-nav-targets";
import { matchViewCommand } from "../actions/view-command-matcher.js";

export const VIEWS_ACTION_NAME = "VIEWS";

type ViewCommandRoutingContext = {
	runtime: { actions?: ReadonlyArray<{ name?: string }> };
	message?: { content?: { text?: unknown } };
};

function messageText(context: ViewCommandRoutingContext): string {
	const text = context.message?.content?.text;
	return typeof text === "string" ? text : "";
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
	const matchedViewId = matchViewCommand(text);
	if (!matchedViewId) return null;
	return SHARED_NAV_TARGETS[matchedViewId]?.viewId ?? matchedViewId;
}
