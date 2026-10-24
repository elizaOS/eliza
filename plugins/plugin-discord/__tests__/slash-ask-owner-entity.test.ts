/**
 * The Discord service resolves a slash-command caller to the runtime entity
 * before dispatch (owner Discord ids map to the canonical owner entity).
 * `/ask` and `/app` must act as that entity, not as a fresh entity minted
 * from the raw Discord user id, or the owner is answered as a stranger.
 */
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { createUniqueUuid } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { getRegisteredCommands, handleSlashCommand } from "../slash-commands";

const OWNER_ENTITY = "00000000-0000-0000-0000-00000000own1" as UUID;

function runtime(handleMessage: ReturnType<typeof vi.fn>): IAgentRuntime {
	return {
		agentId: "00000000-0000-0000-0000-0000000agent" as UUID,
		character: { name: "Agent" },
		ensureConnection: vi.fn(async () => undefined),
		getSetting: vi.fn(() => undefined),
		getRoom: vi.fn(async () => null),
		reportError: vi.fn(),
		logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
		messageService: { handleMessage },
	} as unknown as IAgentRuntime;
}

function interaction() {
	return {
		id: "interaction-1",
		channelId: "channel-1",
		guildId: "guild-1",
		guild: { name: "Guild" },
		user: { id: "discord-user-1", username: "owner", displayName: "Owner" },
		channel: { type: 0 },
		inGuild: () => true,
		options: { getString: () => "what is on my calendar?" },
		reply: vi.fn(async () => undefined),
		deferReply: vi.fn(async () => undefined),
		editReply: vi.fn(async () => undefined),
		followUp: vi.fn(async () => undefined),
	};
}

describe("Discord /ask caller identity", () => {
	it("receives the dispatched context through the real dispatcher", async () => {
		const handleMessage = vi.fn(
			async (
				_rt: IAgentRuntime,
				_m: Memory,
				cb: (c: { text: string }) => Promise<unknown>,
			) => {
				await cb({ text: "Two meetings." });
				return { responseMessages: [] };
			},
		);
		const rt = runtime(handleMessage);
		const dispatched = {
			...interaction(),
			commandName: "ask",
			user: { id: "discord-user-2", username: "owner", displayName: "Owner" },
		};
		// Same call the Discord event handler makes after resolving the caller.
		await handleSlashCommand(dispatched as never, rt, {
			entityId: OWNER_ENTITY,
			roomId: createUniqueUuid(rt, "channel-1"),
		});
		const message = handleMessage.mock.calls[0]?.[1] as Memory;
		expect(message.entityId).toBe(OWNER_ENTITY);
	});

	it("acts as the entity the service resolved for the caller", async () => {
		const handleMessage = vi.fn(
			async (
				_rt: IAgentRuntime,
				_m: Memory,
				cb: (c: { text: string }) => Promise<unknown>,
			) => {
				await cb({ text: "Two meetings." });
				return { responseMessages: [] };
			},
		);
		const rt = runtime(handleMessage);
		const ask = getRegisteredCommands().get("ask");
		if (!ask) throw new Error("ask command not registered");
		await ask.execute(interaction() as never, rt, {
			entityId: OWNER_ENTITY,
			roomId: createUniqueUuid(rt, "channel-1"),
		});
		const message = handleMessage.mock.calls[0]?.[1] as Memory;
		expect(message.entityId).toBe(OWNER_ENTITY);
		expect(rt.ensureConnection).toHaveBeenCalledWith(
			expect.objectContaining({ entityId: OWNER_ENTITY }),
		);
	});
});
