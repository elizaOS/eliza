/**
 * Covers evaluator reasoning-residue parsing, successful-tool recovery, and
 * final planner egress with deterministic model/tool doubles. Valid completed
 * prefixes retain their envelope; dangling or mutated tags never become chat.
 */
import { describe, expect, it, vi } from "vitest";
import { parseEvaluatorOutput, runEvaluator } from "../evaluator";
import { isUnsafeUserVisibleText, runPlannerLoop } from "../planner-loop";

const ENVELOPE =
	'```json\n{ "success": true, "decision": "FINISH", "thought": "Documents store is empty.", "messageToUser": "Your documents store is empty." }\n```';

describe("evaluator reasoning-residue parsing", () => {
	it.each([
		"None</think>",
		"<THINK >synthetic reasoning</THINK >",
		"<thinking>synthetic reasoning</thinking>",
		'< reasoning provider="synthetic">synthetic reasoning</ reasoning >',
	])("parses a valid envelope after completed prefix %s", (prefix) => {
		const output = parseEvaluatorOutput(`${prefix}${ENVELOPE}`);
		expect(output.parseError).toBeUndefined();
		expect(output.decision).toBe("FINISH");
		expect(output.messageToUser).toBe("Your documents store is empty.");
	});

	it("still parses a plain fenced envelope", () => {
		const output = parseEvaluatorOutput(ENVELOPE);
		expect(output.parseError).toBeUndefined();
		expect(output.messageToUser).toBe("Your documents store is empty.");
	});
});

describe("successful-tool evaluator recovery", () => {
	async function recover(raw: string) {
		return runEvaluator({
			runtime: { useModel: vi.fn(async () => raw) },
			context: {
				id: "ctx",
				staticPrefix: {
					characterPrompt: { content: "agent_name: Eliza", stable: true },
				},
				events: [],
			},
			trajectory: {
				context: { id: "ctx" },
				steps: [
					{
						toolCall: { id: "tool-1", name: "SHELL", params: {} },
						result: { success: true, text: "synthetic tool result" },
					},
				],
				archivedSteps: [],
				plannedQueue: [],
				evaluatorOutputs: [],
			},
		});
	}

	it.each([
		"<think>synthetic internal analysis with no close",
		"<THINK >synthetic internal analysis with no close",
		"<thinking>synthetic internal analysis with no close",
		'< reasoning provider="synthetic">internal analysis with no close',
		"synthetic internal analysis</ THINK >synthetic prose",
	])("does not promote reasoning-tag residue as prose: %s", async (raw) => {
		const output = await recover(raw);
		expect(output.decision).toBe("CONTINUE");
		expect(output.messageToUser).toBeUndefined();
		expect(output.raw).toMatchObject({
			recoverySource: "reasoning_markup_text",
		});
	});
});

describe("reasoning residue at final egress", () => {
	it.each([
		"<think>synthetic internal",
		"</THINK >synthetic answer",
		"<thinking>synthetic internal</thinking>",
		"< reasoning >synthetic internal</ reasoning >",
	])("rejects provider tag variant %s", (text) => {
		expect(isUnsafeUserVisibleText(text)).toBe(true);
	});

	it("passes ordinary prose that merely mentions reasoning words", () => {
		expect(
			isUnsafeUserVisibleText(
				"I think the decision to finish early was a success.",
			),
		).toBe(false);
	});

	it("falls back to tool-owned text instead of emitting evaluator residue", async () => {
		const safeToolText = "Synthetic tool result is ready.";
		const result = await runPlannerLoop({
			runtime: {
				useModel: vi.fn().mockResolvedValueOnce({
					text: "",
					toolCalls: [
						{ id: "call-1", name: "SHELL", arguments: {} },
					],
				}),
			},
			context: { id: "ctx" },
			executeToolCall: vi.fn(async () => ({
				success: true,
				text: safeToolText,
				userFacingText: safeToolText,
			})),
			evaluate: vi.fn(async () => ({
				success: true,
				decision: "FINISH" as const,
				thought: "Synthetic evaluation.",
				messageToUser: "<THINK >synthetic internal analysis with no close",
			})),
		});

		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe(safeToolText);
		expect(result.finalMessage).not.toMatch(/<\s*\/?\s*think/i);
	});
});
