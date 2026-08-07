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

/**
 * Strip the prompt envelope (`message:user:`, the external-content wrapper, and
 * any trailing provider/event boundary) so a fixture matches the exact user
 * text regardless of the surrounding prompt scaffolding.
 */
export function finalMessageUserText(value: string): string {
	const markerIndex = value.lastIndexOf(MESSAGE_USER_MARKER);
	const messageText =
		markerIndex === -1
			? value
			: value.slice(markerIndex + MESSAGE_USER_MARKER.length);
	const envelopeStart = messageText.lastIndexOf(EXTERNAL_CONTENT_START);
	const envelopeEnd = messageText.lastIndexOf(EXTERNAL_CONTENT_END);
	if (envelopeStart === -1 || envelopeEnd <= envelopeStart) {
		return messageText.split(MESSAGE_USER_SUFFIX_BOUNDARY, 1)[0]?.trim() ?? "";
	}
	const envelopeText = messageText.slice(
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

/** A text matcher that compares the normalized latest user text exactly. */
export function matchesScenarioInput(expected: string) {
	return (value: string) => finalMessageUserText(value) === expected;
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

/** Register strict action-route fixtures onto a scenario-style runtime bridge. */
export function registerStrictActionRouteFixtures(
	runtime: RuntimeWithScenarioModelFixtures,
	specs: readonly StrictActionRouteFixture[],
): void {
	runtime.scenarioModelFixtures?.register(
		...specs.flatMap((spec) => strictActionRouteFixtures(spec)),
	);
}
