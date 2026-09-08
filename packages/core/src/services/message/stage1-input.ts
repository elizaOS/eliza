/** Renders complete message-handler instructions and model input with stable prompt-prefix boundaries. */

import { v4 } from "uuid";
import { HANDLE_RESPONSE_TOOL_NAME } from "../../actions/to-tool";
import { messageHandlerTemplate } from "../../prompts";
import { completionContextSources } from "../../runtime/completion-context";
import {
	normalizePromptSegments,
	renderContextObject,
	segmentBlock,
} from "../../runtime/context-renderer";
import type { ContextObject } from "../../types/context-object";
import type { ContextDefinition } from "../../types/contexts";
import type { Memory } from "../../types/memory";
import type { ChatMessage, PromptSegment } from "../../types/model";
import type { UUID } from "../../types/primitives";
import { asUUID, ChannelType } from "../../types/primitives";
import type { IAgentRuntime } from "../../types/runtime";
import { composePrompt } from "../../utils";
import type { OptimizedPromptTask } from "../optimized-prompt";
import {
	type OptimizedPromptRuntimeLike,
	resolveOptimizedPromptForRuntime,
} from "../optimized-prompt-resolver";
import {
	listAvailableContextsForRole,
	resolveStage1SenderRole,
} from "./addressing.js";
import { createV5MessageContextObject } from "./context-assembly.js";
import {
	ambientTurnProviderExclusions,
	composeResponseState,
} from "./provider-state.js";

export const CODE_SNIPPET_VALIDITY_INSTRUCTION =
	"For code snippets, prioritize syntactically valid runnable code over impossible formatting constraints. If a tight line count would require invalid syntax, provide a valid version and briefly note the constraint tradeoff.";

export const VOICE_ENGAGEMENT_RULES = [
	"- shouldRespond=RESPOND for a completed caller question, request, substantive statement, or conversational continuation.",
	"- This is a one-to-one conversation: respond naturally to acknowledgements, reactions, and brief follow-ups, including disagreement or requests to clarify your previous reply.",
	"- shouldRespond=IGNORE only for non-speech/noise or ambient speech clearly not addressed to the agent.",
	"- shouldRespond=STOP only when the caller explicitly asks the agent to disengage or end the conversation.",
	"- Do not use IGNORE merely because the answer is brief, uncertain, or requires a tool.",
].join("\n");

/**
 * Format the role-filtered context catalog as a compact bullet list for the
 * Stage 1 prompt. Each line includes the id plus compressed metadata that helps
 * Stage 1 pick generously without inventing contexts.
 */
export function formatAvailableContextsForPrompt(
	contexts: readonly ContextDefinition[],
): string {
	if (contexts.length === 0) {
		return "(no contexts registered)";
	}
	return contexts
		.map((definition) => {
			const description = definition.description?.trim();
			const metadata = [
				definition.label && definition.label !== definition.id
					? `label=${definition.label}`
					: undefined,
				definition.aliases?.length
					? `aliases=${definition.aliases.join(",")}`
					: undefined,
				definition.parent
					? `parent=${definition.parent}`
					: definition.parents?.length
						? `parents=${definition.parents.join(",")}`
						: undefined,
				definition.roleGate
					? formatRoleGateForPrompt(definition.roleGate)
					: undefined,
				definition.sensitivity
					? `sensitivity=${definition.sensitivity}`
					: undefined,
				definition.cacheScope ? `cache=${definition.cacheScope}` : undefined,
			].filter(Boolean);
			const suffix = metadata.length > 0 ? ` [${metadata.join("; ")}]` : "";
			return description
				? `- ${definition.id}${suffix}: ${description}`
				: `- ${definition.id}${suffix}`;
		})
		.join("\n");
}

export function formatRoleGateForPrompt(
	roleGate: ContextDefinition["roleGate"],
): string | undefined {
	if (!roleGate) {
		return undefined;
	}
	if (roleGate.minRole) {
		return `role>=${roleGate.minRole}`;
	}
	const anyOf = [...(roleGate.roles ?? []), ...(roleGate.anyOf ?? [])];
	if (anyOf.length > 0) {
		return `role=${anyOf.join("|")}`;
	}
	if (roleGate.allOf?.length) {
		return `role_all=${roleGate.allOf.join("+")}`;
	}
	return undefined;
}

