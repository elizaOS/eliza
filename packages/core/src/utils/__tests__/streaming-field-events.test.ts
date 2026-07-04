/**
 * Streaming field extractors (StructuredFieldStreamExtractor,
 * ResponseSkeletonStreamExtractor): per-field start/done/chunk events, clean
 * text-only streaming, JSON-skeleton field selection, think-tag hiding, and
 * abort handling, fed in small slices to exercise chunk boundaries.
 */
import { describe, expect, it } from "vitest";
import type { SchemaRow } from "../../types/state";
import {
	ResponseSkeletonStreamExtractor,
	StructuredFieldStreamExtractor,
} from "../streaming";

const schema: SchemaRow[] = [
	{ field: "thought", description: "internal reasoning" },
	{ field: "replyText", description: "user-facing reply", streamField: true },
	{ field: "contexts", description: "context ids" },
	{ field: "facts", description: "durable facts", type: "array" },
];

function feed(extractor: StructuredFieldStreamExtractor, text: string): void {
	// Feed in small slices to exercise the line buffer across chunk boundaries.
	for (let i = 0; i < text.length; i += 7) {
		extractor.push(text.slice(i, i + 7));
	}
}

describe("StructuredFieldStreamExtractor per-field events", () => {
	it("emits onFieldStart/onFieldDone in document order for every top-level field", () => {
		const starts: string[] = [];
		const dones: Array<[string, string]> = [];
		const chunks: Array<[string | undefined, string]> = [];
		const extractor = new StructuredFieldStreamExtractor({
			level: 0,
			schema,
			streamFields: ["replyText"],
			onChunk: (chunk, field) => chunks.push([field, chunk]),
			onFieldStart: (f) => starts.push(f),
			onFieldDone: (f, v) => dones.push([f, v]),
		});

		// Line-oriented "field: value" form (the dynamicPromptExecFromState format).
		feed(
			extractor,
			[
				"thought: routing to a simple reply",
				"replyText: Hello there, friend.",
				'contexts: ["simple"]',
				"facts: []",
			].join("\n"),
		);
		extractor.flush();

		expect(starts).toEqual(["thought", "replyText", "contexts", "facts"]);
		expect(dones.map(([f]) => f)).toEqual([
			"thought",
			"replyText",
			"contexts",
			"facts",
		]);
		// Decoded values arrive on onFieldDone.
		const replyDone = dones.find(([f]) => f === "replyText");
		expect(replyDone?.[1]).toBe("Hello there, friend.");
		const thoughtDone = dones.find(([f]) => f === "thought");
		expect(thoughtDone?.[1]).toBe("routing to a simple reply");
		// onChunk only fires for the streamed field.
		expect(chunks.every(([f]) => f === "replyText")).toBe(true);
		expect(chunks.map(([, c]) => c).join("")).toBe("Hello there, friend.");
	});

	it("fires onFieldStart('replyText') before any replyText chunk", () => {
		const order: string[] = [];
		const extractor = new StructuredFieldStreamExtractor({
			level: 0,
			schema,
			streamFields: ["replyText"],
			onChunk: (_chunk, field) => {
				if (field === "replyText") order.push("chunk");
			},
			onFieldStart: (f) => {
				if (f === "replyText") order.push("start");
			},
			onFieldDone: (f) => {
				if (f === "replyText") order.push("done");
			},
		});

		feed(
			extractor,
			["thought: x", "replyText: one two three", 'contexts: ["simple"]'].join(
				"\n",
			),
		);
		extractor.flush();

		expect(order[0]).toBe("start");
		expect(order[order.length - 1]).toBe("done");
		expect(order).toContain("chunk");
	});

	it("does not double-fire onFieldStart/onFieldDone", () => {
		const starts: string[] = [];
		const dones: string[] = [];
		const extractor = new StructuredFieldStreamExtractor({
			level: 0,
			schema,
			streamFields: ["replyText"],
			onChunk: () => {},
			onFieldStart: (f) => starts.push(f),
			onFieldDone: (f) => dones.push(f),
		});

		feed(
			extractor,
			["replyText: hi", 'contexts: ["simple"]', "facts: []"].join("\n"),
		);
		extractor.flush();
		// flush() must not re-fire done for fields already closed by the next key.
		expect(starts).toEqual(["replyText", "contexts", "facts"]);
		expect(dones).toEqual(["replyText", "contexts", "facts"]);
	});

	it("works when no event callbacks are supplied (back-compat)", () => {
		const chunks: string[] = [];
		const extractor = new StructuredFieldStreamExtractor({
			level: 0,
			schema,
			streamFields: ["replyText"],
			onChunk: (chunk, field) => {
				if (field === "replyText") chunks.push(chunk);
			},
		});
		feed(
			extractor,
			["replyText: still works", 'contexts: ["simple"]'].join("\n"),
		);
		extractor.flush();
		expect(chunks.join("")).toBe("still works");
	});
});

