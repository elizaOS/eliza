import { describe, expect, it, vi } from "vitest";
import { createMessageDebouncer } from "../debouncer";
import {
	getDiscordMessageCoalesceConfig,
	makeCoalescedDiscordMessage,
} from "../message-coalesce";

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
	} as never;
}

describe("Discord message coalescing", () => {
	it("is disabled by default and parses scoped env-style settings", () => {
		const settings = new Map<string, unknown>([
			["DISCORD_MESSAGE_COALESCE_WINDOW_MS", "1200"],
			["DISCORD_MESSAGE_COALESCE_MAX_BATCH", "3"],
		]);

		expect(getDiscordMessageCoalesceConfig((key) => settings.get(key))).toEqual(
			{
				enabled: false,
				windowMs: 8000,
				maxBatch: 3,
			},
		);

		settings.set("DISCORD_MESSAGE_COALESCE_ENABLED", "true");
		expect(getDiscordMessageCoalesceConfig((key) => settings.get(key))).toEqual(
			{
				enabled: true,
				windowMs: 1200,
				maxBatch: 3,
			},
		);
	});

	it("formats multiple messages into one annotated Discord message", () => {
		const combined = makeCoalescedDiscordMessage(
			[mockMessage("1", "first"), mockMessage("2", "second")],
			undefined,
			{ enabled: true, maxBatch: 5 },
		) as never as {
			content: string;
			__discordCoalescedMessageIds: string[];
		};

		expect(combined.content).toContain(
			"[Discord message 1/2 id=1 author=Member user-1",
		);
		expect(combined.content).toContain("first");
		expect(combined.content).toContain("second");
		expect(combined.__discordCoalescedMessageIds).toEqual(["1", "2"]);
	});

	it("flushes the receive window when max-batch is reached", () => {
		vi.useFakeTimers();
		try {
			const flushed: unknown[][] = [];
			const debouncer = createMessageDebouncer(
				(messages) => flushed.push([...messages]),
				8000,
				{ maxBatch: 2 },
			);

			debouncer.enqueue(mockMessage("1", "first"));
			expect(flushed).toHaveLength(0);

			debouncer.enqueue(mockMessage("2", "second"));
			expect(flushed).toHaveLength(1);
			expect(flushed[0]).toHaveLength(2);
			expect(debouncer.pendingCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("flushes after the coalescing window expires", () => {
		vi.useFakeTimers();
		try {
			const flushed: unknown[][] = [];
			const debouncer = createMessageDebouncer(
				(messages) => flushed.push([...messages]),
				8000,
				{ maxBatch: 5 },
			);

			debouncer.enqueue(mockMessage("1", "first"));
			debouncer.enqueue(mockMessage("2", "second"));
			expect(flushed).toHaveLength(0);

			vi.advanceTimersByTime(7999);
			expect(flushed).toHaveLength(0);

			vi.advanceTimersByTime(1);
			expect(flushed).toHaveLength(1);
			expect(flushed[0]).toHaveLength(2);
		} finally {
			vi.useRealTimers();
		}
	});
});
