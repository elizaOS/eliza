/**
 * `MtpDraftProposer` / `MtpTargetVerifier` bridge the pipeline's
 * `{ cancelled }` flag onto the `AbortSignal` handed to the text runner.
 * `VoicePipeline.run` creates a plain `{ cancelled: false }` token, so the
 * bridge polls that flag on a 10 ms interval. The poll has to stop when the
 * generation returns: a turn that finishes normally never cancels its token.
 *
 * Only `setInterval` / `clearInterval` are faked, so `vi.getTimerCount()`
 * counts exactly the polls that are still scheduled.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { StubTtsBackend } from "./engine-bridge";
import { VoicePipeline } from "./pipeline";
import {
	MtpDraftProposer,
	MtpTargetVerifier,
	type MtpTextRunner,
} from "./pipeline-impls";
import { InMemoryAudioSink } from "./ring-buffer";
import { VoiceScheduler } from "./scheduler";
import type {
	SpeakerPreset,
	StreamingTranscriber,
	TranscriptUpdate,
} from "./types";

function makePreset(): SpeakerPreset {
	const embedding = new Float32Array([0.1, 0.2, 0.3]);
	return {
		voiceId: "default",
		embedding,
		bytes: new Uint8Array(embedding.buffer.slice(0)),
	};
}

function fakeTranscriber(transcript: string): StreamingTranscriber {
	return {
		feed: () => {},
		async flush(): Promise<TranscriptUpdate> {
			return { partial: transcript, isFinal: true };
		},
		on: () => () => {},
		dispose: () => {},
	};
}

/**
 * Stand-in for the native MTP runtime: answers every request with
 * `maxTokens` tokens for the first `fullCalls` calls, then with one token,
 * which the verifier reads as the model's natural stop.
 */
function scriptedRunner(fullCalls: number): MtpTextRunner & { calls: number } {
	return {
		calls: 0,
		hasDrafter: () => true,
		async generateWithVerifierEvents(args) {
			this.calls++;
			const n = this.calls > fullCalls ? 1 : (args.maxTokens ?? 1);
			const tokens = Array.from({ length: n }, (_, i) => ({
				index: i,
				text: ` w${i}`,
			}));
			await args.onVerifierEvent({ kind: "accept", tokens });
			return { text: tokens.map((t) => t.text).join("") };
		},
	};
}

describe("MtpDraftProposer / MtpTargetVerifier cancel polling", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("leaves no cancel poll running after a voice turn finishes", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const runner = scriptedRunner(6);
		const scheduler = new VoiceScheduler(
			{
				chunkerConfig: { maxTokensPerPhrase: 4 },
				preset: makePreset(),
				ringBufferCapacity: 4096,
				sampleRate: 24000,
			},
			{ backend: new StubTtsBackend(), sink: new InMemoryAudioSink() },
		);
		const pipeline = new VoicePipeline(
			{
				scheduler,
				transcriber: fakeTranscriber("hello there"),
				drafter: new MtpDraftProposer(runner),
				verifier: new MtpTargetVerifier(runner),
			},
			{ maxDraftTokens: 4 },
		);

		const exit = await pipeline.run({
			pcm: new Float32Array(1600),
			sampleRate: 16_000,
		});

		expect(exit).toBe("done");
		expect(runner.calls).toBeGreaterThan(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("still aborts the runner's signal when the token is cancelled mid-call", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const cancel = { cancelled: false };
		let seen: AbortSignal | undefined;
		const runner: MtpTextRunner = {
			hasDrafter: () => true,
			async generateWithVerifierEvents(args) {
				seen = args.signal;
				cancel.cancelled = true;
				vi.advanceTimersByTime(10);
				return { text: "" };
			},
		};

		const draft = await new MtpDraftProposer(runner).propose({
			prefix: [],
			maxDraft: 4,
			cancel,
		});

		expect(draft).toEqual([]);
		expect(seen?.aborted).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("drops an onCancel listener once the call returns", async () => {
		const listeners = new Set<() => void>();
		const cancel = {
			cancelled: false,
			onCancel(listener: () => void) {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
		};

		await new MtpTargetVerifier(scriptedRunner(0)).verify({
			prefix: [],
			draft: [],
			cancel,
		});

		expect(listeners.size).toBe(0);
	});
});
