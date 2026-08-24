/**
 * Exercises the shared user-visible model-output boundary with adversarial
 * envelope nesting and genuine JSON. Pure parser tests; no model or runtime.
 */
import { describe, expect, it } from "vitest";
import {
	looksLikeActionEnvelopeJson,
	sanitizeUserVisibleModelOutput,
} from "../user-visible-model-output";

describe("sanitizeUserVisibleModelOutput", () => {
	it("rejects a fenced action envelope even when foreign metadata keys are present", () => {
		const output = sanitizeUserVisibleModelOutput(
			'```json\n{"action":"BROWSER","parameters":{"url":"https://example.com"},"status":"retry","toolCallId":"call-1"}\n```',
		);

		expect(output).toEqual({
			kind: "control",
			envelope: "action",
			malformed: false,
			fieldPath: [],
		});
		expect(
			looksLikeActionEnvelopeJson(
				'{"action":"BROWSER","parameters":{},"status":"retry"}',
			),
		).toBe(true);
	});

	it("recursively rejects action envelopes hidden in nested reply fields", () => {
		const action = JSON.stringify({
			action: "WEB_SEARCH",
			parameters: { query: "current weather" },
			thought: "search first",
			metadata: { attempt: 2 },
		});
		const output = sanitizeUserVisibleModelOutput(
			JSON.stringify({
				response: JSON.stringify({
					messageToUser: `\`\`\`json\n${action}\n\`\`\``,
				}),
			}),
		);

		expect(output).toEqual({
			kind: "control",
			envelope: "action",
			malformed: false,
			fieldPath: ["response", "messageToUser"],
		});

		expect(
			sanitizeUserVisibleModelOutput(
				JSON.stringify({
					response: action,
					traceId: "trace-1",
					foreignMetadata: true,
				}),
			),
		).toEqual({
			kind: "control",
			envelope: "action",
			malformed: false,
			fieldPath: ["response"],
		});
	});

	it("unwraps nested response scaffolds until it reaches plain user text", () => {
		const output = sanitizeUserVisibleModelOutput(
			JSON.stringify({
				response: JSON.stringify({
					replyText: "Something went wrong. Please try again.",
				}),
			}),
		);

		expect(output).toEqual({
			kind: "text",
			text: "Something went wrong. Please try again.",
			format: "plain",
			fieldPath: ["response", "replyText"],
		});
	});

	it("rejects a truncated action envelope as malformed control data", () => {
		for (const candidate of [
			'{"action":"BROWSER","parameters":{"url":"https://example.com"},"status":',
			'{"action":"BROWSER"',
			'{"action":"BROWSER"}',
		]) {
			expect(sanitizeUserVisibleModelOutput(candidate)).toEqual({
				kind: "control",
				envelope: "action",
				malformed: true,
				fieldPath: [],
			});
		}
	});

	it("rejects single-line fences and nested OpenAI function-call records", () => {
		expect(
			sanitizeUserVisibleModelOutput(
				'```json {"action":"BROWSER","parameters":{"url":"https://example.com"}} ```',
			),
		).toMatchObject({
			kind: "control",
			envelope: "action",
			malformed: false,
		});
		expect(
			sanitizeUserVisibleModelOutput(
				'{"function":{"name":"WEB_SEARCH","arguments":"{\\"query\\":\\"weather\\"}"},"id":"call-1"}',
			),
		).toMatchObject({
			kind: "control",
			envelope: "planner",
			malformed: false,
		});
	});

	it("rejects control records in direct JSON arrays while preserving ordinary arrays", () => {
		expect(
			sanitizeUserVisibleModelOutput(
				'[{"label":"first"},{"action":"BROWSER","parameters":{"url":"https://example.com"}}]',
			),
		).toEqual({
			kind: "control",
			envelope: "action",
			malformed: false,
			fieldPath: [],
		});

		const ordinary = '[{"label":"first"},{"action":"proceed","step":2}]';
		expect(sanitizeUserVisibleModelOutput(ordinary)).toEqual({
			kind: "text",
			text: ordinary,
			format: "json",
			fieldPath: [],
		});
	});

	it("preserves genuine JSON instead of treating any action key as control", () => {
		const lowerCaseAction =
			'{"action":"proceed","parameters":{"step":1},"status":"done","summary":"approved"}';
		expect(sanitizeUserVisibleModelOutput(lowerCaseAction)).toEqual({
			kind: "text",
			text: lowerCaseAction,
			format: "json",
			fieldPath: [],
		});

		const documentedExample =
			'{"example":{"action":"BROWSER","parameters":{"url":"https://example.com"}},"description":"planner schema example"}';
		expect(sanitizeUserVisibleModelOutput(documentedExample)).toEqual({
			kind: "text",
			text: documentedExample,
			format: "json",
			fieldPath: [],
		});
	});

	it("returns an explicit invalid result for a reply scaffold with no usable field", () => {
		expect(
			sanitizeUserVisibleModelOutput(
				'{"shouldRespond":true,"replyText":"","contexts":["simple"]}',
			),
		).toEqual({
			kind: "invalid",
			reason: "reply-envelope-without-text",
			fieldPath: [],
		});
	});
});

