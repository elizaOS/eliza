/**
 * Unit tests for MemorySecretStorage: validates in-memory secrets CRUD,
 * scoping by global/world/user context, and TTL expiration.
 */
import { describe, expect, it } from "vitest";
import type { SecretContext } from "../types.ts";
import { MemorySecretStorage } from "./memory-store.ts";

describe("memory-store", () => {
	const globalContext: SecretContext = { level: "global", agentId: "agent-1" };
	const userContext: SecretContext = { level: "user", userId: "user-1" };

	it("initializes with storageType 'memory'", () => {
		const storage = new MemorySecretStorage();
		expect(storage.storageType).toBe("memory");
	});

	it("performs basic CRUD operations across contexts", async () => {
		const storage = new MemorySecretStorage();
		await storage.initialize();

		// Set and get
		await storage.set("API_KEY", "secret-value-123", globalContext);
		expect(await storage.get("API_KEY", globalContext)).toBe(
			"secret-value-123",
		);
		expect(await storage.exists("API_KEY", globalContext)).toBe(true);

		// Context isolation
		expect(await storage.get("API_KEY", userContext)).toBeNull();

		// List
		const listed = await storage.list(globalContext);
		expect(listed.API_KEY).toBeDefined();

		// Delete
		const deleted = await storage.delete("API_KEY", globalContext);
		expect(deleted).toBe(true);
		expect(await storage.get("API_KEY", globalContext)).toBeNull();
	});

	it("expires secrets past their expiresAt timestamp", async () => {
		const storage = new MemorySecretStorage();
		await storage.set("TEMP_KEY", "temp-val", globalContext, {
			expiresAt: Date.now() - 1000, // already expired
		});

		expect(await storage.get("TEMP_KEY", globalContext)).toBeNull();
	});

	it("manages secret configs and testing utility methods", async () => {
		const storage = new MemorySecretStorage();
		await storage.set("CONFIG_KEY", "val", userContext, {
			encrypted: false,
		});

		const cfg = await storage.getConfig("CONFIG_KEY", userContext);
		expect(cfg?.encrypted).toBe(false);

		await storage.updateConfig("CONFIG_KEY", userContext, { encrypted: true });
		const updated = await storage.getConfig("CONFIG_KEY", userContext);
		expect(updated?.encrypted).toBe(true);

		expect(storage.size()).toBe(1);
		storage.clear();
		expect(storage.size()).toBe(0);
	});
});
