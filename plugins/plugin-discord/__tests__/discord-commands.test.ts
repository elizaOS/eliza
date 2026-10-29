import { describe, expect, it, vi } from "vitest";
import { handleGuildCreate } from "../discord-commands";

function makeService() {
	const runtime = {
		agentId: "00000000-0000-0000-0000-000000000001",
		emitEvent: vi.fn(),
		reportError: vi.fn(),
		logger: {
			debug: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			info: vi.fn(),
		},
	};
	const memberCache = new Map([
		[
			"u1",
			{
				id: "u1",
				user: { id: "u1", username: "alice", displayName: "Alice" },
			},
		],
	]);
	const fullGuild = {
		id: "g1",
		name: "Guild",
		ownerId: "o1",
		memberCount: 2,
		channels: {
			cache: new Map([
				[
					"chan1",
					{
						id: "chan1",
						type: 0,
						name: "general",
						permissionsFor: () => ({ has: () => true }),
					},
				],
			]),
		},
		members: {
			cache: memberCache,
			fetch: async () => memberCache,
		},
	};
	const service = {
		runtime,
		accountId: undefined,
		client: undefined,
		slashCommands: [],
	};
	const guild = {
		name: "Guild",
		id: "g1",
		fetch: async () => fullGuild,
	};
	return { runtime, service, guild };
}

describe("Discord guild join listener failures", () => {
	it("reports guild join listener failures instead of dropping them", async () => {
		const { runtime, service, guild } = makeService();
		runtime.emitEvent.mockRejectedValue(new Error("listener boom"));

		await handleGuildCreate(service as never, guild as never);

		expect(runtime.reportError).toHaveBeenCalledTimes(2);
		expect(runtime.reportError).toHaveBeenNthCalledWith(
			1,
			"discord:emit-event",
			expect.any(Error),
			expect.objectContaining({ accountId: "default" }),
		);
		expect(runtime.reportError).toHaveBeenNthCalledWith(
			2,
			"discord:emit-event",
			expect.any(Error),
			expect.objectContaining({ accountId: "default" }),
		);
	});
});