describe("sanitizeUserVisibleModelOutput: plain and empty inputs", () => {
	it("passes ordinary prose through as plain text", () => {
		expect(
			sanitizeUserVisibleModelOutput("Please summarise the thread."),
		).toEqual({
			kind: "text",
			text: "Please summarise the thread.",
			format: "plain",
			fieldPath: [],
		});
	});

	it("trims surrounding whitespace from plain text", () => {
		expect(sanitizeUserVisibleModelOutput("   hello there   ")).toEqual({
			kind: "text",
			text: "hello there",
			format: "plain",
			fieldPath: [],
		});
	});

	it("reports empty output for undefined and whitespace-only input", () => {
		expect(sanitizeUserVisibleModelOutput(undefined)).toEqual({
			kind: "empty",
			fieldPath: [],
		});
		expect(sanitizeUserVisibleModelOutput("  \n\t  ")).toEqual({
			kind: "empty",
			fieldPath: [],
		});
	});

	it("keeps an empty JSON object visible as json text", () => {
		expect(sanitizeUserVisibleModelOutput("{}")).toEqual({
			kind: "text",
			text: "{}",
			format: "json",
			fieldPath: [],
		});
	});
});

describe("evaluator envelope classification", () => {
	it("classifies well-formed evaluator decisions as control", () => {
		expect(
			sanitizeUserVisibleModelOutput(
				'{"decision":"FINISH","success":true,"thought":"done"}',
			),
		).toEqual({
			kind: "control",
			envelope: "evaluator",
			malformed: false,
			fieldPath: [],
		});
		expect(
			sanitizeUserVisibleModelOutput(
				'{"route":"continue","recommendedToolCallId":"call-9"}',
			),
		).toEqual({
			kind: "control",
			envelope: "evaluator",
			malformed: false,
			fieldPath: [],
		});
	});

	it("rejects a truncated evaluator record as malformed control data", () => {
		expect(
			sanitizeUserVisibleModelOutput('{"decision":"FINISH","success":'),
		).toEqual({
			kind: "control",
			envelope: "evaluator",
			malformed: true,
			fieldPath: [],
		});
	});

	it("exposes the evaluator probe helper", async () => {
		const { looksLikeEvaluatorEnvelopeJson } = await import(
			"../user-visible-model-output"
		);
		expect(
			looksLikeEvaluatorEnvelopeJson(
				'{"decision":"NEXT_RECOMMENDED","nextTool":{"name":"BROWSER"}}',
			),
		).toBe(true);
		expect(looksLikeEvaluatorEnvelopeJson("plain sentence")).toBe(false);
	});
});

describe("spawn envelope classification", () => {
	it("classifies records carrying two or more spawn discriminators", () => {
		expect(
			sanitizeUserVisibleModelOutput(
				'{"task":"water the plants","agentType":"assistant"}',
			),
		).toEqual({
			kind: "control",
			envelope: "spawn",
			malformed: false,
			fieldPath: [],
		});
	});

	it("keeps a single-discriminator record visible as ordinary json", () => {
		const single = '{"task":"water the plants"}';
		expect(sanitizeUserVisibleModelOutput(single)).toEqual({
			kind: "text",
			text: single,
			format: "json",
			fieldPath: [],
		});
	});

	it("exposes the spawn probe helper", async () => {
		const { looksLikeSpawnEnvelopeJson } = await import(
			"../user-visible-model-output"
		);
		expect(
			looksLikeSpawnEnvelopeJson(
				'{"brief":"daily standup notes","approvalPreset":"auto"}',
			),
		).toBe(true);
		expect(looksLikeSpawnEnvelopeJson('{"task":"one key only"}')).toBe(false);
	});
});

