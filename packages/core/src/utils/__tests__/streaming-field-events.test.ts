import { describe, expect, it } from "vitest";
import type { SchemaRow } from "../../types/state";
import { StructuredFieldStreamExtractor } from "../streaming";

const schema: SchemaRow[] = [
	{ field: "thought", description: "internal reasoning" },
	{ field: "replyText", description: "user-facing reply", streamField: true },
	{ field: "contexts", description: "context ids" },
	{ field: "extract", description: "durable facts", type: "object" },
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
				"extract: {}",
			].join("\n"),
		);
		extractor.flush();

		expect(starts).toEqual(["thought", "replyText", "contexts", "extract"]);
		expect(dones.map(([f]) => f)).toEqual([
			"thought",
			"replyText",
			"contexts",
			"extract",
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
			["replyText: hi", 'contexts: ["simple"]', "extract: {}"].join("\n"),
		);
		extractor.flush();
		// flush() must not re-fire done for fields already closed by the next key.
		expect(starts).toEqual(["replyText", "contexts", "extract"]);
		expect(dones).toEqual(["replyText", "contexts", "extract"]);
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
