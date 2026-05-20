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

	it("keeps the reply quote after the current user text", async () => {
		const envelope = await formatInboundEnvelope(
			makeDiscordMessage(),
			"@assistant can you try this?",
		);

		expect(envelope.formattedContent).toContain(
			"@assistant can you try this?\n(in reply to @Teammate:",
		);
		expect(envelope.formattedContent).toContain(
			"please note this as something the agent should learn from",
		);
	});
});
