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
import type {
	ChatMessage,
	ChatMessageRole,
	PromptSegment,
} from "../types/model";

export interface RenderedContextObject {
	messages: ContextObjectMessage[];
	tools: ContextObjectTool[];
	promptSegments: ContextObjectPromptSegment[];
}

/**
 * Format one prompt segment as a labeled block. Segments with `label: "system"`
 * are emitted as raw content (the label is implicit in the system role); all
 * other segments get a `<label>:\n<content>` prefix so the model can locate
 * them inside the merged Tier 1 / Tier 2 strings.
 */
export function segmentBlock(segment: PromptSegment): string {
	const content = segment.content.trim();
	const label = (segment as PromptSegment & { label?: unknown }).label;
	if (label === "system") {
		return content;
	}
	return typeof label === "string" && label ? `${label}:\n${content}` : content;
}

/**
 * Build the wire-shape `messages` array for a stage call: ONE system message
 * (Tier 1: stable context segments + the stage's task instructions), ONE user
 * message (Tier 2: dynamic context segments + caller-supplied dynamic blocks),
 * and the trajectory's append-only assistant/tool suffix.
 *
 * Why: stacking many `system` messages fragments the cache prefix, confuses
 * turn boundaries, and triggers strict provider validation. The native chat
 * protocol expects a single system + user prefix followed by assistant/tool
 * turns for each iteration of the planner loop.
 */
/**
 * Drop segments with empty content. Used by `normalizePromptSegments` and as a
 * post-step in renderers that build segment lists incrementally.
 */
export function compactPromptSegments(
	segments: PromptSegment[],
): PromptSegment[] {
	return segments.filter((segment) => segment.content.length > 0);
}

/**
 * Trim each segment's content and prefix all but the first with `\n\n` so that
 * `segments.map(s => s.content).join("")` round-trips to a clean concatenated
 * prompt. Empties are dropped.
 */
export function normalizePromptSegments(
	segments: PromptSegment[],
): PromptSegment[] {
	return compactPromptSegments(
		segments.map((segment, index) => ({
			...segment,
			content: `${index === 0 ? "" : "\n\n"}${segment.content.trim()}`,
		})),
	);
}

/**
 * Take the longest stable prefix of `segments`. If no segment is stable, fall
 * back to the first segment so a non-empty prefix hash is always available.
 */
export function cachePrefixSegments(
	segments: PromptSegment[],
): PromptSegment[] {
	const prefix: PromptSegment[] = [];
	for (const segment of segments) {
		if (!segment.stable) break;
		prefix.push(segment);
	}
	return prefix.length > 0 ? prefix : segments.slice(0, 1);
}

export function buildStageChatMessages(args: {
	contextSegments: PromptSegment[];
	stageLabel: string;
	instructions: string;
	dynamicBlocks: string[];
	stepMessages: ChatMessage[];
}): ChatMessage[] {
	const stableContext = args.contextSegments
		.filter((segment) => segment.stable)
		.map(segmentBlock)
		.filter(Boolean);
	const dynamicContext = args.contextSegments
		.filter((segment) => !segment.stable)
		.map(segmentBlock)
		.filter(Boolean);
	const systemContent = [
		...stableContext,
		`${args.stageLabel}:\n${args.instructions}`,
	]
		.filter(Boolean)
		.join("\n\n");
	const userContent = [...dynamicContext, ...args.dynamicBlocks]
		.map((block) => block.trim())
		.filter(Boolean)
		.join("\n\n");
	return [
		{ role: "system", content: systemContent },
		{ role: "user", content: userContent },
		...args.stepMessages,
	];
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

function compactRuntimeEventForPrompt(
	event: ContextEvent,
): string | null | undefined {
	if (event.type === "message_handler") {
		const metadata =
			event.metadata && typeof event.metadata === "object"
				? event.metadata
				: {};
		const plan = metadata.plan;
		const thought =
			typeof metadata.thought === "string" ? metadata.thought.trim() : "";
		return [
			"message_handler:",
			metadata.processMessage
				? `processMessage: ${String(metadata.processMessage)}`
				: "",
			plan ? `plan: ${textFromUnknown(plan)}` : "",
			thought ? `thought: ${thought}` : "",
		]
			.filter(Boolean)
			.join("\n");
	}

	// These runtime events are represented to the model as native
	// assistant/tool messages or explicit compaction segments. Dumping their
	// full JSON into the user message duplicates payloads, hurts cache hit rate,
	// and can keep compacted content alive after compaction.
	if (
		event.type === "planned_tool_call" ||
		event.type === "tool_result" ||
		event.type === "evaluation"
	) {
		return null;
	}

	return undefined;
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

	const compactRuntimeEvent = compactRuntimeEventForPrompt(event);
	if (compactRuntimeEvent === null) {
		return;
	}
	if (typeof compactRuntimeEvent === "string") {
		appendSyntheticSegment(rendered, {
			id: event.id,
			label: `event:${event.type}`,
			content: compactRuntimeEvent,
			stable: false,
		});
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
	// Native tool definitions are sent on the wire via `tools: [...]` and the
	// model sees them as first-class function specs. We deliberately do NOT
	// also stamp a synthetic `tool: NAME\ndescription: ...` text segment into
	// the system prompt — duplicating tool catalogs in text wastes prompt
	// tokens and gives the model two representations of the same surface area
	// to reconcile. Callers that need text-mode tool catalogs (legacy adapters
	// without native tool support) should serialize from `rendered.tools`
	// themselves at the boundary.
	rendered.tools.push({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
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
