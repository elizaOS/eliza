/**
 * Unit tests for ComponentSecretStorage: validates secret storage backed
 * by user runtime components.
 */
import { describe, expect, it } from "vitest";
import type { Component, IAgentRuntime, UUID } from "../../../types/index.ts";
import type { KeyManager } from "../crypto/encryption.ts";
import type { SecretContext } from "../types.ts";
import { ComponentSecretStorage } from "./component-store.ts";

describe("ComponentSecretStorage", () => {
	const agentId = "00000000-0000-0000-0000-000000000001" as UUID;
	const userId = "00000000-0000-0000-0000-000000000002" as UUID;
	const mockKeyManager = {} as KeyManager;

	function createStorage(components: Component[] = []) {
		const runtime = {
			agentId,
			getComponents: async (_entityId: UUID) => components,
			getComponent: async (_entityId: UUID, type: string) =>
				components.find((c) => c.type === type) ?? null,
			createComponent: async (c: Component) => {
				components.push(c);
			},
		} as unknown as IAgentRuntime;

		return {
			storage: new ComponentSecretStorage(runtime, mockKeyManager),
			runtime,
			components,
		};
	}

	const context: SecretContext = {
		source: "user",
		userId,
		requesterId: userId,
	};

	it("returns false for exists when userId is missing", async () => {
		const { storage } = createStorage();
		expect(await storage.exists("KEY", { source: "agent" })).toBe(false);
	});

	it("retrieves plain string secret from component", async () => {
		const { storage } = createStorage([
			{
				id: "comp-1" as UUID,
				agentId,
				entityId: userId,
				type: "secret:GITHUB_TOKEN",
				data: {
					key: "GITHUB_TOKEN",
					value: "ghp_12345",
					config: { required: true },
					updatedAt: Date.now(),
				},
				createdAt: Date.now(),
			},
		]);

		expect(await storage.exists("GITHUB_TOKEN", context)).toBe(true);
		const val = await storage.get("GITHUB_TOKEN", context);
		expect(val).toBe("ghp_12345");
	});
});
