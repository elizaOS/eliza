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
 * (matchViewCommand → the same view) and navigates.
 *
 * Contextual / implicit intent ("fix the login bug" → task-coordinator) is NOT
 * handled here — that is the post-response `viewContextEvaluator` (small model).
 * The two are disjoint: this fires only on a rigid `matchViewCommand` hit.
 */
import type {
	ResponseHandlerEvaluator,
	ResponseHandlerEvaluatorContext,
} from "@elizaos/core";
import {
	resolveViewCommandShortcut,
	VIEWS_ACTION_NAME,
} from "./view-command-routing.js";

function shouldShortcut(
	context: ResponseHandlerEvaluatorContext,
): string | null {
	if (context.messageHandler.processMessage === "STOP") return null;
	// This shortcut is only for explicit navigation commands. Passive/domain
	// intent ("fix my app", "how much did I spend") belongs to the contextual
	// evaluator or planner so it cannot preempt coding/content actions.
	return resolveViewCommandShortcut(context);
}

export const viewCommandShortcutEvaluator: ResponseHandlerEvaluator = {
	name: "app-control.view-command-shortcut",
	description:
		"Deterministic multilingual fast-path: forces the VIEWS action when the message is an explicit view-navigation command, so view switching never depends on weak-model action selection.",
	// Run before core.simple_registered_action_request (20) so deterministic view
	// intents never get captured by a broader coding/domain action first.
	priority: 10,
	shouldRun: (context) => shouldShortcut(context) !== null,
	evaluate: (context) => {
		const viewId = shouldShortcut(context);
		if (!viewId) return undefined;
		return {
			requiresTool: true,
			clearCandidateActions: true,
			addCandidateActions: [VIEWS_ACTION_NAME],
			clearParentActionHints: true,
			addParentActionHints: [VIEWS_ACTION_NAME],
			deterministicToolCall: {
				name: VIEWS_ACTION_NAME,
				params: { action: "show", view: viewId },
			},
			debug: [
				`rigid view command → ${viewId}; forcing VIEWS action (deterministic, no model)`,
			],
		};
	},
};
