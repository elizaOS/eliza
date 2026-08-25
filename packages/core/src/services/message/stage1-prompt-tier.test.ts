/**
 * Verifies the Stage-1 structural classifier for unaddressed group-channel
 * turns: only positively-identified text group traffic that does not address
 * the agent qualifies; autonomous self-turns, sub-agent relays, client-chat
 * sources, and unknown/missing channel types all fail open.
 */

import { describe, expect, it } from "vitest";
import type { Memory } from "../../types/memory";
import { ChannelType } from "../../types/primitives";
import {
	isUnaddressedTextGroupTurn,
	TEXT_GROUP_CHANNEL_TYPES,
} from "./stage1-prompt-tier";

function message(overrides: Partial<Memory> = {}): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000001",
		agentId: "00000000-0000-0000-0000-000000000002",
		roomId: "00000000-0000-0000-0000-000000000003",
		userId: "00000000-0000-0000-0000-000000000004",
		content: { text: "hello" },
		createdAt: Date.now(),
		...overrides,
	};
}

describe("TEXT_GROUP_CHANNEL_TYPES", () => {
	it("includes exactly the text group-ish channel types", () => {
		expect(TEXT_GROUP_CHANNEL_TYPES.has(String(ChannelType.GROUP))).toBe(true);
		expect(TEXT_GROUP_CHANNEL_TYPES.has(String(ChannelType.THREAD))).toBe(true);
		expect(TEXT_GROUP_CHANNEL_TYPES.has(String(ChannelType.WORLD))).toBe(true);
		expect(TEXT_GROUP_CHANNEL_TYPES.has(String(ChannelType.FORUM))).toBe(true);
		expect(TEXT_GROUP_CHANNEL_TYPES.has(String(ChannelType.FEED))).toBe(true);
	});

	it("excludes DM and voice channel types", () => {
		expect(TEXT_GROUP_CHANNEL_TYPES.has(String(ChannelType.DM))).toBe(false);
		expect(TEXT_GROUP_CHANNEL_TYPES.has(String(ChannelType.VOICE_DM))).toBe(
			false,
		);
		expect(TEXT_GROUP_CHANNEL_TYPES.has(String(ChannelType.VOICE_GROUP))).toBe(
			false,
		);
	});
});

describe("isUnaddressedTextGroupTurn", () => {
	it("returns false when the turn explicitly addresses the agent", () => {
		const msg = message({
			content: { text: "@agent hello", channelType: String(ChannelType.GROUP) },
		});
		expect(isUnaddressedTextGroupTurn(msg, true)).toBe(false);
	});

	it("classifies an unaddressed group turn as true", () => {
		const msg = message({
			content: { text: "hello", channelType: String(ChannelType.GROUP) },
		});
		expect(isUnaddressedTextGroupTurn(msg, false)).toBe(true);
	});

	it("accepts every text group-ish channel type", () => {
		for (const channelType of [
			ChannelType.GROUP,
			ChannelType.THREAD,
			ChannelType.WORLD,
			ChannelType.FORUM,
			ChannelType.FEED,
		]) {
			const msg = message({
				content: { text: "hi", channelType: String(channelType) },
			});
			expect(isUnaddressedTextGroupTurn(msg, false)).toBe(true);
		}
	});

	it("rejects DM and voice channels", () => {
		for (const channelType of [
			ChannelType.DM,
			ChannelType.VOICE_DM,
			ChannelType.VOICE_GROUP,
		]) {
			const msg = message({
				content: { text: "hi", channelType: String(channelType) },
			});
			expect(isUnaddressedTextGroupTurn(msg, false)).toBe(false);
		}
	});

	it("normalizes channel type case and whitespace", () => {
		const msg = message({
			content: { text: "hi", channelType: "  group  " },
		});
		expect(isUnaddressedTextGroupTurn(msg, false)).toBe(true);
	});

	it("fails open on missing or unknown channel types", () => {
		expect(isUnaddressedTextGroupTurn(message(), false)).toBe(false);
		const unknown = message({
			content: { text: "hi", channelType: "MysteryChannel" },
		});
		expect(isUnaddressedTextGroupTurn(unknown, false)).toBe(false);
	});

	it("rejects autonomous self-turns from content metadata", () => {
		const msg = message({
			content: {
				text: "working",
				channelType: String(ChannelType.GROUP),
				metadata: { isAutonomous: true },
			},
		});
		expect(isUnaddressedTextGroupTurn(msg, false)).toBe(false);
	});

	it("rejects autonomous self-turns from top-level metadata", () => {
		const msg = message({
			metadata: { isAutonomous: true },
			content: { text: "working", channelType: String(ChannelType.GROUP) },
		});
		expect(isUnaddressedTextGroupTurn(msg, false)).toBe(false);
	});

	it("rejects sub-agent completion relays by source", () => {
		const msg = message({
			content: {
				text: "done",
				channelType: String(ChannelType.GROUP),
				source: "sub_agent",
			},
		});
		expect(isUnaddressedTextGroupTurn(msg, false)).toBe(false);
	});

	it("matches sub-agent source case-insensitively with whitespace", () => {
		const msg = message({
			content: {
				text: "done",
				channelType: String(ChannelType.GROUP),
				source: "  SUB_AGENT  ",
			},
		});
		expect(isUnaddressedTextGroupTurn(msg, false)).toBe(false);
	});

	it("rejects sub-agent relays flagged in metadata", () => {
		for (const metadata of [{ subAgent: true }]) {
			const content = message({
				content: {
					text: "done",
					channelType: String(ChannelType.GROUP),
					metadata,
				},
			});
			expect(isUnaddressedTextGroupTurn(content, false)).toBe(false);
			const top = message({
				metadata,
				content: {
					text: "done",
					channelType: String(ChannelType.GROUP),
				},
			});
			expect(isUnaddressedTextGroupTurn(top, false)).toBe(false);
		}
	});

	it("rejects client-chat sources that bypass should-respond", () => {
		const msg = message({
			content: {
				text: "hi",
				channelType: String(ChannelType.GROUP),
				source: "client_chat",
			},
		});
		expect(isUnaddressedTextGroupTurn(msg, false)).toBe(false);
	});

	it("rejects trigger-prompt sources", () => {
		const msg = message({
			content: {
				text: "hi",
				channelType: String(ChannelType.GROUP),
				source: "trigger-prompt",
			},
		});
		expect(isUnaddressedTextGroupTurn(msg, false)).toBe(false);
	});
});
