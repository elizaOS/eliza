/**
 * Unit coverage for trusted-admin context resolution across owner, room, world,
 * and role boundaries. Typed runtime fakes supply boundary data while the real
 * resolver and server-derived world ID logic execute unchanged.
 */

import { describe, expect, test, vi } from "vitest";
import { createUniqueUuid } from "../../../entities.ts";
import { createMockRuntime } from "../../../testing/mock-runtime.ts";
import {
	ChannelType,
	type Memory,
	Role,
	type Room,
	type State,
	type UUID,
	type World,
} from "../../../types/index.ts";
import { resolveAdminContext } from "./adminContext.ts";

const AGENT_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const ENTITY_ID = "00000000-0000-0000-0000-000000000002" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-000000000003" as UUID;
const ROOM_WORLD_ID = "00000000-0000-0000-0000-000000000004" as UUID;
const CONFIGURED_WORLD_ID = "00000000-0000-0000-0000-000000000005" as UUID;
const SERVER_ID = "00000000-0000-0000-0000-000000000006" as UUID;

const message: Memory = {
	agentId: AGENT_ID,
	entityId: ENTITY_ID,
	roomId: ROOM_ID,
	content: { text: "check admin context" },
};

function room(
	type: Room["type"],
	worldId?: UUID,
	messageServerId?: UUID,
): Room {
	return {
		id: ROOM_ID,
		agentId: AGENT_ID,
		source: "test",
		type,
		worldId,
		messageServerId,
	};
}

function world(id: UUID, role?: Role): World {
	return {
		id,
		agentId: AGENT_ID,
		metadata: role ? { roles: { [ENTITY_ID]: role } } : undefined,
	};
}

