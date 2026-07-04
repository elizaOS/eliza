/**
 * Deterministic unit test for permission enforcement across the secret storage
 * backends (features/secrets/storage): ComponentSecretStorage (user-scoped),
 * WorldMetadataStorage (world-scoped), and CharacterSettingsStorage (global).
 * Verifies each fails closed on a missing or unentitled requester and enforces
 * the read/write roles for its level. Uses createMockRuntime backed by
 * in-memory component/world maps and a real KeyManager.
 */
import { describe, expect, it } from "vitest";
import { createMockRuntime } from "../../../testing/mock-runtime.ts";
import {
	type Component,
	type IAgentRuntime,
	Role,
	type UUID,
} from "../../../types/index.ts";
import { KeyManager } from "../crypto/encryption.ts";
import { PermissionDeniedError, type SecretContext } from "../types.ts";
import { CharacterSettingsStorage } from "./character-store.ts";
import { ComponentSecretStorage } from "./component-store.ts";
import { WorldMetadataStorage } from "./world-store.ts";

const AGENT_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const OWNER_ID = "00000000-0000-0000-0000-000000000002";
const MEMBER_ID = "00000000-0000-0000-0000-000000000003";
const STRANGER_ID = "00000000-0000-0000-0000-000000000004";
const WORLD_ID = "00000000-0000-0000-0000-000000000005" as UUID;

function keyManager(): KeyManager {
	const manager = new KeyManager();
	manager.initializeFromPassword(AGENT_ID, "test-salt");
	return manager;
}

function makeRuntime(): IAgentRuntime {
	const components = new Map<string, Component[]>();
	const world = {
		id: WORLD_ID,
		agentId: AGENT_ID,
		metadata: {
			ownership: { ownerId: OWNER_ID },
			roles: {
				[OWNER_ID]: Role.OWNER,
				[MEMBER_ID]: Role.MEMBER,
			},
			secrets: {},
		},
	};

	return createMockRuntime({
		agentId: AGENT_ID,
		character: {
			name: "T",
			bio: [],
			settings: { secrets: {} },
		} as IAgentRuntime["character"],
		getSetting: ((key: string) =>
			key === "ELIZA_ADMIN_ENTITY_ID"
				? OWNER_ID
				: undefined) as IAgentRuntime["getSetting"],
		getWorld: (async (id: UUID) =>
			id === WORLD_ID ? world : null) as IAgentRuntime["getWorld"],
		updateWorld: (async (nextWorld) => {
			Object.assign(world, nextWorld);
			return true;
		}) as IAgentRuntime["updateWorld"],
		getComponents: (async (entityId: UUID) =>
			components.get(entityId) ?? []) as IAgentRuntime["getComponents"],
		createComponent: (async (component: Component) => {
			const list = components.get(component.entityId) ?? [];
			list.push(component);
			components.set(component.entityId, list);
			return true;
		}) as IAgentRuntime["createComponent"],
		updateComponent: (async (component: Component) => {
			const list = components.get(component.entityId) ?? [];
			const index = list.findIndex((entry) => entry.id === component.id);
			if (index >= 0) {
				list[index] = component;
			}
			components.set(component.entityId, list);
			return true;
		}) as IAgentRuntime["updateComponent"],
		deleteComponent: (async (componentId: UUID) => {
			for (const [entityId, list] of components.entries()) {
				components.set(
					entityId,
					list.filter((entry) => entry.id !== componentId),
				);
			}
			return true;
		}) as IAgentRuntime["deleteComponent"],
	});
}

