/**
 * Verifies trust bootstrap writes ADMIN through the real in-memory world CAS,
 * producing the same committed authority audit as interactive role changes.
 */
import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "../../database/inMemoryAdapter";
import { AgentRuntime } from "../../runtime";
import { ChannelType, type Character, type UUID } from "../../types";
import { ROLE_WRITE_AUDIT_LOG_TYPE } from "../../types/database";
import { stringToUuid } from "../../utils";
import { ensureAdminRoleOnInit } from "./index";

describe("trust admin role bootstrap CAS", () => {
	it("commits ADMIN and its authority audit without runtime.updateWorld", async () => {
		const runtime = new AgentRuntime({
			character: { name: "trust-cas" } as Character,
		});
		const adapter = new InMemoryDatabaseAdapter();
		await adapter.init();
		runtime.registerDatabaseAdapter(adapter);
		const ownerId = stringToUuid("trust-cas-owner") as UUID;
		const worldId = stringToUuid("trust-cas-world") as UUID;
		const roomId = stringToUuid("trust-cas-room") as UUID;
		await adapter.createEntities([
			{ id: ownerId, agentId: runtime.agentId, names: ["Owner"] },
		]);
		await adapter.createWorlds([
			{ id: worldId, agentId: runtime.agentId, name: "Trust", metadata: {} },
		]);
		await adapter.createRooms([
			{
				id: roomId,
				agentId: runtime.agentId,
				worldId,
				source: "test",
				type: ChannelType.WORLD,
			},
		]);
		(
			runtime as unknown as { getSetting: (key: string) => unknown }
		).getSetting = (key) =>
			key === "OWNER_ENTITY_ID"
				? ownerId
				: key === "WORLD_ID"
					? worldId
					: undefined;
		(runtime as unknown as { updateWorld: () => Promise<void> }).updateWorld =
			async () => {
				throw new Error("blind world writer must not run");
			};

		await ensureAdminRoleOnInit(runtime);

		const world = (await adapter.getWorldsByIds([worldId]))[0];
		if (!world) throw new Error("trust CAS test world missing");
		expect(
			(world.metadata as { roles?: Record<string, string> }).roles?.[ownerId],
		).toBe("ADMIN");
		const audits = await adapter.getLogs({ type: ROLE_WRITE_AUDIT_LOG_TYPE });
		expect(audits).toHaveLength(1);
		expect(audits[0]?.body).toMatchObject({
			metadata: {
				targetEntityId: ownerId,
				previousRole: "GUEST",
				newRole: "ADMIN",
			},
		});
	});
});