describe("StructuredFieldStreamExtractor emits the clean text-field delta (#9174)", () => {
	// The default dynamic-prompt stream field is `text` (the clean reply). This
	// locks that a structured response streams only the decoded `text` value —
	// never the surrounding `thought:`/`actions:` markup — and that the third
	// onChunk arg (`accumulated`) is the clean reply text, not raw markup.
	const replySchema: SchemaRow[] = [
		{ field: "thought", description: "internal reasoning" },
		{ field: "text", description: "user-facing reply", streamField: true },
		{ field: "actions", description: "actions to run", type: "array" },
	];

	it("streams only the decoded text field, never the markup around it", () => {
		const chunks: Array<[string | undefined, string, string | undefined]> = [];
		const extractor = new StructuredFieldStreamExtractor({
			level: 0,
			schema: replySchema,
			streamFields: ["text"],
			onChunk: (chunk, field, accumulated) =>
				chunks.push([field, chunk, accumulated]),
		});

		feed(
			extractor,
			[
				"thought: the user greeted me, respond warmly",
				"text: Hey! Good to see you again.",
				'actions: ["REPLY"]',
			].join("\n"),
		);
		extractor.flush();

		// Every emitted chunk belongs to the `text` field — no control-field leak.
		expect(chunks.every(([field]) => field === "text")).toBe(true);
		const joined = chunks.map(([, chunk]) => chunk).join("");
		expect(joined).toBe("Hey! Good to see you again.");
		// Raw field markup never reaches the user-visible token stream.
		expect(joined).not.toContain("thought:");
		expect(joined).not.toContain("actions:");
		expect(joined).not.toContain("the user greeted me");
		// `accumulated` is the clean reply text, ending at the full reply.
		const accumulated = chunks.map(([, , acc]) => acc);
		expect(accumulated.at(-1)).toBe("Hey! Good to see you again.");
	});
});

