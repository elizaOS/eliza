import type { Content } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
	applyDiscordStalenessGuard,
	getDiscordStalenessConfig,
	recordDiscordChannelMessageSeen,
} from "../staleness";

function mockMessage(channelId = "channel-1") {
	return {
		id: "message-1",
		channel: { id: channelId },
	} as never;
}

describe("Discord staleness guard", () => {
	it("is disabled by default and parses scoped settings", () => {
		const settings = new Map<string, unknown>([
			["DISCORD_STALENESS_BEHAVIOR", "skip"],
			["DISCORD_STALENESS_THRESHOLD", "4"],
		]);

		expect(getDiscordStalenessConfig((key) => settings.get(key))).toEqual({
			enabled: false,
			behavior: "skip",
			threshold: 4,
		});

		settings.set("DISCORD_STALENESS_ENABLED", "true");
		expect(getDiscordStalenessConfig((key) => settings.get(key))).toEqual({
			enabled: true,
			behavior: "skip",
			threshold: 4,
		});
	});

	it("allows responses when the newer-message delta is within threshold", () => {
		const owner = {};
		const start = recordDiscordChannelMessageSeen(owner, "channel-1", "a");
		recordDiscordChannelMessageSeen(owner, "channel-1", "b");
		const content: Content = { text: "hello" };

		expect(
			applyDiscordStalenessGuard({
				config: { enabled: true, behavior: "skip", threshold: 1 },
				owner,
				message: mockMessage(),
				startSequence: start,
				content,
			}),
		).toMatchObject({ shouldSend: true, stale: false });
		expect(content.text).toBe("hello");
	});

	it("skips stale responses when configured to skip", () => {
		const owner = {};
		const start = recordDiscordChannelMessageSeen(owner, "channel-1", "a");
		recordDiscordChannelMessageSeen(owner, "channel-1", "b");
		recordDiscordChannelMessageSeen(owner, "channel-1", "c");
		const content: Content = { text: "hello" };

		expect(
			applyDiscordStalenessGuard({
				config: { enabled: true, behavior: "skip", threshold: 1 },
				owner,
				message: mockMessage(),
				startSequence: start,
				content,
			}),
		).toMatchObject({
			shouldSend: false,
			stale: true,
			messagesSinceTurnStart: 2,
		});
	});

	it("tags stale responses once when configured to tag", () => {
		const owner = {};
		const start = recordDiscordChannelMessageSeen(owner, "channel-1", "a");
		recordDiscordChannelMessageSeen(owner, "channel-1", "b");
		recordDiscordChannelMessageSeen(owner, "channel-1", "c");
		const content: Content = { text: "hello" };

		const first = applyDiscordStalenessGuard({
			config: { enabled: true, behavior: "tag", threshold: 1 },
			owner,
			message: mockMessage(),
			startSequence: start,
			content,
		});
		const second = applyDiscordStalenessGuard({
			config: { enabled: true, behavior: "tag", threshold: 1 },
			owner,
			message: mockMessage(),
			startSequence: start,
			content,
		});

		expect(first).toMatchObject({ shouldSend: true, stale: true });
		expect(second).toMatchObject({ shouldSend: true, stale: true });
		expect(content.text).toBe("(catching up:) hello");
	});
});