describe("resolveAdminContext", () => {
	test("trusts the configured owner without loading room or world state", async () => {
		const getRoom = vi.fn();
		const getWorld = vi.fn();
		const runtime = createMockRuntime({
			agentId: AGENT_ID,
			getSetting: (key) => (key === "OWNER_ENTITY_ID" ? ENTITY_ID : null),
			getRoom,
			getWorld,
		});

		await expect(resolveAdminContext(runtime, message)).resolves.toBe(true);
		expect(getRoom).not.toHaveBeenCalled();
		expect(getWorld).not.toHaveBeenCalled();
	});

	test("uses a room already present in state instead of loading it", async () => {
		const getRoom = vi.fn();
		const runtime = createMockRuntime({
			agentId: AGENT_ID,
			getSetting: () => null,
			getRoom,
		});
		const state: State = {
			values: {},
			data: { room: room(ChannelType.DM) },
			text: "",
		};

		await expect(resolveAdminContext(runtime, message, state)).resolves.toBe(
			true,
		);
		expect(getRoom).not.toHaveBeenCalled();
	});

	test("rejects a sender when the room cannot be resolved", async () => {
		const getWorld = vi.fn();
		const runtime = createMockRuntime({
			agentId: AGENT_ID,
			getSetting: () => null,
			getRoom: async () => null,
			getWorld,
		});

		await expect(resolveAdminContext(runtime, message)).resolves.toBe(false);
		expect(getWorld).not.toHaveBeenCalled();
	});

	test("trusts a direct-message sender without world resolution", async () => {
		const getWorld = vi.fn();
		const runtime = createMockRuntime({
			agentId: AGENT_ID,
			getSetting: () => null,
			getRoom: async () => room(ChannelType.DM),
			getWorld,
		});

		await expect(resolveAdminContext(runtime, message)).resolves.toBe(true);
		expect(getWorld).not.toHaveBeenCalled();
	});

	test("rejects non-DM, non-group channels without world resolution", async () => {
		const getWorld = vi.fn();
		const runtime = createMockRuntime({
			agentId: AGENT_ID,
			getSetting: () => null,
			getRoom: async () => room(ChannelType.VOICE_GROUP),
			getWorld,
		});

		await expect(resolveAdminContext(runtime, message)).resolves.toBe(false);
		expect(getWorld).not.toHaveBeenCalled();
	});

	test("rejects a group with no room, configured, or server world binding", async () => {
		const getWorld = vi.fn();
		const runtime = createMockRuntime({
			agentId: AGENT_ID,
			getSetting: () => null,
			getRoom: async () => room(ChannelType.GROUP),
			getWorld,
		});

		await expect(resolveAdminContext(runtime, message)).resolves.toBe(false);
		expect(getWorld).not.toHaveBeenCalled();
	});

	test("prefers the room world ID and trusts its ADMIN role", async () => {
		const getWorld = vi.fn(async () => world(ROOM_WORLD_ID, Role.ADMIN));
		const runtime = createMockRuntime({
			agentId: AGENT_ID,
			getSetting: (key) => (key === "WORLD_ID" ? CONFIGURED_WORLD_ID : null),
			getRoom: async () => room(ChannelType.GROUP, ROOM_WORLD_ID, SERVER_ID),
			getWorld,
		});

		await expect(resolveAdminContext(runtime, message)).resolves.toBe(true);
		expect(getWorld).toHaveBeenCalledWith(ROOM_WORLD_ID);
	});

	test("falls back to the configured world ID and trusts its OWNER role", async () => {
		const getWorld = vi.fn(async () => world(CONFIGURED_WORLD_ID, Role.OWNER));
		const runtime = createMockRuntime({
			agentId: AGENT_ID,
			getSetting: (key) => (key === "WORLD_ID" ? CONFIGURED_WORLD_ID : null),
			getRoom: async () => room(ChannelType.GROUP, undefined, SERVER_ID),
			getWorld,
		});

		await expect(resolveAdminContext(runtime, message)).resolves.toBe(true);
		expect(getWorld).toHaveBeenCalledWith(CONFIGURED_WORLD_ID);
	});

	test("derives the world ID from the message server when needed", async () => {
		const getWorld = vi.fn(async (worldId: UUID) => world(worldId, Role.ADMIN));
		const runtime = createMockRuntime({
			agentId: AGENT_ID,
			getSetting: () => null,
			getRoom: async () => room(ChannelType.GROUP, undefined, SERVER_ID),
			getWorld,
		});
		const derivedWorldId = createUniqueUuid(runtime, SERVER_ID);

		await expect(resolveAdminContext(runtime, message)).resolves.toBe(true);
		expect(getWorld).toHaveBeenCalledWith(derivedWorldId);
	});

	test("rejects a group when the resolved world is missing", async () => {
		const runtime = createMockRuntime({
			agentId: AGENT_ID,
			getSetting: () => null,
			getRoom: async () => room(ChannelType.GROUP, ROOM_WORLD_ID),
			getWorld: async () => null,
		});

		await expect(resolveAdminContext(runtime, message)).resolves.toBe(false);
	});

	test("rejects a group when the world has no role for the sender", async () => {
		const runtime = createMockRuntime({
			agentId: AGENT_ID,
			getSetting: () => null,
			getRoom: async () => room(ChannelType.GROUP, ROOM_WORLD_ID),
			getWorld: async () => world(ROOM_WORLD_ID),
		});

		await expect(resolveAdminContext(runtime, message)).resolves.toBe(false);
	});

	test.each([Role.MEMBER, Role.GUEST, Role.NONE, "admin" as Role])(
		"rejects the non-privileged or non-canonical role %s",
		async (role) => {
			const runtime = createMockRuntime({
				agentId: AGENT_ID,
				getSetting: () => null,
				getRoom: async () => room(ChannelType.GROUP, ROOM_WORLD_ID),
				getWorld: async () => world(ROOM_WORLD_ID, role),
			});

			await expect(resolveAdminContext(runtime, message)).resolves.toBe(false);
		},
	);
});
