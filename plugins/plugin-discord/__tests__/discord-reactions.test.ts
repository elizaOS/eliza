import { ChannelType, createUniqueUuid, type UUID } from "@elizaos/core";
import type { MessageReaction, User } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import {
	handleReaction,
	type ReactionServiceInternals,
} from "../discord-reactions";

function makeService() {
	const runtime = {
		agentId: "00000000-0000-0000-0000-000000000001" as UUID,
		ensureConnection: vi.fn(),
		emitEvent: vi.fn(),
		logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
	};
	const service: ReactionServiceInternals = {
		runtime: runtime as unknown as ReactionServiceInternals["runtime"],
		resolveDiscordEntityId: (userId) =>
			createUniqueUuid(runtime as never, userId),
		getChannelType: async () => ChannelType.GROUP,
	};
	return { runtime, service };
}

const reaction = {
	partial: false,
	emoji: { name: "⏳", id: null },
	message: {
		id: "890000000000000001",
		content: "ship it",
		author: { id: "990000000000000001", username: "agent" },
		channel: { id: "880000000000000001", name: "general" },
		guild: { id: "870000000000000001", name: "Guild" },
	},
} as unknown as MessageReaction;

function reactor(bot: boolean) {
	return {
		id: bot ? "990000000000000003" : "990000000000000002",
		partial: false,
		bot,
		username: bot ? "statusbot" : "member",
		globalName: null,
	} as unknown as User;
}

describe("handleReaction", () => {
	it("stores a person's reaction", async () => {
		const { runtime, service } = makeService();

		await handleReaction(service, reaction, reactor(false), "add");

		expect(runtime.emitEvent).toHaveBeenCalledTimes(1);
	});

	it("drops a bot's reaction", async () => {
		const { runtime, service } = makeService();

		await handleReaction(service, reaction, reactor(true), "add");

		expect(runtime.ensureConnection).not.toHaveBeenCalled();
		expect(runtime.emitEvent).not.toHaveBeenCalled();
	});

	it("quotes the reacted-to message without escape characters", async () => {
		const { runtime, service } = makeService();

		await handleReaction(service, reaction, reactor(false), "add");

		expect(runtime.emitEvent.mock.calls[0][1].message.content.text).toBe(
			'*Added <⏳> to: "ship it"*',
		);
	});
});
