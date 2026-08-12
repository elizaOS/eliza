/**
 * Chronological planner history and its fail-closed model projection. Semantic
 * consumers read archived and live steps together, while model stages receive
 * only the original conversational context plus machine-owned tool authority.
 */
import { isSensitiveKeyName, redactObjectSecrets } from "../security/redact";
import type {
	ContextEvent,
	ContextInstructionEvent,
	ContextMessageEvent,
	ContextProviderEvent,
	ContextSegmentEvent,
} from "../types/context-object";
import {
	type EffectReceipt,
	hasAppliedUserFacingEffectProof,
	mergeEffectReceipts,
} from "../types/effects";
import { isPlainObject } from "../utils/type-guards";
import { appendContextEvent } from "./context-object";
import type {
	ContextObject,
	PlannerStep,
	PlannerTrajectory,
} from "./planner-types";

/** Complete semantic history, independent of the bounded live render window. */
export function allSteps(trajectory: PlannerTrajectory): PlannerStep[] {
	return [...trajectory.archivedSteps, ...trajectory.steps];
}

/** All normalized receipts in chronological semantic history. */
export function allEffectReceipts(
	trajectory: PlannerTrajectory,
): readonly EffectReceipt[] {
	return mergeEffectReceipts(
		...allSteps(trajectory).map((step) => step.result?.effectReceipts),
	);
}

/**
 * Capture the immutable model-input event set exactly once. A nested planner
 * may inherit a context containing later runtime events, so the context-level
 * marker is authoritative and prevents those untrusted additions from being
 * reclassified as original input.
 */
export function captureOriginalContextEvents(
	context: ContextObject,
): ContextObject {
	const normalized = Array.isArray(context.events)
		? context
		: { ...context, events: [] };
	if (normalized.provenance?.originalEventsCaptured === true) {
		return normalized;
	}
	return {
		...normalized,
		provenance: { originalEventsCaptured: true },
		events: normalized.events.map((event) => ({
			...event,
			provenance: event.provenance ?? "original",
		})),
	};
}

/**
 * Exact action-owned text eligible for model projection and final delivery.
 * A successful result is eligible only when it explicitly declares itself
 * no-effect or binds its text to active committed receipts from the complete
 * turn. The optional terminal-failure category is limited to an action's
 * verified, turn-complete failure guidance and never licenses that text as a
 * successful completion.
 */
export function canonicalUserFacingText(
	result: PlannerStep["result"],
	options: {
		allTurnReceipts?: readonly EffectReceipt[];
		includeTerminalFailure?: boolean;
	} = {},
): string | undefined {
	if (result?.verifiedUserFacing !== true) {
		return undefined;
	}
	const text = result.userFacingText?.trim();
	if (!text) return undefined;
	if (result.success !== true) {
		return options.includeTerminalFailure === true &&
			result.success === false &&
			result.turnComplete === true
			? text
			: undefined;
	}
	if (result.userFacingEffect === "none") return text;
	return options.allTurnReceipts !== undefined &&
		hasAppliedUserFacingEffectProof(result, options.allTurnReceipts)
		? text
		: undefined;
}

/**
 * Defense-in-depth for the immutable events admitted by the provenance gate.
 * Credential-shaped object fields are omitted, and inline assignments or auth
 * headers are removed as whole forms so even their labels cannot become model
 * instructions. The ordinary security redactor still handles bare token shapes.
 */
function projectModelSafeValue<T>(value: T): T {
	if (typeof value === "string") {
		const withoutCredentialForms = value
			.replace(
				/\bAuthorization\s*[:=]\s*(?:Bearer|Basic)\s+[^\s,;]+/giu,
				"[credential omitted]",
			)
			.replace(
				/\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|MNEMONIC|SEED|CREDENTIAL)\b\s*[=:]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/giu,
				"[credential omitted]",
			)
			.replace(
				/\b(?:Bearer|Basic)\s+[A-Za-z0-9._+/=-]{8,}/giu,
				"[credential omitted]",
			);
		return redactObjectSecrets(withoutCredentialForms, {}) as T;
	}
	if (Array.isArray(value)) {
		return value.map((entry) => projectModelSafeValue(entry)) as T;
	}
	if (value !== null && typeof value === "object") {
		const projected = Object.fromEntries(
			Object.entries(value).flatMap(([key, entry]) =>
				isSensitiveKeyName(key)
					? []
					: [[key, projectModelSafeValue(entry)] as const],
			),
		);
		return projected as T;
	}
	return value;
}

