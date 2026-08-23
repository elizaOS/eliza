/**
 * Exercises ComponentSecretStorage through an in-memory runtime that preserves
 * component persistence semantics while keeping authorization, encryption,
 * expiry, filtering, configuration, and bulk-operation behavior real.
 */
import { describe, expect, it } from "vitest";
import { createMockRuntime } from "../../../testing/mock-runtime.ts";
import type { Component, IAgentRuntime, UUID } from "../../../types/index.ts";
import { KeyManager } from "../crypto/encryption.ts";
import type { EncryptedSecret, SecretConfig, SecretContext } from "../types.ts";
import { PermissionDeniedError, StorageError } from "../types.ts";
import { ComponentSecretStorage } from "./component-store.ts";

const AGENT_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const OTHER_AGENT_ID = "00000000-0000-0000-0000-000000000002" as UUID;
const USER_ID = "00000000-0000-0000-0000-000000000003" as UUID;

function ownerContext(): SecretContext {
	return {
		level: "user",
		agentId: AGENT_ID,
		userId: USER_ID,
		requesterId: USER_ID,
	};
}

function keyManager(): KeyManager {
	const manager = new KeyManager();
	manager.initializeFromPassword(AGENT_ID, "component-store-test-salt");
	return manager;
}

function secretConfig(options?: {
	encrypted?: boolean;
	expiresAt?: number;
	description?: string;
}): SecretConfig {
	return {
		type: "secret",
		required: false,
		description: options?.description ?? "fixture secret",
		canGenerate: false,
		status: "valid",
		attempts: 0,
		plugin: "user",
		level: "user",
		ownerId: USER_ID,
		encrypted: options?.encrypted ?? false,
		expiresAt: options?.expiresAt,
	};
}

function component(options: {
	id: string;
	key: string;
	value?: string | EncryptedSecret;
	type?: string;
	agentId?: UUID;
	expiresAt?: number;
	description?: string;
}): Component {
	const agentId = options.agentId ?? AGENT_ID;
	return {
		id: options.id as UUID,
		createdAt: 1,
		entityId: USER_ID,
		agentId,
		roomId: agentId,
		worldId: agentId,
		sourceEntityId: USER_ID,
		type: options.type ?? `secret:${options.key}`,
		data: {
			key: options.key,
			value: options.value ?? "stored-value",
			config: secretConfig({
				expiresAt: options.expiresAt,
				description: options.description,
			}),
			updatedAt: 1,
		},
	};
}

function rawComponent(
	id: string,
	type: string,
	data: Component["data"],
): Component {
	return {
		id: id as UUID,
		createdAt: 1,
		entityId: USER_ID,
		agentId: AGENT_ID,
		roomId: AGENT_ID,
		worldId: AGENT_ID,
		sourceEntityId: USER_ID,
		type,
		data,
	};
}

function makeHarness(initial: Component[] = []): {
	runtime: IAgentRuntime;
	all: () => Component[];
	deletedIds: UUID[];
} {
	let components = [...initial];
	const deletedIds: UUID[] = [];
	const runtime = createMockRuntime({
		agentId: AGENT_ID,
		getComponents: async (entityId) =>
			components.filter((entry) => entry.entityId === entityId),
		createComponent: async (entry) => {
			components.push(entry);
			return true;
		},
		updateComponent: async (updated) => {
			components = components.map((entry) =>
				entry.id === updated.id ? updated : entry,
			);
		},
		deleteComponent: async (componentId) => {
			deletedIds.push(componentId);
			components = components.filter((entry) => entry.id !== componentId);
		},
	});

	return { runtime, all: () => components, deletedIds };
}

function makeStorage(initial: Component[] = []): {
	storage: ComponentSecretStorage;
	all: () => Component[];
	deletedIds: UUID[];
} {
	const harness = makeHarness(initial);
	return {
		storage: new ComponentSecretStorage(harness.runtime, keyManager()),
		all: harness.all,
		deletedIds: harness.deletedIds,
	};
}