/**
 * The Stage-1 `messageHandlerTemplate` covers two optimized-prompt tasks:
 *
 *   - `should_respond` — the prompt asks the model to decide whether to
 *     respond or ignore the message. Optimizing this task tunes the classifier.
 *   - `response` — Stage-1 also emits the assistant's draft reply when it
 *     decides to respond, so a separately-trained `response` artifact
 *     replaces the same baseline when present and the operator wants that
 *     variant active.
 */
export function selectMessageHandlerTask(
	_availableContexts: readonly ContextDefinition[],
): OptimizedPromptTask {
	// context_routing was retired (inferContextRoutingFromText is pure regex,
	// no LLM call to optimize); the message-handler template falls back to the
	// should_respond task for both the contexts-available and contexts-empty
	// callers.
	return "should_respond";
}

export function renderMessageHandlerInstructions(
	runtime: OptimizedPromptRuntimeLike & Pick<IAgentRuntime, "character">,
	availableContexts: readonly ContextDefinition[],
	options?: {
		directMessage?: boolean;
		voiceDirectMessage?: boolean;
		responseHandlerFields?: string;
	},
): string {
	const baseline = resolveOptimizedPromptForRuntime(
		runtime,
		selectMessageHandlerTask(availableContexts),
		messageHandlerTemplate,
	);
	const rendered = composePrompt({
		state: {
			agentName: runtime.character.name?.trim() || "the agent",
			directMessage: options?.directMessage ? "true" : "",
			availableContexts: formatAvailableContextsForPrompt(availableContexts),
			handleResponseToolName: HANDLE_RESPONSE_TOOL_NAME,
		},
		template: baseline,
	}).trim();
	const renderedWithVoiceRules = options?.voiceDirectMessage
		? [rendered, "", "voice engagement rules:", VOICE_ENGAGEMENT_RULES].join(
				"\n",
			)
		: rendered;
	const renderedWithSharedRules = [
		renderedWithVoiceRules,
		"",
		"## Shared Response Quality Rules",
		`- ${CODE_SNIPPET_VALIDITY_INSTRUCTION}`,
	].join("\n");
	if (!options?.responseHandlerFields?.trim()) {
		return renderedWithSharedRules;
	}
	return [
		renderedWithSharedRules,
		"",
		"## Response Handler Fields",
		"Populate every registered field. Use empty value when not applicable.",
		options.responseHandlerFields.trim(),
	].join("\n");
}

export function renderMessageHandlerModelInput(
	runtime: OptimizedPromptRuntimeLike & Pick<IAgentRuntime, "character">,
	context: ContextObject,
	availableContexts: readonly ContextDefinition[] = [],
	options?: {
		directMessage?: boolean;
		voiceDirectMessage?: boolean;
		groupTriage?: boolean;
		responseHandlerFields?: string;
	},
): {
	messages: ChatMessage[];
	promptSegments: PromptSegment[];
} {
	const rendered = renderContextObject(context);
	const completionSources = options?.voiceDirectMessage
		? undefined
		: completionContextSources(context);
	const completionSourceIds = new Map(
		completionSources?.sources.map(({ id, event }) => [event.id, id]),
	);
	const instructions = renderMessageHandlerInstructions(
		runtime,
		availableContexts,
		options,
	);
	const stableSegments = rendered.promptSegments.filter(
		(segment) => segment.stable,
	);
	const dynamicSegments = rendered.promptSegments.filter(
		(segment) => !segment.stable,
	);
	const currentTurnBoundary = dynamicSegments.filter(
		(segment) => segment.id === "current-turn-boundary",
	);
	const remainingDynamicSegments = dynamicSegments.filter(
		(segment) => segment.id !== "current-turn-boundary",
	);
	const priorDialogueSegments = remainingDynamicSegments
		.filter((segment) => segment.label?.startsWith("prior_message:") === true)
		.map((segment) => {
			const sourceId = segment.id && completionSourceIds.get(segment.id);
			return sourceId
				? {
						...segment,
						content: `[completion_source=${sourceId}]\n${segment.content}`,
					}
				: segment;
		});
	const dynamicProviderSegments = remainingDynamicSegments.filter(
		(segment) => segment.label?.startsWith("provider:") === true,
	);
	const turnTailSegments = remainingDynamicSegments.filter(
		(segment) =>
			segment.label?.startsWith("prior_message:") !== true &&
			segment.label?.startsWith("provider:") !== true,
	);
	// The boundary follows untrusted dialogue so stored messages cannot supersede
	// it with structural-looking text. Providers remain adjacent after that
	// boundary, preserving their reusable prefix before the current message.
	const orderedDynamicSegments = [
		...priorDialogueSegments,
		...currentTurnBoundary,
		...(completionSources?.sources.length
			? [
					{
						content: `completion_source_set: ${completionSources.sourceSetId}\nThe completion_source labels above identify prior user messages only. Select their exact IDs for completionContext. The current request, all providers, assistant dialogue, permissions, tool evidence and pending execution remain included automatically. Review every source for applicable standing constraints, corrections, references and unresolved work. Use mode=full if uncertain or if exhaustive history is needed.`,
						stable: false,
					},
				]
			: []),
		...dynamicProviderSegments,
		...turnTailSegments,
	];
	const stableWireSegments = [
		...stableSegments,
		{ content: `message_handler_stage:\n${instructions}`, stable: true },
	];
	const promptSegments = normalizePromptSegments([
		...stableWireSegments,
		...orderedDynamicSegments,
	]);
	// `normalizePromptSegments` embeds separators in segment content for cache
	// consumers that concatenate the array. Render message blocks from the raw
	// segments so those separators remain between labeled blocks instead of
	// becoming extra whitespace inside a block's content.
	const systemContent = stableWireSegments.map(segmentBlock).join("\n\n");
	const userContent = orderedDynamicSegments.map(segmentBlock).join("\n\n");
	return {
		messages: [
			{ role: "system", content: systemContent },
			{ role: "user", content: userContent },
		],
		promptSegments,
	};
}

