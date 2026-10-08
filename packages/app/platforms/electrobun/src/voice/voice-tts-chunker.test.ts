import { describe, expect, it } from "vitest";
import { VoiceTtsChunker } from "./voice-tts-chunker";

describe("VoiceTtsChunker", () => {
	it("does not split an emoji across speech chunks", () => {
		const chunker = new VoiceTtsChunker({
			config: {
				minChars: 40,
				maxChars: 41,
				flushOnPunctuation: false,
				maxDelayMs: 10_000,
			},
		});
		const emoji = "😀";
		const chunks = [
			...chunker.pushDelta(`${"a".repeat(40)}${emoji} tail`),
			...chunker.flush(),
		];
		expect(chunks.map((chunk) => chunk.text).join("")).toContain(emoji);
		for (const chunk of chunks) {
			expect(chunk.text).toBe(chunk.text.toWellFormed());
		}
	});
});
