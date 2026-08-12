/**
 * Chronological planner history and its fail-closed model projection. Semantic
 * consumers read archived and live steps together, while model stages receive
 * only the original conversational context plus machine-owned tool authority.
 */
import type {
	ContextEvent,
	ContextInstructionEvent,
	ContextMessageEvent,
	ContextProviderEvent,
	ContextSegmentEvent,
} from "../types/context-object";
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

/**
 * Model-visible authority for completed and queued work. Raw reasoning,
 * invocation identities and parameters, diagnostic result fields, terminal
 * candidates, evaluator output, and compaction state remain process-local.
 */
export function projectModelVisibleTrajectory(
	trajectory: PlannerTrajectory,
	context: ContextObject = trajectory.context,
): PlannerTrajectory {
	let projectedContext = modelVisibleBaseContext(context);
	const authority = [
		...allSteps(trajectory).flatMap((step) => {
			if (!step.toolCall || !step.result) return [];
			const userFacingText =
				step.result.verifiedUserFacing === true &&
				typeof step.result.userFacingText === "string" &&
				step.result.userFacingText.trim().length > 0
					? step.result.userFacingText
					: undefined;
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

function modelVisibleBaseContext(context: ContextObject): ContextObject {
	const original: ContextObject = Array.isArray(context.events)
		? context
		: { ...context, events: [] };
	const events = original.events.flatMap((event): ContextEvent[] => {
		if (isModelVisibleMessageEvent(event)) {
			return [
				{
					id: event.id,
					type: "message",
					source: event.source,
					createdAt: event.createdAt,
					message: {
						id: event.message.id,
						role: event.message.role,
						content: event.message.content,
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
					name: event.name,
					text: event.text,
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
					content: event.content,
					role: event.role,
					stable: event.stable,
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
					segment: {
						id: event.segment.id,
						label: "reply_reference",
						content: event.segment.content,
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
		staticPrefix: original.staticPrefix
			? {
					systemPrompt: original.staticPrefix.systemPrompt,
					characterPrompt: original.staticPrefix.characterPrompt,
					staticProviders: original.staticPrefix.staticProviders,
				}
			: undefined,
		trajectoryPrefix: original.trajectoryPrefix
			? {
					selectedContexts: original.trajectoryPrefix.selectedContexts,
					contextDefinitions: original.trajectoryPrefix.contextDefinitions,
					contextProviders: original.trajectoryPrefix.contextProviders,
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
		event.segment.label === "reply_reference" &&
		typeof event.segment.content === "string"
	);
}
