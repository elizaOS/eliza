/**
 * Exercises connection reconciliation against the production in-memory adapter,
 * including durable shared-world role metadata across sequential callers.
 */
import { describe, expect, it } from "vitest";
import { ensureConnection } from "./connection";
import { InMemoryDatabaseAdapter } from "./database/inMemoryAdapter";
import { recordOwnerGrant, recordRoleGrant } from "./roles";
import { stringToUuid } from "./utils";

describe("ensureConnection", () => {
	it("preserves existing role grants when another caller reconciles", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		const agentId = stringToUuid("connection-role-agent");
		const ownerId = stringToUuid("connection-role-owner");
		const firstCallerId = stringToUuid("connection-role-first-caller");
		const secondCallerId = stringToUuid("connection-role-second-caller");
		const worldId = stringToUuid("connection-role-world");
		const messageServerId = stringToUuid("connection-role-server");

		const reconcile = async (callerId: typeof firstCallerId) => {
			await ensureConnection(adapter, {
				agentId,
				entityId: callerId,
				roomId: stringToUuid(`connection-role-room-${callerId}`),
				worldId,
				messageServerId,
				source: "client_chat",
				channelId: `connection-role-channel-${callerId}`,
				metadata: {
					ownership: { ownerId },
					waifuRole: "USER",
				},
			});

			const [world] = await adapter.getWorldsByIds([worldId]);
			if (!world?.metadata) throw new Error("reconciled world is missing");
			recordOwnerGrant(world.metadata, ownerId);
			recordRoleGrant(world.metadata, callerId, "USER", "connector_admin");
			await adapter.updateWorlds([world]);
		};

		await reconcile(firstCallerId);
		await reconcile(secondCallerId);

		const [world] = await adapter.getWorldsByIds([worldId]);
		expect(world?.metadata?.roles).toMatchObject({
			[ownerId]: "OWNER",
			[firstCallerId]: "USER",
			[secondCallerId]: "USER",
		});
		expect(world?.metadata?.roleSources).toMatchObject({
			[ownerId]: "owner",
			[firstCallerId]: "connector_admin",
			[secondCallerId]: "connector_admin",
		});
	});

	it("preserves the entity's per-source identity when a later connection omits identity fields", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		const agentId = stringToUuid("connection-identity-agent");
		const ownerEntityId = stringToUuid("connection-identity-owner");
		const worldId = stringToUuid("connection-identity-world");
		const base = {
			agentId,
			entityId: ownerEntityId,
			roomId: stringToUuid("connection-identity-room"),
			worldId,
			messageServerId: stringToUuid("connection-identity-server"),
			source: "discord",
			channelId: "connection-identity-channel",
		};

		await ensureConnection(adapter, {
			...base,
			userId: stringToUuid("owner-wire-id"),
			name: "Owner Display",
			userName: "owner_handle",
		});

		// An owner-aliased author (webhook or alias account) ensures the same
		// canonical entity without identity fields; the recorded identity and
		// names must survive untouched.
		await ensureConnection(adapter, base);

		const [entity] = await adapter.getEntitiesByIds([ownerEntityId]);
		expect(entity?.metadata?.discord).toEqual({
			id: stringToUuid("owner-wire-id"),
			name: "Owner Display",
			userName: "owner_handle",
		});
		expect(entity?.names).toEqual(["Owner Display", "owner_handle"]);
	});

	it("merges per-source identity field-by-field instead of replacing the record", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		const agentId = stringToUuid("connection-merge-agent");
		const entityId = stringToUuid("connection-merge-entity");
		const base = {
			agentId,
			entityId,
			roomId: stringToUuid("connection-merge-room"),
			worldId: stringToUuid("connection-merge-world"),
			messageServerId: stringToUuid("connection-merge-server"),
			source: "discord",
			channelId: "connection-merge-channel",
		};

		await ensureConnection(adapter, {
			...base,
			userId: stringToUuid("merge-wire-id"),
			name: "Original Name",
			userName: "original_handle",
		});
		await ensureConnection(adapter, { ...base, name: "Renamed" });

		const [entity] = await adapter.getEntitiesByIds([entityId]);
		expect(entity?.metadata?.discord).toEqual({
			id: stringToUuid("merge-wire-id"),
			name: "Renamed",
			userName: "original_handle",
		});
	});

	it("keeps identity records from different sources side by side", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		const agentId = stringToUuid("connection-sources-agent");
		const entityId = stringToUuid("connection-sources-entity");
		const shared = {
			agentId,
			entityId,
			roomId: stringToUuid("connection-sources-room"),
			worldId: stringToUuid("connection-sources-world"),
			messageServerId: stringToUuid("connection-sources-server"),
			channelId: "connection-sources-channel",
		};

		await ensureConnection(adapter, {
			...shared,
			source: "discord",
			userName: "discord_handle",
		});
		await ensureConnection(adapter, {
			...shared,
			source: "telegram",
			userName: "telegram_handle",
		});

		const [entity] = await adapter.getEntitiesByIds([entityId]);
		expect(entity?.metadata?.discord).toEqual({ userName: "discord_handle" });
		expect(entity?.metadata?.telegram).toEqual({ userName: "telegram_handle" });
	});
});
