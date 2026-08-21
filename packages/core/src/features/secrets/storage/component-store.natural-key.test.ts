/**
 * Deterministic unit test for ComponentSecretStorage against the SQL natural
 * key (entityId, type, worldId, sourceEntityId). The access-control suite
 * uses a list-push mock that hides the unique constraint; this harness
 * rejects a second insert with the same natural key the way plugin-sql does.
 */
import { describe, expect, it } from "vitest";
import { createMockRuntime } from "../../../testing/mock-runtime.ts";
import type { Component, IAgentRuntime, UUID } from "../../../types/index.ts";
import { KeyManager } from "../crypto/encryption.ts";
import type { SecretContext } from "../types.ts";
import { ComponentSecretStorage } from "./component-store.ts";

const AGENT_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const USER_ID = "00000000-0000-0000-0000-000000000003";

function naturalKey(
	component: Pick<
		Component,
		"entityId" | "type" | "worldId" | "sourceEntityId"
	>,
): string {
	return [
		String(component.entityId),
		component.type,
		String(component.worldId ?? ""),
		String(component.sourceEntityId ?? ""),
	].join("::");
}

function keyManager(): KeyManager {
	const manager = new KeyManager();
	manager.initializeFromPassword(AGENT_ID, "test-salt");
	return manager;
}

function makeSqlLikeRuntime(): {
	runtime: IAgentRuntime;
	typesFor: (entityId: string) => string[];
} {
	const byId = new Map<string, Component>();
	const byNatural = new Map<string, string>();
	const byEntity = new Map<string, Component[]>();

	const runtime = createMockRuntime({
		agentId: AGENT_ID,
		getComponents: (async (entityId: UUID) =>
			byEntity.get(entityId) ?? []) as IAgentRuntime["getComponents"],
		createComponent: (async (component: Component) => {
			const key = naturalKey(component);
			if (byNatural.has(key)) {
				throw new Error(`UNIQUE unique_component_natural_key: ${key}`);
			}
			byId.set(component.id, component);
			byNatural.set(key, component.id);
			const list = byEntity.get(component.entityId) ?? [];
			list.push(component);
			byEntity.set(component.entityId, list);
			return true;
		}) as IAgentRuntime["createComponent"],
		updateComponent: (async (component: Component) => {
			byId.set(component.id, component);
			byEntity.set(
				component.entityId,
				(byEntity.get(component.entityId) ?? []).map((entry) =>
					entry.id === component.id ? component : entry,
				),
			);
			return true;
		}) as IAgentRuntime["updateComponent"],
		deleteComponent: (async (componentId: UUID) => {
			const existing = byId.get(componentId);
			if (!existing) return true;
			byId.delete(componentId);
			byNatural.delete(naturalKey(existing));
			byEntity.set(
				existing.entityId,
				(byEntity.get(existing.entityId) ?? []).filter(
					(entry) => entry.id !== componentId,
				),
			);
			return true;
		}) as IAgentRuntime["deleteComponent"],
	});

	return {
		runtime,
		typesFor: (entityId) =>
			(byEntity.get(entityId) ?? []).map((component) => component.type),
	};
}

function ownerContext(): SecretContext {
	return {
		level: "user",
		agentId: AGENT_ID,
		userId: USER_ID,
		requesterId: USER_ID,
	};
}

