import { describe, expect, it } from "vitest";
import { PhraseChunkedTts, speakStreamingText } from "./phrase-chunked-tts";

describe("phrase audio delivery", () => {
	it("synthesizes concurrently but delivers in order and shares the finishing drain", async () => {
		const first = Promise.withResolvers<string>();
		const second = Promise.withResolvers<string>();
		const played: unknown[] = [];
		let calls = 0;
		const pipe = new PhraseChunkedTts(
			() => (++calls === 1 ? first.promise : second.promise),
			{
				onAudio: (_phrase, audio) => {
					played.push(audio);
				},
			},
		);
		pipe.push("First.");
		pipe.push("Second.");
		const finished = pipe.finish();
		expect(pipe.finish()).toBe(finished);
		await Promise.resolve();
		expect(calls).toBe(2);
		second.resolve("second audio");
		await Promise.resolve();
		expect(played).toEqual([]);
		first.resolve("first audio");
		await finished;
		expect(played).toEqual(["first audio", "second audio"]);
	});

	it("aborts synthesis and suppresses audio resolving after cancellation", async () => {
		const pending = Promise.withResolvers<string>();
		const signals: AbortSignal[] = [];
		const played: unknown[] = [];
		const pipe = new PhraseChunkedTts(
			(_text, signal) => {
				signals.push(signal);
				return pending.promise;
			},
			{
				onAudio: (_phrase, audio) => {
					played.push(audio);
				},
			},
		);
		pipe.push("Pending.");
		await Promise.resolve();
		pipe.cancel();
		expect(signals[0].aborted).toBe(true);
		pending.resolve("late audio");
		await pipe.finish();
		expect(played).toEqual([]);
	});

	it("propagates even null provider rejections through finish", async () => {
		const pipe = new PhraseChunkedTts(() => Promise.reject(null));
		pipe.push("Failure.");
		await expect(pipe.finish()).rejects.toBeNull();
	});

	it("preserves upstream failure and does not synthesize its unfinished tail", async () => {
		const failure = new Error("source disconnected");
		let calls = 0;
		async function* source() {
			yield "unfinished response";
			throw failure;
		}
		await expect(
			speakStreamingText(source(), () => {
				calls++;
			}),
		).rejects.toBe(failure);
		expect(calls).toBe(0);
	});

	it("drains an unterminated tail once", async () => {
		const spoken: string[] = [];
		const pipe = new PhraseChunkedTts((text) => {
			spoken.push(text);
		});
		pipe.push("tail");
		await Promise.all([pipe.finish(), pipe.finish()]);
		expect(spoken).toEqual(["tail"]);
	});
});
