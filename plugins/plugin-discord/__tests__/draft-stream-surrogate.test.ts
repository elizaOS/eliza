/**
 * Regression tests for the draft-stream finalize path: the raw `slice` at
 * `findBreakPoint`'s maxLen fallback must never split a UTF-16 surrogate pair
 * (emoji) across draft chunks, and a chunk limit that cannot make UTF-16
 * progress must reject instead of spinning. Uses the same hand-rolled channel
 * stub as draft-stream.test.ts; no network.
 */
import type { TextChannel } from "discord.js";
import { describe, expect, it } from "vitest";
import { createDraftStreamController } from "../draft-stream";

interface CapturedSend {
	content?: string;
}

function makeChannel() {
	const sends: CapturedSend[] = [];
	const channel = {
		send: async (options: CapturedSend) => {
			sends.push(options);
			return {
				id: `msg-${sends.length}`,
				content: options.content ?? "",
				createdTimestamp: Date.now(),
				edit: async () => ({ id: `msg-${sends.length}` }),
			};
		},
	} as unknown as TextChannel;
	return { channel, sends };
}

describe("draft-stream surrogate-safe chunking", () => {
	it("keeps surrogate pairs intact across draft chunks", async () => {
		// An emoji run shifted onto an odd offset lands the raw maxLen fallback
		// cut between a pair's high and low surrogate instead of on a boundary.
		const { channel, sends } = makeChannel();
		const controller = createDraftStreamController({ maxChars: 60 });
		await controller.start(channel);

		const text = `x${"🙂".repeat(200)}`;
		await controller.finalize(text);

		expect(sends.length).toBeGreaterThan(1);
		for (const send of sends) {
			expect(send.content).toBeDefined();
			expect(send.content?.isWellFormed()).toBe(true);
		}
	});

	it("rejects a draft chunk limit that cannot make UTF-16 progress", async () => {
		const { channel } = makeChannel();
		const controller = createDraftStreamController({ maxChars: 1 });
		await controller.start(channel);

		// maxChars=1 cannot hold the lead half of an emoji without stranding it.
		await expect(controller.finalize(`😀${"x".repeat(10)}`)).rejects.toThrow(
			RangeError,
		);
	});

	it("still chunks long prose at natural break points", async () => {
		const { channel, sends } = makeChannel();
		const controller = createDraftStreamController({ maxChars: 60 });
		await controller.start(channel);

		const longText = Array.from(
			{ length: 8 },
			(_, i) => `Sentence number ${i} pads the reply.`,
		).join(" ");

		await controller.finalize(longText);

		expect(sends.length).toBeGreaterThan(1);
		for (const send of sends) {
			expect(send.content?.isWellFormed()).toBe(true);
		}
	});
});