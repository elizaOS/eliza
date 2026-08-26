/**
 * Post-Stage-1 view-switch hook — deterministic execution for an exact,
 * standalone navigation command.
 *
 * Runs during response handling, BEFORE the action executes. If the user's
 * message is an explicit navigation command in ANY supported language
 * ("open settings", "go to my calendar", "abre ajustes", "설정 열어",
 * "打开设置"…), it resolves the target and executes the canonical VIEWS
 * action without a second planner round. Stage 1 normally names VIEWS first,
 * but an exact standalone command may safely promote VIEWS when a weak model
 * returns no action at all. Any other registered action keeps the turn
 * planner-owned so domain and compound requests are never erased.
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
	const viewId = resolveViewCommandShortcut(context);
	if (!viewId) return null;

	// A rigid whole-message match is enough when Stage 1 selected VIEWS or no
	// action. If Stage 1 selected another *registered* action, preserve that
	// semantic evidence and leave the turn to normal planning. This is what keeps
	// "open calendar and schedule a meeting" with CALENDAR while allowing a weak
	// model's actionless "go home" turn to reach the shell deterministically.
	const selectedCandidates = (
		context.messageHandler.plan.candidateActions ?? []
	).map((candidate) => candidate.trim().toUpperCase());

	// Unknown names may be weak-model category noise (for example CODING_TOOLS),
	// so they do not block an otherwise standalone command; the direct executor
	// installs only the registered VIEWS call.
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
	return viewId;
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
