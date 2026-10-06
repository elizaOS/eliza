/**
 * Runs the registered response-handler evaluators over a Stage-1 message-handler
 * result, applying each evaluator's patch to the plan — contexts, candidate
 * actions, parent-action hints, deterministic tool call, reply — in priority
 * order and collecting a per-evaluator trace of what changed.
 */

import { ElizaError } from "../errors";
import type {
	MessageHandlerAction,
	MessageHandlerDeterministicToolCall,
	MessageHandlerResult,
} from "../types/components";
import type {
	AgentContext,
	ContextDefinition,
	RoleGateRole,
} from "../types/contexts";
import type { Memory } from "../types/memory";
import type { IAgentRuntime } from "../types/runtime";
import type { State } from "../types/state";
import type { ContextProviderEvent } from "./context-object";
import type { DirectActionRoutingRule } from "./direct-action-routing";

export interface ResponseHandlerPatch {
	processMessage?: MessageHandlerAction;
	requiresTool?: boolean;
	/** Mark a terminal refusal without granting a completed-effect claim. */
	replyEffectStatus?: "non_applied";
	setContexts?: readonly AgentContext[];
	/** Atomically replace derived intents and invalidate declared inferred-scope fields. */
	replaceIntentScope?: {
		intents: readonly string[];
		invalidateFields: readonly string[];
		/** Registered, admitted owner; retained only during this evaluator run. */
		owner?: DirectActionRoutingRule;
	};
	/** Complete canonical sources authored by trusted evaluators, outside model plans. */
	contextSources?: readonly ContextProviderEvent[];
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
	/** Runtime-only invalidations from earlier applied patches in this run.
	 * Never populated from model output, plan extensions, or stored history. */
	invalidatedScopeFields?: ReadonlySet<string>;
	wholeRequestOwner?: DirectActionRoutingRule;
	runtime: IAgentRuntime;
	message: Memory;
	state: State;
	messageHandler: MessageHandlerResult;
	availableContexts: readonly ContextDefinition[];
	userRoles?: readonly RoleGateRole[];
}

export interface ResponseHandlerEvaluator {
	name: string;
	description?: string;
	priority?: number;
	/** Exact action names this evaluator may select for deterministic execution. */
	deterministicActions?: readonly string[];
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
	contextSources?: ContextProviderEvent[];
	activeEvaluators: string[];
	appliedPatches: ResponseHandlerPatchTrace[];
	candidateActionsAddedByEvaluators: string[];
	candidateActionsClearedByEvaluators: boolean;
	errors: Array<{ evaluatorName: string; error: string }>;
}

