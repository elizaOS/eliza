/**
 * Canonical fixture templates for deterministic message-loop model calls.
 *
 * The agent loop is two model calls: a Stage-1 `RESPONSE_HANDLER` that routes
 * the user message to candidate actions, then an `ACTION_PLANNER` that emits the
 * concrete tool-call. {@link strictActionRouteFixtures} declares the matching
 * pair for one action invocation so the provider has an exact response for each
 * call. The adversarial counterpart emits malformed and incorrect responses.
 */

import { ModelType } from "../types/model";
import type { JsonValue } from "../types/primitives";
import type { DeterministicModelFixture } from "./deterministic-model-plugin";

type JsonRecord = Record<string, JsonValue>;

const MESSAGE_USER_MARKER = "message:user:\n";
const EXTERNAL_CONTENT_START = "<<<EXTERNAL_UNTRUSTED_CONTENT>>>";
const EXTERNAL_CONTENT_END = "<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>";
const EXTERNAL_CONTENT_SEPARATOR = "\n---\n";

/**
 * Declares the security-adjudication result for a test whose external message
 * is known to be benign. The exact classifier prompt prefix keeps this fixture
 * isolated from ordinary text generation.
 */
export function benignExternalMessageFixture(
	name = "benign-external-message",
): DeterministicModelFixture {
	return {
		name,
		match: {
			modelType: ModelType.TEXT_LARGE,
			prompt: (prompt) =>
				prompt.startsWith("You are a security classifier for an AI assistant."),
		},
		response: "VERDICT: ALLOW\nREASON: The message is a normal user request.",
		times: 1,
	};
}
const MESSAGE_USER_SUFFIX_BOUNDARY =
	/\n\n(?:event:|provider:|current_turn_boundary:|The Stage 1 router)/;
const MESSAGE_USER_BLOCK_MARKER = /(?:^|\n\n)message:user:\n/g;

type JsonObjectKeyInspection = {
	hasDuplicateRootKeys: boolean;
	topLevelKeys: Set<string>;
};

export type RuntimeWithScenarioModelFixtures = {
	scenarioModelFixtures?: {
		register: (...fixtures: DeterministicModelFixture[]) => void;
	};
};

export type StrictActionRouteFixture = {
	actionName: string;
	args: JsonRecord;
	contextIds?: readonly string[];
	input: string;
	messageToUser?: string;
};

export type StrictMultiToolRouteFixture = {
	input: string;
	tools: readonly { actionName: string; args: JsonRecord }[];
	contextIds?: readonly string[];
	messageToUser?: string;
};

export type StrictTerminalRouteFixture = {
	input: string;
	text: string;
	contextIds?: readonly string[];
};

function extractExternalContent(value: string): string | null {
	const envelopeStart = value.lastIndexOf(EXTERNAL_CONTENT_START);
	const envelopeEnd = value.lastIndexOf(EXTERNAL_CONTENT_END);
	if (envelopeStart === -1 || envelopeEnd <= envelopeStart) return null;
	const envelopeText = value.slice(
		envelopeStart + EXTERNAL_CONTENT_START.length,
		envelopeEnd,
	);
	const separatorIndex = envelopeText.indexOf(EXTERNAL_CONTENT_SEPARATOR);
	return (
		separatorIndex === -1
			? envelopeText
			: envelopeText.slice(separatorIndex + EXTERNAL_CONTENT_SEPARATOR.length)
	).trim();
}

/**
 * Inspect root envelope keys before JSON.parse can collapse duplicate members.
 * Decoding each string token also normalizes escaped spellings such as
 * `"te\\u0078t"` to the same semantic key as `"text"`.
 * Nested metadata is not an alternate envelope and cannot change its text.
 */
function inspectJsonObjectKeys(value: string): JsonObjectKeyInspection {
	type Container = { kind: "array" } | { kind: "object"; topLevel: boolean };
	const containers: Container[] = [];
	const topLevelKeys = new Set<string>();
	let hasDuplicateRootKeys = false;

	for (let index = 0; index < value.length; index++) {
		const character = value[index];
		if (character === "{") {
			containers.push({
				kind: "object",
				topLevel: containers.length === 0,
			});
			continue;
		}
		if (character === "[") {
			containers.push({ kind: "array" });
			continue;
		}
		if (character === "}" || character === "]") {
			containers.pop();
			continue;
		}
		if (character !== '"') continue;

		let end = index + 1;
		for (; end < value.length; end++) {
			if (value[end] === "\\") {
				end++;
				continue;
			}
			if (value[end] === '"') break;
		}
		if (end >= value.length) break;

		let afterString = end + 1;
		while (/\s/.test(value[afterString] ?? "")) afterString++;
		const container = containers.at(-1);
		if (
			value[afterString] === ":" &&
			container?.kind === "object" &&
			container.topLevel
		) {
			try {
				const key = JSON.parse(value.slice(index, end + 1));
				if (typeof key === "string") {
					if (topLevelKeys.has(key)) hasDuplicateRootKeys = true;
					topLevelKeys.add(key);
				}
			} catch {
				// error-policy:J3 JSON.parse below validates the complete input;
				// malformed string tokens cannot identify an envelope key.
			}
		}
		index = end;
	}

	return { hasDuplicateRootKeys, topLevelKeys };
}