describe("ComponentSecretStorage SQL natural key", () => {
	it("stores two user secrets without colliding on unique_component_natural_key", async () => {
		const { runtime, typesFor } = makeSqlLikeRuntime();
		const storage = new ComponentSecretStorage(runtime, keyManager());
		await storage.initialize();
		const context = ownerContext();

		await expect(storage.set("API_KEY", "aaa", context)).resolves.toBe(true);
		await expect(storage.set("OAUTH_TOKEN", "bbb", context)).resolves.toBe(
			true,
		);

		await expect(storage.get("API_KEY", context)).resolves.toBe("aaa");
		await expect(storage.get("OAUTH_TOKEN", context)).resolves.toBe("bbb");
		await expect(storage.list(context)).resolves.toMatchObject({
			API_KEY: expect.any(Object),
			OAUTH_TOKEN: expect.any(Object),
		});
		await expect(storage.listKeys(USER_ID)).resolves.toEqual(
			expect.arrayContaining(["API_KEY", "OAUTH_TOKEN"]),
		);
		await expect(storage.countForUser(USER_ID)).resolves.toBe(2);
		expect(typesFor(USER_ID).sort()).toEqual(
			["secret:API_KEY", "secret:OAUTH_TOKEN"].sort(),
		);
	});

	it("updates one key without deleting a sibling", async () => {
		const { runtime } = makeSqlLikeRuntime();
		const storage = new ComponentSecretStorage(runtime, keyManager());
		await storage.initialize();
		const context = ownerContext();

		await storage.set("API_KEY", "aaa", context);
		await storage.set("OAUTH_TOKEN", "bbb", context);
		await storage.set("API_KEY", "ccc", context);

		await expect(storage.get("API_KEY", context)).resolves.toBe("ccc");
		await expect(storage.get("OAUTH_TOKEN", context)).resolves.toBe("bbb");
	});

	it("deletes one key and leaves the other", async () => {
		const { runtime } = makeSqlLikeRuntime();
		const storage = new ComponentSecretStorage(runtime, keyManager());
		await storage.initialize();
		const context = ownerContext();

		await storage.set("API_KEY", "aaa", context);
		await storage.set("OAUTH_TOKEN", "bbb", context);
		await expect(storage.delete("API_KEY", context)).resolves.toBe(true);

		await expect(storage.get("API_KEY", context)).resolves.toBeNull();
		await expect(storage.get("OAUTH_TOKEN", context)).resolves.toBe("bbb");
		await expect(storage.countForUser(USER_ID)).resolves.toBe(1);
	});

	it("still reads and updates a legacy type=secret row", async () => {
		const { runtime } = makeSqlLikeRuntime();
		const storage = new ComponentSecretStorage(runtime, keyManager());
		await storage.initialize();
		const context = ownerContext();
		const km = keyManager();

		await runtime.createComponent({
			id: "00000000-0000-0000-0000-0000000000aa" as UUID,
			createdAt: Date.now(),
			entityId: USER_ID as UUID,
			agentId: AGENT_ID,
			roomId: AGENT_ID,
			worldId: AGENT_ID,
			sourceEntityId: USER_ID as UUID,
			type: "secret",
			data: {
				key: "LEGACY_KEY",
				value: km.encrypt("legacy-value"),
				config: {
					type: "secret",
					required: false,
					description: "legacy",
					canGenerate: false,
					status: "valid",
					attempts: 0,
					plugin: "user",
					level: "user",
					encrypted: true,
					ownerId: USER_ID,
				},
				updatedAt: Date.now(),
			},
		});

		await expect(storage.get("LEGACY_KEY", context)).resolves.toBe(
			"legacy-value",
		);
		await expect(storage.set("LEGACY_KEY", "rotated", context)).resolves.toBe(
			true,
		);
		await expect(storage.get("LEGACY_KEY", context)).resolves.toBe("rotated");
		await expect(storage.set("SIBLING_KEY", "other", context)).resolves.toBe(
			true,
		);
		await expect(storage.get("LEGACY_KEY", context)).resolves.toBe("rotated");
		await expect(storage.get("SIBLING_KEY", context)).resolves.toBe("other");
		await expect(storage.listKeys(USER_ID)).resolves.toEqual(
			expect.arrayContaining(["LEGACY_KEY", "SIBLING_KEY"]),
		);
	});

	it("ignores a keyed type whose stored key does not match", async () => {
		const { runtime } = makeSqlLikeRuntime();
		const storage = new ComponentSecretStorage(runtime, keyManager());
		await storage.initialize();
		const context = ownerContext();
		const km = keyManager();

		await runtime.createComponent({
			id: "00000000-0000-0000-0000-0000000000bb" as UUID,
			createdAt: Date.now(),
			entityId: USER_ID as UUID,
			agentId: AGENT_ID,
			roomId: AGENT_ID,
			worldId: AGENT_ID,
			sourceEntityId: USER_ID as UUID,
			type: "secret:TARGET_KEY",
			data: {
				key: "OTHER_KEY",
				value: km.encrypt("must-not-leak"),
				config: {
					type: "secret",
					required: false,
					description: "mismatched row",
					canGenerate: false,
					status: "valid",
					attempts: 0,
					plugin: "user",
					level: "user",
					encrypted: true,
					ownerId: USER_ID,
				},
				updatedAt: Date.now(),
			},
		});

		await expect(storage.get("TARGET_KEY", context)).resolves.toBeNull();
		await expect(storage.listKeys(USER_ID)).resolves.toEqual([]);
		await expect(storage.countForUser(USER_ID)).resolves.toBe(0);
		await expect(storage.deleteAllForUser(USER_ID)).resolves.toBe(0);
	});

	it("does not read or delete another agent's secret for the same user and key", async () => {
		const otherAgentId = "00000000-0000-0000-0000-000000000099" as UUID;
		const { runtime } = makeSqlLikeRuntime();
		const storage = new ComponentSecretStorage(runtime, keyManager());
		await storage.initialize();
		const context = ownerContext();
		const otherKm = new KeyManager();
		otherKm.initializeFromPassword(otherAgentId, "test-salt");

		await runtime.createComponent({
			id: "00000000-0000-0000-0000-0000000000bb" as UUID,
			createdAt: Date.now(),
			entityId: USER_ID as UUID,
			agentId: otherAgentId,
			roomId: otherAgentId,
			worldId: otherAgentId,
			sourceEntityId: USER_ID as UUID,
			type: "secret:SHARED",
			data: {
				key: "SHARED",
				value: otherKm.encrypt("other-agent-secret"),
				config: {
					type: "secret",
					required: false,
					description: "other",
					canGenerate: false,
					status: "valid",
					attempts: 0,
					plugin: "user",
					level: "user",
					encrypted: true,
					ownerId: USER_ID,
				},
				updatedAt: Date.now(),
			},
		});
		await expect(
			storage.set("SHARED", "this-agent-secret", context),
		).resolves.toBe(true);
		await expect(storage.get("SHARED", context)).resolves.toBe(
			"this-agent-secret",
		);
		await expect(storage.countForUser(USER_ID)).resolves.toBe(1);
		await expect(storage.deleteAllForUser(USER_ID)).resolves.toBe(1);
		await expect(storage.get("SHARED", context)).resolves.toBeNull();
		const leftover = await runtime.getComponents(USER_ID as UUID);
		expect(
			leftover.some((component) => component.agentId === otherAgentId),
		).toBe(true);
	});
});