describe("ComponentSecretStorage", () => {
	it("reports its backend and initializes", async () => {
		const { storage } = makeStorage();

		expect(storage.storageType).toBe("component");
		await expect(storage.initialize()).resolves.toBeUndefined();
	});

	it("returns empty results without a user and rejects userless writes", async () => {
		const { storage } = makeStorage();
		const context: SecretContext = { level: "user", agentId: AGENT_ID };

		await expect(storage.exists("API_KEY", context)).resolves.toBe(false);
		await expect(storage.get("API_KEY", context)).resolves.toBeNull();
		await expect(storage.delete("API_KEY", context)).resolves.toBe(false);
		await expect(storage.list(context)).resolves.toEqual({});
		await expect(storage.getConfig("API_KEY", context)).resolves.toBeNull();
		await expect(storage.updateConfig("API_KEY", context, {})).resolves.toBe(
			false,
		);
		await expect(
			storage.set("API_KEY", "value", context),
		).rejects.toBeInstanceOf(StorageError);
	});

	it("denies reads, writes, deletes, and metadata access by another requester", async () => {
		const { storage } = makeStorage();
		const context: SecretContext = {
			...ownerContext(),
			requesterId: OTHER_AGENT_ID,
		};

		await expect(storage.exists("API_KEY", context)).rejects.toBeInstanceOf(
			PermissionDeniedError,
		);
		await expect(storage.get("API_KEY", context)).rejects.toBeInstanceOf(
			PermissionDeniedError,
		);
		await expect(
			storage.set("API_KEY", "value", context),
		).rejects.toBeInstanceOf(PermissionDeniedError);
		await expect(storage.delete("API_KEY", context)).rejects.toBeInstanceOf(
			PermissionDeniedError,
		);
		await expect(storage.list(context)).rejects.toBeInstanceOf(
			PermissionDeniedError,
		);
		await expect(storage.getConfig("API_KEY", context)).rejects.toBeInstanceOf(
			PermissionDeniedError,
		);
		await expect(
			storage.updateConfig("API_KEY", context, { required: true }),
		).rejects.toBeInstanceOf(PermissionDeniedError);
	});

	it("creates encrypted components with user-scoped defaults", async () => {
		const { storage, all } = makeStorage();

		await expect(
			storage.set("API_KEY", "top-secret", ownerContext()),
		).resolves.toBe(true);

		const [created] = all();
		expect(created).toMatchObject({
			entityId: USER_ID,
			agentId: AGENT_ID,
			roomId: AGENT_ID,
			worldId: AGENT_ID,
			sourceEntityId: USER_ID,
			type: "secret:API_KEY",
		});
		expect(created.data?.value).toMatchObject({
			algorithm: "aes-256-gcm",
			keyId: "default",
		});
		expect(created.data?.config).toMatchObject({
			description: "Secret: API_KEY",
			encrypted: true,
			level: "user",
			ownerId: USER_ID,
		});
		await expect(storage.get("API_KEY", ownerContext())).resolves.toBe(
			"top-secret",
		);
	});

	it("updates an existing component while retaining omitted configuration", async () => {
		const { storage, all } = makeStorage();
		const context = ownerContext();

		await storage.set("API_KEY", "first", context, {
			description: "custom description",
			encrypted: false,
		});
		const originalId = all()[0].id;
		await storage.set("API_KEY", "second", context, { required: true });

		expect(all()).toHaveLength(1);
		expect(all()[0].id).toBe(originalId);
		expect(all()[0].data).toMatchObject({
			value: "second",
			config: {
				description: "custom description",
				encrypted: false,
				required: true,
			},
		});
		await expect(storage.get("API_KEY", context)).resolves.toBe("second");
	});

	it("prefers a keyed component over an earlier legacy row", async () => {
		const legacy = component({
			id: "00000000-0000-0000-0000-000000000010",
			key: "API_KEY",
			value: "legacy",
			type: "secret",
		});
		const keyed = component({
			id: "00000000-0000-0000-0000-000000000011",
			key: "API_KEY",
			value: "keyed",
		});
		const { storage } = makeStorage([legacy, keyed]);

		await expect(storage.get("API_KEY", ownerContext())).resolves.toBe("keyed");
	});

	it("deletes an expired secret on get but only omits it from list", async () => {
		const expired = component({
			id: "00000000-0000-0000-0000-000000000020",
			key: "EXPIRED",
			expiresAt: Date.now() - 1,
		});
		const { storage, all, deletedIds } = makeStorage([expired]);

		await expect(storage.list(ownerContext())).resolves.toEqual({});
		expect(all()).toHaveLength(1);
		await expect(storage.get("EXPIRED", ownerContext())).resolves.toBeNull();
		expect(all()).toHaveLength(0);
		expect(deletedIds).toEqual([expired.id]);
	});

	it("returns null or false when a requested component is missing", async () => {
		const { storage } = makeStorage();
		const context = ownerContext();

		await expect(storage.exists("MISSING", context)).resolves.toBe(false);
		await expect(storage.get("MISSING", context)).resolves.toBeNull();
		await expect(storage.getConfig("MISSING", context)).resolves.toBeNull();
		await expect(storage.updateConfig("MISSING", context, {})).resolves.toBe(
			false,
		);
		await expect(storage.delete("MISSING", context)).resolves.toBe(false);
	});

	it("returns copied configuration and persists configuration updates", async () => {
		const stored = component({
			id: "00000000-0000-0000-0000-000000000030",
			key: "API_KEY",
			description: "original",
		});
		const { storage } = makeStorage([stored]);
		const context = ownerContext();

		const firstRead = await storage.getConfig("API_KEY", context);
		expect(firstRead).not.toBeNull();
		if (firstRead) firstRead.description = "local mutation";
		await expect(storage.getConfig("API_KEY", context)).resolves.toMatchObject({
			description: "original",
		});

		await expect(
			storage.updateConfig("API_KEY", context, {
				description: "persisted",
				required: true,
			}),
		).resolves.toBe(true);
		await expect(storage.getConfig("API_KEY", context)).resolves.toMatchObject({
			description: "persisted",
			required: true,
		});
	});

	it("filters malformed, unrelated, and foreign-agent rows from collection APIs", async () => {
		const valid = component({
			id: "00000000-0000-0000-0000-000000000040",
			key: "VALID",
		});
		const unrelated = component({
			id: "00000000-0000-0000-0000-000000000041",
			key: "UNRELATED",
			type: "profile",
		});
		const foreign = component({
			id: "00000000-0000-0000-0000-000000000042",
			key: "FOREIGN",
			agentId: OTHER_AGENT_ID,
		});
		const malformed = rawComponent(
			"00000000-0000-0000-0000-000000000043",
			"secret:MALFORMED",
			{ key: "MALFORMED", value: 42 },
		);
		const { storage, all } = makeStorage([
			valid,
			unrelated,
			foreign,
			malformed,
		]);

		await expect(storage.list(ownerContext())).resolves.toEqual({
			VALID: expect.objectContaining({ description: "fixture secret" }),
		});
		await expect(storage.listKeys(USER_ID)).resolves.toEqual(["VALID"]);
		await expect(storage.countForUser(USER_ID)).resolves.toBe(1);
		await expect(storage.deleteAllForUser(USER_ID)).resolves.toBe(1);
		expect(all().map((entry) => entry.id)).toEqual([
			unrelated.id,
			foreign.id,
			malformed.id,
		]);
	});

	it("handles empty collections in bulk operations", async () => {
		const { storage } = makeStorage();

		await expect(storage.listKeys(USER_ID)).resolves.toEqual([]);
		await expect(storage.countForUser(USER_ID)).resolves.toBe(0);
		await expect(storage.deleteAllForUser(USER_ID)).resolves.toBe(0);
	});
});
