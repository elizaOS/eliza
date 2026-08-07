/**
 * Deterministic unit tests for the local-LLM PII recognizer — a scripted
 * `generate` stands in for the resident llama.cpp backend so parsing,
 * verbatim relocation, chunking, and failure behavior are exercised without a
 * model download.
 */

import { describe, expect, it } from "vitest";
import {
	buildPiiExtractionPrompt,
	chunkText,
	LlmEntityRecognizer,
	parseReportedEntities,
	relocateEntities,
} from "./llm-recognizer.js";

const TEXT =
	"Yesterday Alice Johnson met the Acme Corp board in San Francisco. Alice Johnson signed.";

describe("parseReportedEntities", () => {
	it("parses a plain JSON array", () => {
		expect(
			parseReportedEntities(
				'[{"kind":"person","value":"Alice Johnson"},{"kind":"org","value":"Acme Corp"}]',
			),
		).toEqual([
			{ kind: "person", value: "Alice Johnson" },
			{ kind: "org", value: "Acme Corp" },
		]);
	});

	it("extracts the array from surrounding prose and code fences", () => {
		const completion =
			'Here you go:\n```json\n[{"kind":"location","value":"San Francisco"}]\n```';
		expect(parseReportedEntities(completion)).toEqual([
			{ kind: "location", value: "San Francisco" },
		]);
	});

	it("drops unknown kinds, non-string values, and empty values", () => {
		expect(
			parseReportedEntities(
				'[{"kind":"misc","value":"x"},{"kind":"person","value":3},{"kind":"org","value":"  "},{"kind":"PERSON","value":"Bob"}]',
			),
		).toEqual([{ kind: "person", value: "Bob" }]);
	});

	it("throws on output with no JSON array", () => {
		expect(() => parseReportedEntities("I cannot help with that.")).toThrow(
			/no JSON array/,
		);
	});

	it("throws on malformed JSON", () => {
		expect(() => parseReportedEntities('[{"kind":"person",]')).toThrow(
			/not valid JSON/,
		);
	});
});

describe("relocateEntities", () => {
	it("locates values verbatim with offsets re-based onto the full text", () => {
		const spans = relocateEntities(TEXT, 100, [
			{ kind: "person", value: "Alice Johnson" },
			{ kind: "org", value: "Acme Corp" },
		]);
		expect(spans).toEqual([
			{
				kind: "person",
				value: "Alice Johnson",
				start: 100 + TEXT.indexOf("Alice Johnson"),
				end: 100 + TEXT.indexOf("Alice Johnson") + "Alice Johnson".length,
			},
			{
				kind: "org",
				value: "Acme Corp",
				start: 100 + TEXT.indexOf("Acme Corp"),
				end: 100 + TEXT.indexOf("Acme Corp") + "Acme Corp".length,
			},
		]);
	});

	it("drops hallucinated values not present verbatim", () => {
		const spans = relocateEntities(TEXT, 0, [
			{ kind: "person", value: "Alicia Johnson" },
			{ kind: "location", value: "San Francisco" },
		]);
		expect(spans).toEqual([
			{
				kind: "location",
				value: "San Francisco",
				start: TEXT.indexOf("San Francisco"),
				end: TEXT.indexOf("San Francisco") + "San Francisco".length,
			},
		]);
	});

	it("retries from the chunk start when the model reports out of order", () => {
		// "Acme Corp" appears once, before "San Francisco" — reporting it second
		// forces the fallback scan from the chunk start.
		const spans = relocateEntities(TEXT, 0, [
			{ kind: "location", value: "San Francisco" },
			{ kind: "org", value: "Acme Corp" },
		]);
		expect(spans).toHaveLength(2);
		expect(spans[1]).toMatchObject({
			value: "Acme Corp",
			start: TEXT.indexOf("Acme Corp"),
		});
	});
});

describe("chunkText", () => {
	it("returns a single zero-offset chunk for short input", () => {
		expect(chunkText("short", 100)).toEqual([{ text: "short", offset: 0 }]);
	});

	it("splits long input on whitespace with correct offsets", () => {
		const text = "word ".repeat(100).trim();
		const chunks = chunkText(text, 120);
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(text.slice(chunk.offset, chunk.offset + chunk.text.length)).toBe(
				chunk.text,
			);
		}
		const reassembled = chunks.map((c) => c.text).join("");
		expect(reassembled.replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " "));
	});
});

describe("LlmEntityRecognizer", () => {
	it("returns [] for empty input without calling the model", async () => {
		let calls = 0;
		const recognizer = new LlmEntityRecognizer(async () => {
			calls += 1;
			return "[]";
		});
		expect(await recognizer.recognize("")).toEqual([]);
		expect(await recognizer.recognize("   ")).toEqual([]);
		expect(calls).toBe(0);
	});

	it("runs one extraction prompt per chunk and merges relocated spans", async () => {
		const twoChunkText =
			"Alice Johnson lives here. Bob Stone works at Acme Corp.";
		const prompts: string[] = [];
		// The model reports the same three entities for every chunk; relocation
		// keeps only the ones actually present verbatim in that chunk, so the
		// merged result covers all three across both chunks with no phantoms.
		const recognizer = new LlmEntityRecognizer(
			async ({ prompt }) => {
				prompts.push(prompt);
				return '[{"kind":"person","value":"Alice Johnson"},{"kind":"person","value":"Bob Stone"},{"kind":"org","value":"Acme Corp"}]';
			},
			{ chunkChars: 35 },
		);
		const spans = await recognizer.recognize(twoChunkText);
		expect(prompts.length).toBe(2);
		expect(prompts[0]).toBe(
			buildPiiExtractionPrompt(chunkText(twoChunkText, 35)[0].text),
		);
		const values = spans.map((s) => s.value);
		expect(values).toContain("Alice Johnson");
		expect(values).toContain("Bob Stone");
		expect(values).toContain("Acme Corp");
		// Every span slices verbatim out of the source at its offsets.
		for (const span of spans) {
			expect(twoChunkText.slice(span.start, span.end)).toBe(span.value);
		}
	});

	it("propagates parse failures so the composite recognizer degrades", async () => {
		const recognizer = new LlmEntityRecognizer(async () => "no entities here");
		await expect(recognizer.recognize(TEXT)).rejects.toThrow(/no JSON array/);
	});
});
