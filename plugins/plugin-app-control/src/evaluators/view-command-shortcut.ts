/**
 * EARLY view-switch hook — the deterministic, zero-model "up front" step.
 *
 * Runs during response handling, BEFORE the action executes. If the user's
 * message is an explicit navigation command in ANY supported language
 * ("open settings", "go to my calendar", "abre ajustes", "설정 열어",
 * "打开设置"…), it FORCES the VIEWS action onto the plan. This guarantees the
 * view switches even when a weak local model would not have selected VIEWS on
 * its own — the rigid matcher decides, not the model.
 *
 * The VIEWS action then resolves the exact target deterministically
 * (resolveIntentView → matchViewCommand → the same view) and navigates.
 *
 * Contextual / implicit intent ("fix the login bug" → task-coordinator) is NOT
 * handled here — that is the post-response `viewContextEvaluator` (small model).
 * The two are disjoint: this fires only on a rigid `matchViewCommand` hit; the
 * contextual evaluator's gate defers whenever `resolveIntentView` (which now
 * wraps `matchViewCommand`) returns non-null.
 */
import type {
	ResponseHandlerEvaluator,
	ResponseHandlerEvaluatorContext,
} from "@elizaos/core";
import { resolveIntentView } from "../actions/views-show.js";

const VIEWS_ACTION_NAME = "VIEWS";

function messageText(context: ResponseHandlerEvaluatorContext): string {
	const text = context.message?.content?.text;
	return typeof text === "string" ? text : "";
}

function hasRegisteredViewsAction(
	context: ResponseHandlerEvaluatorContext,
): boolean {
	return (context.runtime.actions ?? []).some(
		(action) => action.name?.toUpperCase() === VIEWS_ACTION_NAME,
	);
}

function shouldShortcut(
	context: ResponseHandlerEvaluatorContext,
): string | null {
	if (context.messageHandler.processMessage === "STOP") return null;
	// Already committed to a tool — don't fight an existing plan.
	if (context.messageHandler.plan.requiresTool === true) return null;
	if (!hasRegisteredViewsAction(context)) return null;
	// resolveIntentView = the unified deterministic resolver: the rigid
	// multilingual matchViewCommand for explicit commands PLUS the legacy
	// passive-intent rules ("how much did i spend" → finances). Both are
	// deterministic and safe to force up-front; only truly contextual intent
	// with no keyword (handled by the post-response viewContextEvaluator)
	// returns null here.
	return resolveIntentView(messageText(context));
}

export const viewCommandShortcutEvaluator: ResponseHandlerEvaluator = {
	name: "app-control.view-command-shortcut",
	description:
		"Deterministic multilingual fast-path: forces the VIEWS action when the message is an explicit view-navigation command, so view switching never depends on weak-model action selection.",
	// Higher than view-followup-routing (20) so the explicit-command shortcut is
	// considered first.
	priority: 30,
	shouldRun: (context) => shouldShortcut(context) !== null,
	evaluate: (context) => {
		const viewId = shouldShortcut(context);
		if (!viewId) return undefined;
		return {
			requiresTool: true,
			addCandidateActions: [VIEWS_ACTION_NAME],
			addParentActionHints: [VIEWS_ACTION_NAME],
			debug: [
				`rigid view command → ${viewId}; forcing VIEWS action (deterministic, no model)`,
			],
		};
	},
};
