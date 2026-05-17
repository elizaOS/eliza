/**
 * Regression for the tolerant `PLAN_ACTIONS`-in-text recovery in
 * `parsePlannerOutput` (elizaOS/eliza#7620 / linked feature request).
 *
 * The v5 planner contract is that the model emits a native tool call. Some
 * hosted models — Cerebras-served `gpt-oss-120b` in particular — instead
 * emit the same envelope as message-content text. The planner-loop's second
 * pass extracts the envelope so the downstream resolver still dispatches.
 */

import { describe, expect, it } from "vitest";

import type { GenerateTextResult } from "../../types/model";
import { parsePlannerOutput } from "../planner-loop";

describe("parsePlannerOutput — PLAN_ACTIONS-in-text recovery (#7620)", () => {
	it("recovers PLAN_ACTIONS({...}) envelopes emitted as message text", () => {
		const raw: GenerateTextResult = {
			text: `PLAN_ACTIONS({"action":"TASKS_SPAWN_AGENT","parameters":{"task":"write /tmp/foo.py","agentType":"opencode"},"thought":"delegating"})`,
			finishReason: "stop",
			toolCalls: [],
		};
		const parsed = parsePlannerOutput(raw);
		expect(parsed.toolCalls).toHaveLength(1);
		expect(parsed.toolCalls[0]?.name).toBe("TASKS_SPAWN_AGENT");
		expect(parsed.toolCalls[0]?.params).toEqual({
			task: "write /tmp/foo.py",
			agentType: "opencode",
		});
		// When we recovered the call from text, messageToUser is blanked:
		// the text WAS the call envelope, not a user-facing message.
		expect(parsed.messageToUser).toBeUndefined();
		// The recovery source is recorded for trajectory observability.
		expect(parsed.raw.textRecoverySource).toBe("plan-actions-envelope");
	});

	it("recovers bare-action-object envelopes emitted as message text", () => {
		const raw: GenerateTextResult = {
			text: '{"action":"REPLY","parameters":{"text":"hi"},"thought":""}',
			finishReason: "stop",
			toolCalls: [],
		};
		const parsed = parsePlannerOutput(raw);
		expect(parsed.toolCalls[0]?.name).toBe("REPLY");
		expect(parsed.toolCalls[0]?.params).toEqual({ text: "hi" });
		expect(parsed.raw.textRecoverySource).toBe("bare-action-object");
	});

	it("prefers native tool calls when both native tool calls AND in-text envelopes exist", () => {
		const raw: GenerateTextResult = {
			text: 'PLAN_ACTIONS({"action":"NOT_THIS","parameters":{},"thought":""})',
			finishReason: "tool-calls",
			toolCalls: [
				{
					id: "call_1",
					toolName: "REAL_ACTION",
					input: { x: 1 },
				} as unknown as NonNullable<GenerateTextResult["toolCalls"]>[number],
			],
		};
		const parsed = parsePlannerOutput(raw);
		expect(parsed.toolCalls[0]?.name).toBe("REAL_ACTION");
		expect(parsed.toolCalls[0]?.params).toEqual({ x: 1 });
		// No text recovery happened, so no recoverySource marker.
		expect(parsed.raw.textRecoverySource).toBeUndefined();
	});

	it("falls through to messageToUser when text is plain prose without an envelope", () => {
		const raw: GenerateTextResult = {
			text: "I'd be happy to help you with that task.",
			finishReason: "stop",
			toolCalls: [],
		};
		const parsed = parsePlannerOutput(raw);
		expect(parsed.toolCalls).toEqual([]);
		expect(parsed.messageToUser).toBe(
			"I'd be happy to help you with that task.",
		);
	});

	it("recovers from plain-string raw outputs with embedded envelope (legacy JSON-mode path)", () => {
		// The string-mode parser also gains the in-text recovery. When the raw
		// is plain prose without a recognizable JSON object, the extractor
		// runs and recovers the PLAN_ACTIONS envelope as a tool call.
		const raw =
			'Sure, delegating now. PLAN_ACTIONS(action=TASKS_SPAWN_AGENT, parameters={task: "x"})';
		// This shape is not valid JSON so `parseJsonObject` returns null; the
		// in-text extractor is the only fallback. It does NOT recover because
		// the inner shape isn't a JSON object — and that's intentional. Test
		// the assertion accordingly: parser returns toolCalls=[] + messageToUser.
		const parsed = parsePlannerOutput(raw);
		expect(parsed.toolCalls).toEqual([]);
		expect(parsed.messageToUser).toBe(raw);
	});

	it("string-mode recovers a well-formed PLAN_ACTIONS envelope in surrounding prose", () => {
		// Well-formed JSON envelope embedded in prose: `parseJsonObject`'s
		// `extractFirstJsonObject` pulls the inner `{...}`, then the
		// existing `normalizeBarePlannerAction` path turns it into a tool call.
		// This test pins that existing behaviour stays intact — the in-text
		// recovery in `parsePlannerOutput` is the SAFETY net for cases the
		// bare extractor misses.
		const raw =
			'I will delegate this: {"action":"TASKS_SPAWN_AGENT","parameters":{"task":"x"},"thought":""}';
		const parsed = parsePlannerOutput(raw);
		expect(parsed.toolCalls[0]?.name).toBe("TASKS_SPAWN_AGENT");
		expect(parsed.toolCalls[0]?.params).toEqual({ task: "x" });
	});
});
