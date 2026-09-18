/**
 * Captures real planner rendering across a tool/replan boundary. Model replies
 * are deterministic; the test exercises input serialization, not model quality.
 */
import { describe, expect, it, vi } from "vitest";
import { runPlannerLoop } from "../../../../../plugins/plugin-assistant/src/runtime/planner-loop.ts";
import type { ChatMessage } from "../../types/model";
import type { PlannerRuntime, PlannerToolResult } from "../planner-types";

function toolValue(messages: ChatMessage[], name = "LOOKUP"): string {
	for (const message of messages) {
		if (message.role !== "tool" || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (
				part.type === "tool-result" &&
				part.toolName === name &&
				"output" in part &&
				part.output?.type === "text" &&
				typeof part.output.value === "string"
			) {
				return part.output.value;
			}
		}
	}
	throw new Error(`Missing ${name} text result`);
}

async function renderAfterTool(extraHistory: ChatMessage[] = []) {
	const result: PlannerToolResult = {
		success: true,
		text: "  exact whitespace\r\n\tUnicode 🦉.  ",
		data: {
			noteId: "note-1",
			body: "first\n  second\n",
			permission: { canRead: true, canDelete: false },
			futureField: { complete: [false, null, 0, ""] },
		},
		promptData: { source: "full supplemental evidence" },
	};
	const originalResult = JSON.stringify(result);
	const originalExtra = JSON.stringify(extraHistory);
	const calls: ChatMessage[][] = [];
	const useModel = vi.fn<PlannerRuntime["useModel"]>(async (_, params) => {
		calls.push(params.messages ?? []);
		return {
			text: "",
			toolCalls:
				calls.length === 1
					? [{ id: "lookup", name: "LOOKUP", arguments: {} }]
					: [
							{
								id: "reply",
								name: "REPLY",
								arguments: { text: "Read complete." },
							},
						],
		};
	});
	let evaluations = 0;
	let storedHistory: ChatMessage[] = [];
	let storedSnapshot = "";
	const output = await runPlannerLoop({
		runtime: { useModel },
		context: { id: "canonical-tool-input" },
		tools: [{ name: "LOOKUP" }, { name: "REPLY" }],
		executeToolCall: vi.fn(async () => result),
		evaluate: ({ trajectory }) => {
			if (++evaluations === 1) {
				trajectory.modelHistory?.push(...extraHistory);
				storedHistory = [...(trajectory.modelHistory ?? [])];
				storedSnapshot = JSON.stringify(storedHistory);
				return {
					success: false,
					decision: "CONTINUE",
					thought: "Answer using the complete read result.",
				};
			}
			return {
				success: true,
				decision: "FINISH",
				messageToUser: "Read complete.",
			};
		},
	});
	expect(output.finalMessage).toBe("Read complete.");
	expect(calls).toHaveLength(2);
	expect(JSON.stringify(result)).toBe(originalResult);
	expect(JSON.stringify(extraHistory)).toBe(originalExtra);
	expect(JSON.stringify(storedHistory)).toBe(storedSnapshot);
	return { calls, storedHistory };
}

describe("planner canonical tool JSON input", () => {
	it("removes only indentation from the wire copy, preserving every string and field", async () => {
		const { calls, storedHistory } = await renderAfterTool();
		const original = toolValue(storedHistory);
		const projected = toolValue(calls[1]);
		expect(original).toBe(JSON.stringify(JSON.parse(original), null, 2));
		expect(projected).toBe(JSON.stringify(JSON.parse(original)));
		expect(projected.length).toBeLessThan(original.length);
		expect(JSON.parse(projected)).toEqual(JSON.parse(original));
		expect(JSON.parse(projected).text).toBe(
			"  exact whitespace\r\n\tUnicode 🦉.  ",
		);
		expect(JSON.parse(projected).data.permission).toEqual({
			canRead: true,
			canDelete: false,
		});
		expect(JSON.parse(projected).promptData).toEqual({
			source: "full supplemental evidence",
		});
	});

	it.each([
		'Raw evidence before {"a":1} and after.',
		'{"id":9007199254740993}',
		'{\n  "id": 9007199254740993\n}',
		'{"a":1,"a":2}',
		'{\n  "a": 1,\n  "a": 2\n}',
		'```json\n{"a":1}\n```',
		'{"invalid":"\\q"}',
		'{"already":"compact"}',
	])("keeps custom or noncanonical evidence unchanged: %s", async (value) => {
		const custom: ChatMessage = {
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "custom",
					toolName: "CUSTOM",
					output: { type: "text", value },
				},
			],
		};
		const { calls, storedHistory } = await renderAfterTool([custom]);
		expect(toolValue(calls[1], "CUSTOM")).toBe(value);
		expect(toolValue(storedHistory, "CUSTOM")).toBe(value);
	});
});
