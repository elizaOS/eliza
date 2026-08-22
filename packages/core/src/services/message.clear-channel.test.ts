/**
 * Drives the real {@link DefaultMessageService.clearChannel} against a real
 * {@link AgentRuntime} + {@link InMemoryDatabaseAdapter}. Origin getMemoriesByRoomIds
 * defaulted limit to 20, so a 25-message room left 5 rows after a successful
 * clear. The bulk deleteAllMemories path must empty the room regardless of that
 * default.
 */
import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "../database/inMemoryAdapter.ts";
import { AgentRuntime } from "../runtime.ts";
import type { Character, UUID } from "../types";
import { DefaultMessageService } from "./message.ts";

const ROOM_ID = "20000000-0000-0000-0000-0000000000aa" as UUID;
const ENTITY_ID = "10000000-0000-0000-0000-0000000000aa" as UUID;

async function seededRuntime(count: number): Promise<{
	runtime: AgentRuntime;
	adapter: InMemoryDatabaseAdapter;
}> {
	const adapter = new InMemoryDatabaseAdapter();
	await adapter.initialize();
	const runtime = new AgentRuntime({
		character: { name: "ClearChannelAgent", bio: "test" } as Character,
		adapter,
		logLevel: "fatal",
	});
	const memories = Array.from({ length: count }, (_, index) => ({
		memory: {
			id: `30000000-0000-0000-0000-0000000000${String(index).padStart(2, "0")}` as UUID,
			entityId: ENTITY_ID,
			agentId: runtime.agentId,
			roomId: ROOM_ID,
			content: { text: `msg ${index}` },
			createdAt: index,
		},
		tableName: "messages",
	}));
	await adapter.createMemories(memories);
	return { runtime, adapter };
}

describe("DefaultMessageService.clearChannel", () => {
	it("deletes every message in a room larger than the in-memory default page", async () => {
		const { runtime, adapter } = await seededRuntime(25);
		const before = await adapter.getMemories({
			tableName: "messages",
			roomId: ROOM_ID,
		});
		expect(before).toHaveLength(25);

		await new DefaultMessageService().clearChannel(
			runtime,
			ROOM_ID,
			"chan-repro",
		);

		const remaining = await adapter.getMemories({
			tableName: "messages",
			roomId: ROOM_ID,
		});
		expect(remaining).toHaveLength(0);
	});

	it("is a no-op on an already empty room", async () => {
		const { runtime, adapter } = await seededRuntime(0);
		await new DefaultMessageService().clearChannel(
			runtime,
			ROOM_ID,
			"chan-empty",
		);
		const remaining = await adapter.getMemories({
			tableName: "messages",
			roomId: ROOM_ID,
		});
		expect(remaining).toHaveLength(0);
	});
});
