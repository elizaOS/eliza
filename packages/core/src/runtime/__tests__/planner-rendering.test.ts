import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../types/model";
import {
	trajectoryStepsToMessages,
	truncateToolResultText,
} from "../planner-rendering";
import type { PlannerStep } from "../planner-types";

/**
 * Build a single completed planner step whose tool-result text is the
 * provided string. Test-only helper — the actual planner emits a richer
 * structure, but for the truncation render-path only the result text
 * matters.
 */
function stepWithResult(
	iteration: number,
	toolName: string,
	resultText: string,
): PlannerStep {
	return {
		iteration,
		thought: "test",
		toolCall: {
			id: `call-${iteration}`,
			name: toolName,
			params: {},
		},
		result: {
			success: true,
			text: resultText,
		},
	};
}

function getRenderedResultValue(messages: ChatMessage[]): string {
	const toolMsg = messages.find((m) => m.role === "tool");
	if (!toolMsg) throw new Error("expected a tool message");
	const content = toolMsg.content;
	if (!Array.isArray(content)) throw new Error("tool content must be array");
	const part = content[0];
	if (
		!part ||
		typeof part !== "object" ||
		!("output" in part) ||
		typeof part.output !== "object" ||
		!part.output ||
		!("value" in part.output) ||
		typeof part.output.value !== "string"
	) {
		throw new Error("expected text-output tool-result");
	}
	return part.output.value;
}

describe("truncateToolResultText (pure)", () => {
	it("returns input unchanged when maxChars is undefined", () => {
		const input = "x".repeat(20_000);
		expect(truncateToolResultText(input, undefined)).toBe(input);
	});

	it("returns input unchanged when maxChars is 0 or negative", () => {
		const input = "x".repeat(20_000);
		expect(truncateToolResultText(input, 0)).toBe(input);
		expect(truncateToolResultText(input, -5)).toBe(input);
	});

	it("returns input unchanged when maxChars is non-finite", () => {
		const input = "x".repeat(20_000);
		expect(truncateToolResultText(input, Number.NaN)).toBe(input);
		expect(truncateToolResultText(input, Number.POSITIVE_INFINITY)).toBe(input);
	});

	it("returns input unchanged when it already fits", () => {
		const input = "short text";
		expect(truncateToolResultText(input, 1_000)).toBe(input);
	});

	it("truncates with a head + marker + tail when input exceeds maxChars", () => {
		const input = `${"H".repeat(2_000)}${"M".repeat(20_000)}${"T".repeat(2_000)}`;
		const out = truncateToolResultText(input, 1_000);
		expect(out.length).toBeLessThan(input.length);
		expect(out.length).toBeLessThanOrEqual(1_000);
		expect(out).toMatch(/chars truncated/);
		// Head must start with H, tail must end with T — proves we kept
		// both ends rather than slicing only from one side.
		expect(out.startsWith("H")).toBe(true);
		expect(out.endsWith("T")).toBe(true);
		// The marker carries the count of dropped characters.
		const match = out.match(/\[(\d+) chars truncated\]/);
		expect(match).not.toBeNull();
		const dropped = Number.parseInt(match?.[1] ?? "0", 10);
		expect(dropped).toBeGreaterThan(0);
		expect(dropped).toBeLessThan(input.length);
	});

	it("preserves the byte count: head + truncated + tail = original length", () => {
		const input = `${"A".repeat(5_000)}${"B".repeat(50_000)}${"C".repeat(5_000)}`;
		const out = truncateToolResultText(input, 2_000);
		const match = out.match(/\[(\d+) chars truncated\]/);
		expect(match).not.toBeNull();
		const dropped = Number.parseInt(match?.[1] ?? "0", 10);
		// Strip the marker (and the surrounding `" [N chars truncated] "`)
		// to count the preserved bytes.
		const preserved = out.replace(/\s\[\d+ chars truncated\]\s/, "").length;
		expect(preserved + dropped).toBe(input.length);
	});

	it("emits a deterministic 60/40 head/tail split for large inputs", () => {
		const input = `${"H".repeat(60_000)}${"T".repeat(40_000)}`;
		const out = truncateToolResultText(input, 1_000);
		const match = out.match(/^(H+)\s+\[\d+ chars truncated\]\s+(T+)$/);
		expect(match).not.toBeNull();
		const headLen = match?.[1]?.length ?? 0;
		const tailLen = match?.[2]?.length ?? 0;
		// 60/40 split of the usable budget — head should be roughly 1.5x tail.
		expect(headLen).toBeGreaterThan(tailLen);
		expect(headLen / tailLen).toBeGreaterThanOrEqual(1.4);
		expect(headLen / tailLen).toBeLessThanOrEqual(1.6);
	});

	it("still respects tiny caps that cannot fit a marker", () => {
		const input = "x".repeat(15);
		const out = truncateToolResultText(input, 10);
		expect(out).toBe("x".repeat(10));
		expect(out.length).toBeLessThanOrEqual(10);
	});

	it("never exceeds maxChars when the truncated-count marker grows digits", () => {
		const input = "x".repeat(1_000_000);
		const out = truncateToolResultText(input, 80);
		expect(out.length).toBeLessThanOrEqual(80);
		expect(out).toMatch(/chars truncated/);
	});
});

