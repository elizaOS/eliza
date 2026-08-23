/**
 * Exercises safe NaN handling and ascending sort order in runBotLoopGate.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createCharacter } from "../../character";
import { InMemoryDatabaseAdapter } from "../../database/inMemoryAdapter";
import { AgentRuntime } from "../../runtime";
import type { Memory, UUID } from "../../types/index";
import { ChannelType } from "../../types/index";
import { runBotLoopGate } from "./bot-loop-gate";

const WORLD_ID = "66666666-6666-6666-6666-666666666660" as UUID;
const GROUP_ROOM = "66666666-6666-6666-6666-666666666661" as UUID;
const HUMAN = "66666666-6666-6666-6666-6666666666aa" as UUID;
const OTHER_BOT = "66666666-6666-6666-6666-6666666666bb" as UUID;

const activeRuntimes: AgentRuntime[] = [];

afterEach(async () => {
	while (activeRuntimes.length > 0) {
		await activeRuntimes.pop()?.stop();
	}
});

async function makeRuntime(): Promise<{
	runtime: AgentRuntime;
	adapter: InMemoryDatabaseAdapter;
}> {
	const adapter = new InMemoryDatabaseAdapter();
	const runtime = new AgentRuntime({
		character: createCharacter({
			name: "GateAgent",
		}),
		adapter,
		logLevel: "fatal",
		enableAutonomy: false,
	});
	await runtime.initialize();
	runtime.useModel = (async () => {
		throw new Error("bot-loop gate must not call a model");
	}) as typeof runtime.useModel;
	await adapter.createWorlds([
		{
			id: WORLD_ID,
			agentId: runtime.agentId,
			name: "gate world",
			metadata: { roles: {} },
		},
	]);
	await adapter.createRooms([
		{
			id: GROUP_ROOM,
			agentId: runtime.agentId,
			source: "test",
			type: ChannelType.GROUP,
			worldId: WORLD_ID,
		},
	]);
	activeRuntimes.push(runtime);
	return { runtime, adapter };
}

describe("bot-loop-gate safe NaN handling and chronological ordering", () => {
	it("preserves newest turns in chronological order when earlier messages contain NaN createdAt", async () => {
		const { runtime, adapter } = await makeRuntime();

		// Seed a dialogue where early messages have NaN/undefined timestamps, followed by human then 2 bot turns
		const rows: Memory[] = [
			{
				id: "00000000-0000-0000-0000-000000000001" as UUID,
				entityId: OTHER_BOT,
				roomId: GROUP_ROOM,
				worldId: WORLD_ID,
				createdAt: Number.NaN,
				content: { text: "nan message", source: "test" },
				metadata: { fromBot: true },
			} as Memory,
			{
				id: "00000000-0000-0000-0000-000000000002" as UUID,
				entityId: HUMAN,
				roomId: GROUP_ROOM,
				worldId: WORLD_ID,
				createdAt: 1000,
				content: { text: "human kickoff", source: "test" },
			} as Memory,
			{
				id: "00000000-0000-0000-0000-000000000003" as UUID,
				entityId: OTHER_BOT,
				roomId: GROUP_ROOM,
				worldId: WORLD_ID,
				createdAt: 2000,
				content: { text: "bot 1", source: "test" },
				metadata: { fromBot: true },
			} as Memory,
			{
				id: "00000000-0000-0000-0000-000000000004" as UUID,
				entityId: runtime.agentId,
				roomId: GROUP_ROOM,
				worldId: WORLD_ID,
				createdAt: 3000,
				content: { text: "agent 1", source: "test" },
			} as Memory,
			{
				id: "00000000-0000-0000-0000-000000000005" as UUID,
				entityId: OTHER_BOT,
				roomId: GROUP_ROOM,
				worldId: WORLD_ID,
				createdAt: 4000,
				content: { text: "bot 2", source: "test" },
				metadata: { fromBot: true },
			} as Memory,
			{
				id: "00000000-0000-0000-0000-000000000006" as UUID,
				entityId: runtime.agentId,
				roomId: GROUP_ROOM,
				worldId: WORLD_ID,
				createdAt: 5000,
				content: { text: "agent 2", source: "test" },
			} as Memory,
		];

		await adapter.createMemories(
			rows.map((memory) => ({ memory, tableName: "messages" })),
		);

		const inbound = {
			id: "00000000-0000-0000-0000-000000000007" as UUID,
			entityId: OTHER_BOT,
			roomId: GROUP_ROOM,
			worldId: WORLD_ID,
			createdAt: 6000,
			content: {
				text: "bot 3 incoming",
				source: "test",
				channelType: ChannelType.GROUP,
			},
			metadata: { fromBot: true },
		} as Memory;

		const result = await runBotLoopGate({ runtime, message: inbound });

		// Since order is chronological (ascending), the agent turns (3000, 5000) after human (1000)
		// are correctly recognized as 2 consecutive turns without human intervention -> ignored: true
		expect(result.ignored).toBe(true);
		expect(result.agentTurnsSinceLastHuman).toBe(2);
	});
	it("treats a non-finite human timestamp as oldest instead of newest", async () => {
		const { runtime, adapter } = await makeRuntime();

		// The human turn carries a non-finite createdAt. A raw
		// `(a.createdAt ?? 0) - (b.createdAt ?? 0)` comparator sorts Infinity to
		// the END of the window, which makes the human look like the newest turn
		// and resets agentTurnsSinceLastHuman to 0 — the gate then fails open on a
		// genuine bot loop. The safe comparator maps every non-finite value to 0,
		// so the human stays the oldest turn and the two agent turns after it are
		// still counted.
		const rows: Memory[] = [
			{
				id: "00000000-0000-0000-0000-0000000000a1" as UUID,
				entityId: HUMAN,
				roomId: GROUP_ROOM,
				worldId: WORLD_ID,
				createdAt: Number.POSITIVE_INFINITY,
				content: { text: "human kickoff", source: "test" },
			} as Memory,
			{
				id: "00000000-0000-0000-0000-0000000000a2" as UUID,
				entityId: OTHER_BOT,
				roomId: GROUP_ROOM,
				worldId: WORLD_ID,
				createdAt: 2000,
				content: { text: "bot 1", source: "test" },
				metadata: { fromBot: true },
			} as Memory,
			{
				id: "00000000-0000-0000-0000-0000000000a3" as UUID,
				entityId: runtime.agentId,
				roomId: GROUP_ROOM,
				worldId: WORLD_ID,
				createdAt: 3000,
				content: { text: "agent 1", source: "test" },
			} as Memory,
			{
				id: "00000000-0000-0000-0000-0000000000a4" as UUID,
				entityId: OTHER_BOT,
				roomId: GROUP_ROOM,
				worldId: WORLD_ID,
				createdAt: 4000,
				content: { text: "bot 2", source: "test" },
				metadata: { fromBot: true },
			} as Memory,
			{
				id: "00000000-0000-0000-0000-0000000000a5" as UUID,
				entityId: runtime.agentId,
				roomId: GROUP_ROOM,
				worldId: WORLD_ID,
				createdAt: 5000,
				content: { text: "agent 2", source: "test" },
			} as Memory,
		];

		await adapter.createMemories(
			rows.map((memory) => ({ memory, tableName: "messages" })),
		);

		const inbound = {
			id: "00000000-0000-0000-0000-0000000000a6" as UUID,
			entityId: OTHER_BOT,
			roomId: GROUP_ROOM,
			worldId: WORLD_ID,
			createdAt: 6000,
			content: {
				text: "bot 3 incoming",
				source: "test",
				channelType: ChannelType.GROUP,
			},
			metadata: { fromBot: true },
		} as Memory;

		const result = await runBotLoopGate({ runtime, message: inbound });

		expect(result.agentTurnsSinceLastHuman).toBe(2);
		expect(result.ignored).toBe(true);
	});
});
