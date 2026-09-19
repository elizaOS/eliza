/** Matches a declared scenario action's evaluator only after its correlated successful tool receipt. */
import {
	activeCommittedEffectReceipts,
	normalizeEffectReceipts,
} from "../types/effects";
import { ModelType } from "../types/model";
import type { JsonValue } from "../types/primitives";
import { matchesScenarioInput } from "./deterministic-action-fixtures";
import type { DeterministicModelFixture } from "./deterministic-model-plugin";

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonical(value: unknown): string | undefined {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (record(value))
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
			.join(",")}}`;
	return JSON.stringify(value);
}

export function postToolEvaluatorFixture(spec: {
	actionName: string;
	args: Record<string, JsonValue>;
	input: string;
	messageToUser?: string;
}): DeterministicModelFixture {
	return {
		name: `evaluate-${spec.actionName}-${spec.input}`,
		match(call) {
			if (
				call.modelType !== ModelType.RESPONSE_HANDLER ||
				call.toolNames.length !== 0
			)
				return false;
			const messages = call.params.messages ?? [];
			if (
				!messages.some(
					(message) =>
						message.role === "system" &&
						typeof message.content === "string" &&
						message.content.includes("evaluator_stage:\n"),
				)
			)
				return false;
			const inputs = messages.filter(
				(message) =>
					message.role === "user" &&
					typeof message.content === "string" &&
					message.content.includes("message:user:\n"),
			);
			if (
				inputs.length !== 1 ||
				typeof inputs[0].content !== "string" ||
				!matchesScenarioInput(spec.input)(inputs[0].content)
			)
				return false;
			const calls = messages
				.filter((message) => message.role === "assistant")
				.flatMap((message) =>
					Array.isArray(message.content) ? message.content : [],
				)
				.filter((part) => record(part) && part.type === "tool-call");
			// One declared route owns one effect; unexpected extra calls need their own fixture.
			if (calls.length !== 1) return false;
			const toolCall = calls[0];
			if (
				toolCall.type !== "tool-call" ||
				toolCall.toolName !== spec.actionName ||
				typeof toolCall.toolCallId !== "string" ||
				canonical(toolCall.input) !== canonical(spec.args)
			)
				return false;
			const results = messages
				.filter((message) => message.role === "tool")
				.flatMap((message) =>
					Array.isArray(message.content) ? message.content : [],
				)
				.filter((part) => record(part) && part.type === "tool-result");
			if (results.length !== 1) return false;
			const result = results[0];
			if (
				result.type !== "tool-result" ||
				result.toolCallId !== toolCall.toolCallId ||
				result.toolName !== spec.actionName ||
				!record(result.output) ||
				result.output.type !== "text" ||
				typeof result.output.value !== "string"
			)
				return false;
			try {
				const receipt: unknown = JSON.parse(result.output.value);
				return record(receipt) && receipt.success === true;
			} catch {
				// error-policy:J3 Malformed receipts cannot authorize a successful evaluation.
				return false;
			}
		},
		response(call) {
			const resultPart = (call.params.messages ?? [])
				.filter((message) => message.role === "tool")
				.flatMap((message) =>
					Array.isArray(message.content) ? message.content : [],
				)
				.find((part) => part.type === "tool-result");
			if (
				resultPart?.type !== "tool-result" ||
				!record(resultPart.output) ||
				resultPart.output.type !== "text" ||
				typeof resultPart.output.value !== "string"
			) {
				throw new Error("Matched tool receipt is missing");
			}
			const result: unknown = JSON.parse(resultPart.output.value);
			if (!record(result))
				throw new Error("Matched tool receipt is not an object");
			const effects = normalizeEffectReceipts(result.effectReceipts);
			const messageToUser =
				result.verifiedUserFacing === true &&
				typeof result.userFacingText === "string"
					? result.userFacingText
					: spec.messageToUser;
			return {
				thought:
					"The declared action completed with a correlated successful receipt.",
				success: true,
				decision: "FINISH",
				...(messageToUser
					? {
							messageToUser,
							effectReceiptIds: activeCommittedEffectReceipts(effects).map(
								(receipt) => receipt.receiptId,
							),
						}
					: {}),
			};
		},
		times: 1,
	};
}
