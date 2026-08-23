/**
 * Deterministic unit coverage for the shared secret-storage base and composite
 * implementations. The suite exercises default configuration construction and
 * every composite operation against real in-memory backends, including the
 * defensive fallback for an unrecognized runtime context level.
 */
import { describe, expect, it } from "vitest";
import type { SecretConfig, SecretContext } from "../types.ts";
import { CompositeSecretStorage } from "./interface.ts";
import { MemorySecretStorage } from "./memory-store.ts";

const GLOBAL_CONTEXT: SecretContext = {
	level: "global",
	agentId: "agent-1",
};
const WORLD_CONTEXT: SecretContext = {
	level: "world",
	agentId: "agent-1",
	worldId: "world-1",
};
const USER_CONTEXT: SecretContext = {
	level: "user",
	agentId: "agent-1",
	userId: "user-1",
};

class ExposedMemoryStorage extends MemorySecretStorage {
	initialized = false;

	override async initialize(): Promise<void> {
		this.initialized = true;
	}

	createConfig(
		key: string,
		context: SecretContext,
		partial?: Partial<SecretConfig>,
	): SecretConfig {
		return this.createDefaultConfig(key, context, partial);
	}
}

function makeComposite() {
	const globalStorage = new ExposedMemoryStorage();
	const worldStorage = new ExposedMemoryStorage();
	const userStorage = new ExposedMemoryStorage();
	const composite = new CompositeSecretStorage({
		globalStorage,
		worldStorage,
		userStorage,
	});

	return { composite, globalStorage, worldStorage, userStorage };
}

describe("BaseSecretStorage", () => {
	it("creates complete defaults from the key and context", () => {
		const storage = new ExposedMemoryStorage();
		const before = Date.now();
		const config = storage.createConfig("API_KEY", USER_CONTEXT);
		const after = Date.now();

		expect(config).toEqual({
			type: "secret",
			required: false,
			description: "Secret: API_KEY",
			canGenerate: false,
			validationMethod: undefined,
			status: "valid",
			lastError: undefined,
			attempts: 0,
			createdAt: expect.any(Number),
			validatedAt: expect.any(Number),
			plugin: "user",
			level: "user",
			ownerId: "user-1",
			worldId: undefined,
			encrypted: true,
			permissions: [],
			sharedWith: [],
			expiresAt: undefined,
		});
		expect(config.createdAt).toBeGreaterThanOrEqual(before);
		expect(config.createdAt).toBeLessThanOrEqual(after);
		expect(config.validatedAt).toBeGreaterThanOrEqual(before);
		expect(config.validatedAt).toBeLessThanOrEqual(after);
	});

	it("preserves supplied values while context owns scope fields", () => {
		const storage = new ExposedMemoryStorage();
		const permissions = [
			{
				entityId: "reader-1",
				permissions: ["read" as const],
				grantedBy: "owner-1",
				grantedAt: 10,
			},
		];
		const config = storage.createConfig("TOKEN", WORLD_CONTEXT, {
			type: "token",
			required: true,
			description: "World token",
			canGenerate: true,
			validationMethod: "none",
			status: "invalid",
			lastError: "rejected",
			attempts: 0,
			createdAt: 0,
			validatedAt: 0,
			plugin: "plugin-example",
			level: "user",
			ownerId: "ignored-owner",
			worldId: "ignored-world",
			encrypted: false,
			permissions,
			sharedWith: [],
			expiresAt: 20,
		});

		expect(config).toEqual({
			type: "token",
			required: true,
			description: "World token",
			canGenerate: true,
			validationMethod: "none",
			status: "invalid",
			lastError: "rejected",
			attempts: 0,
			createdAt: 0,
			validatedAt: 0,
			plugin: "plugin-example",
			level: "world",
			ownerId: undefined,
			worldId: "world-1",
			encrypted: false,
			permissions,
			sharedWith: [],
			expiresAt: 20,
		});
	});
});

