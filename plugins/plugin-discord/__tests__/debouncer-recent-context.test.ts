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

	it("still buffers an unaddressed message during the response cooldown (strict mode)", () => {
		vi.useFakeTimers();
		try {
			const { flushed, debouncer } = setup({
				shouldRespondOnlyToMentions: true,
				bufferTtlMs: 10_000,
				responseCooldownMs: 30_000,
			});

			// Bot just answered an addressed message → cooldown armed, buffer cleared.
			debouncer.markResponded("channel-1");

			// A follow-up question (unaddressed) arrives inside the cooldown window.
			// In strict mode it never triggers a reply, so it must NOT be dropped —
			// it should still be ingested and buffered for a following pointer.
			debouncer.enqueue(mockMessage("1", "a follow-up question"));
			vi.advanceTimersByTime(3000);

			debouncer.enqueue(mockMessage("2", "<@123> ^^"));
			expect(flushed[flushed.length - 1]).toEqual(["1", "2"]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not fold the buffer into a substantive addressed question (only into pointers)", () => {
		vi.useFakeTimers();
		try {
			const { flushed, debouncer } = setup({
				shouldRespondOnlyToMentions: true,
				bufferTtlMs: 10_000,
			});

			// Unrelated chatter buffers and flushes on its own.
			debouncer.enqueue(mockMessage("1", "man the weather is nice today"));
			vi.advanceTimersByTime(3000);
			expect(flushed).toEqual([["1"]]);

			// A self-contained question arrives a beat later. It is NOT a pointer
			// (it has its own words), so the chatter must NOT be folded in — folding
			// unrelated context can derail the question's routing.
			vi.advanceTimersByTime(2000);
			debouncer.enqueue(
				mockMessage("2", "<@123> what is the capital of france?"),
			);
			expect(flushed[flushed.length - 1]).toEqual(["2"]);
		} finally {
			vi.useRealTimers();
		}
	});

	// Pin the pointer-classification boundary: a message that, after its mentions
	// are stripped, has no letters/digits in any script is a pointer (fold the
	// buffer); anything with a word stands on its own (do not fold). Guards the
	// \p{L}\p{N} check against being narrowed to ASCII \w, which would silently
	// break non-English text.
	it.each([
		{ kind: "caret pointer", content: "<@123> ^^", folds: true },
		{ kind: "emoji pointer", content: "<@123> 👆", folds: true },
		{ kind: "punctuation pointer", content: "<@123> ?", folds: true },
		{ kind: "bare mention", content: "<@123>", folds: true },
		{ kind: "english question", content: "<@123> what is up?", folds: false },
		{ kind: "single word", content: "<@123> this", folds: false },
		{ kind: "unicode word", content: "<@123> ¿qué tal?", folds: false },
		{ kind: "digits", content: "<@123> 2+2", folds: false },
	])("folds=$folds for a $kind", ({ content, folds }) => {
		vi.useFakeTimers();
		try {
			const { flushed, debouncer } = setup({
				shouldRespondOnlyToMentions: true,
				bufferTtlMs: 10_000,
			});

			debouncer.enqueue(mockMessage("1", "prior unaddressed chatter"));
			vi.advanceTimersByTime(3000);
			vi.advanceTimersByTime(1000);
			debouncer.enqueue(mockMessage("2", content));

			expect(flushed[flushed.length - 1]).toEqual(folds ? ["1", "2"] : ["2"]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not duplicate a message present in both the buffer and the pending batch", () => {
		vi.useFakeTimers();
		try {
			const { flushed, debouncer } = setup({
				shouldRespondOnlyToMentions: true,
				bufferTtlMs: 10_000,
			});

			// Unaddressed message goes into BOTH the rolling buffer and the pending
			// debounce batch. A targeted message arriving before the batch flushes
			// drains both — the message must appear once, not twice.
			debouncer.enqueue(mockMessage("1", "chatter still pending"));
			debouncer.enqueue(mockMessage("2", "<@123> ^^"));

			expect(flushed[flushed.length - 1]).toEqual(["1", "2"]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("caps the rolling buffer so a flood of unaddressed messages cannot grow without bound", () => {
		vi.useFakeTimers();
		try {
			const { flushed, debouncer } = setup({
				shouldRespondOnlyToMentions: true,
				bufferTtlMs: 60_000,
			});

			// Flood the channel with unaddressed messages well past the 50-entry cap.
			for (let i = 1; i <= 120; i++) {
				debouncer.enqueue(mockMessage(String(i), `flood ${i}`));
			}
			// Let the pending debounce batch flush so only the rolling buffer remains.
			vi.advanceTimersByTime(3000);
			flushed.length = 0;

			// A pointer drains the buffer; it must carry at most the 50 most-recent
			// unaddressed messages plus the pointer itself.
			debouncer.enqueue(mockMessage("999", "<@123> ^^"));
			const lastBatch = flushed[flushed.length - 1];
			expect(lastBatch.length).toBe(51);
			expect(lastBatch[lastBatch.length - 1]).toBe("999");
			// Oldest retained entry is #71 (120 - 50 + 1); #1..#70 were evicted.
			expect(lastBatch[0]).toBe("71");
		} finally {
			vi.useRealTimers();
		}
	});
});
