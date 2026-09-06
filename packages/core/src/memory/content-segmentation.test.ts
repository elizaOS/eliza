/**
 * Deterministic unit coverage for the UTF-8 content-segmentation primitive
 * (#25140): byte-exact boundaries, immutability of computed segments, SHA
 * reassembly, page-window clamping, and fail-closed surrogate handling. Pure
 * logic — no database involved; the SQL adapter layers prove persistence.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	buildSegmentationRevision,
	clampPageWindow,
	encodeUtf8Strict,
	MEMORY_PAGE_MAX_BYTES,
	MEMORY_SEGMENT_BYTES,
	MEMORY_SEGMENTATION_THRESHOLD_BYTES,
	memorySegmentFieldKey,
	reassembleAndVerify,
	segmentMemoryContent,
	shouldSegmentContent,
} from "./content-segmentation";

function sourceOf(byteLength: number, fill: (index: number) => string): string {
	const parts: string[] = [];
	let bytes = 0;
	while (bytes < byteLength) {
		const chunk = fill(bytes);
		parts.push(chunk);
		bytes += Buffer.byteLength(chunk, "utf8");
	}
	return parts.join("");
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function expectCode(fn: () => unknown, code: string): void {
	try {
		fn();
		throw new Error("expected throw");
	} catch (error) {
		const thrown = error as { code?: string; message: string };
		const observed = thrown.code ?? thrown.message;
		const variants = code.split("|").map((variant) => variant.trim());
		expect(variants.some((variant) => observed.includes(variant))).toBe(true);
	}
}

describe("encodeUtf8Strict", () => {
	it("round-trips ascii and multibyte text", () => {
		const text = "hello 世界 — 🚀🎉 emoji";
		const bytes = encodeUtf8Strict(text);
		expect(Buffer.from(text, "utf8").equals(Buffer.from(bytes))).toBe(true);
	});

	it("fails closed on lone surrogates", () => {
		expectCode(
			() => encodeUtf8Strict("bad: \ud800 surrogate"),
			"MEMORY_SEGMENT_UNPAIRED_SURROGATE|unpaired surrogates",
		);
	});
});

describe("segmentMemoryContent", () => {
	it("produces non-overlapping contiguous segments that reassemble byte-exactly", () => {
		const text = sourceOf(300, (i) =>
			i % 3 === 0 ? "αβγδ" : i % 3 === 1 ? "emoji🚀" : "plain",
		);
		const { segments, descriptor } = segmentMemoryContent(
			text,
			{ kind: "content.text" },
			{
				segmentBytes: 64,
			},
		);
		expect(segments.length).toBeGreaterThan(3);
		expect(descriptor.totalBytes).toBe(encodeUtf8Strict(text).length);
		expect(descriptor.totalSha256).toBe(sha256(encodeUtf8Strict(text)));
		expect(descriptor.segmentCount).toBe(segments.length);

		const reassembled = reassembleAndVerify(segments, descriptor);
		expect(reassembled).toBe(text);
	});

	it("never splits a UTF-8 code point at a boundary", () => {
		// Multibyte-heavy source hitting every boundary parity.
		const text = "🚀".repeat(500);
		const { segments } = segmentMemoryContent(
			text,
			{ kind: "content.text" },
			{
				segmentBytes: 7, // not divisible by 4: boundaries land mid-codepoint
			},
		);
		for (const segment of segments) {
			// Decoding throws if a code point was split.
			expect(() =>
				new TextDecoder("utf-8", { fatal: true }).decode(
					encodeUtf8Strict(segment.text),
				),
			).not.toThrow();
			expect((segment.byteEnd - segment.byteStart) % 4).toBe(0);
		}
	});

	it("mints a fresh generation per call even for identical text", () => {
		const text = "same bytes".repeat(100);
		const a = segmentMemoryContent(text, { kind: "content.text" });
		const b = segmentMemoryContent(text, { kind: "content.text" });
		expect(a.descriptor.generation).not.toBe(b.descriptor.generation);
		expect(a.descriptor.totalSha256).toBe(b.descriptor.totalSha256);
		expect(a.descriptor.revision).toMatch(/^seg:[0-9a-f-]{36}:[0-9a-f]{64}$/);
	});

	it("rejects empty and out-of-range budgets", () => {
		expectCode(
			() => segmentMemoryContent("", { kind: "content.text" }),
			"MEMORY_SEGMENT_EMPTY_SOURCE",
		);
		expectCode(
			() =>
				segmentMemoryContent(
					"x".repeat(10),
					{ kind: "content.text" },
					{ segmentBytes: 1 },
				),
			"MEMORY_SEGMENT_INVALID_BUDGET",
		);
	});

	it("keys attachment fields by attachment id", () => {
		expect(memorySegmentFieldKey({ kind: "content.text" })).toBe(
			"content.text",
		);
		expect(
			memorySegmentFieldKey({ kind: "attachment.text", attachmentId: "att-1" }),
		).toBe("attachment.text:att-1");
	});
});

describe("shouldSegmentContent", () => {
	it("segments only above the threshold", () => {
		expect(shouldSegmentContent("small")).toBe(false);
		const big = "a".repeat(MEMORY_SEGMENTATION_THRESHOLD_BYTES + 1);
		expect(shouldSegmentContent(big)).toBe(true);
	});

	it("measures UTF-8 bytes, not code units", () => {
		// 3 bytes per char: a third the character count crosses the threshold.
		const chars = Math.floor(MEMORY_SEGMENTATION_THRESHOLD_BYTES / 3) + 1;
		expect(shouldSegmentContent("€".repeat(chars))).toBe(true);
	});
});

describe("clampPageWindow", () => {
	it("clamps oversize and omitted limits to the hard page ceiling", () => {
		const window = clampPageWindow(10 * 1024 * 1024, 0, undefined);
		expect(window.end).toBe(MEMORY_PAGE_MAX_BYTES);
		const oversize = clampPageWindow(10 * 1024 * 1024, 0, 99 * 1024 * 1024);
		expect(oversize.end).toBe(MEMORY_PAGE_MAX_BYTES);
	});

	it("clamps the end to the total", () => {
		const window = clampPageWindow(1000, 900, undefined);
		expect(window).toEqual({ start: 900, end: 1000 });
	});

	it("rejects invalid offsets and limits", () => {
		expectCode(
			() => clampPageWindow(100, -1, 10),
			"MEMORY_PAGE_INVALID_OFFSET",
		);
		expectCode(
			() => clampPageWindow(100, 101, 10),
			"MEMORY_PAGE_INVALID_OFFSET",
		);
		expectCode(() => clampPageWindow(100, 0, 0), "MEMORY_PAGE_INVALID_LIMIT");
	});
});

describe("reassembleAndVerify", () => {
	it("detects gaps, overlaps, digest and count drift", () => {
		const text = sourceOf(400, (i) => (i % 2 ? "日本語テキスト" : "content"));
		const { segments, descriptor } = segmentMemoryContent(
			text,
			{ kind: "content.text" },
			{
				segmentBytes: 50,
			},
		);

		const gapped = segments.slice(0, segments.length - 1);
		expectCode(
			() => reassembleAndVerify(gapped, descriptor),
			"MEMORY_SEGMENT_COUNT_MISMATCH",
		);

		const tampered = segments.map((segment, index) =>
			index === 1 ? { ...segment, text: `${segment.text}x` } : segment,
		);
		expectCode(
			() => reassembleAndVerify(tampered, descriptor),
			"MEMORY_SEGMENT_LENGTH_MISMATCH|MEMORY_SEGMENT_DIGEST_MISMATCH",
		);
	});
});

describe("buildSegmentationRevision", () => {
	it("binds generation and total digest", () => {
		expect(buildSegmentationRevision("g", "d".repeat(64))).toBe(
			`seg:g:${"d".repeat(64)}`,
		);
	});
});

// The three exported budgets are wire-format-relevant limits, not internal
// tuning: the page ceiling bounds a single memory read over the agent HTTP
// surface, the segment budget fixes the segment-store row shape, and the
// threshold decides which memories get a marker instead of inline content.
// Each is pinned to its literal contracted value and to the observable
// default-path and continuation-page behavior those values produce.
describe("segmentation budget contracts (#25140)", () => {
	it("pins the exported budget constants to their contracted values", () => {
		expect(MEMORY_SEGMENT_BYTES).toBe(128 * 1024);
		expect(MEMORY_SEGMENTATION_THRESHOLD_BYTES).toBe(128 * 1024);
		expect(MEMORY_PAGE_MAX_BYTES).toBe(256 * 1024);
	});

	it("applies the default segment budget and covers the source exactly", () => {
		// ASCII source: byte boundaries never snap, so the default budget's
		// arithmetic is directly observable in the segment ranges.
		const text = "a".repeat(200 * 1024);
		const { segments, descriptor } = segmentMemoryContent(text, {
			kind: "content.text",
		});
		expect(descriptor.totalBytes).toBe(200 * 1024);
		expect(segments.length).toBe(2);
		expect(segments[0].byteStart).toBe(0);
		expect(segments[0].byteEnd).toBe(128 * 1024);
		expect(segments[1].byteStart).toBe(128 * 1024);
		expect(segments[1].byteEnd).toBe(200 * 1024);
		// Coverage invariant: segmentation ends exactly at the source end.
		expect(segments[segments.length - 1].byteEnd).toBe(descriptor.totalBytes);
	});

	it("holds the segmentation threshold at its contracted byte boundary", () => {
		expect(shouldSegmentContent("a".repeat(128 * 1024))).toBe(false);
		expect(shouldSegmentContent("a".repeat(128 * 1024 + 1))).toBe(true);
	});

	it("clamps a page read to the literal page ceiling, not a source-derived bound", () => {
		expect(clampPageWindow(10 * 1024 * 1024, 0, undefined).end).toBe(
			256 * 1024,
		);
		expect(clampPageWindow(10 * 1024 * 1024, 0, 99 * 1024 * 1024).end).toBe(
			256 * 1024,
		);
		// A limit below the ceiling is honored exactly.
		expect(clampPageWindow(10 * 1024 * 1024, 0, 4 * 1024).end).toBe(4 * 1024);
		// Continuation pages clamp relative to the offset, not to the ceiling:
		// offset + limit is the window end a paged reader advances to.
		expect(clampPageWindow(10 * 1024 * 1024, 64 * 1024, undefined)).toEqual({
			start: 64 * 1024,
			end: 320 * 1024,
		});
	});
});
