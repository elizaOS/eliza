/** Maintains complete action-result and context-routing state shared by message and planner phases. */

import {
	formatTaskCompletionStatus,
	type TaskCompletionAssessment,
} from "../../features/advanced-capabilities/evaluators/task-completion";
import { renderActionResultsForModel } from "../../runtime/planner-rendering";
import type { ActionResult } from "../../types/components";
import type { Memory } from "../../types/memory";
import type { IAgentRuntime } from "../../types/runtime";
import type { State } from "../../types/state";
import {
	collectActionResultSizeWarnings,
	trimActionResultForPromptState,
} from "../../utils/action-results";
import {
	AVAILABLE_CONTEXTS_STATE_KEY,
	CONTEXT_ROUTING_STATE_KEY,
	type ContextRoutingDecision,
	getActiveRoutingContexts,
	inferContextRoutingFromMessage,
} from "../../utils/context-routing";

export function withActionResultsForPrompt(
	state: State,
	actionResults: ActionResult[],
	_runtime?: IAgentRuntime,
): State {
	const promptActionResults = renderActionResultsForModel(actionResults).text;
	return {
		...state,
		values: {
			...state.values,
			actionResults: promptActionResults,
		},
		data: {
			...state.data,
			actionResults,
		},
	};
}

export const _withActionResults = withActionResultsForPrompt;

export function _preparePromptActionResult<T extends ActionResult>(
	runtime: IAgentRuntime,
	message: Memory,
	result: T,
): T {
	for (const warning of collectActionResultSizeWarnings(result)) {
		runtime.logger.warn(
			{
				src: "service:message",
				agentId: runtime.agentId,
				messageId: message.id,
				roomId: message.roomId,
				action: warning.actionName,
				field: warning.field,
				rawCharLength: warning.rawCharLength,
				estimatedTokens: warning.estimatedTokens,
				thresholdTokens: warning.thresholdTokens,
			},
			"Action result exceeds prompt-size warning threshold",
		);
	}

	return trimActionResultForPromptState(result);
}

export function _withTaskCompletion(
	state: State,
	taskCompletion: TaskCompletionAssessment | null | undefined,
): State {
	if (!taskCompletion) {
		return state;
	}

	return {
		...state,
		values: {
			...state.values,
			taskCompletionStatus: formatTaskCompletionStatus(taskCompletion),
			taskCompleted: taskCompletion.completed,
			taskCompletionAssessed: taskCompletion.assessed,
			taskCompletionReason: taskCompletion.reason,
		},
		data: {
			...state.data,
			taskCompletion,
		},
	};
}

export type ContextRoutingStateValues = {
	[AVAILABLE_CONTEXTS_STATE_KEY]?: unknown;
	[CONTEXT_ROUTING_STATE_KEY]?: unknown;
};

export function withContextRoutingValues(
	state: State,
	contextRoutingStateValues?: ContextRoutingStateValues,
): State {
	if (!contextRoutingStateValues) {
		return state;
	}

	const mergedStateValues = {
		...state.values,
	};

	if (contextRoutingStateValues[AVAILABLE_CONTEXTS_STATE_KEY] !== undefined) {
		mergedStateValues[AVAILABLE_CONTEXTS_STATE_KEY] = contextRoutingStateValues[
			AVAILABLE_CONTEXTS_STATE_KEY
		] as State["values"][string];
	}

	if (contextRoutingStateValues[CONTEXT_ROUTING_STATE_KEY] !== undefined) {
		mergedStateValues[CONTEXT_ROUTING_STATE_KEY] = contextRoutingStateValues[
			CONTEXT_ROUTING_STATE_KEY
		] as State["values"][string];
	}

	return {
		...state,
		values: mergedStateValues,
	};
}

export function withInferredContextRoutingFallback(
	routing: ContextRoutingDecision,
	message: Memory,
): ContextRoutingDecision {
	if (getActiveRoutingContexts(routing).length > 0) {
		return routing;
	}
	const inferred = inferContextRoutingFromMessage(message);
	return inferred;
}

export async function _composeContinuationDecisionState(
	runtime: IAgentRuntime,
	message: Memory,
	contextRoutingStateValues?: ContextRoutingStateValues,
): Promise<State> {
	// Continuation prompts run after the runtime has already persisted an
	// assistant reply and/or action_result memories. Refresh RECENT_MESSAGES so
	// the follow-up planner does not reuse stale conversation history cached on
	// the original user turn.
	const state = await runtime.composeState(
		message,
		["RECENT_MESSAGES", "ACTIONS"],
		false,
		false,
	);
	return withContextRoutingValues(state, contextRoutingStateValues);
}
