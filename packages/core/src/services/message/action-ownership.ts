/** Determines action-owned replies and continuation policy from registered action metadata and explicit reply intent. */

import type { ActionResult } from "../../types/components";
import type { Content } from "../../types/primitives";
import type { IAgentRuntime } from "../../types/runtime";
import {
	buildRuntimeActionLookup,
	canonicalPlannerControlActionName,
	resolveRuntimeAction,
} from "./action-identifiers.js";
import { looksLikeActionExplanationRequest } from "./coding-request.js";
import { normalizeActionIdentifier } from "./direct-action-heuristics";

export const PROVIDER_FOLLOWUP_PASSIVE_ACTIONS = new Set(
	["REPLY", "RESPOND", "NONE"].map(normalizeActionIdentifier),
);

// Actions the planner selects as explicit delegation / orchestration intent.
// These cannot be evaluated by keyword-overlap against the user's message
// (e.g. "build me an app" does not contain "spawn" or "agent"), so the
// metadata-based corrector must not override them with a keyword-matched
// alternative like a cross-channel send action.
//
// WORKFLOW + its trigger schedule similes are included because the phrase
// structure the planner matches on ("every N minutes", "at 7am daily",
// "schedule a cron task") does not keyword-overlap with the action's
// description the way owner reminder/todo prose does.
// Without these entries, the metadata-overlap correction path routinely
// overrides a correct CREATE_CRON / WORKFLOW pick on
// page-automations with owner task actions based on fuzzy description overlap — breaking
// the scope-gated routing on the page-automations surface.
// CONTACT/ENTITY are explicit umbrella actions for contacts /
// rolodex / follow-up surface. The metadata-based corrector would otherwise
// override a correct contact follow-up pick with
// SCHEDULE_FOLLOW_UP based on keyword overlap ("follow up with X next week"),
// creating a task on the wrong surface. Treat CONTACT and ENTITY as explicit
// planner intent so the corrector does not second-guess them.
//
// START_CODING_TASK is the orchestrator's coding-sub-agent delegation. When a user
// says "build me X" or "implement Y", the planner correctly picks START_CODING_TASK,
// but the user's prose contains zero START_CODING_TASK keywords. Without this entry
// the corrector overrides START_CODING_TASK with whatever role-gated action
// (CALENDAR, MESSAGE, MANAGE_ISSUES) happens to overlap with
// incidental words in the prompt — e.g. a build request that mentions a date
// keyword-rescores CALENDAR over START_CODING_TASK and the user gets
// "Google Calendar is not connected" in response to a code request. Same
// precedent as SPAWN_AGENT, the sibling delegation action that's already
// protected here.
//
// Media and advertising actions are also explicit artifact-producing intent.
// Requests like "generate an image", "make an ad creative", or "publish the
// ad pack" can contain generic workflow/productivity words that fuzzy metadata
// scoring over-values for owner/life actions. If the planner already selected
// a concrete media/ad action, do not rewrite it to LIFE/CALENDAR/etc. based on
// incidental overlap.
export type ActionOwnershipSuggestion = {
	actionName: string;
	score: number;
	secondBestScore: number;
	reasons: string[];
};

export function hasNonPassiveAction(
	responseContent: Pick<Content, "actions"> | null | undefined,
): boolean {
	return (
		responseContent?.actions?.some(
			(actionName) =>
				typeof actionName === "string" &&
				!PROVIDER_FOLLOWUP_PASSIVE_ACTIONS.has(
					normalizeActionIdentifier(actionName),
				) &&
				normalizeActionIdentifier(actionName) !==
					normalizeActionIdentifier("IGNORE") &&
				normalizeActionIdentifier(actionName) !==
					normalizeActionIdentifier("STOP"),
		) ?? false
	);
}

/**
 * Returns true when the planner deliberately chose to converse — i.e. the
 * response actions list contains REPLY (or its alias RESPOND).
 *
 * REPLY is a deliberate signal that the LLM judged the message as
 * conversation, not a delegated task. The metadata-overlap rescue path
 * must respect this and not promote REPLY to a privileged action like
 * MESSAGE or MANAGE_ISSUES based on incidental keyword overlap with
 * those actions' example text. Without this gate, a chitchat message
 * containing common scheduling/workflow words ("workflow", "policy",
 * "follow up", "friday", "2026") gets force-routed into a role-gated
 * action and the user sees "Permission denied: only the owner or admin
 * may use inbox actions" in response to plain conversation.
 */
