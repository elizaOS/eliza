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
	return (context.runtime.actions ?? []).some(
		(action) => action.name?.toUpperCase() === VIEWS_ACTION_NAME,
	);
}

export function resolveViewCommandShortcut(
	context: ViewCommandRoutingContext,
): string | null {
	if (!hasRegisteredViewsAction(context)) return null;
	return matchViewCommand(messageText(context));
}
