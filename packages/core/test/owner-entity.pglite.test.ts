/**
 * resolveOwnerEntityId must agree with resolveOwnerEntityIdOrDefault when the
 * configured or world-recorded owner id is not a UUID, so owner routing never
 * passes a connector platform id into UUID-typed queries. Drives a real
 * AgentRuntime on an in-memory PGlite database (plugin-sql).
 */

import pluginSql from "@elizaos/plugin-sql";
import { afterEach, expect, it } from "vitest";
import { resolveOwnerEntityId } from "../src/owner-entity";
import { resolveOwnerEntityIdOrDefault } from "../src/roles";
import { AgentRuntime } from "../src/runtime";
import { ChannelType, type UUID } from "../src/types/primitives";
import { stringToUuid } from "../src/utils/string-to-uuid.js";

const SNOWFLAKE = "123456789012345678";
const WORLD_OWNER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

let databases = 0;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function createRuntime(): Promise<AgentRuntime> {
	const previousDataDir = process.env.PGLITE_DATA_DIR;
	// plugin-sql caches managers per data dir, so each runtime gets its own.
	process.env.PGLITE_DATA_DIR = `memory://owner-entity-${process.pid}-${++databases}`;
	const runtime = new AgentRuntime({
		character: { name: "OwnerEntity", bio: ["Tests owner entity resolution"] },
		logLevel: "fatal",
	});
	await runtime.registerPlugin(pluginSql);
	await runtime.initialize();
	cleanups.push(async () => {
		await runtime.stop();
		await runtime.close();
		if (previousDataDir === undefined) delete process.env.PGLITE_DATA_DIR;
		else process.env.PGLITE_DATA_DIR = previousDataDir;
	});
	return runtime;
}

/** Persists a world recording `ownerId` and a room in it the agent joins. */
async function seedOwnedWorld(
	runtime: AgentRuntime,
	label: string,
	ownerId: string,
): Promise<void> {
	const worldId = stringToUuid(`${runtime.agentId}-${label}-world`);
	const roomId = stringToUuid(`${runtime.agentId}-${label}-room`);
	await runtime.createWorld({
		id: worldId,
		name: label,
		agentId: runtime.agentId,
		metadata: { ownership: { ownerId } },
	});
	await runtime.createRoom({
		id: roomId,
		name: label,
		source: "test",
		type: ChannelType.GROUP,
		worldId,
	});
	await runtime.addParticipant(runtime.agentId, roomId);
}

it("falls back to the default owner when a world records a non-UUID owner id", async () => {
	const runtime = await createRuntime();
	await seedOwnedWorld(runtime, "legacy", SNOWFLAKE);

	const owner = (await resolveOwnerEntityId(runtime)) as UUID;

	expect(owner).toBe(resolveOwnerEntityIdOrDefault(runtime));
	await expect(runtime.getRoomsForParticipants([owner])).resolves.toEqual([]);
});

it("falls back to the default owner when the configured owner id is not a UUID", async () => {
	const runtime = await createRuntime();
	// Configured owners outrank world metadata even when the configured id is unusable.
	await seedOwnedWorld(runtime, "owned", WORLD_OWNER);
	runtime.setSetting("ELIZA_ADMIN_ENTITY_ID", SNOWFLAKE);

	const owner = (await resolveOwnerEntityId(runtime)) as UUID;

	expect(owner).toBe(resolveOwnerEntityIdOrDefault(runtime));
	await expect(runtime.getRoomsForParticipants([owner])).resolves.toEqual([]);
});

it("returns a UUID owner id recorded on a world", async () => {
	const runtime = await createRuntime();
	await seedOwnedWorld(runtime, "owned", WORLD_OWNER);

	expect(await resolveOwnerEntityId(runtime)).toBe(WORLD_OWNER);
});
