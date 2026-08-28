/**
 * Behavioral tests for the Kokoro phoneme stream seam.
 *
 * Materiality: the module owns the boundary between the phonemizer and the
 * model input tensor. `streamPhonemes` deliberately strips BOS/EOS framing so
 * the model sees one BOS at the head and one EOS at the tail; `phonemizePhrase`
 * documents itself as equivalent to draining the stream — but did not strip
 * framing, so a whole-phrase caller fed the model BOS/EOS on every phrase.
 */
import { describe, expect, it, vi } from "vitest";
import { phonemizePhrase, streamPhonemes } from "./phoneme-stream";

/** Phonemizer mock: returns queued id arrays in call order, framed like the
 *  real espeak-ng output (BOS=1 ... EOS=2). */
function makePhonemizer(seqs: number[][]) {
	const queue = seqs.map((ids) => ({
		ids: Int32Array.from(ids),
		phonemes: "",
	}));
	const phonemize = vi.fn(
		async () => queue.shift() ?? { ids: new Int32Array(0), phonemes: "" },
	);
	return { phonemizer: { phonemize, lang: "en-us" }, phonemize };
}

function drainStream(
	chunks: string[],
	seqs: number[][],
	opts: Record<string, unknown> = {},
) {
	const { phonemizer, phonemize } = makePhonemizer(seqs);
	return {
		phonemize,
		windows: streamPhonemes(chunks, { ...opts, phonemizer }),
	};
}

describe("streamPhonemes", () => {
	it("strips BOS/EOS framing so the model sees one BOS at head and one EOS at tail", async () => {
		const { windows } = drainStream(["hello"], [[1, 5, 6, 2]]);
		const final = await windows.next();
		expect(final.done).toBe(false);
		expect(Array.from(final.value.ids)).toEqual([5, 6]);
		expect(final.value.isFinal).toBe(true);
		const done = await windows.next();
		expect(done.done).toBe(true);
	});

	it("keeps raw ids when the phonemizer emits no framing", async () => {
		const { windows } = drainStream(["hello"], [[5, 6]]);
		const final = await windows.next();
		expect(Array.from(final.value.ids)).toEqual([5, 6]);
		expect(final.value.isFinal).toBe(true);
	});

	it("yields a cumulative window once flushAt new ids have accumulated", async () => {
		// chunk "one two" → head "one" (3 ids); then leftover "two" + " three" →
		// head "two three" (2 ids) → 5 accumulated ≥ flushAt 4.
		const { windows } = drainStream(
			["one two", " three"],
			[
				[10, 11, 12],
				[13, 14],
				[15, 16],
			],
			{ flushAt: 4 },
		);
		const first = await windows.next();
		expect(first.done).toBe(false);
		expect(Array.from(first.value.ids)).toEqual([10, 11, 12, 13, 14]);
		expect(first.value.isFinal).toBe(false);
		const final = await windows.next();
		expect(Array.from(final.value.ids)).toEqual([10, 11, 12, 13, 14, 15, 16]);
		expect(final.value.isFinal).toBe(true);
	});

	it("clamps degenerate flushAt values to 1", async () => {
		for (const flushAt of [0, -3]) {
			const { windows } = drainStream(
				["hello world"],
				[
					[1, 10, 11, 2],
					[12, 13],
				],
				{ flushAt },
			);
			const first = await windows.next();
			// flushAt 1 → flush after the first phonemize call.
			expect(Array.from(first.value.ids)).toEqual([10, 11]);
		}
	});

	it("skips empty chunks without calling the phonemizer", async () => {
		const { windows, phonemize } = drainStream(
			["", "", "hello"],
			[[1, 5, 6, 2]],
		);
		await windows.next();
		expect(phonemize).toHaveBeenCalledTimes(1);
	});

	it("accumulates the phoneme string across windows", async () => {
		const { phonemizer } = makePhonemizer([[1, 10, 11, 2]]);
		phonemizer.phonemize.mockResolvedValueOnce({
			ids: Int32Array.from([1, 10, 11, 2]),
			phonemes: "hello",
		});
		const windows = streamPhonemes(["hello"], { phonemizer });
		const final = await windows.next();
		expect(final.value.phonemes).toBe("hello");
	});
});

describe("phonemizePhrase", () => {
	it("strips BOS/EOS framing — matches draining streamPhonemes on a single item", async () => {
		// Documented equivalence: phonemizePhrase "returns the full id array —
		// equivalent to draining streamPhonemes on a single-item iterator and
		// taking the last window." A whole-phrase caller must not feed the model
		// a BOS/EOS pair per phrase.
		const { phonemizer } = makePhonemizer([[1, 5, 6, 2]]);
		const window = await phonemizePhrase("hello", { phonemizer });
		expect(Array.from(window.ids)).toEqual([5, 6]);
		expect(window.isFinal).toBe(true);
	});

	it("keeps ids unchanged when the phonemizer omits framing", async () => {
		const { phonemizer } = makePhonemizer([[5, 6]]);
		const window = await phonemizePhrase("hello", { phonemizer });
		expect(Array.from(window.ids)).toEqual([5, 6]);
	});
});
