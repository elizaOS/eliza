/**
 * Verifies that planner rendering carries complete tool-result text and data
 * into model messages without mutating the source trajectory.
 */
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../types/model";
import {
	toolMessageContent,
	trajectoryStepsToMessages,
} from "../planner-rendering";
import type { PlannerStep } from "../planner-types";

function stepWithResult(iteration: number, resultText: string): PlannerStep {
	return {
		iteration,
		thought: "test",
		toolCall: { id: `call-${iteration}`, name: "BASH", params: {} },
		result: { success: true, text: resultText },
	};
}

function getRenderedResultValue(messages: ChatMessage[]): string {
	const toolMsg = messages.find((message) => message.role === "tool");
	if (!toolMsg || !Array.isArray(toolMsg.content)) {
		throw new Error("expected a tool message with array content");
	}
	const part = toolMsg.content[0];
	if (
		!part ||
		typeof part !== "object" ||
		!("output" in part) ||
		typeof part.output !== "object" ||
		!part.output ||
		!("value" in part.output) ||
		typeof part.output.value !== "string"
	) {
		throw new Error("expected text-output tool result");
	}
	return part.output.value;
}

describe("trajectoryStepsToMessages", () => {
	it("renders a result larger than the former cap in full", () => {
		const result = `HEAD_SENTINEL${"x".repeat(150_000)}TAIL_SENTINEL`;
		const steps = [stepWithResult(1, result)];
		const rendered = getRenderedResultValue(trajectoryStepsToMessages(steps));
		expect(JSON.parse(rendered).text).toBe(result);
		expect(steps[0]?.result?.text).toBe(result);
	});

	it("renders every large step independently and completely", () => {
		const steps = Array.from({ length: 3 }, (_, index) =>
			stepWithResult(index + 1, `${index}:${"z".repeat(50_000)}:${index}`),
		);
		const messages = trajectoryStepsToMessages(steps).filter(
			(message) => message.role === "tool",
		);
		expect(messages).toHaveLength(3);
		for (const [index, message] of messages.entries()) {
			expect(JSON.parse(getRenderedResultValue([message])).text).toBe(
				`${index}:${"z".repeat(50_000)}:${index}`,
			);
		}
	});
});

describe("toolMessageContent", () => {
	it("renders both promptData and the complete machine payload", () => {
		const memories = Array.from({ length: 17 }, (_, index) => ({
			id: `id-${index}`,
			type: "facts",
			text: `stored fact ${index}: ${"detail ".repeat(400)}`,
		}));
		const rendered = toolMessageContent({
			success: true,
			text: "Showing all 17 match(es) found in the scanned window.",
			data: { actionName: "MEMORY", op: "search", memories },
			promptData: { actionName: "MEMORY", op: "search", matchedInWindow: 17 },
		});
		expect(rendered).toContain('"matchedInWindow": 17');
		expect(rendered).toContain("stored fact 0");
		expect(rendered).toContain("stored fact 16");
	});

	it("renders large chaining data completely", () => {
		const marker = `CHAINING_FIELD_${"x".repeat(150_000)}_END`;
		const rendered = toolMessageContent({
			success: true,
			text: "Created workspace.",
			data: { agentId: "a1", marker, workspaceId: "w1" },
		});
		expect(rendered).toContain(marker);
		expect(rendered).toContain('"workspaceId": "w1"');
	});

	it("renders large data completely when no text projection exists", () => {
		const rows = Array.from(
			{ length: 2_000 },
			(_, index) => `row ${index} ${"y".repeat(100)}`,
		);
		const rendered = toolMessageContent({ success: true, data: { rows } });
		expect(rendered).toContain("row 1999");
		expect(rendered).not.toMatch(/truncated|omitted/i);
	});
});