export function hasExplicitReplyIntent(
	responseContent: Pick<Content, "actions"> | null | undefined,
): boolean {
	const replyId = normalizeActionIdentifier("REPLY");
	const respondId = normalizeActionIdentifier("RESPOND");
	return (
		responseContent?.actions?.some((actionName) => {
			if (typeof actionName !== "string") return false;
			const id = normalizeActionIdentifier(actionName);
			return id === replyId || id === respondId;
		}) ?? false
	);
}

/**
 * Race-keep policy for a finished response that a newer same-room message
 * superseded mid-generation. Returns the human-readable keep reason, or null
 * when the response should be discarded. Kept only when the planner
 * deliberately chose to converse (explicit REPLY/RESPOND): every deliverable
 * response constructor in this pipeline sets `actions:["REPLY"]`, so this is
 * the complete keep set — a discard is always a non-deliverable shape, and it
 * ends the run with the observable "replaced" terminal instead of vanishing.
 */
export function resolveSupersededResponseKeepReason(
	responseContent: Pick<Content, "actions"> | null | undefined,
): string | null {
	if (hasExplicitReplyIntent(responseContent)) {
		return "explicit REPLY for an addressed message";
	}
	return null;
}

/**
 * Gate for the metadata-rescue path that promotes a passive (REPLY/NONE)
 * response to a privileged action based on keyword overlap. Run only when
 * the planner produced no real action AND no explicit REPLY — i.e. when
 * we genuinely have nothing to say.
 */
export function shouldRunMetadataActionRescue(
	responseContent: Pick<Content, "actions"> | null | undefined,
): boolean {
	if (hasNonPassiveAction(responseContent)) return false;
	if (hasExplicitReplyIntent(responseContent)) return false;
	return true;
}

export function shouldPromoteExplicitReplyToOwnedAction(
	responseContent: Pick<Content, "actions"> | null | undefined,
	suggestion: ActionOwnershipSuggestion | null,
	messageText = "",
): boolean {
	if (!suggestion || !hasExplicitReplyIntent(responseContent)) {
		return false;
	}
	if (looksLikeActionExplanationRequest(messageText)) {
		return false;
	}
	return (
		suggestion.reasons.includes("direct:local-shell-check") ||
		suggestion.reasons.includes("direct:web-search")
	);
}

export const TERMINAL_ACTION_IDENTIFIERS = new Set(
	[
		"REPLY",
		"IGNORE",
		"STOP",
		"CREATE_TASK",
		"START_CODING_TASK",
		"CODE_TASK",
		"SPAWN_AGENT",
		"SPAWN_CODING_AGENT",
	].map(normalizeActionIdentifier),
);

export type ActionContinuationDecision = {
	shouldContinue: boolean;
	suppressed: boolean;
	continuingActions: string[];
	suppressingActions: string[];
};

export function getActionContinuationDecision(
	runtime: Pick<IAgentRuntime, "actions">,
	responseContent: Content | null | undefined,
): ActionContinuationDecision {
	const actionLookup = buildRuntimeActionLookup(runtime);
	const continuingActions: string[] = [];
	const suppressingActions: string[] = [];

	for (const action of responseContent?.actions ?? []) {
		if (typeof action !== "string") continue;

		const resolvedAction = resolveRuntimeAction(actionLookup, action);
		if (resolvedAction?.suppressPostActionContinuation) {
			suppressingActions.push(resolvedAction.name);
			continue;
		}

		const canonicalAction =
			resolvedAction?.name ??
			canonicalPlannerControlActionName(action) ??
			action;
		if (
			!TERMINAL_ACTION_IDENTIFIERS.has(
				normalizeActionIdentifier(canonicalAction),
			)
		) {
			continuingActions.push(canonicalAction);
		}
	}

	const suppressed = suppressingActions.length > 0;
	return {
		shouldContinue: !suppressed && continuingActions.length > 0,
		suppressed,
		continuingActions,
		suppressingActions,
	};
}

export function actionResultsSuppressPostActionContinuation(
	actionResults: readonly ActionResult[],
): boolean {
	return actionResults.some((result) => {
		const data =
			result?.data &&
			typeof result.data === "object" &&
			!Array.isArray(result.data)
				? (result.data as Record<string, unknown>)
				: null;
		if (!data) {
			return false;
		}

		if (data.suppressPostActionContinuation === true) {
			return true;
		}

		const terminal = data.terminal;
		return (
			terminal !== null &&
			typeof terminal === "object" &&
			!Array.isArray(terminal) &&
			(terminal as Record<string, unknown>).permissionDenied === true
		);
	});
}

