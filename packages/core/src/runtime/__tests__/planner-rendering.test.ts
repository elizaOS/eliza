/**
 * Verifies that planner rendering carries complete tool-result text and data
 * into model messages without mutating the source trajectory.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../types/model";
import {
	projectToolResultForModel,
	renderActionResultsForModel,
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

function readViewFor(text: string) {
	return {
		reference: { kind: "file" as const, ref: "file_opaque", revision: "r1" },
		slice: {
			range: { unit: "line" as const, start: 0, end: 100, total: 200 },
			hasPrevious: false,
			hasMore: true,
			nextOffset: 100,
			revision: "r1",
			completeness: "partial-recoverable" as const,
			sliceSha256: createHash("sha256").update(text).digest("hex"),
		},
	};
}

describe("trajectoryStepsToMessages", () => {
	it("renders every large step independently and completely", () => {
		const steps = Array.from({ length: 3 }, (_, index) =>
			stepWithResult(
				index + 1,
				`HEAD_${index}:${"z".repeat(150_000)}:TAIL_${index}`,
			),
		);
		const messages = trajectoryStepsToMessages(steps).filter(
			(message) => message.role === "tool",
		);
		expect(messages).toHaveLength(3);
		for (const [index, message] of messages.entries()) {
			expect(JSON.parse(getRenderedResultValue([message])).text).toBe(
				`HEAD_${index}:${"z".repeat(150_000)}:TAIL_${index}`,
			);
		}
	});
});

describe("renderActionResultsForModel", () => {
	it("preserves complete recoverable and non-recoverable results", () => {
		const page = `PAGE_HEAD${"x".repeat(50_000)}PAGE_TAIL`;
		const shell = `SHELL_HEAD${"y".repeat(50_000)}SHELL_TAIL`;
		const rendered = renderActionResultsForModel([
			{
				success: true,
				text: page,
				data: { actionName: "FILE", rawBody: "SECOND_CARRIER" },
				promptData: { actionName: "FILE", readView: readViewFor(page) },
			},
			{ success: true, text: shell, data: { actionName: "BASH" } },
		]);

		expect(rendered.text).toContain(page);
		expect(rendered.text).toContain(shell);
		expect(rendered.text).not.toContain("SECOND_CARRIER");
		expect(rendered.stats).toEqual({
			resultCount: 2,
			pagesIncluded: 1,
			pagesOmitted: 0,
			omissionReasons: {},
		});
	});

	it("redacts credentials without dropping surrounding content", () => {
		const rendered = renderActionResultsForModel([
			{
				success: true,
				text: "HEAD completed with sk-test-secret-value TAIL",
				data: { apiKey: "must-not-leak", actionName: "FETCH" },
			},
		]);
		expect(rendered.text).toContain("HEAD");
		expect(rendered.text).toContain("TAIL");
		expect(rendered.text).not.toContain("sk-test-secret-value");
		expect(rendered.text).not.toContain("must-not-leak");
		expect(rendered.text).toContain("[REDACTED]");
	});
});

describe("toolMessageContent", () => {
	it("uses promptData as a replacement without dropping complete text", () => {
		const text = `BEGIN\u0000é🙂\r\n${"exact ".repeat(20_000)}END`;
		const readView = readViewFor(text);
		const parsed = JSON.parse(
			toolMessageContent({
				success: true,
				text,
				data: { rawMachinePayload: "must-not-duplicate" },
				promptData: { actionName: "FILE", readView },
			}),
		);
		expect(parsed.text).toBe(text);
		expect(parsed.data).toBeUndefined();
		expect(parsed.promptData.readView).toEqual(readView);
		expect(parsed.contentProjection).toBeUndefined();
	});

	it("preserves large structured data and the first, middle, and last fields", () => {
		const rows = Array.from(
			{ length: 2_000 },
			(_, index) => `row ${index} ${"y".repeat(100)}`,
		);
		const rendered = toolMessageContent({
			success: true,
			data: { first: "FIRST", rows, middle: "MIDDLE", last: "LAST" },
		});
		expect(rendered).toContain("FIRST");
		expect(rendered).toContain("row 1000");
		expect(rendered).toContain("row 1999");
		expect(rendered).toContain("MIDDLE");
		expect(rendered).toContain("LAST");
		expect(rendered).not.toMatch(/truncated|omitted/i);
	});

	it("does not mutate the complete trajectory result", () => {
		const result = {
			success: true,
			text: "page",
			data: { complete: "runtime" },
			promptData: { safe: "model" },
		};
		const projected = projectToolResultForModel(result);
		expect(projected.data).toBeUndefined();
		expect(result.data).toEqual({ complete: "runtime" });
	});
});