/**
 * Model-visible authority for completed and queued work. Raw reasoning,
 * invocation identities and parameters, diagnostic result fields, terminal
 * candidates, evaluator output, and compaction state remain process-local.
 */
export function projectModelVisibleTrajectory(
	trajectory: PlannerTrajectory,
	context: ContextObject = trajectory.context,
): PlannerTrajectory {
	let projectedContext = modelVisibleBaseContext(
		captureOriginalContextEvents(context),
	);
	const receipts = allEffectReceipts(trajectory);
	const authority = [
		...allSteps(trajectory).flatMap((step) => {
			if (!step.toolCall || !step.result) return [];
			const userFacingText = canonicalUserFacingText(step.result, {
				allTurnReceipts: receipts,
			});
			return [
				[
					`tool_name: ${JSON.stringify(step.toolCall.name)}`,
					`machine_status: ${step.result.success === true ? "success" : "failed"}`,
					userFacingText
						? `canonical_user_facing_text: ${JSON.stringify(userFacingText)}`
						: "canonical_user_facing_text: unavailable",
				].join("\n"),
			];
		}),
		...trajectory.plannedQueue.map((toolCall) =>
			[
				`tool_name: ${JSON.stringify(toolCall.name)}`,
				"machine_status: queued",
				"canonical_user_facing_text: unavailable",
			].join("\n"),
		),
	];
	if (authority.length > 0) {
		projectedContext = appendContextEvent(projectedContext, {
			id: "model-visible-tool-authority",
			type: "segment",
			source: "planner-loop",
			provenance: "runtime",
			segment: {
				id: "model-visible-tool-authority",
				label: "tool_authority",
				content: authority.join("\n\n"),
				stable: false,
			},
		});
	}
	return {
		context: projectedContext,
		steps: [],
		archivedSteps: [],
		plannedQueue: [],
		evaluatorOutputs: [],
	};
}

/**
 * Evaluator boundary view of the complete trajectory. Archived steps remain
 * chronologically visible as machine status, while reasoning, invocation
 * identity/parameters, diagnostics, effect identifiers, terminal prose, and
 * evaluator output never cross the boundary. Canonical text is proven against
 * the unprojected all-turn receipt set before it enters this view.
 */
export function projectEvaluatorVisibleTrajectory(
	trajectory: PlannerTrajectory,
	terminalIteration?: number,
): PlannerTrajectory {
	const receipts = allEffectReceipts(trajectory);
	const steps = allSteps(trajectory).flatMap((step): PlannerStep[] => {
		if (step.terminalOnly === true) {
			return [{ iteration: step.iteration, terminalOnly: true }];
		}
		if (!step.toolCall || !step.result) return [];
		const userFacingText = canonicalUserFacingText(step.result, {
			allTurnReceipts: receipts,
		});
		return [
			{
				iteration: step.iteration,
				toolCall: { name: step.toolCall.name },
				result: {
					success: step.result.success,
					...(userFacingText
						? {
								userFacingText,
								verifiedUserFacing: true,
								userFacingEffect: "none" as const,
							}
						: {}),
					...(step.result.turnComplete !== undefined
						? { turnComplete: step.result.turnComplete }
						: {}),
					...(step.result.continueChain !== undefined
						? { continueChain: step.result.continueChain }
						: {}),
					...(step.result.silentTerminalAction
						? { silentTerminalAction: step.result.silentTerminalAction }
						: {}),
				},
			},
		];
	});
	if (terminalIteration !== undefined) {
		steps.push({ iteration: terminalIteration, terminalOnly: true });
	}
	return {
		context: modelVisibleBaseContext(
			captureOriginalContextEvents(trajectory.context),
		),
		steps,
		archivedSteps: [],
		plannedQueue: trajectory.plannedQueue.map((call) => ({ name: call.name })),
		evaluatorOutputs: [],
	};
}

