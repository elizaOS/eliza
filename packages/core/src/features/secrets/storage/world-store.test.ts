/**
 * Unit tests for WorldMetadataStorage: validates secrets stored in world.metadata.secrets.
 */
import { describe, expect, it } from "vitest";
import type { IAgentRuntime, UUID, World } from "../../../types/index.ts";
import type { KeyManager } from "../crypto/encryption.ts";
import type { SecretContext } from "../types.ts";
import { WorldMetadataStorage } from "./world-store.ts";

describe("WorldMetadataStorage", () => {
	const worldId = "00000000-0000-0000-0000-000000000010" as UUID;
	const agentId = "00000000-0000-0000-0000-000000000001" as UUID;
	const mockKeyManager = {} as KeyManager;

	function createStorage(metadataSecrets: Record<string, any> = {}) {
		const mockWorld: World = {
			id: worldId,
			name: "TestWorld",
			agentId,
			metadata: {
				secrets: metadataSecrets,
			},
		} as World;

		const runtime = {
			agentId,
			getWorld: async (_id: UUID) => mockWorld,
			getRoom: async () => null,
		} as unknown as IAgentRuntime;

		return {
			storage: new WorldMetadataStorage(runtime, mockKeyManager),
			runtime,
		};
	}

	const context: SecretContext = {
		source: "agent",
		worldId,
		requesterId: agentId,
	};

	it("returns false for exists when worldId is missing", async () => {
		const { storage } = createStorage();
		expect(await storage.exists("KEY", { source: "agent" })).toBe(false);
	});

	it("retrieves plain string secret from world metadata", async () => {
		const { storage } = createStorage({
			DISCORD_BOT_TOKEN: "discord_secret_token_123",
		});

		expect(await storage.exists("DISCORD_BOT_TOKEN", context)).toBe(true);
		const val = await storage.get("DISCORD_BOT_TOKEN", context);
		expect(val).toBe("discord_secret_token_123");
	});
});