function decodeStage1JsonMessageEnvelope(value: string): string | null {
	const trimmed = value.trim();
	const first = trimmed[0];
	if (first !== "{" && first !== "[" && first !== '"') {
		return trimmed;
	}

	const keyInspection = inspectJsonObjectKeys(trimmed);
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		// error-policy:J3 Stage-1 fixture input is an untrusted JSON boundary;
		// reject malformed modern envelopes without reclassifying legacy JSON text.
		return keyInspection.topLevelKeys.has("source") ||
			keyInspection.topLevelKeys.has("channelType")
			? null
			: trimmed;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return trimmed;
	}

	const record = parsed as Record<string, unknown>;
	const hasSource = Object.hasOwn(record, "source");
	const hasChannelType = Object.hasOwn(record, "channelType");
	if (!hasSource && !hasChannelType) return trimmed;
	if (keyInspection.hasDuplicateRootKeys) return null;
	if (
		!hasSource ||
		!hasChannelType ||
		typeof record.source !== "string" ||
		typeof record.channelType !== "string"
	) {
		return null;
	}
	if (!Object.hasOwn(record, "text") || typeof record.text !== "string") {
		return null;
	}
	if (Object.hasOwn(record, "currentMessageText")) {
		if (
			typeof record.currentMessageText !== "string" ||
			record.currentMessageText !== record.text
		) {
			return null;
		}
	}
	if (Object.hasOwn(record, "content")) return null;
	return extractExternalContent(record.text) ?? record.text.trim();
}

function latestMessageUserMarkerIndex(value: string): number {
	let blockIndex = -1;
	for (const match of value.matchAll(MESSAGE_USER_BLOCK_MARKER)) {
		blockIndex =
			(match.index ?? 0) + match[0].length - MESSAGE_USER_MARKER.length;
	}
	return blockIndex === -1
		? value.lastIndexOf(MESSAGE_USER_MARKER)
		: blockIndex;
}

function extractScenarioInput(value: string): string | null {
	const markerIndex = latestMessageUserMarkerIndex(value);
	const afterMarker =
		markerIndex === -1
			? value
			: value.slice(markerIndex + MESSAGE_USER_MARKER.length);
	const candidate =
		afterMarker.split(MESSAGE_USER_SUFFIX_BOUNDARY, 1)[0]?.trim() ?? "";
	if (
		markerIndex !== -1 &&
		(candidate[0] === "{" || candidate[0] === "[" || candidate[0] === '"')
	) {
		return decodeStage1JsonMessageEnvelope(candidate);
	}
	const externalContent = extractExternalContent(candidate);
	if (externalContent !== null) return externalContent;
	return candidate;
}

/**
 * Strip the prompt envelope (`message:user:`, the external-content wrapper, and
 * any trailing provider/event boundary) so a fixture matches the exact user
 * text regardless of the surrounding prompt scaffolding.
 */
export function finalMessageUserText(value: string): string {
	return extractScenarioInput(value) ?? "";
}

/** A text matcher that compares the normalized latest user text exactly. */
export function matchesScenarioInput(expected: string) {
	return (value: string) => {
		const actual = extractScenarioInput(value);
		return actual !== null && actual === expected;
	};
}

