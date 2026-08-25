/**
 * Unit tests for inbound-envelope normalisation — content formatting and chat
 * surface classification (dm/group/channel/thread/forum). Synthetic Discord
 * messages.
 */
import { ChannelType as DiscordChannelType } from "discord.js";
import { describe, expect, it } from "vitest";
import {
	formatInboundEnvelope,
	getDiscordReplyContext,
} from "../inbound-envelope";

function makeDiscordMessage() {
	return {
		createdTimestamp: Date.UTC(2026, 4, 19, 22, 31),
		reference: { messageId: "1234567890123456789" },
		channel: {
			id: "1111111111111111111",
			type: 0,
			name: "general",
		},
		guild: { name: "Example Server" },
		author: {
			id: "2222222222222222222",
			displayName: "User",
			username: "user",
		},
		member: { nickname: "User" },
		fetchReference: async () => ({
			id: "1234567890123456789",
			content:
				"please note this as something the agent should learn from and use to develop better future ideas",
			author: {
				id: "3333333333333333333",
				displayName: "Teammate",
				username: "teammate",
			},
		}),
	} as never;
}

describe("inbound Discord envelope", () => {
	it("extracts reply target content for current-turn grounding", async () => {
		const replyContext = await getDiscordReplyContext(makeDiscordMessage());

		expect(replyContext).toMatchObject({
			messageId: "1234567890123456789",
			authorId: "3333333333333333333",
			authorName: "Teammate",
		});
		expect(replyContext?.content).toContain(
			"agent should learn from and use to develop better future ideas",
		);
	});

	it("classifies a 1:1 DM as dm and a group DM as group — never conflated", async () => {
		// GroupDM must NOT classify as "dm": only a true 1:1 DM may read as a
		// private surface (owner-only delivery audiences key off this split).
		const makePrivateChannelMessage = (channelType: number) =>
			({
				createdTimestamp: Date.UTC(2026, 4, 19, 22, 31),
				reference: undefined,
				channel: { id: "1111111111111111111", type: channelType },
				guild: null,
				author: {
					id: "2222222222222222222",
					displayName: "User",
					username: "user",
				},
				member: null,
			}) as never;

		const dm = await formatInboundEnvelope(
			makePrivateChannelMessage(DiscordChannelType.DM),
			"hi",
		);
		expect(dm.chatType).toBe("dm");
		expect(dm.formattedContent).toContain("[Discord DM]");

		const group = await formatInboundEnvelope(
			makePrivateChannelMessage(DiscordChannelType.GroupDM),
			"hi",
		);
		expect(group.chatType).toBe("group");
		expect(group.formattedContent).toContain("[Discord Group DM]");
	});

	it("keeps the reply quote after the current user text", async () => {
		const envelope = await formatInboundEnvelope(
			makeDiscordMessage(),
			"@assistant can you try this?",
		);

		expect(envelope.formattedContent).toContain(
			"@assistant can you try this?\n[platform_reply_reference]",
		);
		expect(envelope.formattedContent).toContain("author: Teammate");
		expect(envelope.formattedContent).toContain(
			"message_id: 1234567890123456789",
		);
		expect(envelope.formattedContent).toContain(
			"[/platform_reply_reference]\n(in reply to @Teammate:",
		);
		expect(envelope.formattedContent).toContain(
			"please note this as something the agent should learn from",
		);
	});

	it("keeps surrogate pairs intact when truncating reply reference text", async () => {
		const longReply = `${"a".repeat(196)}🦊${"b".repeat(50)}`;
		const message = {
			...makeDiscordMessage(),
			fetchReference: async () => ({
				id: "1234567890123456789",
				content: longReply,
				author: {
					id: "3333333333333333333",
					displayName: "Teammate",
					username: "teammate",
				},
			}),
		} as never;

		const envelope = await formatInboundEnvelope(message, "test");
		expect(envelope.formattedContent.isWellFormed()).toBe(true);
		expect(envelope.formattedContent).toContain(`${"a".repeat(196)}...`);
	});
});
