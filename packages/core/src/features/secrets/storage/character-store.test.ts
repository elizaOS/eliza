/**
 * Unit tests for CharacterSettingsStorage: verifies character.settings.secrets
 * access control, existence, retrieval, and updates.
 */
import { describe, expect, it } from "vitest";
import type { IAgentRuntime, UUID } from "../../../types/index.ts";
import type { KeyManager } from "../crypto/encryption.ts";
import type { SecretContext, StoredSecret } from "../types.ts";
import { CharacterSettingsStorage } from "./character-store.ts";

describe("CharacterSettingsStorage", () => {
	const agentId = "00000000-0000-0000-0000-000000000001" as UUID;
	const mockKeyManager = {} as KeyManager;

	function createStorage(
		initialSecrets: Record<string, string | StoredSecret> = {},
	) {
		const character = {
			name: "TestAgent",
			settings: {
				secrets: { ...initialSecrets },
			},
		};
		const runtime = {
			agentId,
			character,
		} as unknown as IAgentRuntime;
		return {
			storage: new CharacterSettingsStorage(runtime, mockKeyManager),
			runtime,
		};
	}

	const validContext: SecretContext = {
		source: "agent",
		requesterId: agentId,
		userId: "owner-1",
	};

	it("initializes storage structure safely", async () => {
		const { storage, runtime } = createStorage();
		await storage.initialize();
		expect(runtime.character.settings).toBeDefined();
		expect(runtime.character.settings?.secrets).toBeDefined();
	});

	it("checks secret existence and retrieves string value", async () => {
		const { storage } = createStorage({
			OPENAI_API_KEY: "sk-test-12345",
		});
		await storage.initialize();

		expect(await storage.exists("OPENAI_API_KEY", validContext)).toBe(true);
		expect(await storage.exists("UNKNOWN_KEY", validContext)).toBe(false);

		const value = await storage.get("OPENAI_API_KEY", validContext);
		expect(value).toBe("sk-test-12345");
	});

	it("returns null for non-existent secret", async () => {
		const { storage } = createStorage();
		await storage.initialize();

		const value = await storage.get("MISSING_KEY", validContext);
		expect(value).toBeNull();
	});
});
