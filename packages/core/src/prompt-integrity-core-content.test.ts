/**
 * Pins the prompt-integrity contract for the two former prompt-cap sites in
 * core: attachment content handed to the answering model and entity metadata
 * rendered into the entities provider block. Both used to slice to a MAX and
 * append a truncation suffix; CLAUDE.md's "never discard model context" rule
 * removed those caps in #24134, so the contract is now byte-for-byte
 * completeness. Deterministic: pure functions, no runtime and no model.
 */
import { describe, expect, it } from "vitest";
import { formatEntityMetadata } from "./entities.ts";
import { completeAttachmentContent } from "./features/working-memory/readAttachmentAction.ts";
import { stableStringify } from "./utils/deterministic.ts";

describe("prompt integrity — no caps on model-facing core content", () => {
	it("attachment content reaches the model complete past the old 32000 cap", () => {
		const input = "a".repeat(32_000 + 5_000);
		const out = completeAttachmentContent(input);
		expect(out).toBe(input);
		expect(out.length).toBe(37_000);
		expect(out).not.toContain("truncated");
	});

	it("attachment content is identical for small and boundary inputs", () => {
		for (const size of [0, 1, 31_999, 32_000, 32_001]) {
			const input = "a".repeat(size);
			expect(completeAttachmentContent(input), `size ${size}`).toBe(input);
		}
	});

	it("entity metadata renders complete past the old 2000 cap", () => {
		const note = "x".repeat(2_000 + 100);
		const metadata = { note };
		const out = formatEntityMetadata(metadata);
		expect(out).toBe(stableStringify(metadata));
		expect(out).toContain(note);
		expect(out.length).toBeGreaterThan(2_000);
		expect(out).not.toContain("(truncated)");
	});

	it("entity metadata keeps every key regardless of rendered length", () => {
		const metadata = {
			alpha: "a".repeat(3_000),
			beta: "b".repeat(3_000),
			gamma: "c".repeat(3_000),
		};
		const out = formatEntityMetadata(metadata);
		for (const key of Object.keys(metadata)) {
			expect(out, key).toContain(key);
		}
		expect(out).toBe(stableStringify(metadata));
	});
});