describe("secrets storage access control", () => {
	it("fails closed for user secrets when requesterId is omitted", async () => {
		const runtime = makeRuntime();
		const storage = new ComponentSecretStorage(runtime, keyManager());
		await storage.initialize();
		const context: SecretContext = {
			level: "user",
			agentId: AGENT_ID,
			userId: MEMBER_ID,
		};

		await expect(storage.get("USER_KEY", context)).rejects.toBeInstanceOf(
			PermissionDeniedError,
		);
		await expect(
			storage.set("USER_KEY", "value", context),
		).rejects.toBeInstanceOf(PermissionDeniedError);
	});

	it("allows only the user to read and write user secrets", async () => {
		const runtime = makeRuntime();
		const storage = new ComponentSecretStorage(runtime, keyManager());
		await storage.initialize();
		const ownerContext: SecretContext = {
			level: "user",
			agentId: AGENT_ID,
			userId: MEMBER_ID,
			requesterId: MEMBER_ID,
		};
		const strangerContext: SecretContext = {
			...ownerContext,
			requesterId: STRANGER_ID,
		};

		await expect(storage.set("USER_KEY", "value", ownerContext)).resolves.toBe(
			true,
		);
		await expect(storage.get("USER_KEY", ownerContext)).resolves.toBe("value");
		await expect(
			storage.get("USER_KEY", strangerContext),
		).rejects.toBeInstanceOf(PermissionDeniedError);
	});

	it("requires world membership for world secret reads", async () => {
		const runtime = makeRuntime();
		const storage = new WorldMetadataStorage(runtime, keyManager());
		await storage.initialize();
		const ownerContext: SecretContext = {
			level: "world",
			agentId: AGENT_ID,
			worldId: WORLD_ID,
			requesterId: OWNER_ID,
		};
		const memberContext: SecretContext = {
			...ownerContext,
			requesterId: MEMBER_ID,
		};
		const strangerContext: SecretContext = {
			...ownerContext,
			requesterId: STRANGER_ID,
		};
		const anonymousContext: SecretContext = {
			level: "world",
			agentId: AGENT_ID,
			worldId: WORLD_ID,
		};

		await storage.set("WORLD_KEY", "value", ownerContext);
		await expect(storage.get("WORLD_KEY", memberContext)).resolves.toBe(
			"value",
		);
		await expect(
			storage.get("WORLD_KEY", strangerContext),
		).rejects.toBeInstanceOf(PermissionDeniedError);
		await expect(
			storage.get("WORLD_KEY", anonymousContext),
		).rejects.toBeInstanceOf(PermissionDeniedError);
	});

	it("requires OWNER or ADMIN for world secret writes", async () => {
		const runtime = makeRuntime();
		const storage = new WorldMetadataStorage(runtime, keyManager());
		await storage.initialize();
		const memberContext: SecretContext = {
			level: "world",
			agentId: AGENT_ID,
			worldId: WORLD_ID,
			requesterId: MEMBER_ID,
		};

		await expect(
			storage.set("WORLD_KEY", "value", memberContext),
		).rejects.toBeInstanceOf(PermissionDeniedError);
	});

	it("requires an entitled requester for global secrets", async () => {
		const runtime = makeRuntime();
		const storage = new CharacterSettingsStorage(runtime, keyManager());
		await storage.initialize();
		const ownerContext: SecretContext = {
			level: "global",
			agentId: AGENT_ID,
			requesterId: OWNER_ID,
		};
		const anonymousContext: SecretContext = {
			level: "global",
			agentId: AGENT_ID,
		};
		const strangerContext: SecretContext = {
			level: "global",
			agentId: AGENT_ID,
			requesterId: STRANGER_ID,
		};

		await expect(
			storage.set("GLOBAL_KEY", "value", ownerContext),
		).resolves.toBe(true);
		await expect(storage.get("GLOBAL_KEY", ownerContext)).resolves.toBe(
			"value",
		);
		await expect(
			storage.get("GLOBAL_KEY", anonymousContext),
		).rejects.toBeInstanceOf(PermissionDeniedError);
		await expect(
			storage.get("GLOBAL_KEY", strangerContext),
		).rejects.toBeInstanceOf(PermissionDeniedError);
	});
});
