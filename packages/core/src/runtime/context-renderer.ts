import type {
	ContextEvent,
	ContextInstructionEvent,
	ContextMemoryEvent,
	ContextMessageEvent,
	ContextObject,
	ContextObjectMessage,
	ContextObjectPromptSegment,
	ContextObjectTool,
	ContextProviderEvent,
	ContextSegmentEvent,
	ContextToolEvent,
} from "../types/context-object";

export interface RenderedContextObject {
	messages: ContextObjectMessage[];
	tools: ContextObjectTool[];
	promptSegments: ContextObjectPromptSegment[];
}

function textFromUnknown(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}
	if (
		typeof value === "object" &&
		value !== null &&
		"text" in value &&
		typeof value.text === "string"
	) {
		return value.text;
	}
	return JSON.stringify(value) ?? "";
}

function isMessageEvent(event: ContextEvent): event is ContextMessageEvent {
	return event.type === "message" && "message" in event;
}

function isMemoryEvent(event: ContextEvent): event is ContextMemoryEvent {
	return event.type === "memory" && "memory" in event;
}

function isProviderEvent(event: ContextEvent): event is ContextProviderEvent {
	return event.type === "provider" && "name" in event;
}

function isToolEvent(event: ContextEvent): event is ContextToolEvent {
	return event.type === "tool" && "tool" in event;
}

function isInstructionEvent(
	event: ContextEvent,
): event is ContextInstructionEvent {
	return event.type === "instruction" && "content" in event;
}

function isSegmentEvent(event: ContextEvent): event is ContextSegmentEvent {
	return event.type === "segment" && "segment" in event;
}

function renderEvent(
	rendered: RenderedContextObject,
	event: ContextEvent,
): void {
	if (isMessageEvent(event)) {
		rendered.messages.push(event.message);
		rendered.promptSegments.push({
			id: event.message.id ?? event.id,
			label: `message:${event.message.role}`,
			content: textFromUnknown(event.message.content),
			stable: false,
		});
		return;
	}

	if (isMemoryEvent(event)) {
		rendered.messages.push({
			id: event.memory.id,
			role: "user",
			content: event.memory.content,
		});
		rendered.promptSegments.push({
			id: event.memory.id ?? event.id,
			label: "memory",
			content: textFromUnknown(event.memory.content),
			stable: false,
		});
		return;
	}

	if (isProviderEvent(event) && event.text) {
		rendered.promptSegments.push({
			id: event.id,
			label: `provider:${event.name}`,
			content: event.text,
			stable: false,
		});
		return;
	}

	if (isToolEvent(event)) {
		rendered.tools.push(event.tool);
		return;
	}

	if (isInstructionEvent(event)) {
		rendered.promptSegments.push({
			id: event.id,
			label: `instruction:${event.role ?? "system"}`,
			content: event.content,
			stable: Boolean(event.stable),
		});
		return;
	}

	if (isSegmentEvent(event)) {
		rendered.promptSegments.push(event.segment);
	}
}

export function renderContextObject(
	context: ContextObject,
): RenderedContextObject {
	const rendered: RenderedContextObject = {
		messages: [],
		tools: [],
		promptSegments: [],
	};

	for (const event of context.events) {
		renderEvent(rendered, event);
	}

	return rendered;
}
