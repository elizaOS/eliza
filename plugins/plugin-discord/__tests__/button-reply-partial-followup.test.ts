/**
 * A tapped in-chat choice button is replayed as a user turn by the real
 * handleInteractionCreate; the agent's reply rides interaction follow-ups.
 * When a later follow-up fails, only the chunks Discord did not accept may be
 * sent over the channel, and a failure with no channel fallback is reported.
 */
import {
	type Content,
	encodeReplyCallback,
	type HandlerCallback,
	type Memory,
	type UUID,
} from "@elizaos/core";
import type { Interaction } from "discord.js";
import { describe, expect, it } from "vitest";
import {
	handleInteractionCreate,
	type InteractionServiceInternals,
} from "../discord-interactions";

const AGENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" as UUID;

function longReply(): string {
	return Array.from(
		{ length: 3 },
		(_, i) => `Part ${i + 1}. ${"word ".repeat(380).trim()}`,
	).join("\n\n");
}

async function tapButton(options: {
	reply: string;
	failFollowUpCall: number;
	channelSend: boolean;
}) {
	const followUps: string[] = [];
	const channelSends: string[] = [];
	let followUpCalls = 0;
	const callbackErrors: string[] = [];
	const runtime = {
		agentId: AGENT_ID,
		character: { name: "Eliza" },
		logger: {
			debug: () => {},
			info: () => {},
			warn: () => {},
			error: () => {},
		},
		getSetting: () => undefined,
		getService: () => null,
		getRoom: async () => null,
		ensureConnection: async () => {},
		reportError: () => {},
		messageService: {
			handleMessage: async (
				_runtime: unknown,
				_memory: Memory,
				callback: HandlerCallback,
			) => {
				try {
					await callback({ text: options.reply } as Content);
				} catch (error) {
					callbackErrors.push(String(error));
				}
			},
		},
	};
	const channel = {
		id: "777000000000000000",
		isThread: () => false,
		...(options.channelSend
			? {
					send: async (payload: { content?: string }) => {
						channelSends.push(payload.content ?? "");
						return { id: `ch-${channelSends.length}` };
					},
				}
			: {}),
	};
	const interaction = {
		id: "555000000000000001",
		customId: encodeReplyCallback("Option A"),
		user: {
			id: "444000000000000000",
			bot: false,
			username: "tester",
			discriminator: "0",
			displayName: "Tester",
		},
		channel,
		channelId: channel.id,
		guild: null,
		isCommand: () => false,
		isModalSubmit: () => false,
		isMessageComponent: () => true,
		isButton: () => true,
		deferUpdate: async () => {},
		followUp: async (payload: { content?: string }) => {
			followUpCalls += 1;
			if (followUpCalls === options.failFollowUpCall) {
				throw new Error("Unknown Webhook");
			}
			followUps.push(payload.content ?? "");
			return { id: `fu-${followUps.length}` };
		},
	} as unknown as Interaction;
	const service = {
		accountId: "default",
		runtime,
		resolveDiscordEntityId: () =>
			"87654321-4321-4321-4321-cba987654321" as UUID,
		getChannelType: async () => "DM",
	} as unknown as InteractionServiceInternals;
	await handleInteractionCreate(service, interaction);
	return { followUps, channelSends, callbackErrors };
}

describe("button-tap reply that fails part way", () => {
	it("sends only the chunks Discord did not accept over the channel", async () => {
		const result = await tapButton({
			reply: longReply(),
			failFollowUpCall: 3,
			channelSend: true,
		});
		expect(result.followUps.map((text) => text.slice(0, 7))).toEqual([
			"Part 1.",
			"Part 2.",
		]);
		expect(result.channelSends.map((text) => text.slice(0, 7))).toEqual([
			"Part 3.",
		]);
		expect(result.callbackErrors).toEqual([]);
	});

	it("reports the failure when no channel send is available", async () => {
		const result = await tapButton({
			reply: longReply(),
			failFollowUpCall: 2,
			channelSend: false,
		});
		expect(result.followUps).toHaveLength(1);
		expect(result.callbackErrors).toEqual(["Error: Unknown Webhook"]);
	});
});
