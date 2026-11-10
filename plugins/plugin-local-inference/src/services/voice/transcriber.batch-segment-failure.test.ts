/**
 * A failed batch-ASR decode must not feed its audio into the next turn, and
 * must not stop the transcriber. This is the same rule #38966 applied to the
 * bionic path: what arrived for a failed segment belongs to that segment.
 * `FfiBatchTranscriber` kept `buf` after a rejected decode and chained every
 * later pass onto the rejected promise, so one bad decode made all later
 * `flush()` calls reject with the first error and kept the failed audio.
 */

import { describe, expect, it } from "vitest";
import { fakeFfi } from "./__test-helpers__/fake-ffi";
import type { ElizaInferenceFfi } from "./ffi-bindings";
import { FfiBatchTranscriber } from "./transcriber";
import type { PcmFrame } from "./types";

/** One second of 16 kHz speech-shaped PCM. */
function frame(): PcmFrame {
	return {
		pcm: new Float32Array(16_000).fill(0.1),
		sampleRate: 16_000,
		timestampMs: 0,
	};
}

describe("FfiBatchTranscriber failed segment", () => {
	it("drops a failed segment's audio and keeps decoding later segments", async () => {
		const decodeSizes: number[] = [];
		let decodes = 0;
		const base = fakeFfi("next turn");
		const ffi = {
			...base,
			asrTranscribe: ({ pcm }: { pcm: Float32Array }) => {
				decodes += 1;
				decodeSizes.push(pcm.length);
				// The native decoder fails once, then works again.
				if (decodes === 1) throw new Error("decode exploded");
				return "next turn";
			},
		} as ElizaInferenceFfi;
		const transcriber = new FfiBatchTranscriber({
			ffi,
			getContext: () => 1n,
			stepSeconds: 0.1,
		});

		transcriber.feed(frame());
		await expect(transcriber.flush()).rejects.toThrow("decode exploded");

		transcriber.feed(frame());
		// A failed segment must not stop the transcriber or keep its audio.
		const second = await transcriber.flush().then(
			(update) => update,
			(error: unknown) => ({
				rejected: error instanceof Error ? error.message : String(error),
			}),
		);
		expect(second).toEqual({ partial: "next turn", isFinal: true });
		// Only the second segment's own audio reached the decoder.
		expect(decodeSizes.slice(1).filter((size) => size > 16_000)).toEqual([]);
		transcriber.dispose();
	});
});
