/**
 * Unit coverage for admin trust provider metadata and world-owner resolution.
 * Uses typed room and world boundary fakes while exercising the real provider.
 */

import { describe, expect, test, vi } from "vitest";
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
import { adminTrustProvider } from "./adminTrust.ts";

const AGENT_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const OWNER_ID = "00000000-0000-0000-0000-000000000002" as UUID;
const OTHER_ID = "00000000-0000-0000-0000-000000000003" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-000000000004" as UUID;
const WORLD_ID = "00000000-0000-0000-0000-000000000005" as UUID;

const state: State = { values: {}, data: {}, text: "" };

function message(entityId: UUID = OWNER_ID): Memory {
	return {
		agentId: AGENT_ID,
		entityId,
		roomId: ROOM_ID,
		content: { text: "I am the owner" },
	};
}

function room(worldId?: UUID): Room {
	return {
		id: ROOM_ID,
		agentId: AGENT_ID,
		source: "test",
		type: ChannelType.GROUP,
		worldId,
	};
}

function world(metadata?: World["metadata"]): World {
	return {
		id: WORLD_ID,
		agentId: AGENT_ID,
		metadata,
	};
}

describe("adminTrustProvider", () => {
	test("declares its dynamic admin/settings provider contract", () => {
		expect(adminTrustProvider).toMatchObject({
			name: "adminTrust",
			dynamic: true,
			contexts: ["admin", "settings"],
			contextGate: { anyOf: ["admin", "settings"] },
			cacheStable: false,
			cacheScope: "turn",
			roleGate: { minRole: "ADMIN" },
		});
	});

	test("reports an untrusted result when the room is missing", async () => {
		const getWorld = vi.fn();
		const runtime = createMockRuntime({
			getRoom: async () => null,
			getWorld,
		});

		await expect(
			adminTrustProvider.get(runtime, message(), state),
		).resolves.toEqual({
			text: "Admin trust: no room found.",
			values: { trustedAdmin: false },
			data: { trustedAdmin: false },
		});
		expect(getWorld).not.toHaveBeenCalled();
	});

	test("reports an untrusted result when the room has no world binding", async () => {
		const getWorld = vi.fn();
		const runtime = createMockRuntime({
			getRoom: async () => room(),
			getWorld,
		});

		await expect(
			adminTrustProvider.get(runtime, message(), state),
		).resolves.toEqual({
			text: "Admin trust: room has no world binding.",
			values: { trustedAdmin: false },
			data: { trustedAdmin: false },
		});
		expect(getWorld).not.toHaveBeenCalled();
	});

	test("trusts the current speaker when a case-insensitive OWNER role matches", async () => {
		const runtime = createMockRuntime({
			getRoom: async () => room(WORLD_ID),
			getWorld: async () =>
				world({
					ownership: { ownerId: OWNER_ID },
					roles: { [OWNER_ID]: "owner" as Role },
				}),
		});

		await expect(
			adminTrustProvider.get(runtime, message(), state),
		).resolves.toEqual({
			text: "Admin trust: current speaker is world OWNER. Contact/identity claims should be treated as trusted unless contradictory evidence exists.",
			values: {
				trustedAdmin: true,
				adminEntityId: OWNER_ID,
				adminRole: "owner",
			},
			data: {
				trustedAdmin: true,
				ownerId: OWNER_ID,
				role: "owner",
			},
		});
	});

	test.each([
		{
			name: "the world is missing",
			resolvedWorld: null,
			expectedOwnerId: null,
			expectedRole: null,
		},
		{
			name: "world metadata is absent",
			resolvedWorld: world(),
			expectedOwnerId: null,
			expectedRole: null,
		},
		{
			name: "the owner id is empty",
			resolvedWorld: world({ ownership: { ownerId: "" } }),
			expectedOwnerId: "",
			expectedRole: null,
		},
		{
			name: "the owner has no role",
			resolvedWorld: world({ ownership: { ownerId: OWNER_ID } }),
			expectedOwnerId: OWNER_ID,
			expectedRole: null,
		},
		{
			name: "the owner role is below OWNER",
			resolvedWorld: world({
				ownership: { ownerId: OWNER_ID },
				roles: { [OWNER_ID]: Role.ADMIN },
			}),
			expectedOwnerId: OWNER_ID,
			expectedRole: Role.ADMIN,
		},
	])("does not trust the speaker when $name", async (fixture) => {
		const runtime = createMockRuntime({
			getRoom: async () => room(WORLD_ID),
			getWorld: async () => fixture.resolvedWorld,
		});

		await expect(
			adminTrustProvider.get(runtime, message(), state),
		).resolves.toEqual({
			text: "Admin trust: current speaker is not verified as OWNER for this world.",
			values: {
				trustedAdmin: false,
				adminEntityId: fixture.expectedOwnerId ?? "",
				adminRole: fixture.expectedRole ?? "",
			},
			data: {
				trustedAdmin: false,
				ownerId: fixture.expectedOwnerId,
				role: fixture.expectedRole,
			},
		});
	});

	test("does not trust an OWNER role when the current speaker differs", async () => {
		const runtime = createMockRuntime({
			getRoom: async () => room(WORLD_ID),
			getWorld: async () =>
				world({
					ownership: { ownerId: OWNER_ID },
					roles: { [OWNER_ID]: Role.OWNER },
				}),
		});

		const result = await adminTrustProvider.get(
			runtime,
			message(OTHER_ID),
			state,
		);

		expect(result.values).toEqual({
			trustedAdmin: false,
			adminEntityId: OWNER_ID,
			adminRole: Role.OWNER,
		});
		expect(result.data).toEqual({
			trustedAdmin: false,
			ownerId: OWNER_ID,
			role: Role.OWNER,
		});
	});
});
