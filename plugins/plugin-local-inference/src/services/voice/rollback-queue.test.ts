/**
 * Tests for `RollbackQueue` — speculative-synthesis rollback tracking.
 *
 * Core invariant: when a token range is rejected, every tracked phrase that
 * is not yet played and whose span overlaps the rejected range must emit a
 * rollback event, so the scheduler can cancel it before it reaches the
 * speaker. Played phrases are never rolled back, unknown ids fail loudly,
 * and `drop` removes a phrase from future rejection sweeps entirely.
 */

import { describe, expect, it } from "vitest";
import { RollbackQueue } from "./rollback-queue";
import type { Phrase } from "./types";

function makePhrase(id: number, fromIndex: number, toIndex: number): Phrase {
	return {
		id,
		text: `phrase-${id}`,
		fromIndex,
		toIndex,
		terminator: "punctuation",
	};
}

describe("RollbackQueue", () => {
	it("tracks phrases in the queued state", () => {
		const q = new RollbackQueue();
		q.track(makePhrase(1, 0, 10));

		expect(q.snapshot()).toEqual([
			{ phrase: makePhrase(1, 0, 10), state: "queued" },
		]);
	});

	it("advances state through the synthesis lifecycle", () => {
		const q = new RollbackQueue();
		q.track(makePhrase(1, 0, 10));

		q.markSynthesizing(1);
		expect(q.snapshot()[0].state).toBe("synthesizing");

		q.markRingBuffered(1);
		expect(q.snapshot()[0].state).toBe("ringbuffered");

		q.markPlayed(1);
		expect(q.snapshot()[0].state).toBe("played");
	});

	it("emits rollback events for queued phrases overlapping the range", () => {
		const q = new RollbackQueue();
		q.track(makePhrase(1, 0, 10));
		q.track(makePhrase(2, 11, 20));

		const events = q.onRejected({ fromIndex: 5, toIndex: 15 });

		expect(events).toEqual([
			{
				phraseId: 1,
				reason: "rejected-tokens",
				rejectedRange: { fromIndex: 5, toIndex: 15 },
			},
			{
				phraseId: 2,
				reason: "rejected-tokens",
				rejectedRange: { fromIndex: 5, toIndex: 15 },
			},
		]);
	});

	it("treats the rejection boundaries as inclusive", () => {
		const q = new RollbackQueue();
		// Phrase ends exactly where the rejection starts.
		q.track(makePhrase(1, 0, 5));
		// Phrase starts exactly where the rejection ends.
		q.track(makePhrase(2, 15, 20));

		const events = q.onRejected({ fromIndex: 5, toIndex: 15 });

		expect(events.map((e) => e.phraseId)).toEqual([1, 2]);
	});

	it("skips phrases that do not overlap the rejected range", () => {
		const q = new RollbackQueue();
		q.track(makePhrase(1, 0, 4));
		q.track(makePhrase(2, 16, 20));

		expect(q.onRejected({ fromIndex: 5, toIndex: 15 })).toEqual([]);
	});

	it("never rolls back a played phrase", () => {
		const q = new RollbackQueue();
		q.track(makePhrase(1, 0, 10));
		q.markPlayed(1);

		expect(q.onRejected({ fromIndex: 0, toIndex: 10 })).toEqual([]);
	});

	it("still rolls back ring-buffered phrases awaiting playback", () => {
		const q = new RollbackQueue();
		q.track(makePhrase(1, 0, 10));
		q.markRingBuffered(1);

		const events = q.onRejected({ fromIndex: 0, toIndex: 10 });
		expect(events).toHaveLength(1);
		expect(events[0].phraseId).toBe(1);
	});

	it("drop removes a phrase from the rejection sweep", () => {
		const q = new RollbackQueue();
		q.track(makePhrase(1, 0, 10));
		q.drop(1);

		expect(q.onRejected({ fromIndex: 0, toIndex: 10 })).toEqual([]);
		expect(q.snapshot()).toEqual([]);
	});

	it("throws on state transitions for unknown phrase ids", () => {
		const q = new RollbackQueue();
		expect(() => q.markSynthesizing(99)).toThrow(
			"RollbackQueue: unknown phraseId 99",
		);
		expect(() => q.markPlayed(99)).toThrow(
			"RollbackQueue: unknown phraseId 99",
		);
	});

	it("snapshot returns a defensive copy", () => {
		const q = new RollbackQueue();
		q.track(makePhrase(1, 0, 10));

		const snap = q.snapshot();
		snap[0].state = "played";
		expect(q.snapshot()[0].state).toBe("queued");
	});
});
