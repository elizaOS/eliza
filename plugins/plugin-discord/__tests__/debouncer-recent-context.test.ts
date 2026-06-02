import { describe, expect, it, vi } from "vitest";
import { createChannelDebouncer } from "../debouncer";

function mockMessage(id: string, content: string, authorId = "user-1") {
	return {
		id,
		content,
		createdTimestamp: Number(id.replace(/\D/g, "")) || Date.now(),
		channel: { id: "channel-1" },
		author: {
			id: authorId,
			username: `user-${authorId}`,
			displayName: `User ${authorId}`,
		},
		member: { displayName: `Member ${authorId}` },
		attachments: { size: 0 },
		stickers: { size: 0 },
		reference: undefined,
		mentions: { repliedUser: undefined },
	} as never;
}

/**
 * Regression coverage for the "@bot ^^" pointer bug: a substantive question typed
 * a few seconds before an addressed pointer landed in a SEPARATE debounce batch,
 * so the pointer reached the model with no "[Recent channel context]" and the bot
 * answered with a generic greeting instead of the question. The channel debouncer
 * now carries recent unaddressed messages forward (strict mode only) so the
 * addressed flush folds them back in, matching the within-batch case.
 */
describe("Discord channel debouncer — recent unaddressed context buffer", () => {
	function setup(options: Record<string, unknown>) {
		const flushed: string[][] = [];
		const debouncer = createChannelDebouncer(
			(messages) => flushed.push(messages.map((m) => (m as { id: string }).id)),
			{
				botUserId: "123",
				debounceMs: 3000,
				coalesceEnabled: false,
				...options,
			},
		);
		return { flushed, debouncer };
	}

	it("folds a recent unaddressed message into a later addressed batch (strict mode)", () => {
		vi.useFakeTimers();
		try {
			const { flushed, debouncer } = setup({
				shouldRespondOnlyToMentions: true,
				bufferTtlMs: 10_000,
			});

			// Unaddressed question flushes on its own (recorded, no response).
			debouncer.enqueue(mockMessage("1", "how did apple build things?"));
			vi.advanceTimersByTime(3000);
			expect(flushed).toEqual([["1"]]);

			// Addressed pointer arrives a beat later, in a separate batch.
			vi.advanceTimersByTime(1000);
			debouncer.enqueue(mockMessage("2", "<@123> ^^"));

			// The addressed flush carries the buffered question forward so the
			// bundler can render it as "[Recent channel context]".
			expect(flushed[flushed.length - 1]).toEqual(["1", "2"]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not re-bundle chatter once the bot has responded", () => {
		vi.useFakeTimers();
		try {
			const { flushed, debouncer } = setup({
				shouldRespondOnlyToMentions: true,
				bufferTtlMs: 10_000,
			});

			debouncer.enqueue(mockMessage("1", "some channel chatter"));
			vi.advanceTimersByTime(3000);
			debouncer.markResponded("channel-1");

			debouncer.enqueue(mockMessage("2", "<@123> ^^"));
			expect(flushed[flushed.length - 1]).toEqual(["2"]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("prunes buffered chatter older than bufferTtlMs", () => {
		vi.useFakeTimers();
		try {
			const { flushed, debouncer } = setup({
				shouldRespondOnlyToMentions: true,
				bufferTtlMs: 5000,
			});

			debouncer.enqueue(mockMessage("1", "stale question"));
			vi.advanceTimersByTime(3000);
			vi.advanceTimersByTime(3000); // total 6s elapsed > 5s ttl

			debouncer.enqueue(mockMessage("2", "<@123> ^^"));
			expect(flushed[flushed.length - 1]).toEqual(["2"]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not buffer when message coalescing is enabled", () => {
		vi.useFakeTimers();
		try {
			const { flushed, debouncer } = setup({
				shouldRespondOnlyToMentions: true,
				coalesceEnabled: true,
				bufferTtlMs: 10_000,
			});

			debouncer.enqueue(mockMessage("1", "coalesce handles its own window"));
			vi.advanceTimersByTime(3000);
			debouncer.enqueue(mockMessage("2", "<@123> ^^"));
			vi.advanceTimersByTime(3000);

			expect(flushed).toEqual([["1"], ["2"]]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not buffer in respond-to-all mode", () => {
		vi.useFakeTimers();
		try {
			const { flushed, debouncer } = setup({
				shouldRespondOnlyToMentions: false,
				bufferTtlMs: 10_000,
			});

			debouncer.enqueue(mockMessage("1", "open channel chatter"));
			vi.advanceTimersByTime(3000);
			debouncer.enqueue(mockMessage("2", "<@123> ^^"));

			expect(flushed[flushed.length - 1]).toEqual(["2"]);
		} finally {
			vi.useRealTimers();
		}
	});
});