describe("trajectoryStepsToMessages — maxToolResultChars option", () => {
	// `toolMessageContent` (called inside `trajectoryStepsToMessages`)
	// wraps the raw `result.text` as `text: <body>`, so the assertions
	// compare against that wire shape.
	const RESULT_PREFIX = "text: ";

	it("renders full result text when maxToolResultChars is unset (back-compat)", () => {
		const longResult = "y".repeat(50_000);
		const steps = [stepWithResult(1, "BASH", longResult)];
		const messages = trajectoryStepsToMessages(steps);
		expect(getRenderedResultValue(messages)).toBe(
			`${RESULT_PREFIX}${longResult}`,
		);
	});

	it("renders full result text when maxToolResultChars is undefined (explicit)", () => {
		const longResult = "y".repeat(50_000);
		const steps = [stepWithResult(1, "BASH", longResult)];
		const messages = trajectoryStepsToMessages(steps, {
			maxToolResultChars: undefined,
		});
		expect(getRenderedResultValue(messages)).toBe(
			`${RESULT_PREFIX}${longResult}`,
		);
	});

	it("truncates oversized results when maxToolResultChars is set", () => {
		const longResult = `${"A".repeat(20_000)}${"B".repeat(20_000)}`;
		const steps = [stepWithResult(1, "BASH", longResult)];
		const messages = trajectoryStepsToMessages(steps, {
			maxToolResultChars: 1_000,
		});
		const rendered = getRenderedResultValue(messages);
		expect(rendered.length).toBeLessThan(longResult.length);
		expect(rendered).toMatch(/chars truncated/);
	});

	it("does not truncate already-small results when maxToolResultChars is set", () => {
		const smallResult = "ok";
		const steps = [stepWithResult(1, "BASH", smallResult)];
		const messages = trajectoryStepsToMessages(steps, {
			maxToolResultChars: 1_000,
		});
		expect(getRenderedResultValue(messages)).toBe(
			`${RESULT_PREFIX}${smallResult}`,
		);
	});

	it("truncates each oversized step independently (per-step cap, not global)", () => {
		const longResult = "Z".repeat(10_000);
		const steps = [
			stepWithResult(1, "BASH", longResult),
			stepWithResult(2, "BASH", longResult),
			stepWithResult(3, "BASH", longResult),
		];
		const messages = trajectoryStepsToMessages(steps, {
			maxToolResultChars: 500,
		});
		const toolMessages = messages.filter((m) => m.role === "tool");
		expect(toolMessages.length).toBe(3);
		// Every tool result message should carry the truncation marker.
		for (const m of toolMessages) {
			const content = m.content;
			if (!Array.isArray(content)) throw new Error("expected array content");
			const part = content[0];
			if (
				!part ||
				typeof part !== "object" ||
				!("output" in part) ||
				typeof part.output !== "object" ||
				!part.output ||
				!("value" in part.output) ||
				typeof part.output.value !== "string"
			) {
				throw new Error("expected text-output tool-result");
			}
			expect(part.output.value).toMatch(/chars truncated/);
			expect(part.output.value.length).toBeLessThan(longResult.length);
		}
	});

	it("does not mutate the underlying PlannerStep.result.text", () => {
		const original = "X".repeat(20_000);
		const steps: PlannerStep[] = [stepWithResult(1, "BASH", original)];
		trajectoryStepsToMessages(steps, { maxToolResultChars: 200 });
		// Trajectory must remain pristine — only the rendered message is truncated.
		expect(steps[0]?.result?.text).toBe(original);
	});
});
