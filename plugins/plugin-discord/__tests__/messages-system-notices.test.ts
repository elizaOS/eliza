/**
 * Discord server notices (thread created, channel renamed, pin, join, boost)
 * arrive through messageCreate with the acting member as author. They are not
 * messages that member wrote and must never start an agent turn. Drives the
 * real MessageManager with Discord network objects stubbed.
 */
import { MessageType } from "discord.js";
import { describe, expect, it } from "vitest";
import { makeMessageManagerHarness } from "../test/helpers/message-manager-harness.ts";

async function turnRan(options: {
	inboundId: string;
	content: string;
	system: boolean;
	type: number;
	dm?: boolean;
}): Promise<boolean> {
	let ran = false;
	const harness = makeMessageManagerHarness({
		...options,
		dm: options.dm ?? false,
		handleMessage: async () => {
			ran = true;
		},
	});
	await harness.run();
	return ran;
}

describe("Discord server notices", () => {
	it("does not run a turn for a thread-created notice that carries the thread name", async () => {
		expect(
			await turnRan({
				inboundId: "666100000000000001",
				content: "Weekly sync",
				system: true,
				type: MessageType.ThreadCreated,
			}),
		).toBe(false);
	});

	it("does not run a turn for a channel-rename notice", async () => {
		expect(
			await turnRan({
				inboundId: "666100000000000002",
				content: "launch-room",
				system: true,
				type: MessageType.ChannelNameChange,
			}),
		).toBe(false);
	});

	it("does not run a turn for a notice in a DM", async () => {
		expect(
			await turnRan({
				inboundId: "666100000000000003",
				content: "a pinned note",
				system: true,
				type: MessageType.ChannelPinnedMessage,
				dm: true,
			}),
		).toBe(false);
	});

	it("still runs a turn for an ordinary message and a reply", async () => {
		expect(
			await turnRan({
				inboundId: "666100000000000004",
				content: "Weekly sync",
				system: false,
				type: MessageType.Default,
			}),
		).toBe(true);
		expect(
			await turnRan({
				inboundId: "666100000000000005",
				content: "sounds good",
				system: false,
				type: MessageType.Reply,
			}),
		).toBe(true);
	});
});
