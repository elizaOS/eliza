/**
 * Canonical fixture templates for deterministic message-loop model calls.
 *
 * Stage 1 routes the user message to candidate actions, the planner emits the
 * concrete tool call, and the evaluator checks its correlated successful result.
 * Strict action fixtures declare these model calls for one action invocation.
 * The adversarial counterpart emits malformed and incorrect responses.
 */

import type { JsonValue } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import type { DeterministicModelFixture } from "./deterministic-model-plugin";
import { postToolEvaluatorFixture } from "./post-tool-evaluator-fixture";

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

