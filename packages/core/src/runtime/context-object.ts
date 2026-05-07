import type { ContextEvent, ContextObject } from "../types/context-object";

export interface CreateContextObjectOptions {
	id: string;
	createdAt?: number;
	metadata?: ContextObject["metadata"];
	events?: readonly ContextEvent[];
}

export function createContextObject({
	id,
	createdAt,
	metadata,
	events = [],
}: CreateContextObjectOptions): ContextObject {
	return {
		id,
		version: "v5",
		createdAt,
		metadata,
		events: [...events],
	};
}

export function appendContextEvent(
	context: ContextObject,
	event: ContextEvent,
): ContextObject {
	return {
		...context,
		events: [...context.events, event],
	};
}