describe("ResponseSkeletonStreamExtractor", () => {
	const skeleton = {
		spans: [
			{ kind: "literal" as const, value: '{"shouldRespond":' },
			{ kind: "free-string" as const, key: "shouldRespond" },
			{ kind: "literal" as const, value: ',"contexts":' },
			{ kind: "free-json" as const, key: "contexts" },
			{ kind: "literal" as const, value: ',"intents":' },
			{ kind: "free-json" as const, key: "intents" },
			{ kind: "literal" as const, value: ',"replyText":' },
			{ kind: "free-string" as const, key: "replyText" },
			{ kind: "literal" as const, value: ',"facts":' },
			{ kind: "free-json" as const, key: "facts" },
			{ kind: "literal" as const, value: "}" },
		],
	};

	it("streams only the selected JSON skeleton field", () => {
		const chunks: Array<[string | undefined, string, string | undefined]> = [];
		const extractor = new ResponseSkeletonStreamExtractor({
			skeleton,
			streamFields: ["replyText"],
			onChunk: (chunk, field, accumulated) =>
				chunks.push([field, chunk, accumulated]),
		});

		extractor.push(
			'{"shouldRespond":"RESPOND","contexts":["general"],"intents":[],',
		);
		extractor.push('"replyText":"Hello ');
		extractor.push('there","facts":[]}');
		extractor.flush();

		expect(chunks).toEqual([
			["replyText", "Hello ", "Hello "],
			["replyText", "there", "Hello there"],
		]);
	});

	it("streams non-envelope prose straight through as the reply (passthrough)", () => {
		// A local model that was not grammar-constrained (e.g. the FFI backend,
		// which cannot apply GBNF) emits the reply as raw prose with no JSON
		// envelope. The extractor still streams that prose token-by-token rather
		// than matching no spans and collapsing the whole reply into one trailing
		// chunk.
		const chunks: string[] = [];
		const accumulated: string[] = [];
		const extractor = new ResponseSkeletonStreamExtractor({
			skeleton,
			streamFields: ["replyText"],
			onChunk: (chunk, _field, acc) => {
				chunks.push(chunk);
				if (acc !== undefined) accumulated.push(acc);
			},
		});

		extractor.push("Hello ");
		extractor.push("there, ");
		extractor.push("friend.");
		extractor.flush();

		expect(chunks.join("")).toBe("Hello there, friend.");
		// Streamed incrementally (one emission per pushed token), not once at the end.
		expect(chunks.length).toBeGreaterThan(1);
		expect(accumulated.at(-1)).toBe("Hello there, friend.");
	});

	it("keeps envelope-shaped output on the structured path (no control-field leak)", () => {
		// Output that opens with `{` is still parsed as the envelope, so thought /
		// shouldRespond / facts never reach the user — only replyText does.
		const chunks: string[] = [];
		const extractor = new ResponseSkeletonStreamExtractor({
			skeleton,
			streamFields: ["replyText"],
			onChunk: (chunk) => chunks.push(chunk),
		});

		extractor.push('{"shouldRespond":"RESPOND","contexts":[],"intents":[],');
		extractor.push('"replyText":"hi","facts":[]}');
		extractor.flush();

		expect(chunks.join("")).toBe("hi");
	});

	it("decodes JSON string escapes before emitting text", () => {
		const chunks: string[] = [];
		const extractor = new ResponseSkeletonStreamExtractor({
			skeleton,
			streamFields: ["replyText"],
			onChunk: (chunk) => chunks.push(chunk),
		});

		extractor.push(
			'{"shouldRespond":"RESPOND","contexts":[],"intents":[],"replyText":"Line 1\\nLine 2 \\u2728","facts":[]}',
		);
		extractor.flush();

		expect(chunks.join("")).toBe("Line 1\nLine 2 \u2728");
	});

	it("streams selected fields when provider JSON field order differs", () => {
		const chunks: string[] = [];
		const extractor = new ResponseSkeletonStreamExtractor({
			skeleton,
			streamFields: ["replyText"],
			unordered: true,
			onChunk: (chunk) => chunks.push(chunk),
		});

		extractor.push('{"contexts":[],"reply');
		extractor.push('Text":"Hello ');
		extractor.push('there","shouldRespond":"RESPOND","facts":[]}');
		extractor.flush();

		expect(chunks).toEqual(["Hello ", "there"]);
	});

	it("hides think tags while streaming selected JSON fields", () => {
		const chunks: string[] = [];
		const extractor = new ResponseSkeletonStreamExtractor({
			skeleton,
			streamFields: ["replyText"],
			unordered: true,
			onChunk: (chunk) => chunks.push(chunk),
		});

		extractor.push('{"replyText":"Hello <thi');
		extractor.push('nk>secret</think>there"}');
		extractor.flush();

		expect(chunks.join("")).toBe("Hello there");
	});

	it("surfaces a 'Cancelled by user' error and emits nothing when already aborted", () => {
		const controller = new AbortController();
		controller.abort();
		const chunks: string[] = [];
		const events: Array<{ eventType: string; error?: string }> = [];
		const extractor = new ResponseSkeletonStreamExtractor({
			skeleton,
			streamFields: ["replyText"],
			onChunk: (chunk) => chunks.push(chunk),
			onEvent: (event) => events.push(event),
			abortSignal: controller.signal,
		});

		const out = extractor.push(
			'{"shouldRespond":"RESPOND","contexts":[],"intents":[],"replyText":"hi","facts":[]}',
		);

		expect(out).toBe("");
		// No field content leaks once aborted.
		expect(chunks).toEqual([]);
		expect(extractor.done).toBe(true);
		expect(events).toContainEqual(
			expect.objectContaining({
				eventType: "error",
				error: "Cancelled by user",
			}),
		);
	});

	it("aborting mid-stream stops further field chunks and does not double-signal", () => {
		const controller = new AbortController();
		const chunks: string[] = [];
		const events: Array<{ eventType: string; error?: string }> = [];
		const extractor = new ResponseSkeletonStreamExtractor({
			skeleton,
			streamFields: ["replyText"],
			onChunk: (chunk) => chunks.push(chunk),
			onEvent: (event) => events.push(event),
			abortSignal: controller.signal,
		});

		// A partial reply streams normally before the abort.
		extractor.push(
			'{"shouldRespond":"RESPOND","contexts":[],"intents":[],"replyText":"Hel',
		);
		expect(chunks.join("")).toBe("Hel");
		const chunkCountBeforeAbort = chunks.length;

		// Abort, then push the rest — the abort branch fires; no new chunk emits.
		controller.abort();
		const out = extractor.push('lo there","facts":[]}');
		expect(out).toBe("");
		expect(chunks.length).toBe(chunkCountBeforeAbort);
		expect(extractor.done).toBe(true);
		expect(
			events.filter(
				(e) => e.eventType === "error" && e.error === "Cancelled by user",
			),
		).toHaveLength(1);

		// A further push after abort must NOT emit a duplicate error event.
		extractor.push("ignored");
		expect(events.filter((e) => e.eventType === "error")).toHaveLength(1);
	});
});