/**
 * Render only the *stable* part of the Stage-1 (`HANDLE_RESPONSE`) model
 * input for a given room — the system prompt + tool/action schema block +
 * the stable provider blocks. This is the prefix that does NOT depend on
 * the user's turn, so it is the exact text the local-inference KV cache
 * should be pre-warmed with the instant a voice session opens or VAD
 * detects speech onset (item I1/C1 of the voice swarm).
 *
 * The returned string is byte-identical to the `messages[0].content`
 * (the "system" message) that `renderMessageHandlerModelInput` would
 * produce for the first turn of a fresh conversation in that room — the
 * unstable tail (recent dialogue, the current user message) is dropped.
 * Pre-warming with this string lands the system prefix in the slot's KV
 * so the real request only forward-passes the user tokens.
 *
 * Best-effort by construction: composing state may hit providers that
 * query the DB; a synthetic empty message is used so a brand-new room
 * with no history still renders. Callers that fail to render should just
 * skip the pre-warm (the real request cold-prefills, which is the
 * pre-pre-warm behaviour).
 */
export async function renderMessageHandlerStablePrefix(
	runtime: IAgentRuntime,
	roomId: UUID,
): Promise<string> {
	const syntheticMessage: Memory = {
		id: asUUID(v4()),
		entityId: (runtime.agentId ?? asUUID(v4())) as UUID,
		agentId: runtime.agentId,
		roomId,
		createdAt: Date.now(),
		content: {
			text: "",
			source: "voice-prewarm",
			channelType: ChannelType.VOICE_DM,
		},
	};
	const senderRole = await resolveStage1SenderRole(runtime, syntheticMessage);
	const availableContexts = listAvailableContextsForRole(
		runtime.contexts,
		senderRole,
	);
	const state = await composeResponseState(runtime, syntheticMessage, true);
	const context = await createV5MessageContextObject({
		runtime,
		message: syntheticMessage,
		state,
		userRoles: [senderRole],
		availableContexts,
		extraProviderExclusions: ambientTurnProviderExclusions(
			runtime,
			syntheticMessage,
		),
		// Per-turn exclusions so the stable-prefix render is owned by the same
		// gate as every live render; the synthetic VOICE_DM message classifies
		// as addressed, so today this resolves to the static set.
	});
	const rendered = renderContextObject(context);
	const stableSegments = rendered.promptSegments.filter(
		(segment) => segment.stable,
	);
	const instructions = renderMessageHandlerInstructions(
		runtime,
		availableContexts,
		{ directMessage: true },
	);
	return [
		...stableSegments,
		{ content: `message_handler_stage:\n${instructions}`, stable: true },
	]
		.map(segmentBlock)
		.join("\n\n");
}