type AppliedResponseHandlerPatch = {
	invalidatedScopeFields: readonly string[];
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

function assertDeterministicToolCallAllowed(
	evaluator: ResponseHandlerEvaluator,
	patch: ResponseHandlerPatch,
): void {
	const toolCall = normalizeDeterministicToolCall(patch.deterministicToolCall);
	if (!toolCall) return;

	const requested = toolCall.name.toLowerCase();
	const allowed = uniqueStrings(evaluator.deterministicActions).some(
		(actionName) => actionName.toLowerCase() === requested,
	);
	if (!allowed) {
		throw new ElizaError(
			`Response-handler evaluator "${evaluator.name}" is not allowed to select deterministic action "${toolCall.name}"`,
			{
				code: "RESPONSE_HANDLER_DETERMINISTIC_ACTION_DENIED",
				context: {
					evaluator: evaluator.name,
					requestedAction: toolCall.name,
				},
			},
		);
	}
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

// Core routing and source evidence have dedicated contracts; they are not
// inferred operation-scope extensions a plugin may invalidate by name.
const PROTECTED_SCOPE_FIELDS = new Set(
	[
		"contexts",
		"reply",
		"replyeffectstatus",
		"requirestool",
		"contextSlices",
		"completioncontext",
		"candidateactions",
		"intents",
		"parentactionhints",
		"requiredtoolmissbudget",
		"requiredtoolevidence",
		"deterministictoolcall",
		"simple",
		"metadata",
		"data",
		"state",
		"messages",
		"originalmessages",
		"originalrequest",
		"history",
		"receipts",
		"effectreceipts",
		"source",
		"sources",
		"sourcecontext",
		"sourcesetid",
		"sourceselection",
		"currentsourcerevisions",
		"invalidatedscopefields",
		"constructor",
		"prototype",
		"__proto__",
	].map((field) => field.toLowerCase()),
);

function applyResponseHandlerPatch(
	messageHandler: MessageHandlerResult,
	patch: ResponseHandlerPatch,
	availableContexts: readonly ContextDefinition[],
): AppliedResponseHandlerPatch | null {
	const scope = patch.replaceIntentScope;
	// Validate the whole replacement before applying any other patch field.
	// Extension fields cannot name core routing, context or source fields.
	if (
		scope &&
		(!Array.isArray(scope.intents) ||
			scope.intents.length === 0 ||
			scope.intents.some(
				(intent) => typeof intent !== "string" || !intent.trim(),
			) ||
			!Array.isArray(scope.invalidateFields) ||
			scope.invalidateFields.some(
				(field) =>
					typeof field !== "string" ||
					!/^[A-Za-z][A-Za-z0-9_]*$/u.test(field) ||
					PROTECTED_SCOPE_FIELDS.has(field.toLowerCase()),
			))
	) {
		throw new ElizaError("Invalid response-handler intent scope replacement", {
			code: "RESPONSE_HANDLER_INTENT_SCOPE_INVALID",
		});
	}
	const changed: string[] = [];
	const debug = uniqueStrings(patch.debug);
	const available = availableContextSet(availableContexts);
	let candidateActionsAdded: string[] | undefined;
	if (scope) {
		messageHandler.plan.intents = [...scope.intents];
		changed.push("intents:replace");
		for (const field of new Set(scope.invalidateFields)) {
			delete messageHandler.plan[field];
			// Record even staged fields stored by their owner outside the plan.
			changed.push(`intentField:invalidate:${field}`);
		}
		// Execution choices and relaxation budgets derived from the old intent
		// cannot survive replacement. Source context and prior receipts do.
		for (const field of [
			"deterministicToolCall",
			"requiredToolEvidence",
			"requiredToolMissBudget",
		] as const) {
			if (Object.hasOwn(messageHandler.plan, field)) {
				delete messageHandler.plan[field];
				changed.push(`${field}:clear`);
			}
		}
	}

	if (patch.processMessage) {
		messageHandler.processMessage = patch.processMessage;
		changed.push("processMessage");
	}
	if (typeof patch.requiresTool === "boolean") {
		messageHandler.plan.requiresTool = patch.requiresTool;
		changed.push("requiresTool");
	}
	if (patch.replyEffectStatus === "non_applied") {
		messageHandler.plan.replyEffectStatus = "non_applied";
		changed.push("replyEffectStatus:non_applied");
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
		invalidatedScopeFields: [...new Set(scope?.invalidateFields ?? [])],
	};
}

export async function runResponseHandlerEvaluators(args: {
	runtime: IAgentRuntime;
	message: Memory;
	state: State;
	messageHandler: MessageHandlerResult;
	availableContexts: readonly ContextDefinition[];
	userRoles?: readonly RoleGateRole[];
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
		candidateActionsClearedByEvaluators: false,
		errors: [],
	};
	if (candidates.length === 0) {
		return result;
	}

	const invalidatedScopeFields = new Set<string>();
	let wholeRequestOwner: DirectActionRoutingRule | undefined;
	for (const evaluator of candidates) {
		const context: ResponseHandlerEvaluatorContext = {
			invalidatedScopeFields,
			wholeRequestOwner,
			runtime: args.runtime,
			message: args.message,
			state: args.state,
			messageHandler: args.messageHandler,
			availableContexts: args.availableContexts,
			userRoles: args.userRoles,
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
			assertDeterministicToolCallAllowed(evaluator, patch);
			const applied = applyResponseHandlerPatch(
				args.messageHandler,
				patch,
				args.availableContexts,
			);
			if (applied) {
				if (patch.replaceIntentScope)
					wholeRequestOwner = patch.replaceIntentScope.owner;
				for (const field of applied.invalidatedScopeFields)
					invalidatedScopeFields.add(field);
				if (patch.clearCandidateActions === true) {
					result.candidateActionsClearedByEvaluators = true;
				}
				const { trace } = applied;
				trace.evaluatorName = evaluator.name;
				result.appliedPatches.push(trace);
				result.candidateActionsAddedByEvaluators = mergeUniqueStrings(
					result.candidateActionsAddedByEvaluators,
					applied.candidateActionsAdded,
				);
			}
			if (patch.contextSources?.length) {
				result.contextSources ??= [];
				result.contextSources.push(...patch.contextSources);
			}
		} catch (error) {
			// error-policy:J7 Evaluators are independent Stage-1 enrichers; collect and
			// report each failure while allowing the remaining evaluators to run.
			args.runtime.reportError("ResponseHandlerEvaluator.evaluate", error, {
				evaluator: evaluator.name,
			});
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
