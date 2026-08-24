/**
 * Unit tests for inbound message coalescing — bursts from one author collapse
 * into a single turn. Driven with fake timers.
 */
import { describe, expect, it, vi } from "vitest";
import { createChannelDebouncer } from "../debouncer";
import {
	formatCoalescedDiscordMessages,
	getDiscordMessageCoalesceConfig,
	getDiscordMessageMeta,
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

	it("does not immediately flush a channel message that mentions the bot incidentally", () => {
		vi.useFakeTimers();
		try {
			const flushed: unknown[][] = [];
			const debouncer = createChannelDebouncer(
				(messages) => flushed.push([...messages]),
				{
					botUserId: "123",
					debounceMs: 8000,
					coalesceEnabled: false,
				},
			);

			debouncer.enqueue(mockMessage("1", "<@456> compare this with <@123>"));
			expect(flushed).toHaveLength(0);

			vi.advanceTimersByTime(8000);
			expect(flushed).toHaveLength(1);
			expect(flushed[0]).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("immediately flushes a channel message directly addressed to the bot", () => {
		const flushed: unknown[][] = [];
		const debouncer = createChannelDebouncer(
			(messages) => flushed.push([...messages]),
			{
				botUserId: "123",
				debounceMs: 8000,
				coalesceEnabled: false,
			},
		);

		debouncer.enqueue(mockMessage("1", "<@123> compare this with <@456>"));
		expect(flushed).toHaveLength(1);
		expect(flushed[0]).toHaveLength(1);
	});
});

describe("getDiscordMessageMeta", () => {
	it("extracts ids and prefers member displayName", () => {
		const msg = mockMessage("42", "hello world", "author-9");
		const meta = getDiscordMessageMeta(msg as never);
		expect(meta.id).toBe("42");
		expect(meta.channelId).toBe("channel-1");
		expect(meta.authorId).toBe("author-9");
		expect(meta.displayName).toBe("Member author-9");
		expect(meta.username).toBe("user-author-9");
		expect(meta.contentPreview).toBe("hello world");
	});

	it("falls back to globalName when member displayName missing", () => {
		const msg = {
			id: "1",
			content: "hi",
			createdTimestamp: 123,
			channel: { id: "ch-1" },
			author: {
				id: "a-1",
				username: "uname",
				globalName: "Global Name",
				displayName: "Display Name",
			},
			member: null,
		} as never;
		const meta = getDiscordMessageMeta(msg);
		expect(meta.displayName).toBe("Global Name");
	});

	it("falls back to author displayName when globalName missing", () => {
		const msg = {
			id: "1",
			content: "hi",
			createdTimestamp: 123,
			channel: { id: "ch-1" },
			author: { id: "a-1", username: "uname", displayName: "Display Name" },
			member: undefined,
		} as never;
		const meta = getDiscordMessageMeta(msg);
		expect(meta.displayName).toBe("Display Name");
	});

	it("falls back to username when all display names missing", () => {
		const msg = {
			id: "1",
			content: "hi",
			createdTimestamp: 123,
			channel: { id: "ch-1" },
			author: { id: "a-1", username: "uname" },
			member: { displayName: undefined },
		} as never;
		const meta = getDiscordMessageMeta(msg);
		expect(meta.displayName).toBe("uname");
	});

	it("truncates long contentPreview to 300 without breaking surrogate pairs", () => {
		const long = "a".repeat(290) + "\uD83D\uDE00".repeat(10);
		const msg = mockMessage("1", long);
		const meta = getDiscordMessageMeta(msg as never);
		expect(meta.contentPreview.length).toBeLessThanOrEqual(300);
		expect(meta.contentPreview).not.toContain("\uFFFD");
		const last = meta.contentPreview.codePointAt(
			meta.contentPreview.length - 1,
		);
		expect(last).not.toBe(0xd83d);
	});

	it("handles missing content as empty string", () => {
		const msg = {
			id: "1",
			content: undefined,
			createdTimestamp: 123,
			channel: { id: "ch-1" },
			author: { id: "a-1", username: "u" },
			member: null,
		} as never;
		const meta = getDiscordMessageMeta(msg);
		expect(meta.contentPreview).toBe("");
	});

	it("preserves createdTimestamp and handles missing channel", () => {
		const msg = {
			id: "99",
			content: "x",
			createdTimestamp: 999999,
			channel: undefined,
			author: { id: "a-1", username: "u" },
			member: null,
		} as never;
		const meta = getDiscordMessageMeta(msg);
		expect(meta.createdTimestamp).toBe(999999);
		expect(meta.channelId).toBeUndefined();
	});
});

describe("formatCoalescedDiscordMessages", () => {
	it("formats single message with ordinal and content", () => {
		const msg = mockMessage("7", "single content");
		const text = formatCoalescedDiscordMessages([msg as never]);
		expect(text).toContain("[Discord message 1/1 id=7");
		expect(text).toContain("single content");
		expect(text).toContain("[/Discord message 1/1 id=7]");
	});

	it("formats multiple messages with correct ordinals and author labels", () => {
		const a = mockMessage("10", "first", "alice");
		const b = mockMessage("20", "second", "bob");
		const c = mockMessage("30", "third", "carol");
		const text = formatCoalescedDiscordMessages([
			a as never,
			b as never,
			c as never,
		]);
		expect(text).toContain("[Discord message 1/3 id=10 author=Member alice");
		expect(text).toContain("[Discord message 2/3 id=20 author=Member bob");
		expect(text).toContain("[Discord message 3/3 id=30 author=Member carol");
		expect(text).toContain("first");
		expect(text).toContain("second");
		expect(text).toContain("third");
	});

	it("uses unknown for missing ids and handles empty content", () => {
		const msg = {
			id: undefined,
			content: "",
			createdTimestamp: undefined,
			channel: undefined,
			author: { id: undefined, username: undefined },
			member: null,
		} as never;
		const text = formatCoalescedDiscordMessages([msg]);
		expect(text).toContain("id=unknown");
		expect(text).toContain("author=unknown");
		expect(text).toContain("at=unknown");
	});

	it("preserves surrogate pairs across formatting", () => {
		const emoji = "\uD83D\uDE00";
		const msg = mockMessage("1", emoji.repeat(5));
		const text = formatCoalescedDiscordMessages([msg as never]);
		expect(text).toContain(emoji);
		expect(text).not.toContain("\uFFFD");
	});
});

describe("coalesce config parsing", () => {
	function settings(values: Record<string, string>) {
		return (key: string) => values[key];
	}

	it("ignores a trailing-garbage batch size instead of parsing its prefix", () => {
		// parseInt("2junk") is 2, so a malformed setting silently capped each
		// coalesced turn at 2 messages instead of the default 5.
		const config = getDiscordMessageCoalesceConfig(
			settings({ DISCORD_MESSAGE_COALESCE_MAX_BATCH: "2junk" }),
		);
		expect(config.maxBatch).toBe(5);
	});

	it("still honours a clean batch size", () => {
		const config = getDiscordMessageCoalesceConfig(
			settings({ DISCORD_MESSAGE_COALESCE_MAX_BATCH: "2" }),
		);
		expect(config.maxBatch).toBe(2);
	});

	it("keeps a signed value and rejects one past the safe range", () => {
		// `Number.parseInt` accepted "+2"; rejecting it would be a regression.
		expect(
			getDiscordMessageCoalesceConfig(
				settings({ DISCORD_MESSAGE_COALESCE_MAX_BATCH: "+2" }),
			).maxBatch,
		).toBe(2);
		expect(
			getDiscordMessageCoalesceConfig(
				settings({ DISCORD_MESSAGE_COALESCE_MAX_BATCH: "9007199254740993" }),
			).maxBatch,
		).toBe(5);
	});
});