function modelVisibleBaseContext(context: ContextObject): ContextObject {
	const original: ContextObject = Array.isArray(context.events)
		? context
		: { ...context, events: [] };
	const events = original.events.flatMap((event): ContextEvent[] => {
		if (event.provenance !== "original") return [];
		if (isModelVisibleMessageEvent(event)) {
			return [
				{
					id: event.id,
					type: "message",
					source: event.source,
					createdAt: event.createdAt,
					provenance: "original",
					message: {
						id: event.message.id,
						role: event.message.role,
						content: projectModelSafeValue(event.message.content),
						name: event.message.name,
					},
				},
			];
		}
		if (isModelVisibleProviderEvent(event)) {
			return [
				{
					id: event.id,
					type: "provider",
					source: event.source,
					createdAt: event.createdAt,
					provenance: "original",
					name: event.name,
					text:
						typeof event.text === "string"
							? projectModelSafeValue(event.text)
							: event.text,
					cacheStable: event.cacheStable,
				},
			];
		}
		if (isModelVisibleInstructionEvent(event)) {
			return [
				{
					id: event.id,
					type: "instruction",
					source: event.source,
					createdAt: event.createdAt,
					provenance: "original",
					content: projectModelSafeValue(event.content),
					role: event.role,
					stable: event.stable,
				},
			];
		}
		if (isModelVisibleConversationalSegmentEvent(event)) {
			return [
				{
					id: event.id,
					type: "segment",
					source: event.source,
					createdAt: event.createdAt,
					provenance: "original",
					modelInputKind: "conversation",
					segment: {
						id: event.segment.id,
						label: event.segment.label,
						content: projectModelSafeValue(event.segment.content),
						stable: event.segment.stable,
					},
				},
			];
		}
		if (isModelVisibleReplyReferenceEvent(event)) {
			return [
				{
					id: event.id,
					type: "segment",
					source: event.source,
					createdAt: event.createdAt,
					provenance: "original",
					modelInputKind: "reply_reference",
					segment: {
						id: event.segment.id,
						label: "reply_reference",
						content: projectModelSafeValue(event.segment.content),
						stable: event.segment.stable,
					},
				},
			];
		}
		return [];
	});
	return {
		id: original.id,
		version: original.version,
		createdAt: original.createdAt,
		provenance: { originalEventsCaptured: true },
		staticPrefix: original.staticPrefix
			? {
					systemPrompt: projectModelSafeValue(
						original.staticPrefix.systemPrompt,
					),
					characterPrompt: projectModelSafeValue(
						original.staticPrefix.characterPrompt,
					),
					staticProviders: projectModelSafeValue(
						original.staticPrefix.staticProviders,
					),
				}
			: undefined,
		trajectoryPrefix: original.trajectoryPrefix
			? {
					selectedContexts: projectModelSafeValue(
						original.trajectoryPrefix.selectedContexts,
					),
					contextDefinitions: projectModelSafeValue(
						original.trajectoryPrefix.contextDefinitions,
					),
					contextProviders: projectModelSafeValue(
						original.trajectoryPrefix.contextProviders,
					),
				}
			: undefined,
		events,
	};
}

function isModelVisibleMessageEvent(
	event: ContextEvent,
): event is ContextMessageEvent {
	return (
		event.type === "message" &&
		"message" in event &&
		isPlainObject(event.message) &&
		typeof event.message.role === "string" &&
		"content" in event.message
	);
}

function isModelVisibleProviderEvent(
	event: ContextEvent,
): event is ContextProviderEvent {
	return event.type === "provider" && "name" in event;
}

function isModelVisibleInstructionEvent(
	event: ContextEvent,
): event is ContextInstructionEvent {
	return event.type === "instruction" && "content" in event;
}

function isModelVisibleReplyReferenceEvent(
	event: ContextEvent,
): event is ContextSegmentEvent {
	return (
		event.type === "segment" &&
		"segment" in event &&
		isPlainObject(event.segment) &&
		event.modelInputKind === "reply_reference" &&
		typeof event.segment.content === "string"
	);
}

function isModelVisibleConversationalSegmentEvent(
	event: ContextEvent,
): event is ContextSegmentEvent {
	return (
		event.type === "segment" &&
		"segment" in event &&
		isPlainObject(event.segment) &&
		event.modelInputKind === "conversation" &&
		typeof event.segment.content === "string"
	);
}