/** Slugify an action name for stable, unique fixture names. */
export function actionSlug(actionName: string): string {
	return actionName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

/**
 * The valid Stage-1 `RESPONSE_HANDLER` fixture: routes `spec.input` to
 * `spec.actionName` as the sole candidate action.
 */
export function stage1ResponseHandlerFixture(
	spec: StrictActionRouteFixture,
): DeterministicModelFixture {
	const slug = actionSlug(spec.actionName);
	return {
		name: `route-${slug}-stage1-${spec.input}`,
		match: {
			modelType: ModelType.RESPONSE_HANDLER,
			input: matchesScenarioInput(spec.input),
			toolName: "HANDLE_RESPONSE",
		},
		response: {
			contexts: [...(spec.contextIds ?? ["general"])],
			intents: [spec.input.toLowerCase()],
			replyText: spec.messageToUser ?? "On it.",
			threadOps: [],
			candidateActionNames: [spec.actionName],
		},
		times: 1,
	};
}

/**
 * Declare the matching Stage-1 + planner fixture pair for one action
 * invocation. Mirrors `@elizaos/scenario-runner`'s strict template.
 */
export function strictActionRouteFixtures(
	spec: StrictActionRouteFixture,
): DeterministicModelFixture[] {
	const slug = actionSlug(spec.actionName);
	const replyText = spec.messageToUser ?? "On it.";

	return [
		stage1ResponseHandlerFixture(spec),
		{
			name: `route-${slug}-planner-${spec.input}`,
			match: {
				modelType: ModelType.ACTION_PLANNER,
				input: matchesScenarioInput(spec.input),
				toolName: spec.actionName,
			},
			response: {
				text: "",
				thought: `Call ${spec.actionName} for ${spec.input}.`,
				messageToUser: replyText,
				completed: true,
				finishReason: "tool-calls",
				toolCalls: [
					{
						id: `call-${slug}`,
						name: spec.actionName,
						type: "function",
						arguments: spec.args,
					},
				],
			},
			times: 1,
		},
	];
}

/** Declare one Stage-1 decision followed by an ordered parallel tool plan. */
export function strictMultiToolRouteFixtures(
	spec: StrictMultiToolRouteFixture,
): DeterministicModelFixture[] {
	if (spec.tools.length < 2) {
		throw new Error("strict multi-tool route requires at least two tools");
	}
	const candidateActionNames = spec.tools.map((tool) => tool.actionName);
	const replyText = spec.messageToUser ?? "On it.";
	return [
		{
			name: `route-multi-stage1-${actionSlug(spec.input)}`,
			match: {
				modelType: ModelType.RESPONSE_HANDLER,
				input: matchesScenarioInput(spec.input),
				toolName: "HANDLE_RESPONSE",
			},
			response: {
				contexts: [...(spec.contextIds ?? ["general"])],
				intents: [spec.input.toLowerCase()],
				replyText,
				threadOps: [],
				candidateActionNames,
			},
			times: 1,
		},
		{
			name: `route-multi-planner-${actionSlug(spec.input)}`,
			match: {
				modelType: ModelType.ACTION_PLANNER,
				input: matchesScenarioInput(spec.input),
				toolNames: candidateActionNames,
			},
			response: {
				text: "",
				thought: `Call ${candidateActionNames.join(", ")}.`,
				messageToUser: replyText,
				completed: true,
				finishReason: "tool-calls",
				toolCalls: spec.tools.map((tool, index) => ({
					id: `call-${index + 1}-${actionSlug(tool.actionName)}`,
					name: tool.actionName,
					type: "function",
					arguments: tool.args,
				})),
			},
			times: 1,
		},
	];
}

/** Stage-1 asks the user for missing information and terminates without tools. */
export function strictClarificationFixture(
	spec: StrictTerminalRouteFixture,
): DeterministicModelFixture {
	return {
		name: `route-clarification-${actionSlug(spec.input)}`,
		match: {
			modelType: ModelType.RESPONSE_HANDLER,
			input: matchesScenarioInput(spec.input),
			toolName: "HANDLE_RESPONSE",
		},
		response: {
			contexts: [...(spec.contextIds ?? ["general"])],
			intents: [spec.input.toLowerCase()],
			replyText: spec.text,
			threadOps: [],
			candidateActionNames: [],
			needsClarification: true,
		},
		times: 1,
	};
}

/** Stage-1 emits a terminal conversational response with no planner call. */
export function strictTerminalReplyFixture(
	spec: StrictTerminalRouteFixture,
): DeterministicModelFixture {
	return {
		name: `route-terminal-reply-${actionSlug(spec.input)}`,
		match: {
			modelType: ModelType.RESPONSE_HANDLER,
			input: matchesScenarioInput(spec.input),
			toolName: "HANDLE_RESPONSE",
		},
		response: {
			contexts: [...(spec.contextIds ?? ["general"])],
			intents: [spec.input.toLowerCase()],
			replyText: spec.text,
			threadOps: [],
			candidateActionNames: ["REPLY"],
		},
		times: 1,
	};
}

/** Declare an exact evaluator/judge-style structured generation call. */
export function strictEvaluatorFixture(options: {
	name: string;
	modelType?: string;
	promptIncludes: string;
	responseSchema?: JsonRecord;
	response: JsonRecord;
	times?: number;
}): DeterministicModelFixture {
	return {
		name: options.name,
		match: {
			modelType: options.modelType ?? ModelType.TEXT_LARGE,
			prompt: (prompt) => prompt.includes(options.promptIncludes),
			...(options.responseSchema
				? { responseSchema: options.responseSchema }
				: {}),
		},
		response: options.response,
		times: options.times ?? 1,
	};
}

/** Declare deterministic scheduled body/title rendering without a global resolver. */
export function strictScheduledRenderFixture(options: {
	name: string;
	promptPrefix: string;
	response: string;
	modelType?: string | string[];
	times?: number;
}): DeterministicModelFixture {
	return {
		name: options.name,
		match: {
			modelType: options.modelType ?? [
				ModelType.TEXT_SMALL,
				ModelType.TEXT_LARGE,
			],
			prompt: (prompt) => prompt.startsWith(options.promptPrefix),
		},
		response: options.response,
		times: options.times ?? 1,
	};
}

/** Register strict action-route fixtures onto a scenario-style runtime bridge. */
export function registerStrictActionRouteFixtures(
	runtime: RuntimeWithScenarioModelFixtures,
	specs: readonly StrictActionRouteFixture[],
): void {
	runtime.scenarioModelFixtures?.register(
		...specs.flatMap((spec) => strictActionRouteFixtures(spec)),
	);
}
