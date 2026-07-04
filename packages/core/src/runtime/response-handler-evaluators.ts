/**
 * Runs the registered response-handler evaluators over a Stage-1 message-handler
 * result, applying each evaluator's patch to the plan — contexts, candidate
 * actions, parent-action hints, deterministic tool call, reply — in priority
 * order and collecting a per-evaluator trace of what changed.
 */
import type {
	MessageHandlerAction,
	MessageHandlerDeterministicToolCall,
	MessageHandlerResult,
} from "../types/components";
import type { AgentContext, ContextDefinition } from "../types/contexts";
import type { Memory } from "../types/memory";
import type { IAgentRuntime } from "../types/runtime";
import type { State } from "../types/state";

export interface ResponseHandlerPatch {
	processMessage?: MessageHandlerAction;
	requiresTool?: boolean;
	setContexts?: readonly AgentContext[];
	addContexts?: readonly AgentContext[];
	addCandidateActions?: readonly string[];
	addParentActionHints?: readonly string[];
	addContextSlices?: readonly string[];
	clearCandidateActions?: boolean;
	clearParentActionHints?: boolean;
	deterministicToolCall?: MessageHandlerDeterministicToolCall;
	clearReply?: boolean;
	reply?: string;
	debug?: readonly string[];
}

type ResponseHandlerEvaluatorResult = ResponseHandlerPatch | undefined;

export interface ResponseHandlerEvaluatorContext {
	runtime: IAgentRuntime;
	message: Memory;
	state: State;
	messageHandler: MessageHandlerResult;
	availableContexts: readonly ContextDefinition[];
}

export interface ResponseHandlerEvaluator {
	name: string;
	description?: string;
	priority?: number;
	shouldRun(
		context: ResponseHandlerEvaluatorContext,
	): boolean | Promise<boolean>;
	evaluate(
		context: ResponseHandlerEvaluatorContext,
	): ResponseHandlerEvaluatorResult | Promise<ResponseHandlerEvaluatorResult>;
}

export interface ResponseHandlerPatchTrace {
	evaluatorName: string;
	debug: string[];
	changed: string[];
}

export interface ResponseHandlerEvaluationRunResult {
	activeEvaluators: string[];
	appliedPatches: ResponseHandlerPatchTrace[];
	candidateActionsAddedByEvaluators: string[];
	errors: Array<{ evaluatorName: string; error: string }>;
}

type AppliedResponseHandlerPatch = {
	trace: ResponseHandlerPatchTrace;
	candidateActionsAdded: string[];
};

function uniqueStrings(values: readonly string[] | undefined): string[] {
	if (!Array.isArray(values) || values.length === 0) {
		return [];
	}
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		const normalized = String(value ?? "").trim();
		if (!normalized) continue;
		const key = normalized.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(normalized);
	}
	return result;
}

function mergeUniqueStrings(
	current: readonly string[] | undefined,
	additions: readonly string[] | undefined,
): string[] {
	return uniqueStrings([...(current ?? []), ...(additions ?? [])]);
}

function normalizeDeterministicToolCall(
	toolCall: MessageHandlerDeterministicToolCall | undefined,
): MessageHandlerDeterministicToolCall | null {
	const name = String(toolCall?.name ?? "").trim();
	if (!name) {
		return null;
	}
	const params =
		toolCall?.params &&
		typeof toolCall.params === "object" &&
		!Array.isArray(toolCall.params)
			? { ...toolCall.params }
			: undefined;
	return params ? { name, params } : { name };
}

function availableContextSet(
	availableContexts: readonly ContextDefinition[],
): Set<string> | null {
	if (availableContexts.length === 0) {
		return null;
	}
	return new Set(availableContexts.map((definition) => String(definition.id)));
}

function filterAvailableContexts(
	contexts: readonly AgentContext[] | undefined,
	available: Set<string> | null,
): AgentContext[] {
	if (!contexts || contexts.length === 0) {
		return [];
	}
	const seen = new Set<string>();
	const result: AgentContext[] = [];
	for (const context of contexts) {
		const id = String(context).trim();
		if (!id || seen.has(id)) continue;
		if (available && !available.has(id)) continue;
		seen.add(id);
		result.push(id as AgentContext);
	}
	return result;
}

