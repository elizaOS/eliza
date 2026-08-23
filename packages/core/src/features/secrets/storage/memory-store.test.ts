/**
 * Exercises MemorySecretStorage directly across scoped key isolation, default
 * and updated metadata, expiration cleanup, deletion, and reset behavior.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SecretContext } from "../types.ts";
import { MemorySecretStorage } from "./memory-store.ts";

const GLOBAL_CONTEXT: SecretContext = {
	level: "global",
	agentId: "agent-a",
};
const WORLD_CONTEXT: SecretContext = {
	level: "world",
	agentId: "agent-a",
	worldId: "world-a",
};
const USER_CONTEXT: SecretContext = {
	level: "user",
	agentId: "agent-a",
	userId: "user-a",
};

afterEach(() => {
	vi.useRealTimers();
});

describe("MemorySecretStorage", () => {
	it("reports its backend, initializes, and handles an empty store", async () => {
		const storage = new MemorySecretStorage();

		expect(storage.storageType).toBe("memory");
		await expect(storage.initialize()).resolves.toBeUndefined();
		await expect(storage.exists("API_KEY", GLOBAL_CONTEXT)).resolves.toBe(
			false,
		);
		await expect(storage.get("API_KEY", GLOBAL_CONTEXT)).resolves.toBeNull();
		await expect(storage.list(GLOBAL_CONTEXT)).resolves.toEqual({});
		await expect(
			storage.getConfig("API_KEY", GLOBAL_CONTEXT),
		).resolves.toBeNull();
		await expect(
			storage.updateConfig("API_KEY", GLOBAL_CONTEXT, { required: true }),
		).resolves.toBe(false);
		await expect(storage.delete("API_KEY", GLOBAL_CONTEXT)).resolves.toBe(
			false,
		);
		expect(storage.size()).toBe(0);
	});

	it("stores values with defaults and returns defensive config objects", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000);
		const storage = new MemorySecretStorage();

		await expect(
			storage.set("API_KEY", "secret-value", USER_CONTEXT),
		).resolves.toBe(true);

		await expect(storage.exists("API_KEY", USER_CONTEXT)).resolves.toBe(true);
		await expect(storage.get("API_KEY", USER_CONTEXT)).resolves.toBe(
			"secret-value",
		);
		const config = await storage.getConfig("API_KEY", USER_CONTEXT);
		expect(config).toEqual({
			type: "secret",
			required: false,
			description: "Secret: API_KEY",
			canGenerate: false,
			validationMethod: undefined,
			status: "valid",
			lastError: undefined,
			attempts: 0,
			createdAt: 1_000,
			validatedAt: 1_000,
			plugin: "user",
			level: "user",
			ownerId: "user-a",
			worldId: undefined,
			encrypted: true,
			permissions: [],
			sharedWith: [],
			expiresAt: undefined,
		});

		if (config) config.description = "mutated copy";
		await expect(
			storage.getConfig("API_KEY", USER_CONTEXT),
		).resolves.toMatchObject({ description: "Secret: API_KEY" });
	});

	it("isolates equal keys by level and by each level's owner identifier", async () => {
		const storage = new MemorySecretStorage();
		const otherGlobal = { ...GLOBAL_CONTEXT, agentId: "agent-b" };
		const otherWorld = { ...WORLD_CONTEXT, worldId: "world-b" };
		const otherUser = { ...USER_CONTEXT, userId: "user-b" };

		await storage.set("TOKEN", "global-a", GLOBAL_CONTEXT);
		await storage.set("TOKEN", "global-b", otherGlobal);
		await storage.set("TOKEN", "world-a", WORLD_CONTEXT);
		await storage.set("TOKEN", "world-b", otherWorld);
		await storage.set("TOKEN", "user-a", USER_CONTEXT);
		await storage.set("TOKEN", "user-b", otherUser);

		await expect(storage.get("TOKEN", GLOBAL_CONTEXT)).resolves.toBe(
			"global-a",
		);
		await expect(storage.get("TOKEN", otherGlobal)).resolves.toBe("global-b");
		await expect(storage.get("TOKEN", WORLD_CONTEXT)).resolves.toBe("world-a");
		await expect(storage.get("TOKEN", otherWorld)).resolves.toBe("world-b");
		await expect(storage.get("TOKEN", USER_CONTEXT)).resolves.toBe("user-a");
		await expect(storage.get("TOKEN", otherUser)).resolves.toBe("user-b");
		expect(storage.size()).toBe(6);
	});

	it("overwrites a value while retaining omitted configuration", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(2_000);
		const storage = new MemorySecretStorage();

		await storage.set("TOKEN", "first", WORLD_CONTEXT, {
			type: "token",
			description: "custom",
			required: true,
		});
		vi.setSystemTime(3_000);
		await storage.set("TOKEN", "second", WORLD_CONTEXT, { attempts: 2 });

		await expect(storage.get("TOKEN", WORLD_CONTEXT)).resolves.toBe("second");
		await expect(
			storage.getConfig("TOKEN", WORLD_CONTEXT),
		).resolves.toMatchObject({
			type: "token",
			description: "custom",
			required: true,
			attempts: 2,
			createdAt: 2_000,
			worldId: "world-a",
		});
		expect(storage.size()).toBe(1);
	});

	it("merges configuration updates without changing the stored value", async () => {
		const storage = new MemorySecretStorage();
		await storage.set("TOKEN", "value", GLOBAL_CONTEXT, {
			description: "before",
		});

		await expect(
			storage.updateConfig("TOKEN", GLOBAL_CONTEXT, {
				description: "after",
				status: "invalid",
				lastError: "rejected",
			}),
		).resolves.toBe(true);

		await expect(storage.get("TOKEN", GLOBAL_CONTEXT)).resolves.toBe("value");
		await expect(
			storage.getConfig("TOKEN", GLOBAL_CONTEXT),
		).resolves.toMatchObject({
			description: "after",
			status: "invalid",
			lastError: "rejected",
		});
	});

	it("expires only after the configured timestamp and removes the entry", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(5_000);
		const storage = new MemorySecretStorage();
		await storage.set("TOKEN", "value", GLOBAL_CONTEXT, { expiresAt: 5_000 });

		await expect(storage.get("TOKEN", GLOBAL_CONTEXT)).resolves.toBe("value");
		vi.setSystemTime(5_001);
		await expect(storage.get("TOKEN", GLOBAL_CONTEXT)).resolves.toBeNull();
		await expect(storage.exists("TOKEN", GLOBAL_CONTEXT)).resolves.toBe(false);
		expect(storage.size()).toBe(0);
	});

	it("lists only the requested scope and purges expired entries", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(10_000);
		const storage = new MemorySecretStorage();
		await storage.set("ACTIVE", "active", WORLD_CONTEXT, {
			description: "active secret",
		});
		await storage.set("EXPIRED", "expired", WORLD_CONTEXT, {
			expiresAt: 9_999,
		});
		await storage.set("OTHER", "other", GLOBAL_CONTEXT);

		await expect(storage.list(WORLD_CONTEXT)).resolves.toEqual({
			ACTIVE: expect.objectContaining({ description: "active secret" }),
		});
		await expect(storage.exists("EXPIRED", WORLD_CONTEXT)).resolves.toBe(false);
		await expect(storage.exists("OTHER", GLOBAL_CONTEXT)).resolves.toBe(true);
		expect(storage.size()).toBe(2);
	});

	it("deletes present keys, reports repeated deletion, and clears all scopes", async () => {
		const storage = new MemorySecretStorage();
		await storage.set("GLOBAL", "one", GLOBAL_CONTEXT);
		await storage.set("WORLD", "two", WORLD_CONTEXT);

		await expect(storage.delete("GLOBAL", GLOBAL_CONTEXT)).resolves.toBe(true);
		await expect(storage.delete("GLOBAL", GLOBAL_CONTEXT)).resolves.toBe(false);
		expect(storage.size()).toBe(1);

		storage.clear();
		expect(storage.size()).toBe(0);
		await expect(storage.list(WORLD_CONTEXT)).resolves.toEqual({});
	});
});
