/**
 * Post-Stage-1 view-switch hook — deterministic execution after the model has
 * selected the VIEWS action.
 *
 * Runs during response handling, BEFORE the action executes. If the user's
 * message is an explicit navigation command in ANY supported language
 * ("open settings", "go to my calendar", "abre ajustes", "설정 열어",
 * "打开设置"…), it resolves the target and executes the already-selected VIEWS
 * action without a second planner round. The model still owns action selection;
 * the rigid matcher only supplies parameters after Stage 1 has named VIEWS.
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
	// Model-owned invariant: an exact phrase alone is insufficient. Stage 1 must
	// already have selected the canonical VIEWS action before this evaluator can
	// turn that selection into a deterministic call. Passive/domain intent and a
	// model-selected adjacent action therefore remain planner-owned.
	const selectedCandidates = (
		context.messageHandler.plan.candidateActions ?? []
	).map((candidate) => candidate.trim().toUpperCase());
	const selectedViews = selectedCandidates.includes(VIEWS_ACTION_NAME);
	if (!selectedViews) return null;

	// A second *registered* action is semantic evidence of a compound/domain
	// request. Never erase it. Unknown names may be weak-model category noise
	// (for example CODING_TOOLS), so they do not block an otherwise standalone
	// command; the direct executor still installs only the registered VIEWS call.
	const registeredActions = new Set(
		(context.runtime.actions ?? [])
			.map((action) => action.name?.trim().toUpperCase())
			.filter((name): name is string => Boolean(name)),
	);
	const hasOtherRegisteredAction = selectedCandidates.some(
		(candidate) =>
			candidate !== VIEWS_ACTION_NAME && registeredActions.has(candidate),
	);
	if (hasOtherRegisteredAction) return null;
	return resolveViewCommandShortcut(context);
}

export const viewCommandShortcutEvaluator: ResponseHandlerEvaluator = {
	name: "app-control.view-command-shortcut",
	description:
		"Executes a model-selected VIEWS action directly when the message is an exact multilingual view-navigation command, avoiding a redundant planner round.",
	// Run before core.simple_registered_action_request (20) so deterministic view
	// intents never get captured by a broader coding/domain action first.
	priority: 10,
	deterministicActions: [VIEWS_ACTION_NAME],
	shouldRun: (context) => shouldShortcut(context) !== null,
	evaluate: (context) => {
		const viewId = shouldShortcut(context);
		if (!viewId) return undefined;
		return {
			requiresTool: true,
			// Navigation must succeed or fail before anything claims completion.
			// The VIEWS callback below the planner owns that one visible response.
			clearReply: true,
			clearCandidateActions: true,
			addCandidateActions: [VIEWS_ACTION_NAME],
			clearParentActionHints: true,
			addParentActionHints: [VIEWS_ACTION_NAME],
			deterministicToolCall: {
				name: VIEWS_ACTION_NAME,
				params: { action: "show", view: viewId },
			},
			debug: [
				`model-selected rigid view command → ${viewId}; executing VIEWS without a second planner round`,
			],
		};
	},
};
