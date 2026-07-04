/**
 * Pre-LLM view-command routing helper for explicit navigation utterances.
 */

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

function looksLikeXrVisionRequest(text: string): boolean {
	const normalized = text.toLowerCase().replace(/\s+/gu, " ").trim();
	if (!normalized.includes("xr")) return false;
	const hasVisionTarget = /\b(?:camera|vision)\b/iu.test(normalized);
	const asksForPerception =
		/\bvision\b/iu.test(normalized) ||
		/\bwhat\s+(?:do|can)\s+you\s+see\b/iu.test(normalized) ||
		/\b(?:see|look)\s+through\b/iu.test(normalized) ||
		/\bdescribe\b/iu.test(normalized);
	return hasVisionTarget && asksForPerception;
}

export function resolveViewCommandShortcut(
	context: ViewCommandRoutingContext,
): string | null {
	if (!hasRegisteredViewsAction(context)) return null;
	const text = messageText(context);
	if (
		hasRegisteredAction(context, "XR_QUERY_VISION") &&
		looksLikeXrVisionRequest(text)
	) {
		return null;
	}
	return matchViewCommand(text);
}
