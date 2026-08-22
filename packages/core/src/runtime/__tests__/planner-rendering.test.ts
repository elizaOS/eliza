/**
 * Verifies that planner rendering carries complete tool-result text and data
 * into model messages without mutating the source trajectory.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../types/model";
import {
	projectToolResultForModel,
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
	it("uses promptData as a replacement and does not duplicate machine payload", () => {
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
		expect(rendered).not.toContain("stored fact 0");
		expect(rendered).not.toContain("stored fact 16");
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

	it("omits only recoverable page text when its serialized budget is exceeded", () => {
		const readView = {
			reference: { kind: "file" as const, ref: "file_opaque", revision: "r1" },
			slice: {
				range: { unit: "line" as const, start: 0, end: 100, total: 200 },
				hasPrevious: false,
				hasMore: true,
				nextOffset: 100,
				revision: "r1",
				completeness: "partial-recoverable" as const,
				sliceSha256: "a".repeat(64),
			},
		};
		const rendered = toolMessageContent(
			{
				success: true,
				text: `BEGIN${"x".repeat(20_000)}END`,
				data: { readView, body: "must-not-duplicate", path: "/raw/path" },
				promptData: { readView, actionName: "FILE" },
			},
			{ maxSerializedTokens: 500 },
		);
		const parsed = JSON.parse(rendered);
		expect(parsed.text).toBeUndefined();
		expect(parsed.data).toBeUndefined();
		expect(parsed.promptData.readView).toEqual(readView);
		expect(parsed.contentProjection).toEqual({
			textIncluded: false,
			reason: "model-input-budget",
		});
		expect(rendered).not.toContain("/raw/path");
		expect(rendered).not.toContain("must-not-duplicate");
	});

	it("preserves exact page text and its validated slice hash when included", () => {
		const text = `BEGIN\u0000é🙂\r\n${"exact ".repeat(200)}END`;
		const readView = readViewFor(text);
		const parsed = JSON.parse(
			toolMessageContent(
				{
					success: true,
					text,
					promptData: { actionName: "FILE", readView },
				},
				{ maxSerializedTokens: 10_000 },
			),
		);
		expect(parsed.text).toBe(text);
		expect(parsed.promptData.readView.slice.sliceSha256).toBe(
			readView.slice.sliceSha256,
		);
	});

	it("retains nested search references when oversized search prose is omitted", () => {
		const reference = {
			kind: "document" as const,
			ref: "document:00000000-0000-0000-0000-000000000001",
			revision: "rev:stable",
		};
		const parsed = JSON.parse(
			toolMessageContent(
				{
					success: true,
					text: "match ".repeat(10_000),
					promptData: { results: [{ reference }] },
				},
				{ maxSerializedTokens: 100 },
			),
		);
		expect(parsed.text).toBeUndefined();
		expect(parsed.promptData.results).toEqual([{ reference }]);
		expect(parsed.contentProjection).toEqual({
			textIncluded: false,
			reason: "model-input-budget",
		});
	});

	it("does not grant recoverable omission to a hostile ReadView-like shape", () => {
		const text = "x".repeat(20_000);
		const invalidReadView = {
			...readViewFor(text),
			rawPath: "/Users/private/secret.txt",
		};
		expect(() =>
			toolMessageContent(
				{
					success: true,
					text,
					promptData: { readView: invalidReadView },
				},
				{ maxSerializedTokens: 100 },
			),
		).toThrow(/Non-recoverable tool result exceeds/u);
	});

	it("reports only aggregate page inclusion and omission reasons", () => {
		const shortText = "short exact page";
		const longText = `BEGIN${"x".repeat(20_000)}END`;
		let stats:
			| Parameters<
					NonNullable<
						Parameters<typeof trajectoryStepsToMessages>[1]["onProjectionStats"]
					>
			  >[0]
			| null = null;
		trajectoryStepsToMessages(
			[
				{
					...stepWithResult(1, shortText),
					result: {
						success: true,
						text: shortText,
						promptData: { readView: readViewFor(shortText) },
					},
				},
				{
					...stepWithResult(2, longText),
					result: {
						success: true,
						text: longText,
						promptData: { readView: readViewFor(longText) },
					},
				},
			],
			{
				projectionBudget: { perResultTokens: 500, aggregateTokens: 1_000 },
				onProjectionStats: (value) => {
					stats = value;
				},
			},
		);
		expect(stats).toEqual({
			resultCount: 2,
			pagesIncluded: 1,
			pagesOmitted: 1,
			omissionReasons: { "model-input-budget": 1 },
		});
		expect(JSON.stringify(stats)).not.toMatch(
			/short exact page|BEGIN|file_opaque/u,
		);
	});

	it("fails explicitly instead of truncating a non-recoverable result", () => {
		expect(() =>
			toolMessageContent(
				{ success: true, text: "x".repeat(20_000) },
				{ maxSerializedTokens: 100 },
			),
		).toThrow(/Non-recoverable tool result exceeds/u);
	});

	it("does not mutate the complete trajectory result during projection", () => {
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
