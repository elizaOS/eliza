/**
 * Character validation must keep `settings.secrets` where `CharacterSettings`
 * declares it and where the runtime reads it. Undeclared settings keys still
 * move into `settings.extra`. Drives a real AgentRuntime over the in-memory
 * SQLite adapter, no model calls.
 */

import { SQLiteDatabaseAdapter } from "@elizaos/testing/runtime";
import { describe, expect, it } from "vitest";
import { parseCharacter } from "../src/character";
import { parseAndValidateCharacter } from "../src/character-schema";
import { getCharacterSecret } from "../src/character-utils";
import { AgentRuntime } from "../src/runtime";
import { flattenRuntimeSettings } from "../src/runtime-settings";
import { stringToUuid } from "../src/utils/string-to-uuid.js";

describe("character settings.secrets validation", () => {
	it("keeps settings.secrets in place and still moves undeclared keys to extra", () => {
		const character = parseCharacter({
			name: "settings-secrets-parse",
			settings: {
				shouldRespondModel: "small",
				secrets: { OPENAI_API_KEY: "sk-settings-secret", RETRIES: 3 },
				avatarUrl: "https://example.com/avatar.png",
			},
		});

		expect(character.settings?.secrets).toEqual({
			OPENAI_API_KEY: "sk-settings-secret",
			RETRIES: 3,
		});
		expect(character.settings?.extra).toEqual({
			avatarUrl: "https://example.com/avatar.png",
		});
		expect(getCharacterSecret(character, "OPENAI_API_KEY")).toBe(
			"sk-settings-secret",
		);
		expect(flattenRuntimeSettings(character, {})).toMatchObject({
			OPENAI_API_KEY: "sk-settings-secret",
			shouldRespondModel: "small",
		});
	});

	it("keeps the object entries that plugin secret stores write", () => {
		// Shape of a plugin-assistant CharacterSettingsStorage entry.
		const stored = {
			value: "stored-plain-value",
			config: { level: "global", encrypted: false },
		};
		const result = parseAndValidateCharacter(
			JSON.stringify({
				name: "settings-secrets-stored-entry",
				settings: { secrets: { STORED_TOKEN: stored } },
			}),
		);

		expect(result.success).toBe(true);
		expect(result.data?.settings?.secrets).toEqual({ STORED_TOKEN: stored });
		expect(result.data?.settings?.extra).toBeUndefined();
	});

	it("serves a parsed settings.secrets value through getSetting after initialize", async () => {
		const name = "settings-secrets-runtime";
		const runtime = new AgentRuntime({
			character: parseCharacter({
				name,
				bio: ["test"],
				settings: { secrets: { SETTINGS_ONLY_TOKEN: "settings-only-value" } },
			}),
			adapter: SQLiteDatabaseAdapter.create(":memory:", stringToUuid(name)),
			logLevel: "fatal",
		});

		try {
			expect(runtime.getSetting("SETTINGS_ONLY_TOKEN")).toBe(
				"settings-only-value",
			);
			await runtime.initialize({ skipMigrations: true });
			expect(runtime.getSetting("SETTINGS_ONLY_TOKEN")).toBe(
				"settings-only-value",
			);
			expect(runtime.character.secrets).toMatchObject({
				SETTINGS_ONLY_TOKEN: "settings-only-value",
			});
		} finally {
			await runtime.stop({ fast: true });
		}
	});

	it("round-trips an initialized runtime character through JSON validation", async () => {
		const name = "settings-secrets-round-trip";
		const runtime = new AgentRuntime({
			character: {
				name,
				bio: ["test"],
				settings: {},
				secrets: { ROUND_TRIP_TOKEN: "round-trip-value" },
			},
			adapter: SQLiteDatabaseAdapter.create(":memory:", stringToUuid(name)),
			logLevel: "fatal",
		});

		try {
			await runtime.initialize({ skipMigrations: true });
			expect(runtime.character.settings?.secrets).toEqual({
				ROUND_TRIP_TOKEN: "round-trip-value",
			});

			const restored = parseAndValidateCharacter(
				JSON.stringify(runtime.character),
			);

			expect(restored.success).toBe(true);
			expect(restored.data?.settings?.secrets).toEqual({
				ROUND_TRIP_TOKEN: "round-trip-value",
			});
			expect(restored.data?.settings?.extra).toBeUndefined();
		} finally {
			await runtime.stop({ fast: true });
		}
	});
});
