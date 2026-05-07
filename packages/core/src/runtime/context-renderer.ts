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
import type { ChatMessageRole } from "../types/model";

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

function renderProviderContent(event: ContextProviderEvent): string {
	const parts: string[] = [`provider: ${event.name}`];
	if (event.text?.trim()) {
		parts.push(event.text.trim());
	}
	return parts.join("\n");
}

function toChatRole(role: string | undefined): ChatMessageRole {
	if (
		role === "system" ||
		role === "developer" ||
		role === "user" ||
		role === "assistant" ||
		role === "tool"
	) {
		return role;
	}
	return "system";
}

function appendPromptSegment(
	rendered: RenderedContextObject,
	segment: ContextObjectPromptSegment,
	role: string | undefined = "system",
): void {
	if (!segment.content.trim()) {
		return;
	}
	rendered.promptSegments.push(segment);
	rendered.messages.push({
		id: segment.id,
		role: toChatRole(role),
		content: segment.content,
	});
}

function appendSyntheticSegment(
	rendered: RenderedContextObject,
	args: {
		id: string;
		label: string;
		content: string;
		stable: boolean;
		role?: string;
	},
): void {
	appendPromptSegment(
		rendered,
		{
			id: args.id,
			label: args.label,
			content: args.content,
			stable: args.stable,
		},
		args.role,
	);
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

	if (isProviderEvent(event)) {
		const content = renderProviderContent(event);
		if (!content.trim()) {
			return;
		}
		appendPromptSegment(rendered, {
			id: event.id,
			label: `provider:${event.name}`,
			content,
			stable: false,
		});
		return;
	}

	if (isToolEvent(event)) {
		rendered.tools.push(event.tool);
		return;
	}

	if (isInstructionEvent(event)) {
		appendPromptSegment(
			rendered,
			{
				id: event.id,
				label: `instruction:${event.role ?? "system"}`,
				content: event.content,
				stable: Boolean(event.stable),
			},
			event.role,
		);
		return;
	}

	if (isSegmentEvent(event)) {
		appendPromptSegment(rendered, event.segment);
		return;
	}

	if (event.type !== "metadata") {
		appendSyntheticSegment(rendered, {
			id: event.id,
			label: `event:${event.type}`,
			content: `${event.type}: ${textFromUnknown(event)}`,
			stable: false,
		});
	}
}

function renderPrefixTool(
	rendered: RenderedContextObject,
	tool: { name: string; description?: string; parameters?: unknown },
): void {
	rendered.tools.push({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
	});
	appendSyntheticSegment(rendered, {
		id: `tool:${tool.name}`,
		label: "tool",
		content: [
			`tool: ${tool.name}`,
			tool.description ? `description: ${tool.description}` : "",
		]
			.filter(Boolean)
			.join("\n"),
		stable: true,
	});
}

export function renderContextObject(
	context: ContextObject,
): RenderedContextObject {
	const rendered: RenderedContextObject = {
		messages: [],
		tools: [],
		promptSegments: [],
	};

	if (context.staticPrefix?.systemPrompt) {
		appendPromptSegment(rendered, context.staticPrefix.systemPrompt, "system");
	}
	if (context.staticPrefix?.characterPrompt) {
		appendPromptSegment(
			rendered,
			context.staticPrefix.characterPrompt,
			"system",
		);
	}
	for (const segment of context.staticPrefix?.staticProviders ?? []) {
		appendPromptSegment(rendered, segment, "system");
	}
	if (context.staticPrefix?.contextRegistryDigest) {
		appendSyntheticSegment(rendered, {
			id: "context-registry-digest",
			label: "context-registry",
			content: `context_registry_digest: ${context.staticPrefix.contextRegistryDigest}`,
			stable: true,
		});
	}
	if (context.trajectoryPrefix?.messageHandlerThought) {
		appendSyntheticSegment(rendered, {
			id: "message-handler-thought",
			label: "message-handler",
			content: `message_handler_thought: ${context.trajectoryPrefix.messageHandlerThought}`,
			stable: true,
		});
	}
	if (context.trajectoryPrefix?.selectedContexts?.length) {
		appendSyntheticSegment(rendered, {
			id: "selected-contexts",
			label: "selected-contexts",
			content: `selected_contexts: ${context.trajectoryPrefix.selectedContexts.join(", ")}`,
			stable: true,
		});
	}
	if (context.trajectoryPrefix?.contextDefinitions?.length) {
		appendSyntheticSegment(rendered, {
			id: "context-definitions",
			label: "context-definitions",
			content: `context_definitions: ${JSON.stringify(
				context.trajectoryPrefix.contextDefinitions.map((definition) => ({
					id: definition.id,
					description: definition.description,
				})),
			)}`,
			stable: true,
		});
	}
	for (const segment of context.trajectoryPrefix?.contextProviders ?? []) {
		appendPromptSegment(rendered, segment, "system");
	}
	for (const tool of context.staticPrefix?.alwaysTools ?? []) {
		renderPrefixTool(rendered, tool);
	}
	for (const tool of context.trajectoryPrefix?.expandedTools ?? []) {
		renderPrefixTool(rendered, tool);
	}

	for (const event of context.events ?? []) {
		renderEvent(rendered, event);
	}

	return rendered;
}
