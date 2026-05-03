import { describe, expect, it } from "vitest";
import type {
	Entity,
	IAgentRuntime,
	Memory,
	Room,
	State,
	UUID,
	World,
} from "../../../types/index.ts";
import { ChannelType } from "../../../types/index.ts";
import { asUUID } from "../../../types/primitives.ts";
import { roleProvider } from "./roles.ts";

const agentId = asUUID("00000000-0000-0000-0000-000000000001");
const roomId = asUUID("00000000-0000-0000-0000-000000000002");
const worldId = asUUID("00000000-0000-0000-0000-000000000003");
const ownerId = asUUID("00000000-0000-0000-0000-000000000004");
const adminId = asUUID("00000000-0000-0000-0000-000000000005");

function createRuntime(entities: Record<UUID, Entity>): IAgentRuntime {
	const world: World = {
		id: worldId,
		agentId,
		name: "Test server",
		metadata: {
			ownership: { ownerId },
			roles: {
				[ownerId]: "OWNER",
				[adminId]: "ADMIN",
			},
		},
	} as World;

	return {
		agentId,
		getRoom: async () => null,
		getWorld: async () => world,
		getEntityById: async (entityId: UUID) => entities[entityId] ?? null,
	} as IAgentRuntime;
}

describe("roleProvider", () => {
	it("formats users with nested platform identity metadata", async () => {
		const room = {
			id: roomId,
			agentId,
			type: ChannelType.GROUP,
			worldId,
		} as Room;
		const message = { roomId } as Memory;
		const state = { values: {}, data: { room }, text: "" } satisfies State;

		const result = await roleProvider.get(
			createRuntime({
				[ownerId]: {
					id: ownerId,
					agentId,
					names: ["Owner Alias"],
					metadata: {
						discord: { name: "Owner Display", username: "owner_handle" },
					},
				},
				[adminId]: {
					id: adminId,
					agentId,
					names: ["Admin Alias"],
					metadata: {
						telegram: { name: "Admin Display", userName: "admin_handle" },
					},
				},
			}),
			message,
			state,
		);

		expect(result.text).toContain("Owner Display (Owner Alias)");
		expect(result.text).toContain("Admin Display (Admin Alias) (admin_handle)");
		expect(result.text).not.toBe(
			"No role information available for this server.",
		);
	});
});
