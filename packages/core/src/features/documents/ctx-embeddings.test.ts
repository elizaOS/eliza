/**
 * Pure-function unit tests for the contextual-chunk prompt builders in
 * ctx-embeddings.ts — template interpolation, mime-type template selection, and
 * fail-safe fallbacks, asserted with no runtime or model in the loop.
 */
import { describe, expect, it } from "vitest";
import {
	getCachingContextualizationPrompt,
	getChunkWithContext,
	getContextualizationPrompt,
	getPromptForMimeType,
} from "./ctx-embeddings.ts";

/**
 * Contextual-chunk enrichment prompts. The builder must interpolate the document
 * and chunk content into the template (so the model contextualizes the right
 * chunk) and fail safe with an explicit error string when content is missing.
 * getPromptForMimeType selects a content-type-specific template, and
 * getChunkWithContext returns the generated context, falling back to the raw
 * chunk when no context was produced.
 */

describe("getContextualizationPrompt", () => {
	it("interpolates doc + chunk content into the prompt", () => {
		const out = getContextualizationPrompt("FULL DOCUMENT", "THE CHUNK");
		expect(out).toContain("FULL DOCUMENT");
		expect(out).toContain("THE CHUNK");
		expect(out).not.toContain("{chunk_content}");
		expect(out).not.toContain("{doc_content}");
	});

	it("fails safe when content is missing", () => {
		expect(getContextualizationPrompt("", "chunk")).toMatch(/missing/i);
		expect(getContextualizationPrompt("doc", "")).toMatch(/missing/i);
	});
});

describe("getPromptForMimeType", () => {
	it("embeds the chunk and varies the template by mime type", () => {
		const code = getPromptForMimeType(
			"text/x-python",
			"doc body",
			"def f(): pass",
		);
		expect(code).toContain("def f(): pass");
		const dflt = getPromptForMimeType(
			"application/octet-stream",
			"doc body",
			"plain chunk",
		);
		expect(dflt).toContain("plain chunk");
		// distinct content-type handling should not produce identical prompts.
		expect(code).not.toBe(dflt);
	});
});

describe("getCachingContextualizationPrompt", () => {
	it("returns a prompt + systemPrompt, error-safe on empty chunk", () => {
		const ok = getCachingContextualizationPrompt("some chunk", "text/markdown");
		expect(ok.prompt).toContain("some chunk");
		expect(typeof ok.systemPrompt).toBe("string");
		expect(getCachingContextualizationPrompt("").prompt).toMatch(/missing/i);
	});
});

describe("getChunkWithContext", () => {
	it("returns the generated context, or the raw chunk when context is empty", () => {
		expect(getChunkWithContext("the chunk", "  enriched context  ")).toBe(
			"enriched context",
		);
		expect(getChunkWithContext("the chunk", "")).toBe("the chunk");
		expect(getChunkWithContext("the chunk", "   ")).toBe("the chunk");
	});
});
