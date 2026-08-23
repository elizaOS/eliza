/**
 * Deterministic unit coverage for character-settings secret persistence,
 * including authorization, legacy values, encryption, metadata, and expiry.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockRuntime } from "../../../testing/mock-runtime.ts";
import type { IAgentRuntime, UUID } from "../../../types/index.ts";
import { KeyManager } from "../crypto/encryption.ts";
import {
	PermissionDeniedError,
	type SecretConfig,
	type SecretContext,
	type StoredSecret,
} from "../types.ts";
import { CharacterSettingsStorage } from "./character-store.ts";

const AGENT_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const OWNER_ID = "00000000-0000-0000-0000-000000000002";
const STRANGER_ID = "00000000-0000-0000-0000-000000000003";

const AGENT_CONTEXT: SecretContext = {
	level: "global",
	agentId: AGENT_ID,
	requesterId: AGENT_ID,
};

function keyManager(): KeyManager {
	const manager = new KeyManager();
	manager.initializeFromPassword(AGENT_ID, "character-store-test-salt");
	return manager;
}

function makeRuntime(
	settings: IAgentRuntime["character"]["settings"] = {},
): IAgentRuntime {
	return createMockRuntime({
		agentId: AGENT_ID,
		character: {
			name: "Character Store Test",
			bio: [],
			settings,
		} as IAgentRuntime["character"],
		getSetting: ((key: string) =>
			key === "ELIZA_ADMIN_ENTITY_ID"
				? OWNER_ID
				: undefined) as IAgentRuntime["getSetting"],
	});
}

function config(overrides: Partial<SecretConfig> = {}): SecretConfig {
	return {
		type: "secret",
		required: false,
		description: "Stored secret",
		canGenerate: false,
		status: "valid",
		attempts: 0,
		plugin: "global",
		level: "global",
		encrypted: false,
		permissions: [],
		sharedWith: [],
		...overrides,
	};
}

function secrets(
	runtime: IAgentRuntime,
): Record<string, StoredSecret | string> {
	return runtime.character.settings?.secrets as Record<
		string,
		StoredSecret | string
	>;
}

afterEach(() => {
	vi.useRealTimers();
});

describe("CharacterSettingsStorage", () => {
	it("initializes missing settings once without replacing existing secrets", async () => {
		const runtime = makeRuntime(undefined);
		const storage = new CharacterSettingsStorage(runtime, keyManager());

		expect(storage.storageType).toBe("character");
		await storage.initialize();
		expect(runtime.character.settings?.secrets).toEqual({});

		secrets(runtime).LEGACY = "kept";
		await storage.initialize();
		expect(secrets(runtime).LEGACY).toBe("kept");
	});

	it("stores encrypted values for the agent and preserves config on overwrite", async () => {
		const runtime = makeRuntime();
		const storage = new CharacterSettingsStorage(runtime, keyManager());

		await expect(storage.exists("API_KEY", AGENT_CONTEXT)).resolves.toBe(false);
		await expect(
			storage.set("API_KEY", "first", AGENT_CONTEXT, {
				description: "Provider key",
				required: true,
			}),
		).resolves.toBe(true);

		const first = secrets(runtime).API_KEY as StoredSecret;
		expect(first.value).not.toBe("first");
		expect(first.value).toMatchObject({ algorithm: "aes-256-gcm" });
		await expect(storage.get("API_KEY", AGENT_CONTEXT)).resolves.toBe("first");
		await expect(storage.exists("API_KEY", AGENT_CONTEXT)).resolves.toBe(true);

		await storage.set("API_KEY", "second", AGENT_CONTEXT, { required: false });
		await expect(storage.get("API_KEY", AGENT_CONTEXT)).resolves.toBe("second");
		await expect(
			storage.getConfig("API_KEY", AGENT_CONTEXT),
		).resolves.toMatchObject({
			description: "Provider key",
			required: false,
			encrypted: true,
		});
	});

	it("stores and reads plaintext only when encryption is explicitly disabled", async () => {
		const runtime = makeRuntime();
		const storage = new CharacterSettingsStorage(runtime, keyManager());

		await storage.set("PUBLIC_VALUE", "plain", AGENT_CONTEXT, {
			encrypted: false,
		});

		expect((secrets(runtime).PUBLIC_VALUE as StoredSecret).value).toBe("plain");
		await expect(storage.get("PUBLIC_VALUE", AGENT_CONTEXT)).resolves.toBe(
			"plain",
		);
	});

	it("allows the configured owner and rejects missing or unrelated requesters", async () => {
		const storage = new CharacterSettingsStorage(makeRuntime(), keyManager());
		const ownerContext: SecretContext = {
			...AGENT_CONTEXT,
			requesterId: OWNER_ID,
		};
		const strangerContext: SecretContext = {
			...AGENT_CONTEXT,
			requesterId: STRANGER_ID,
		};
		const anonymousContext: SecretContext = {
			level: "global",
			agentId: AGENT_ID,
		};

		await expect(storage.set("OWNER_KEY", "value", ownerContext)).resolves.toBe(
			true,
		);
		await expect(storage.get("OWNER_KEY", ownerContext)).resolves.toBe("value");
		await expect(storage.list(anonymousContext)).rejects.toBeInstanceOf(
			PermissionDeniedError,
		);
		await expect(
			storage.updateConfig("OWNER_KEY", strangerContext, { required: true }),
		).rejects.toBeInstanceOf(PermissionDeniedError);
		await expect(
			storage.delete("OWNER_KEY", strangerContext),
		).rejects.toBeInstanceOf(PermissionDeniedError);
	});

	it("reads legacy strings and upgrades their config without changing the value", async () => {
		const runtime = makeRuntime({
			secrets: {
				LEGACY_KEY: "legacy-value",
				__secrets_metadata: "ignored",
			},
		});
		const storage = new CharacterSettingsStorage(runtime, keyManager());

		await expect(storage.get("LEGACY_KEY", AGENT_CONTEXT)).resolves.toBe(
			"legacy-value",
		);
		await expect(
			storage.getConfig("LEGACY_KEY", AGENT_CONTEXT),
		).resolves.toMatchObject({
			description: "Secret: LEGACY_KEY",
			level: "global",
			encrypted: true,
		});
		await expect(storage.list(AGENT_CONTEXT)).resolves.toEqual({
			LEGACY_KEY: expect.objectContaining({
				description: "Secret: LEGACY_KEY",
			}),
		});

		await expect(
			storage.updateConfig("LEGACY_KEY", AGENT_CONTEXT, {
				description: "Migrated legacy key",
			}),
		).resolves.toBe(true);
		expect(secrets(runtime).LEGACY_KEY).toMatchObject({
			value: "legacy-value",
			config: expect.objectContaining({ description: "Migrated legacy key" }),
		});
	});

	it("returns defensive config copies and merges updates into structured values", async () => {
		const runtime = makeRuntime({
			secrets: {
				CONFIGURED: {
					value: "value",
					config: config({ description: "Original", required: true }),
				},
			},
		});
		const storage = new CharacterSettingsStorage(runtime, keyManager());

		const returned = await storage.getConfig("CONFIGURED", AGENT_CONTEXT);
		expect(returned).not.toBeNull();
		if (returned) returned.description = "mutated copy";
		expect(
			(secrets(runtime).CONFIGURED as StoredSecret).config.description,
		).toBe("Original");

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
			status: "invalid",
			lastError: "rejected",
		});
	});

	it("expires values strictly before the current time and removes them on get", async () => {
		const now = new Date("2026-08-23T12:00:00.000Z");
		vi.useFakeTimers();
		vi.setSystemTime(now);
		const runtime = makeRuntime({
			secrets: {
				EXPIRED: {
					value: "expired",
					config: config({ expiresAt: now.getTime() - 1 }),
				},
				AT_BOUNDARY: {
					value: "current",
					config: config({ expiresAt: now.getTime() }),
				},
			},
		});
		const storage = new CharacterSettingsStorage(runtime, keyManager());

		await expect(storage.get("EXPIRED", AGENT_CONTEXT)).resolves.toBeNull();
		expect("EXPIRED" in secrets(runtime)).toBe(false);
		await expect(storage.get("AT_BOUNDARY", AGENT_CONTEXT)).resolves.toBe(
			"current",
		);
		await expect(storage.list(AGENT_CONTEXT)).resolves.toHaveProperty(
			"AT_BOUNDARY",
		);
	});

	it("omits expired metadata without deleting the stored entry", async () => {
		const runtime = makeRuntime({
			secrets: {
				EXPIRED: {
					value: "expired",
					config: config({ expiresAt: Date.now() - 1 }),
				},
				ACTIVE: {
					value: "active",
					config: config({ description: "Active" }),
				},
			},
		});
		const storage = new CharacterSettingsStorage(runtime, keyManager());

		await expect(storage.list(AGENT_CONTEXT)).resolves.toEqual({
			ACTIVE: expect.objectContaining({ description: "Active" }),
		});
		expect("EXPIRED" in secrets(runtime)).toBe(true);
	});

	it("returns null or false for absent and malformed stored values", async () => {
		const runtime = makeRuntime({
			secrets: {
				NULL_VALUE: null,
				MALFORMED: { value: 42, config: config() },
			},
		} as IAgentRuntime["character"]["settings"]);
		const storage = new CharacterSettingsStorage(runtime, keyManager());

		await expect(storage.get("MISSING", AGENT_CONTEXT)).resolves.toBeNull();
		await expect(storage.get("NULL_VALUE", AGENT_CONTEXT)).resolves.toBeNull();
		await expect(storage.get("MALFORMED", AGENT_CONTEXT)).resolves.toBeNull();
		await expect(
			storage.getConfig("MISSING", AGENT_CONTEXT),
		).resolves.toBeNull();
		await expect(
			storage.updateConfig("MISSING", AGENT_CONTEXT, { required: true }),
		).resolves.toBe(false);
		await expect(storage.delete("MISSING", AGENT_CONTEXT)).resolves.toBe(false);
	});

	it("deletes an existing secret and tolerates a malformed secrets container", async () => {
		const runtime = makeRuntime({ secrets: { DELETE_ME: "value" } });
		const storage = new CharacterSettingsStorage(runtime, keyManager());

		await expect(storage.delete("DELETE_ME", AGENT_CONTEXT)).resolves.toBe(
			true,
		);
		await expect(storage.exists("DELETE_ME", AGENT_CONTEXT)).resolves.toBe(
			false,
		);

		runtime.character.settings = {
			secrets: "not-an-object",
		} as IAgentRuntime["character"]["settings"];
		await expect(storage.get("ANY", AGENT_CONTEXT)).resolves.toBeNull();
		await expect(storage.list(AGENT_CONTEXT)).resolves.toEqual({});
	});
});
