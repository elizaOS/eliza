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
});
