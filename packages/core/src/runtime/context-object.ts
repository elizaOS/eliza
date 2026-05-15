import type { ContextEvent, ContextObject } from "../types/context-object";

export interface CreateContextObjectOptions {
	id: string;
	createdAt?: number;
	metadata?: ContextObject["metadata"];
	staticPrefix?: ContextObject["staticPrefix"];
	trajectoryPrefix?: ContextObject["trajectoryPrefix"];
	plannedQueue?: ContextObject["plannedQueue"];
	metrics?: ContextObject["metrics"];
	limits?: ContextObject["limits"];
	events?: readonly ContextEvent[];
}

export function createContextObject({
	id,
	createdAt,
	metadata,
	staticPrefix,
	trajectoryPrefix,
	plannedQueue,
	metrics,
	limits,
	events = [],
}: CreateContextObjectOptions): ContextObject {
	return {
		id,
		version: "v5",
		createdAt,
		metadata,
		staticPrefix,
		trajectoryPrefix,
		plannedQueue,
		metrics,
		limits,
		events: [...events],
	};
}

export function appendContextEvent(
	context: ContextObject,
	event: ContextEvent,
): ContextObject {
	return {
		...context,
		events: [...(context.events ?? []), event],
	};
}
