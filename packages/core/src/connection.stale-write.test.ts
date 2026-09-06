/**
 * ensureConnection's world upsert against an in-memory adapter whose
 * compare-and-swap rejects a stale revision once (a concurrent writer moved the
 * stored world between the read and the write). Deterministic; no database.
 */
import { describe, expect, it, vi } from "vitest";
import { ensureConnection } from "./connection";
import { InMemoryDatabaseAdapter } from "./database/inMemoryAdapter";
import { ElizaError } from "./errors";
import type { UUID, World } from "./types";
import { ChannelType } from "./types";
import { stringToUuid } from "./utils";

const agentId = stringToUuid("stale-agent") as UUID;
const worldId = stringToUuid("stale-world") as UUID;
const roomId = stringToUuid("stale-room") as UUID;
const entityId = stringToUuid("stale-user") as UUID;

function staleError(): ElizaError {
	return new ElizaError("World metadata write used a stale revision", {
		code: "WORLD_METADATA_STALE_WRITE",
		context: { worldId },
	});
}

async function connect(adapter: InMemoryDatabaseAdapter) {
	await ensureConnection(adapter, {
		agentId,
		entityId,
		roomId,
		worldId,
		userName: "Owner",
		source: "client_chat",
		channelId: "web-chat",
		type: ChannelType.API,
		metadata: { ownership: { ownerId: entityId } },
	});
}

describe("ensureConnection world upsert under a stale revision", () => {
	it("re-reads and re-applies the merge after one stale-write conflict", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		await adapter.init();
		const realUpsert = adapter.upsertWorlds.bind(adapter);
		let conflicts = 1;
		const upsertWorlds = vi.fn(async (worlds: World[]) => {
			if (conflicts > 0) {
				conflicts -= 1;
				// Simulate the concurrent writer: the stored world gained a field.
				await realUpsert([
					{
						...worlds[0],
						metadata: { ...(worlds[0].metadata ?? {}), concurrent: true },
					},
				]);
				throw staleError();
			}
			return realUpsert(worlds);
		});
		adapter.upsertWorlds = upsertWorlds as typeof adapter.upsertWorlds;
		const getWorldsByIds = vi.spyOn(adapter, "getWorldsByIds");

		await connect(adapter);

		expect(upsertWorlds).toHaveBeenCalledTimes(2);
		expect(getWorldsByIds.mock.calls.length).toBeGreaterThanOrEqual(2);
		const [world] = await adapter.getWorldsByIds([worldId]);
		// The re-merge kept the concurrent writer's field and applied ownership.
		expect(world?.metadata).toMatchObject({
			concurrent: true,
			ownership: { ownerId: entityId },
		});
	});

	it("propagates the conflict after the bounded attempts", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		await adapter.init();
		const upsertWorlds = vi.fn(async () => {
			throw staleError();
		});
		adapter.upsertWorlds = upsertWorlds as typeof adapter.upsertWorlds;
		await expect(connect(adapter)).rejects.toMatchObject({
			code: "WORLD_METADATA_STALE_WRITE",
		});
		expect(upsertWorlds).toHaveBeenCalledTimes(3);
	});

	it("does not retry other write failures", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		await adapter.init();
		const failure = new Error("disk full");
		const upsertWorlds = vi.fn(async () => {
			throw failure;
		});
		adapter.upsertWorlds = upsertWorlds as typeof adapter.upsertWorlds;
		await expect(connect(adapter)).rejects.toBe(failure);
		expect(upsertWorlds).toHaveBeenCalledTimes(1);
	});
});
