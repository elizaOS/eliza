/**
 * Exercises world-metadata secret storage through an in-memory runtime,
 * covering authorization, encryption, legacy values, expiry, metadata, and
 * cache invalidation against the real storage implementation.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockRuntime } from "../../../testing/mock-runtime.ts";
import {
	type IAgentRuntime,
	Role,
	type UUID,
	type World,
} from "../../../types/index.ts";
import { KeyManager } from "../crypto/encryption.ts";
import {
	PermissionDeniedError,
	type SecretConfig,
	type SecretContext,
	StorageError,
	type StoredSecret,
} from "../types.ts";
import { WorldMetadataStorage } from "./world-store.ts";

const AGENT_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const OWNER_ID = "00000000-0000-0000-0000-000000000002";
const ADMIN_ID = "00000000-0000-0000-0000-000000000003";
const MEMBER_ID = "00000000-0000-0000-0000-000000000004";
const STRANGER_ID = "00000000-0000-0000-0000-000000000005";
const WORLD_ID = "00000000-0000-0000-0000-000000000006" as UUID;

const AGENT_CONTEXT: SecretContext = {
	level: "world",
	agentId: AGENT_ID,
	worldId: WORLD_ID,
	requesterId: AGENT_ID,
};

type WorldSecretValue =
	| StoredSecret
	| string
	| null
	| { value: number; config: SecretConfig };

function keyManager(): KeyManager {
	const manager = new KeyManager();
	manager.initializeFromPassword(AGENT_ID, "world-store-test-salt");
	return manager;
}

function config(overrides: Partial<SecretConfig> = {}): SecretConfig {
	return {
		type: "secret",
		required: false,
		description: "Stored world secret",
		canGenerate: false,
		status: "valid",
		attempts: 0,
		plugin: "world",
		level: "world",
		worldId: WORLD_ID,
		encrypted: false,
		permissions: [],
		sharedWith: [],
		...overrides,
	};
}

function makeWorld(
	secrets: Record<string, WorldSecretValue> = {},
	roles: Record<string, Role> | undefined = {
		[OWNER_ID]: Role.OWNER,
		[ADMIN_ID]: Role.ADMIN,
		[MEMBER_ID]: Role.MEMBER,
		[STRANGER_ID]: Role.NONE,
	},
): World {
	return {
		id: WORLD_ID,
		agentId: AGENT_ID,
		metadata: {
			ownership: { ownerId: OWNER_ID },
			roles,
			secrets,
		},
	};
}

function secretMap(world: World): Record<string, WorldSecretValue> {
	return world.metadata?.secrets as Record<string, WorldSecretValue>;
}

function makeHarness(initialWorld: World | null = makeWorld()): {
	runtime: IAgentRuntime;
	currentWorld: () => World | null;
	replaceWorld: (world: World | null) => void;
	getWorldCalls: () => number;
	updatedWorlds: World[];
} {
	let world = initialWorld;
	let reads = 0;
	const updatedWorlds: World[] = [];
	const runtime = createMockRuntime({
		agentId: AGENT_ID,
		getWorld: async (id) => {
			reads += 1;
			return world?.id === id ? world : null;
		},
		updateWorld: async (updated) => {
			world = updated;
			updatedWorlds.push(updated);
		},
	});

	return {
		runtime,
		currentWorld: () => world,
		replaceWorld: (replacement) => {
			world = replacement;
		},
		getWorldCalls: () => reads,
		updatedWorlds,
	};
}

function storageFor(
	harness: ReturnType<typeof makeHarness>,
): WorldMetadataStorage {
	return new WorldMetadataStorage(harness.runtime, keyManager());
}

afterEach(() => {
	vi.useRealTimers();
});

describe("WorldMetadataStorage", () => {
	it("reports its backend and handles operations without a world scope", async () => {
		const storage = storageFor(makeHarness());
		const context: SecretContext = { level: "world", agentId: AGENT_ID };

		expect(storage.storageType).toBe("world");
		await expect(storage.initialize()).resolves.toBeUndefined();
		await expect(storage.exists("API_KEY", context)).resolves.toBe(false);
		await expect(storage.get("API_KEY", context)).resolves.toBeNull();
		await expect(storage.delete("API_KEY", context)).resolves.toBe(false);
		await expect(storage.list(context)).resolves.toEqual({});
		await expect(storage.getConfig("API_KEY", context)).resolves.toBeNull();
		await expect(storage.updateConfig("API_KEY", context, {})).resolves.toBe(
			false,
		);
		await expect(storage.set("API_KEY", "value", context)).rejects.toEqual(
			expect.objectContaining({
				name: StorageError.name,
				message: "Cannot set world secret without worldId",
			}),
		);
	});

	it("allows members to read while restricting writes to agents, owners, and admins", async () => {
		const storage = storageFor(
			makeHarness(makeWorld({ API_KEY: { value: "value", config: config() } })),
		);
		const memberContext = { ...AGENT_CONTEXT, requesterId: MEMBER_ID };
		const ownerContext = { ...AGENT_CONTEXT, requesterId: OWNER_ID };
		const adminContext = { ...AGENT_CONTEXT, requesterId: ADMIN_ID };
		const strangerContext = { ...AGENT_CONTEXT, requesterId: STRANGER_ID };
		const anonymousContext: SecretContext = {
			level: "world",
			agentId: AGENT_ID,
			worldId: WORLD_ID,
		};

		await expect(storage.get("API_KEY", memberContext)).resolves.toBe("value");
		await expect(storage.set("OWNER_KEY", "owner", ownerContext)).resolves.toBe(
			true,
		);
		await expect(storage.set("ADMIN_KEY", "admin", adminContext)).resolves.toBe(
			true,
		);
		await expect(
			storage.set("AGENT_KEY", "agent", AGENT_CONTEXT),
		).resolves.toBe(true);
		await expect(
			storage.set("MEMBER_KEY", "member", memberContext),
		).rejects.toBeInstanceOf(PermissionDeniedError);
		await expect(
			storage.get("API_KEY", strangerContext),
		).rejects.toBeInstanceOf(PermissionDeniedError);
		await expect(storage.list(anonymousContext)).rejects.toBeInstanceOf(
			PermissionDeniedError,
		);
	});

	it("recognizes ownership for reads but requires an explicit write role", async () => {
		const world = makeWorld({
			API_KEY: { value: "value", config: config() },
		});
		delete world.metadata?.roles;
		const storage = storageFor(makeHarness(world));
		const ownerContext = { ...AGENT_CONTEXT, requesterId: OWNER_ID };

		await expect(storage.get("API_KEY", ownerContext)).resolves.toBe("value");
		await expect(
			storage.set("OWNER_KEY", "owner", ownerContext),
		).rejects.toBeInstanceOf(PermissionDeniedError);
	});

	it("creates encrypted storage metadata and preserves omitted config on overwrite", async () => {
		const world: World = { id: WORLD_ID, agentId: AGENT_ID };
		const harness = makeHarness(world);
		const storage = storageFor(harness);

		await expect(
			storage.set("API_KEY", "first", AGENT_CONTEXT, {
				description: "Provider key",
				required: true,
			}),
		).resolves.toBe(true);

		const first = secretMap(world).API_KEY as StoredSecret;
		expect(first.value).toMatchObject({
			algorithm: "aes-256-gcm",
			keyId: "default",
		});
		expect(first.config).toMatchObject({
			description: "Provider key",
			required: true,
			level: "world",
			worldId: WORLD_ID,
			encrypted: true,
		});
		await expect(storage.get("API_KEY", AGENT_CONTEXT)).resolves.toBe("first");

		await storage.set("API_KEY", "second", AGENT_CONTEXT, { required: false });
		await expect(storage.get("API_KEY", AGENT_CONTEXT)).resolves.toBe("second");
		await expect(
			storage.getConfig("API_KEY", AGENT_CONTEXT),
		).resolves.toMatchObject({
			description: "Provider key",
			required: false,
			encrypted: true,
		});
		expect(harness.updatedWorlds).toHaveLength(2);
	});

	it("stores plaintext only when encryption is explicitly disabled", async () => {
		const world = makeWorld();
		const storage = storageFor(makeHarness(world));

		await storage.set("PUBLIC_VALUE", "plain", AGENT_CONTEXT, {
			encrypted: false,
		});

		expect((secretMap(world).PUBLIC_VALUE as StoredSecret).value).toBe("plain");
		await expect(storage.get("PUBLIC_VALUE", AGENT_CONTEXT)).resolves.toBe(
			"plain",
		);
	});

	it("reads legacy strings and returns null for absent or malformed values", async () => {
		const world = makeWorld({
			LEGACY: "legacy-value",
			NULL_VALUE: null,
			MALFORMED: { value: 42, config: config() },
		});
		const storage = storageFor(makeHarness(world));

		await expect(storage.exists("LEGACY", AGENT_CONTEXT)).resolves.toBe(true);
		await expect(storage.get("LEGACY", AGENT_CONTEXT)).resolves.toBe(
			"legacy-value",
		);
		await expect(storage.exists("MISSING", AGENT_CONTEXT)).resolves.toBe(false);
		await expect(storage.get("MISSING", AGENT_CONTEXT)).resolves.toBeNull();
		await expect(storage.get("NULL_VALUE", AGENT_CONTEXT)).resolves.toBeNull();
		await expect(storage.get("MALFORMED", AGENT_CONTEXT)).resolves.toBeNull();
	});

	it("expires values strictly before now and deletes only with write permission", async () => {
		const now = new Date("2026-08-23T12:00:00.000Z");
		vi.useFakeTimers();
		vi.setSystemTime(now);
		const world = makeWorld({
			EXPIRED_OWNER: {
				value: "expired",
				config: config({ expiresAt: now.getTime() - 1 }),
			},
			EXPIRED_MEMBER: {
				value: "expired",
				config: config({ expiresAt: now.getTime() - 1 }),
			},
			AT_BOUNDARY: {
				value: "current",
				config: config({ expiresAt: now.getTime() }),
			},
		});
		const storage = storageFor(makeHarness(world));

		await expect(
			storage.get("EXPIRED_OWNER", AGENT_CONTEXT),
		).resolves.toBeNull();
		expect("EXPIRED_OWNER" in secretMap(world)).toBe(false);
		await expect(
			storage.get("EXPIRED_MEMBER", {
				...AGENT_CONTEXT,
				requesterId: MEMBER_ID,
			}),
		).resolves.toBeNull();
		expect("EXPIRED_MEMBER" in secretMap(world)).toBe(true);
		await expect(storage.get("AT_BOUNDARY", AGENT_CONTEXT)).resolves.toBe(
			"current",
		);
	});

	it("lists active structured and legacy metadata without expired entries", async () => {
		const world = makeWorld({
			ACTIVE: {
				value: "active",
				config: config({ description: "Active secret" }),
			},
			LEGACY: "legacy",
			EXPIRED: {
				value: "expired",
				config: config({ expiresAt: Date.now() - 1 }),
			},
		});
		const storage = storageFor(makeHarness(world));

		await expect(storage.list(AGENT_CONTEXT)).resolves.toEqual({
			ACTIVE: expect.objectContaining({ description: "Active secret" }),
			LEGACY: expect.objectContaining({
				description: "Secret: LEGACY",
				level: "world",
				worldId: WORLD_ID,
			}),
		});
		expect("EXPIRED" in secretMap(world)).toBe(true);
	});

	it("returns defensive config copies and defaults for legacy values", async () => {
		const world = makeWorld({
			CONFIGURED: {
				value: "value",
				config: config({ description: "Original" }),
			},
			LEGACY: "legacy",
		});
		const storage = storageFor(makeHarness(world));

		const returned = await storage.getConfig("CONFIGURED", AGENT_CONTEXT);
		expect(returned).not.toBeNull();
		if (returned) returned.description = "mutated copy";
		expect(
			(secretMap(world).CONFIGURED as StoredSecret).config.description,
		).toBe("Original");
		await expect(
			storage.getConfig("LEGACY", AGENT_CONTEXT),
		).resolves.toMatchObject({
			description: "Secret: LEGACY",
			worldId: WORLD_ID,
		});
		await expect(
			storage.getConfig("MISSING", AGENT_CONTEXT),
		).resolves.toBeNull();
	});

	it("updates structured config while rejecting missing and legacy values", async () => {
		const world = makeWorld({
			CONFIGURED: {
				value: "value",
				config: config({ description: "Original", required: true }),
			},
			LEGACY: "legacy",
		});
		const harness = makeHarness(world);
		const storage = storageFor(harness);

		await expect(
			storage.updateConfig("CONFIGURED", AGENT_CONTEXT, {
				status: "invalid",
				lastError: "rejected",
			}),
		).resolves.toBe(true);
		await expect(
			storage.getConfig("CONFIGURED", AGENT_CONTEXT),
		).resolves.toMatchObject({
			description: "Original",
			required: true,
			status: "invalid",
			lastError: "rejected",
		});
		await expect(
			storage.updateConfig("LEGACY", AGENT_CONTEXT, {}),
		).resolves.toBe(false);
		await expect(
			storage.updateConfig("MISSING", AGENT_CONTEXT, {}),
		).resolves.toBe(false);
		expect(harness.updatedWorlds).toHaveLength(1);
	});

	it("returns false for missing deletes and persists existing deletion", async () => {
		const emptyWorld: World = { id: WORLD_ID, agentId: AGENT_ID };
		const emptyStorage = storageFor(makeHarness(emptyWorld));
		await expect(emptyStorage.delete("MISSING", AGENT_CONTEXT)).resolves.toBe(
			false,
		);
		await expect(
			emptyStorage.updateConfig("MISSING", AGENT_CONTEXT, {}),
		).resolves.toBe(false);

		const world = makeWorld({ API_KEY: { value: "value", config: config() } });
		const harness = makeHarness(world);
		const storage = storageFor(harness);
		await expect(storage.delete("MISSING", AGENT_CONTEXT)).resolves.toBe(false);
		await expect(storage.delete("API_KEY", AGENT_CONTEXT)).resolves.toBe(true);
		expect(secretMap(world)).toEqual({});
		expect(harness.updatedWorlds).toEqual([world]);
	});

	it("uses cached worlds until a targeted or full invalidation", async () => {
		const first = makeWorld({ FIRST: "one" });
		const harness = makeHarness(first);
		const storage = storageFor(harness);

		await expect(storage.get("FIRST", AGENT_CONTEXT)).resolves.toBe("one");
		expect(harness.getWorldCalls()).toBe(1);

		const second = makeWorld({ SECOND: "two" });
		harness.replaceWorld(second);
		await expect(storage.get("SECOND", AGENT_CONTEXT)).resolves.toBeNull();
		expect(harness.getWorldCalls()).toBe(1);

		storage.invalidateWorld(WORLD_ID);
		await expect(storage.get("SECOND", AGENT_CONTEXT)).resolves.toBe("two");
		expect(harness.getWorldCalls()).toBe(2);

		const third = makeWorld({ THIRD: "three" });
		harness.replaceWorld(third);
		storage.clearCache();
		await expect(storage.get("THIRD", AGENT_CONTEXT)).resolves.toBe("three");
		expect(harness.getWorldCalls()).toBe(3);
	});
});
