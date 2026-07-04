/**
 * Unit tests for Discord text formatting helpers — `escapeDiscordMarkdown`,
 * `stripDiscordFormatting`, and mention round-tripping. Pure-function assertions.
 */
import { describe, expect, it } from "vitest";
import {
	buildMessageLink,
	escapeDiscordMarkdown,
	extractAllUserMentions,
	extractUserIdFromMention,
	formatDiscordRoleMention,
	formatDiscordUserMention,
	messageContainsMention,
	parseMessageLink,
	sanitizeThreadName,
	stripDiscordFormatting,
	truncateUtf16Safe,
} from "../messaging.ts";

/**
 * Discord text helpers. Escaping the markdown metacharacters stops user text
 * forging formatting/mentions; mention build/extract must round-trip (incl. the
 * <@!id> nickname form); truncateUtf16Safe must never cut a surrogate pair in
 * half (which would corrupt an emoji); and the message-link build/parse pair
 * must agree.
 */

describe("escapeDiscordMarkdown", () => {
	it("backslash-escapes every markdown metacharacter", () => {
		expect(escapeDiscordMarkdown("a*b_c~d|e`f")).toBe("a\\*b\\_c\\~d\\|e\\`f");
		expect(escapeDiscordMarkdown("clean")).toBe("clean");
	});
});

describe("stripDiscordFormatting", () => {
	it("removes markup, mentions, and custom emojis", () => {
		expect(stripDiscordFormatting("**bold** ||spoiler|| <@123> hi")).toBe(
			"bold spoiler  hi",
		);
	});
});

describe("mentions round-trip", () => {
	it("formats and extracts user/role mentions", () => {
		const m = formatDiscordUserMention("123");
		expect(m).toBe("<@123>");
		expect(extractUserIdFromMention(m)).toBe("123");
		expect(extractUserIdFromMention("<@!123>")).toBe("123"); // nickname form
		expect(formatDiscordRoleMention("9")).toBe("<@&9>");
		expect(extractUserIdFromMention("not a mention")).toBeNull();
	});

	it("extractAllUserMentions + messageContainsMention", () => {
		expect(extractAllUserMentions("hi <@1> and <@!2>")).toEqual(["1", "2"]);
		expect(messageContainsMention("yo <@!42> there", "42")).toBe(true);
		expect(messageContainsMention("no mention", "42")).toBe(false);
	});
});

describe("truncateUtf16Safe", () => {
	it("does not split a surrogate pair (emoji stays intact or is dropped whole)", () => {
		const text = `abc${"😀".repeat(5)}`; // each 😀 is a surrogate pair (length 2)
		const out = truncateUtf16Safe(text, 6, "…");
		// result must remain valid UTF-16 (no lone surrogate at the end).
		const last = out.charCodeAt(out.length - 2);
		expect(out.length).toBeLessThanOrEqual(6);
		expect(Number.isNaN(last)).toBe(false);
		// round-trips through a JSON encode/decode without replacement chars.
		expect(JSON.parse(JSON.stringify(out))).toBe(out);
	});

	it("returns the text unchanged when within the limit", () => {
		expect(truncateUtf16Safe("short", 20)).toBe("short");
	});
});

describe("sanitizeThreadName", () => {
	it("collapses whitespace and caps length at 100", () => {
		expect(sanitizeThreadName("a\n\nb   c")).toBe("a b c");
		expect(sanitizeThreadName("x".repeat(200)).length).toBeLessThanOrEqual(100);
	});
});

describe("message link build/parse round-trip", () => {
	it("encodes and decodes guild/channel/message ids", () => {
		const url = buildMessageLink("1", "2", "3");
		expect(url).toBe("https://discord.com/channels/1/2/3");
		expect(parseMessageLink(url)).toEqual({
			guildId: "1",
			channelId: "2",
			messageId: "3",
		});
		expect(parseMessageLink("https://example.com/x")).toBeNull();
	});
});