describe("CompositeSecretStorage", () => {
	it("reports its composite backend type and initializes every backend", async () => {
		const { composite, globalStorage, worldStorage, userStorage } =
			makeComposite();

		expect(composite.storageType).toBe("memory");
		await composite.initialize();

		expect(globalStorage.initialized).toBe(true);
		expect(worldStorage.initialized).toBe(true);
		expect(userStorage.initialized).toBe(true);
	});

	it("routes reads and existence checks by context level", async () => {
		const { composite, globalStorage, worldStorage, userStorage } =
			makeComposite();
		await globalStorage.set("SHARED", "global-value", GLOBAL_CONTEXT);
		await worldStorage.set("SHARED", "world-value", WORLD_CONTEXT);
		await userStorage.set("SHARED", "user-value", USER_CONTEXT);

		await expect(composite.get("SHARED", GLOBAL_CONTEXT)).resolves.toBe(
			"global-value",
		);
		await expect(composite.get("SHARED", WORLD_CONTEXT)).resolves.toBe(
			"world-value",
		);
		await expect(composite.get("SHARED", USER_CONTEXT)).resolves.toBe(
			"user-value",
		);
		await expect(composite.exists("SHARED", GLOBAL_CONTEXT)).resolves.toBe(
			true,
		);
		await expect(composite.exists("MISSING", USER_CONTEXT)).resolves.toBe(
			false,
		);
	});

	it("falls back to global storage for an unrecognized runtime level", async () => {
		const { composite, globalStorage } = makeComposite();
		const invalidContext = {
			...GLOBAL_CONTEXT,
			level: "unsupported",
		} as unknown as SecretContext;
		await globalStorage.set("FALLBACK", "global-value", invalidContext);

		await expect(composite.get("FALLBACK", invalidContext)).resolves.toBe(
			"global-value",
		);
	});

	it("routes writes only to the selected backend", async () => {
		const { composite, globalStorage, worldStorage, userStorage } =
			makeComposite();

		await expect(
			composite.set("TOKEN", "world-value", WORLD_CONTEXT, {
				description: "World token",
			}),
		).resolves.toBe(true);
		await expect(worldStorage.get("TOKEN", WORLD_CONTEXT)).resolves.toBe(
			"world-value",
		);
		await expect(globalStorage.get("TOKEN", WORLD_CONTEXT)).resolves.toBeNull();
		await expect(userStorage.get("TOKEN", WORLD_CONTEXT)).resolves.toBeNull();
	});

	it("routes deletion and preserves the backend result for a missing key", async () => {
		const { composite, userStorage } = makeComposite();
		await userStorage.set("TOKEN", "user-value", USER_CONTEXT);

		await expect(composite.delete("TOKEN", USER_CONTEXT)).resolves.toBe(true);
		await expect(composite.delete("TOKEN", USER_CONTEXT)).resolves.toBe(false);
	});

	it("routes metadata listing to the selected backend", async () => {
		const { composite, globalStorage, worldStorage } = makeComposite();
		await globalStorage.set("GLOBAL_KEY", "global-value", GLOBAL_CONTEXT);
		await worldStorage.set("WORLD_KEY", "world-value", WORLD_CONTEXT);

		await expect(composite.list(WORLD_CONTEXT)).resolves.toEqual({
			WORLD_KEY: expect.objectContaining({
				description: "Secret: WORLD_KEY",
				level: "world",
			}),
		});
	});

	it("routes configuration reads and updates", async () => {
		const { composite, userStorage } = makeComposite();
		await userStorage.set("TOKEN", "user-value", USER_CONTEXT);

		await expect(
			composite.getConfig("MISSING", USER_CONTEXT),
		).resolves.toBeNull();
		await expect(
			composite.updateConfig("MISSING", USER_CONTEXT, { required: true }),
		).resolves.toBe(false);
		await expect(
			composite.updateConfig("TOKEN", USER_CONTEXT, {
				required: true,
				status: "expired",
			}),
		).resolves.toBe(true);
		await expect(composite.getConfig("TOKEN", USER_CONTEXT)).resolves.toEqual(
			expect.objectContaining({ required: true, status: "expired" }),
		);
	});
});
