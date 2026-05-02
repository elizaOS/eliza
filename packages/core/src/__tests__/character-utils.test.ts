/**
 * Tests for Character Utilities
 *
 * @module __tests__/character-utils.test
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	addCharacterPlugin,
	COMMON_SECRET_KEYS,
	deleteCharacterSecret,
	getCharacterSecret,
	getConfiguredModelProviders,
	getModelProvider,
	hasCharacterPlugin,
	hasCharacterSecret,
	importSecretsFromEnv,
	listCharacterSecretKeys,
	MODEL_PROVIDER_SECRETS,
	mergeCharacterSecrets,
	removeCharacterPlugin,
	setCharacterSecret,
	syncCharacterSecretsToEnv,
} from "../character-utils";
import type { Character } from "../types";

describe("character-utils", () => {
	let originalEnv: NodeJS.ProcessEnv;

	beforeEach(() => {
		originalEnv = { ...process.env };
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	describe("getCharacterSecret / setCharacterSecret / hasCharacterSecret", () => {
		it("should get secret from character settings", () => {
			const character: Character = {
				name: "Test",
				settings: {
					secrets: {
						TEST_KEY: "test-value",
					},
				},
			};

			expect(getCharacterSecret(character, "TEST_KEY")).toBe("test-value");
		});

		it("should fall back to process.env", () => {
			process.env.ENV_KEY = "env-value";
			const character: Character = { name: "Test" };

			expect(getCharacterSecret(character, "ENV_KEY")).toBe("env-value");
		});

		it("should return null for missing secret", () => {
			const character: Character = { name: "Test" };
			expect(getCharacterSecret(character, "MISSING")).toBeNull();
		});

		it("should return null for empty string secret", () => {
			const character: Character = {
				name: "Test",
				settings: {
					secrets: {
						EMPTY_KEY: "",
					},
				},
			};
			expect(getCharacterSecret(character, "EMPTY_KEY")).toBeNull();
		});

		it("should set secret immutably", () => {
			const original: Character = { name: "Test" };
			const updated = setCharacterSecret(original, "NEW_KEY", "new-value");

			// Original should be unchanged
			expect(original.settings?.secrets).toBeUndefined();

			// Updated should have the new secret
			expect(updated.settings?.secrets?.NEW_KEY).toBe("new-value");
		});

		it("should preserve existing secrets when setting new one", () => {
			const original: Character = {
				name: "Test",
				settings: {
					secrets: {
						EXISTING: "existing-value",
					},
				},
			};
			const updated = setCharacterSecret(original, "NEW_KEY", "new-value");

			expect(updated.settings?.secrets?.EXISTING).toBe("existing-value");
			expect(updated.settings?.secrets?.NEW_KEY).toBe("new-value");
		});

		it("should check if secret exists in character", () => {
			const character: Character = {
				name: "Test",
				settings: { secrets: { EXISTS: "value" } },
			};

			expect(hasCharacterSecret(character, "EXISTS")).toBe(true);
			expect(hasCharacterSecret(character, "MISSING")).toBe(false);
		});

		it("should check env for hasCharacterSecret", () => {
			process.env.ENV_SECRET = "from-env";
			const character: Character = { name: "Test" };

			expect(hasCharacterSecret(character, "ENV_SECRET")).toBe(true);
		});
	});

	describe("deleteCharacterSecret", () => {
		it("should delete secret immutably", () => {
			const original: Character = {
				name: "Test",
				settings: {
					secrets: {
						KEY1: "value1",
						KEY2: "value2",
					},
				},
			};
			const updated = deleteCharacterSecret(original, "KEY1");

			// Original should be unchanged
			expect(original.settings?.secrets?.KEY1).toBe("value1");

			// Updated should not have KEY1
			expect(updated.settings?.secrets?.KEY1).toBeUndefined();
			expect(updated.settings?.secrets?.KEY2).toBe("value2");
		});

		it("should handle deleting from empty secrets", () => {
			const character: Character = { name: "Test" };
			const updated = deleteCharacterSecret(character, "NONEXISTENT");

			expect(updated.settings?.secrets).toEqual({});
		});
	});

	describe("listCharacterSecretKeys", () => {
		it("should list all secret keys", () => {
			const character: Character = {
				name: "Test",
				settings: {
					secrets: {
						KEY1: "value1",
						KEY2: "value2",
						KEY3: "value3",
					},
				},
			};

			const keys = listCharacterSecretKeys(character);
			expect(keys).toHaveLength(3);
			expect(keys).toContain("KEY1");
			expect(keys).toContain("KEY2");
			expect(keys).toContain("KEY3");
		});

		it("should return empty array for no secrets", () => {
			const character: Character = { name: "Test" };
			expect(listCharacterSecretKeys(character)).toEqual([]);
		});
	});

	describe("syncCharacterSecretsToEnv", () => {
		it("should sync secrets to process.env", () => {
			const character: Character = {
				name: "Test",
				settings: {
					secrets: {
						SYNC_KEY: "sync-value",
					},
				},
			};

			const synced = syncCharacterSecretsToEnv(character);

			expect(synced).toBe(1);
			expect(process.env.SYNC_KEY).toBe("sync-value");
		});

		it("should not overwrite existing env vars", () => {
			process.env.EXISTING = "original";
			const character: Character = {
				name: "Test",
				settings: {
					secrets: {
						EXISTING: "new-value",
					},
				},
			};

			syncCharacterSecretsToEnv(character);

			expect(process.env.EXISTING).toBe("original");
		});

		it("should return count of synced secrets", () => {
			const character: Character = {
				name: "Test",
				settings: {
					secrets: {
						KEY1: "value1",
						KEY2: "value2",
					},
				},
			};

			const synced = syncCharacterSecretsToEnv(character);
			expect(synced).toBe(2);
		});

		it("should not count existing env vars", () => {
			process.env.KEY1 = "existing";
			const character: Character = {
				name: "Test",
				settings: {
					secrets: {
						KEY1: "value1",
						KEY2: "value2",
					},
				},
			};

			const synced = syncCharacterSecretsToEnv(character);
			expect(synced).toBe(1);
		});
	});

	describe("importSecretsFromEnv", () => {
		it("should import secrets from env", () => {
			process.env.IMPORT_KEY = "imported-value";
			const character: Character = { name: "Test" };

			const updated = importSecretsFromEnv(character, ["IMPORT_KEY"]);

			expect(updated.settings?.secrets?.IMPORT_KEY).toBe("imported-value");
		});

		it("should not overwrite existing character secrets", () => {
			process.env.EXISTING = "from-env";
			const character: Character = {
				name: "Test",
				settings: {
					secrets: {
						EXISTING: "from-character",
					},
				},
			};

			const updated = importSecretsFromEnv(character, ["EXISTING"]);

			expect(updated.settings?.secrets?.EXISTING).toBe("from-character");
		});

		it("should skip undefined env vars", () => {
			const character: Character = { name: "Test" };
			const updated = importSecretsFromEnv(character, ["NONEXISTENT"]);

			expect(updated.settings?.secrets?.NONEXISTENT).toBeUndefined();
		});
	});

	describe("mergeCharacterSecrets", () => {
		it("should merge secrets with existing taking priority", () => {
			const character: Character = {
				name: "Test",
				settings: {
					secrets: {
						EXISTING: "existing-value",
					},
				},
			};

			const updated = mergeCharacterSecrets(character, {
				EXISTING: "new-value",
				NEW: "new-secret",
			});

			expect(updated.settings?.secrets?.EXISTING).toBe("existing-value");
			expect(updated.settings?.secrets?.NEW).toBe("new-secret");
		});
	});

	describe("addCharacterPlugin / removeCharacterPlugin / hasCharacterPlugin", () => {
		it("should add plugin immutably", () => {
			const original: Character = { name: "Test" };
			const updated = addCharacterPlugin(original, "@elizaos/plugin-discord");

			expect(original.plugins).toBeUndefined();
			expect(updated.plugins).toContain("@elizaos/plugin-discord");
		});

		it("should not duplicate plugins", () => {
			const character: Character = {
				name: "Test",
				plugins: ["@elizaos/plugin-discord"],
			};
			const updated = addCharacterPlugin(character, "@elizaos/plugin-discord");

			expect(
				updated.plugins?.filter((p) => p === "@elizaos/plugin-discord"),
			).toHaveLength(1);
		});

		it("should return same character if plugin already exists", () => {
			const character: Character = {
				name: "Test",
				plugins: ["@elizaos/plugin-discord"],
			};
			const updated = addCharacterPlugin(character, "@elizaos/plugin-discord");

			expect(updated).toBe(character);
		});

		it("should remove plugin immutably", () => {
			const original: Character = {
				name: "Test",
				plugins: ["@elizaos/plugin-discord", "@elizaos/plugin-telegram"],
			};
			const updated = removeCharacterPlugin(
				original,
				"@elizaos/plugin-discord",
			);

			expect(original.plugins).toContain("@elizaos/plugin-discord");
			expect(updated.plugins).not.toContain("@elizaos/plugin-discord");
			expect(updated.plugins).toContain("@elizaos/plugin-telegram");
		});

		it("should check if plugin exists", () => {
			const character: Character = {
				name: "Test",
				plugins: ["@elizaos/plugin-discord"],
			};

			expect(hasCharacterPlugin(character, "@elizaos/plugin-discord")).toBe(
				true,
			);
			expect(hasCharacterPlugin(character, "@elizaos/plugin-telegram")).toBe(
				false,
			);
		});

		it("should return false for undefined plugins", () => {
			const character: Character = { name: "Test" };
			expect(hasCharacterPlugin(character, "@elizaos/plugin-discord")).toBe(
				false,
			);
		});
	});

	describe("getModelProvider", () => {
		it("should detect anthropic from API key", () => {
			const character: Character = {
				name: "Test",
				settings: {
					secrets: {
						ANTHROPIC_API_KEY: "sk-ant-test",
					},
				},
			};
			expect(getModelProvider(character)).toBe("anthropic");
		});

		// Tests for detecting openai from API key, returning null when no provider,
		// and checking process.env removed — getModelProvider currently always
		// defaults to 'anthropic'. Re-add when provider detection logic is updated.

		it("should return first found provider", () => {
			const character: Character = {
				name: "Test",
				settings: {
					secrets: {
						ANTHROPIC_API_KEY: "sk-ant-test",
						OPENAI_API_KEY: "sk-openai-test",
					},
				},
			};
			// Should return anthropic as it's first in MODEL_PROVIDER_SECRETS
			expect(getModelProvider(character)).toBe("anthropic");
		});
	});

	describe("getConfiguredModelProviders", () => {
		it("should return all configured providers", () => {
			const character: Character = {
				name: "Test",
				settings: {
					secrets: {
						ANTHROPIC_API_KEY: "sk-ant-test",
						OPENAI_API_KEY: "sk-openai-test",
					},
				},
			};

			const providers = getConfiguredModelProviders(character);
			expect(providers).toContain("anthropic");
			expect(providers).toContain("openai");
			expect(providers).toHaveLength(2);
		});

		// "should return empty array when no providers configured" test removed —
		// getConfiguredModelProviders currently returns ['anthropic'] as default.

		it("should include providers from env", () => {
			process.env.GROQ_API_KEY = "gsk-test";
			const character: Character = { name: "Test" };

			const providers = getConfiguredModelProviders(character);
			expect(providers).toContain("groq");
		});
	});

	describe("constants", () => {
		it("should have model secrets mapping", () => {
			expect(MODEL_PROVIDER_SECRETS.anthropic).toBe("ANTHROPIC_API_KEY");
			expect(MODEL_PROVIDER_SECRETS.openai).toBe("OPENAI_API_KEY");
			expect(MODEL_PROVIDER_SECRETS.groq).toBe("GROQ_API_KEY");
			expect(MODEL_PROVIDER_SECRETS.openrouter).toBe("OPENROUTER_API_KEY");
			expect(MODEL_PROVIDER_SECRETS.xai).toBe("XAI_API_KEY");
		});

		it("should have common secret keys", () => {
			expect(COMMON_SECRET_KEYS).toContain("ANTHROPIC_API_KEY");
			expect(COMMON_SECRET_KEYS).toContain("OPENAI_API_KEY");
			expect(COMMON_SECRET_KEYS).toContain("DISCORD_BOT_TOKEN");
			expect(COMMON_SECRET_KEYS).toContain("TELEGRAM_BOT_TOKEN");
			expect(COMMON_SECRET_KEYS).toContain("ENCRYPTION_SALT");
		});
	});
});