function applyResponseHandlerPatch(
	messageHandler: MessageHandlerResult,
	patch: ResponseHandlerPatch,
	availableContexts: readonly ContextDefinition[],
): AppliedResponseHandlerPatch | null {
	const changed: string[] = [];
	const debug = uniqueStrings(patch.debug);
	const available = availableContextSet(availableContexts);
	let candidateActionsAdded: string[] | undefined;

	if (patch.processMessage) {
		messageHandler.processMessage = patch.processMessage;
		changed.push("processMessage");
	}
	if (typeof patch.requiresTool === "boolean") {
		messageHandler.plan.requiresTool = patch.requiresTool;
		changed.push("requiresTool");
	}
	if (patch.setContexts) {
		messageHandler.plan.contexts = filterAvailableContexts(
			patch.setContexts,
			available,
		);
		changed.push("contexts:set");
	}
	if (patch.addContexts) {
		messageHandler.plan.contexts = filterAvailableContexts(
			[...messageHandler.plan.contexts, ...patch.addContexts],
			available,
		);
		changed.push("contexts:add");
	}
	if (patch.clearCandidateActions) {
		delete messageHandler.plan.candidateActions;
		changed.push("candidateActions:clear");
	}
	if (patch.addCandidateActions) {
		candidateActionsAdded = uniqueStrings(patch.addCandidateActions);
		messageHandler.plan.candidateActions = mergeUniqueStrings(
			messageHandler.plan.candidateActions,
			patch.addCandidateActions,
		);
		changed.push("candidateActions:add");
	}
	if (patch.clearParentActionHints) {
		delete messageHandler.plan.parentActionHints;
		changed.push("parentActionHints:clear");
	}
	if (patch.addParentActionHints) {
		messageHandler.plan.parentActionHints = mergeUniqueStrings(
			messageHandler.plan.parentActionHints,
			patch.addParentActionHints,
		);
		changed.push("parentActionHints:add");
	}
	if (patch.addContextSlices) {
		messageHandler.plan.contextSlices = mergeUniqueStrings(
			messageHandler.plan.contextSlices,
			patch.addContextSlices,
		);
		changed.push("contextSlices:add");
	}
	const deterministicToolCall = normalizeDeterministicToolCall(
		patch.deterministicToolCall,
	);
	if (deterministicToolCall) {
		messageHandler.plan.deterministicToolCall = deterministicToolCall;
		changed.push("deterministicToolCall:set");
	}
	if (patch.clearReply) {
		delete messageHandler.plan.reply;
		changed.push("reply:clear");
	}
	if (typeof patch.reply === "string") {
		messageHandler.plan.reply = patch.reply;
		changed.push("reply:set");
	}
	if (changed.length === 0 && debug.length === 0) {
		return null;
	}
	return {
		trace: {
			evaluatorName: "",
			debug,
			changed,
		},
		candidateActionsAdded: candidateActionsAdded ?? [],
	};
}

export async function runResponseHandlerEvaluators(args: {
	runtime: IAgentRuntime;
	message: Memory;
	state: State;
	messageHandler: MessageHandlerResult;
	availableContexts: readonly ContextDefinition[];
	evaluators?: readonly ResponseHandlerEvaluator[];
}): Promise<ResponseHandlerEvaluationRunResult> {
	const registered = Array.isArray(args.runtime.responseHandlerEvaluators)
		? (args.runtime
				.responseHandlerEvaluators as readonly ResponseHandlerEvaluator[])
		: [];
	const candidates = [...(args.evaluators ?? []), ...registered].sort(
		(a, b) =>
			(a.priority ?? 100) - (b.priority ?? 100) || a.name.localeCompare(b.name),
	);
	const result: ResponseHandlerEvaluationRunResult = {
		activeEvaluators: [],
		appliedPatches: [],
		candidateActionsAddedByEvaluators: [],
		errors: [],
	};
	if (candidates.length === 0) {
		return result;
	}

	for (const evaluator of candidates) {
		const context: ResponseHandlerEvaluatorContext = {
			runtime: args.runtime,
			message: args.message,
			state: args.state,
			messageHandler: args.messageHandler,
			availableContexts: args.availableContexts,
		};
		try {
			const shouldRun = await evaluator.shouldRun(context);
			if (!shouldRun) {
				continue;
			}
			result.activeEvaluators.push(evaluator.name);
			const patch = await evaluator.evaluate(context);
			if (!patch) {
				continue;
			}
			const applied = applyResponseHandlerPatch(
				args.messageHandler,
				patch,
				args.availableContexts,
			);
			if (applied) {
				const { trace } = applied;
				trace.evaluatorName = evaluator.name;
				result.appliedPatches.push(trace);
				result.candidateActionsAddedByEvaluators = mergeUniqueStrings(
					result.candidateActionsAddedByEvaluators,
					applied.candidateActionsAdded,
				);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			result.errors.push({ evaluatorName: evaluator.name, error: message });
			args.runtime.logger.warn(
				{
					src: "response-handler-evaluator",
					evaluator: evaluator.name,
					err: message,
				},
				"Response-handler evaluator failed",
			);
		}
	}
	return result;
}