/**
 * True when the planner's `text` field should be surfaced to the user as a
 * preamble before action handlers run in actions-mode dispatch. The goal:
 * the user sees "checking your inbox" rather than silence while INBOX/GMAIL
 * do their work.
 *
 * Skipped when the first action is REPLY (the REPLY handler generates its own
 * text), IGNORE (no user-visible response), or STOP (terminal). Also skipped
 * when `text` is empty.
 */
export function shouldEmitPlannerPreamble(
	runtime: IAgentRuntime,
	responseContent: Pick<Content, "text" | "actions"> | null | undefined,
): boolean {
	if (!responseContent) return false;
	const text =
		typeof responseContent.text === "string" ? responseContent.text.trim() : "";
	if (text.length === 0) return false;

	const firstAction =
		typeof responseContent.actions?.[0] === "string"
			? responseContent.actions[0]
			: "";
	if (firstAction.length === 0) return false;

	const actionLookup = buildRuntimeActionLookup(runtime);
	const resolvedAction = resolveRuntimeAction(actionLookup, firstAction);
	if (resolvedAction?.suppressPostActionContinuation) {
		return false;
	}

	const canonicalFirstAction =
		resolvedAction?.name ??
		canonicalPlannerControlActionName(firstAction) ??
		firstAction;
	const normalizedFirstAction = normalizeActionIdentifier(canonicalFirstAction);

	return (
		normalizedFirstAction !== normalizeActionIdentifier("REPLY") &&
		normalizedFirstAction !== normalizeActionIdentifier("IGNORE") &&
		normalizedFirstAction !== normalizeActionIdentifier("STOP")
	);
}

// Actions that are passive bookkeeping / chitchat. Safe to drop when a
// turn-owning action (one that sets suppressPostActionContinuation = true,
// e.g. SPAWN_AGENT) is also picked for the same turn. Keeping them around
// alongside explicit delegation produces duplicate user-visible noise:
// "Created task X" message followed by the actual delegated result.
export const PASSIVE_TURN_ACTIONS = new Set(
	["REPLY", "RESPOND", "TASK"].map(normalizeActionIdentifier),
);

export function stripReplyWhenActionOwnsTurn(
	runtime: Pick<IAgentRuntime, "actions" | "logger">,
	actions: readonly string[] | null | undefined,
): string[] {
	if (!actions || actions.length === 0) {
		return [];
	}
	if (actions.length <= 1) {
		return [...actions];
	}

	const actionLookup = buildRuntimeActionLookup(runtime);
	const dedupedActions: string[] = [];
	const seenActionNames = new Set<string>();
	for (const action of actions) {
		const canonicalName =
			resolveRuntimeAction(actionLookup, action)?.name ??
			canonicalPlannerControlActionName(action) ??
			action;
		const normalizedName = normalizeActionIdentifier(canonicalName);
		if (normalizedName && seenActionNames.has(normalizedName)) {
			continue;
		}
		if (normalizedName) {
			seenActionNames.add(normalizedName);
		}
		dedupedActions.push(action);
	}

	if (dedupedActions.length !== actions.length) {
		runtime.logger.info(
			{
				src: "service:message",
				originalActions: actions,
				filteredActions: dedupedActions,
			},
			"Dropped duplicate planner actions before execution",
		);
	}

	if (dedupedActions.length <= 1) {
		return dedupedActions;
	}

	const hasPassive = dedupedActions.some((action) =>
		PASSIVE_TURN_ACTIONS.has(normalizeActionIdentifier(action)),
	);
	if (!hasPassive) {
		return dedupedActions;
	}

	const ownedActions = dedupedActions.filter((action) => {
		const normalized = normalizeActionIdentifier(action);
		if (!normalized || PASSIVE_TURN_ACTIONS.has(normalized)) {
			return false;
		}
		return (
			resolveRuntimeAction(actionLookup, action)
				?.suppressPostActionContinuation === true
		);
	});
	if (ownedActions.length === 0) {
		return dedupedActions;
	}

	const filtered = dedupedActions.filter(
		(action) => !PASSIVE_TURN_ACTIONS.has(normalizeActionIdentifier(action)),
	);
	runtime.logger.info(
		{
			src: "service:message",
			originalActions: dedupedActions,
			filteredActions: filtered,
			suppressedBy: ownedActions,
		},
		"Dropped passive actions because another selected action already owns the turn",
	);
	return filtered.length > 0 ? filtered : ["REPLY"];
}