describe("planner envelope classification", () => {
	it("classifies toolCalls lists and narrated tool names as planner control", () => {
		expect(
			sanitizeUserVisibleModelOutput(
				'{"toolCalls":[{"name":"BROWSER","arguments":{}}]}',
			),
		).toMatchObject({
			kind: "control",
			envelope: "planner",
			malformed: false,
		});
		expect(
			sanitizeUserVisibleModelOutput(
				'{"toolName":"FILE_WRITE","input":{"path":"/tmp/notes.txt"}}',
			),
		).toMatchObject({
			kind: "control",
			envelope: "planner",
			malformed: false,
		});
	});

	it("rejects a truncated toolCalls record as malformed planner control data", () => {
		expect(
			sanitizeUserVisibleModelOutput('{"toolCalls":[{"id":'),
		).toMatchObject({
			kind: "control",
			envelope: "planner",
			malformed: true,
		});
	});
});

describe("action name forms", () => {
	it("accepts the functions.-prefixed action name form", () => {
		expect(
			sanitizeUserVisibleModelOutput(
				'{"action":"functions.WEB_SEARCH","parameters":{}}',
			),
		).toEqual({
			kind: "control",
			envelope: "action",
			malformed: false,
			fieldPath: [],
		});
	});

	it("reports false from the action probe helper for non-action output", () => {
		expect(
			looksLikeActionEnvelopeJson('{"toolCalls":[{"name":"BROWSER"}]}'),
		).toBe(false);
		expect(looksLikeActionEnvelopeJson("just prose")).toBe(false);
	});
});

describe("reply envelope depth limit", () => {
	const wrap = (inner: string) => JSON.stringify({ response: inner });

	it("accepts scaffolds up to the maximum depth", () => {
		let payload = "all done";
		for (let i = 0; i < 8; i += 1) payload = wrap(payload);
		expect(sanitizeUserVisibleModelOutput(payload)).toEqual({
			kind: "text",
			text: "all done",
			format: "plain",
			fieldPath: Array.from({ length: 8 }, () => "response"),
		});
	});

	it("rejects scaffolds beyond the maximum depth", () => {
		let payload = "all done";
		for (let i = 0; i < 9; i += 1) payload = wrap(payload);
		expect(sanitizeUserVisibleModelOutput(payload)).toEqual({
			kind: "invalid",
			reason: "reply-envelope-too-deep",
			fieldPath: Array.from({ length: 9 }, () => "response"),
		});
	});
});

describe("whole-message fence unwrapping", () => {
	it("unwraps an untagged whole-message fence", () => {
		expect(
			sanitizeUserVisibleModelOutput(
				'```\n{"action":"BROWSER","parameters":{"url":"https://example.com"}}\n```',
			),
		).toEqual({
			kind: "control",
			envelope: "action",
			malformed: false,
			fieldPath: [],
		});
	});

	it("leaves partial fences visible as plain prose", () => {
		const partial = "```json\nnot closed yet";
		expect(sanitizeUserVisibleModelOutput(partial)).toEqual({
			kind: "text",
			text: partial,
			format: "plain",
			fieldPath: [],
		});
	});
});

describe("reply field priority", () => {
	it("prefers usable text in a later reply field over an earlier rejected control record", () => {
		const output = sanitizeUserVisibleModelOutput(
			JSON.stringify({
				messageToUser:
					'{"action":"BROWSER","parameters":{"url":"https://example.com"}}',
				text: "Opening the page now.",
			}),
		);
		expect(output).toEqual({
			kind: "text",
			text: "Opening the page now.",
			format: "plain",
			fieldPath: ["text"],
		});
	});
});

describe("array propagation", () => {
	it("preserves arrays whose entries carry no control data", () => {
		const mixed = '[null, 3, "", "ok"]';
		expect(sanitizeUserVisibleModelOutput(mixed)).toEqual({
			kind: "text",
			text: mixed,
			format: "json",
			fieldPath: [],
		});
	});

	it("propagates an invalid reply scaffold found inside an array", () => {
		const scaffold = JSON.stringify({
			shouldRespond: true,
			contexts: ["simple"],
		});
		expect(sanitizeUserVisibleModelOutput(`["fine", ${scaffold}]`)).toEqual({
			kind: "invalid",
			reason: "reply-envelope-without-text",
			fieldPath: [],
		});
	});
});
