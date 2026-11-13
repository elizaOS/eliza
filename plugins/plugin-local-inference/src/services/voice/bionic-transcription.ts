/**
 * One-shot TRANSCRIPTION over the bionic host, streaming when the host can.
 *
 * The Android TRANSCRIPTION handler receives a whole utterance. When the
 * host reports a streaming ASR backend (op="asr_stream_supported" → true,
 * Phonon-2) the audio goes through `createStreamingTranscriber()`: fed in
 * windows, `flush()` returns the final transcript, and each running partial
 * reaches `onPartial` as a delta (the runtime's `onStreamChunk` pipe, as on
 * the in-process engine path). When the host reports no streaming backend
 * (a host library built without the Parakeet-TDT backend) the batch op="asr"
 * runs instead. A clip the stream would truncate fails with ASR_CLIP_TOO_LONG
 * rather than returning partial text. Any other failure propagates.
 */

import { ElizaError } from "@elizaos/core";
import { BIONIC_ASR_STREAM_MAX_SECONDS } from "../bionic-asr-stream";
import type { PcmFrame, StreamingTranscriber } from "./types";

export interface BionicTranscriptionHost {
	asrStreamSupported(): Promise<boolean>;
	createStreamingTranscriber(opts: {
		maxQueuedSeconds?: number;
	}): StreamingTranscriber & { readonly droppedSamplesLastSegment?: number };
	transcribe(args: {
		pcmBase64: string;
		sampleRate: number;
		signal?: AbortSignal;
	}): Promise<string>;
}

export interface BionicTranscriptionArgs {
	pcm: Float32Array;
	sampleRate: number;
	signal?: AbortSignal;
	onPartial?: (delta: string) => void;
	/** Encodes PCM for the batch op; injected so this module stays Buffer-free in tests. */
	toBase64: (pcm: Float32Array) => string;
}

function clipTooLong(seconds: number, droppedSamples?: number): ElizaError {
	return new ElizaError(
		`Audio is longer than the ${BIONIC_ASR_STREAM_MAX_SECONDS} s streaming ASR limit; send shorter clips`,
		{
			code: "ASR_CLIP_TOO_LONG",
			context: {
				seconds,
				maxSeconds: BIONIC_ASR_STREAM_MAX_SECONDS,
				...(droppedSamples !== undefined ? { droppedSamples } : {}),
			},
		},
	);
}

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new DOMException("Aborted", "AbortError");
}

export async function transcribeViaBionicHost(
	host: BionicTranscriptionHost,
	args: BionicTranscriptionArgs,
): Promise<{ text: string; mode: "stream" | "batch" }> {
	const { signal } = args;
	if (signal?.aborted) throw abortError(signal);
	if (!(await host.asrStreamSupported())) {
		const text = await host.transcribe({
			pcmBase64: args.toBase64(args.pcm),
			sampleRate: args.sampleRate,
			signal,
		});
		return { text, mode: "batch" };
	}
	if (signal?.aborted) throw abortError(signal);
	const seconds = args.pcm.length / Math.max(1, args.sampleRate);
	// One stream segment holds at most BIONIC_ASR_STREAM_MAX_SECONDS; the rest
	// would be dropped and the transcript returned as if complete.
	if (seconds > BIONIC_ASR_STREAM_MAX_SECONDS) throw clipTooLong(seconds);
	// The whole clip is queued at once; size the queue so nothing is dropped.
	const transcriber = host.createStreamingTranscriber({
		maxQueuedSeconds: Math.ceil(seconds) + 1,
	});
	let shown = 0;
	const forward = (full: string): void => {
		if (!args.onPartial || full.length <= shown) return;
		const delta = full.slice(shown);
		shown = full.length;
		args.onPartial(delta);
	};
	const unsub = transcriber.on((ev) => {
		if (ev.kind === "partial") forward(ev.update.partial);
	});
	const abort = () => transcriber.dispose();
	signal?.addEventListener("abort", abort, { once: true });
	try {
		const win = Math.max(1600, Math.round(args.sampleRate));
		for (let off = 0; off < args.pcm.length; off += win) {
			const frame: PcmFrame = {
				pcm: args.pcm.subarray(off, Math.min(off + win, args.pcm.length)),
				sampleRate: args.sampleRate,
				timestampMs: Math.round((off / args.sampleRate) * 1000),
			};
			transcriber.feed(frame);
		}
		const final = await transcriber.flush();
		if (signal?.aborted) throw abortError(signal);
		const dropped = transcriber.droppedSamplesLastSegment ?? 0;
		if (dropped > 0) throw clipTooLong(seconds, dropped);
		forward(final.partial);
		return { text: final.partial, mode: "stream" };
	} catch (err) {
		if (signal?.aborted) throw abortError(signal);
		throw err;
	} finally {
		unsub();
		signal?.removeEventListener("abort", abort);
		transcriber.dispose();
	}
}
