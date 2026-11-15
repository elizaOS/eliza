/**
 * Exercises `AgentRuntime.getSetting` resolution precedence (character env vs
 * settings vs constructor settings vs DB-persisted values on restart) and
 * prompt-batcher construction. Deterministic: real runtime over the in-memory
 * adapter, no model calls.
 */

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteDatabaseAdapter } from "@elizaos/testing/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCharacter } from "../src/character";
import { AgentRuntime } from "../src/runtime";
import type { SecretSwapSession } from "../src/security/secret-swap";
import { clearSaltCache, encryptStringValue, getSalt } from "../src/settings";
import type { Character } from "../src/types/agent.js";
import { stringToUuid as sqliteTestAgentId } from "../src/utils/string-to-uuid.js";

describe("AgentRuntime.getSetting", () => {
	it.each([false, true])(
		"keeps runtime setting writes local (secret=%s)",
		(secret) => {
			const first = new AgentRuntime({
				character: createCharacter({ name: "settings-first" }),
			});
			const second = new AgentRuntime({
				character: createCharacter({ name: "settings-second" }),
			});
			const key = "RUNTIME_SETTINGS_LOCAL_TEST";
			try {
				first.setSetting(key, "first-value", secret);
				expect(first.getSetting(key)).toBe("first-value");
				expect(second.getSetting(key)).toBeNull();
				const later = new AgentRuntime({
					character: createCharacter({ name: "settings-later" }),
				});
				expect(later.getSetting(key)).toBeNull();
				second.setSetting(key, "second-value", secret);
				first.setSetting(key, null, secret);
				expect(first.getSetting(key)).toBeNull();
				expect(second.getSetting(key)).toBe("second-value");
			} finally {
				first.setSetting(key, null, secret);
				second.setSetting(key, null, secret);
			}
		},
	);

	it("owns a mutable copy of caller-provided constructor settings", () => {
		const settings = Object.freeze({ RUNTIME_SETTINGS_COPY_TEST: "initial" });
		const first = new AgentRuntime({
			character: createCharacter({ name: "copy-first" }),
			settings,
		});
		const second = new AgentRuntime({
			character: createCharacter({ name: "copy-second" }),
			settings,
		});
		first.setSetting("RUNTIME_SETTINGS_COPY_TEST", "updated");
		expect(first.getSetting("RUNTIME_SETTINGS_COPY_TEST")).toBe("updated");
		expect(second.getSetting("RUNTIME_SETTINGS_COPY_TEST")).toBe("initial");
		first.setSetting("RUNTIME_SETTINGS_COPY_TEST", null);
		expect(first.getSetting("RUNTIME_SETTINGS_COPY_TEST")).toBeNull();
		expect(second.getSetting("RUNTIME_SETTINGS_COPY_TEST")).toBe("initial");
		expect(settings.RUNTIME_SETTINGS_COPY_TEST).toBe("initial");
	});

	it("reads primitive character env values as runtime settings", () => {
		const runtime = new AgentRuntime({
			character: {
				name: "env-settings-test",
				env: {
					FEATURE_FLAG: true,
					TIMEOUT_MS: 5000,
					vars: {
						ROUTE_POLICY: '{"default":"guest"}',
					},
				},
				settings: {
					ROUTE_POLICY: '{"default":"owner"}',
				},
			} as Character,
		});

		expect(runtime.getSetting("FEATURE_FLAG")).toBe(true);
		expect(runtime.getSetting("TIMEOUT_MS")).toBe(5000);
		expect(runtime.getSetting("ROUTE_POLICY")).toBe('{"default":"owner"}');
	});

	it("reads primitive values from character env vars", () => {
		const runtime = new AgentRuntime({
			character: {
				name: "env-vars-settings-test",
				env: {
					vars: {
						ROUTE_POLICY: '{"default":"guest"}',
					},
				},
			} as Character,
		});

		expect(runtime.getSetting("ROUTE_POLICY")).toBe('{"default":"guest"}');
	});

	it("falls back to env vars when direct env values are not primitive", () => {
		const runtime = new AgentRuntime({
			character: {
				name: "env-vars-fallback-test",
				env: {
					ROUTE_POLICY: {
						default: "owner",
					},
					vars: {
						ROUTE_POLICY: '{"default":"guest"}',
					},
				},
			} as Character,
		});

		expect(runtime.getSetting("ROUTE_POLICY")).toBe('{"default":"guest"}');
	});

	it("keeps character settings ahead of constructor settings", () => {
		const runtime = new AgentRuntime({
			character: {
				name: "character-settings-override-test",
				settings: {
					ROUTE_POLICY: '{"default":"owner"}',
				},
			} as Character,
			settings: {
				ROUTE_POLICY: '{"default":"guest"}',
			},
		});

		expect(runtime.getSetting("ROUTE_POLICY")).toBe('{"default":"owner"}');
	});

	it("clears secrets and settings when setSetting receives null", () => {
		const runtime = new AgentRuntime({
			character: {
				name: "set-setting-clear-test",
				secrets: {
					DISCORD_API_TOKEN: "old-token",
				},
				settings: {
					DISCORD_APPLICATION_ID: "old-app",
				},
			} as Character,
			settings: {
				DISCORD_API_TOKEN: "constructor-token",
				DISCORD_APPLICATION_ID: "constructor-app",
			},
		});

		expect(runtime.getSetting("DISCORD_API_TOKEN")).toBe("old-token");
		runtime.setSetting("DISCORD_API_TOKEN", null, true);
		expect(runtime.getSetting("DISCORD_API_TOKEN")).toBeNull();

		expect(runtime.getSetting("DISCORD_APPLICATION_ID")).toBe("old-app");
		runtime.setSetting("DISCORD_APPLICATION_ID", null, false);
		expect(runtime.getSetting("DISCORD_APPLICATION_ID")).toBeNull();
	});

	it("updates and clears a boot-loaded secret through a non-secret write", () => {
		const runtime = new AgentRuntime({
			character: {
				name: "non-secret-write-over-secret-test",
				secrets: { SOLANA_RPC_URL: "https://old-rpc.example" },
			} as Character,
		});

		runtime.setSetting("SOLANA_RPC_URL", "https://new-rpc.example", false);
		expect(runtime.getSetting("SOLANA_RPC_URL")).toBe(
			"https://new-rpc.example",
		);

		runtime.setSetting("SOLANA_RPC_URL", null, false);
		expect(runtime.getSetting("SOLANA_RPC_URL")).toBeNull();
	});

	it.each(["top-level", "nested"])(
		"excludes legacy public Cloud settings from %s secret catalogs",
		(location) => {
			const secrets = {
				ELIZAOS_CLOUD_ENABLED: "true",
				ELIZAOS_CLOUD_BASE_URL: "https://cloud.example.invalid",
				" elizaos_cloud_enabled ": "true",
			};
			const runtime = new AgentRuntime({
				character: {
					name: "legacy-cloud-public-settings",
					...(location === "top-level"
						? { secrets }
						: { settings: { secrets } }),
				} as Character,
				logLevel: "fatal",
			});
			expect(runtime.getSetting("ELIZAOS_CLOUD_ENABLED")).toBe(true);
			const createSwap = () =>
				(
					runtime as unknown as { createSecretSwapSession(): SecretSwapSession }
				).createSecretSwapSession();
			const text = "Cloud enabled true at https://cloud.example.invalid";
			expect(createSwap().substituteText(text)).toBe(text);
			expect(runtime.redactSecrets(text)).toBe(text);
			runtime.setSetting("PASSWORD", "true", true);
			expect(createSwap().substituteText("credential true")).not.toContain(
				"true",
			);
			expect(runtime.getSetting("ELIZAOS_CLOUD_ENABLED")).toBe(true);
		},
	);

	it("replaces and revokes a boot-copied nested secret", () => {
		const runtime = new AgentRuntime({
			character: {
				name: "nested-secret-live-update-test",
				settings: { secrets: { OPENROUTER_API_KEY: "token-a" } },
			} as Character,
			settings: { OPENROUTER_API_KEY: "token-a" },
		});

		expect(runtime.getSetting("OPENROUTER_API_KEY")).toBe("token-a");
		runtime.setSetting("OPENROUTER_API_KEY", "token-b", true);
		expect(runtime.getSetting("OPENROUTER_API_KEY")).toBe("token-b");
		runtime.setSetting("OPENROUTER_API_KEY", null, true);
		expect(runtime.getSetting("OPENROUTER_API_KEY")).toBeNull();
	});

	it("keeps secrets written after initialize() in the secret maps", async () => {
		const adapter = SQLiteDatabaseAdapter.create(
			":memory:",
			sqliteTestAgentId("runtime-secret-after-initialize-test"),
		);
		const runtime = new AgentRuntime({
			character: {
				name: "runtime-secret-after-initialize-test",
				bio: ["test"],
				settings: {},
				secrets: { BOOT_SERVICE_TOKEN: "boot-service-token-value" },
			} as Character,
			adapter,
			logLevel: "fatal",
		});

		try {
			await runtime.initialize({ skipMigrations: true });
			// initialize() merges both secret maps into one shared object.
			expect(runtime.character.settings?.secrets).toBe(
				runtime.character.secrets,
			);

			runtime.setSetting("BOOT_SERVICE_TOKEN", "rotated-service-token", true);
			runtime.setSetting("LATER_SERVICE_TOKEN", "later-service-token", true);

			expect(runtime.character.secrets).toMatchObject({
				BOOT_SERVICE_TOKEN: "rotated-service-token",
				LATER_SERVICE_TOKEN: "later-service-token",
			});
			const swap = (
				runtime as unknown as {
					createSecretSwapSession(): SecretSwapSession;
				}
			).createSecretSwapSession();
			const wire = swap.substituteText(
				"keys rotated-service-token later-service-token",
			);
			expect(wire).not.toContain("rotated-service-token");
			expect(wire).not.toContain("later-service-token");

			runtime.setSetting("LATER_SERVICE_TOKEN", null, true);
			expect(runtime.getSetting("LATER_SERVICE_TOKEN")).toBeNull();
			expect(runtime.character.secrets).not.toHaveProperty(
				"LATER_SERVICE_TOKEN",
			);
		} finally {
			await runtime.stop({ fast: true });
		}
	});

	it("uses fresh constructor settings over DB-persisted agent settings on restart", async () => {
		const adapter = SQLiteDatabaseAdapter.create(
			":memory:",
			sqliteTestAgentId("runtime-settings-restart-test"),
		);
		const characterName = "runtime-settings-restart-test";
		const firstRuntime = new AgentRuntime({
			character: {
				name: characterName,
				bio: ["test"],
				settings: {},
			} as Character,
			adapter,
			settings: { FOO: "v1" },
			logLevel: "fatal",
		});

		let secondRuntime: AgentRuntime | undefined;
		try {
			await firstRuntime.initialize({ skipMigrations: true });
			expect(firstRuntime.getSetting("FOO")).toBe("v1");
			await adapter.updateAgents([
				{
					agentId: firstRuntime.agentId,
					agent: {
						settings: { FOO: "v1", secrets: { BAR: "v1" } },
						secrets: { BAZ: "v1" },
					},
				},
			]);

			secondRuntime = new AgentRuntime({
				character: {
					name: characterName,
					bio: ["test"],
					settings: {},
				} as Character,
				adapter,
				settings: { FOO: "v2", BAR: "v2", BAZ: "v2" },
				logLevel: "fatal",
			});
			await secondRuntime.initialize({ skipMigrations: true });

			expect(secondRuntime.getSetting("FOO")).toBe("v2");
			expect(secondRuntime.getSetting("BAR")).toBe("v2");
			expect(secondRuntime.getSetting("BAZ")).toBe("v2");
		} finally {
			await firstRuntime.stop({ fast: true });
			await secondRuntime?.stop({ fast: true });
		}
	});
});

describe("retired default-salt override through runtime settings", () => {
	const configuredSalt = randomUUID();
	const fullValue =
		"SALT_POLICY_HEAD\nComplete selected value: café 🌳\nSALT_POLICY_TAIL";
	afterEach(() => {
		vi.unstubAllEnvs();
		clearSaltCache();
	});

	it.each([
		{ label: "unset", salt: undefined },
		{ label: "historical", salt: "secretsalt" },
	])(
		"refuses production $label salt despite the retired override",
		async ({ salt }) => {
			vi.stubEnv("NODE_ENV", "production");
			vi.stubEnv("SECRET_SALT", configuredSalt);
			vi.stubEnv("ELIZA_ALLOW_DEFAULT_SECRET_SALT", "true");
			clearSaltCache();
			const runtime = new AgentRuntime({
				character: {
					name: "SaltPolicyRefusal",
					bio: [],
					settings: { POLICY_VALUE: fullValue },
				},
				logLevel: "fatal",
			});
			try {
				vi.stubEnv("SECRET_SALT", salt);
				clearSaltCache();
				expect(() => runtime.getSetting("POLICY_VALUE")).toThrow(
					"SECRET_SALT must be set to a non-default value in production",
				);
				expect(runtime.character.settings?.POLICY_VALUE).toBe(fullValue);
			} finally {
				vi.stubEnv("SECRET_SALT", configuredSalt);
				clearSaltCache();
				await runtime.stop({ fast: true });
			}
		},
	);

	it("keeps configured encrypted SQLite settings readable after runtime and adapter restart", async () => {
		vi.stubEnv("NODE_ENV", "production");
		vi.stubEnv("SECRET_SALT", configuredSalt);
		vi.stubEnv("ELIZA_ALLOW_DEFAULT_SECRET_SALT", "true");
		clearSaltCache();
		const directory = await mkdtemp(join(tmpdir(), "core-salt-policy-"));
		const name = "SaltPolicyPersistent";
		const database = join(directory, "settings.sqlite");
		const agentId = sqliteTestAgentId(name);
		const ciphertext = encryptStringValue(fullValue, getSalt());
		const firstAdapter = SQLiteDatabaseAdapter.create(database, agentId);
		const first = new AgentRuntime({
			character: { name, bio: [], settings: {} },
			adapter: firstAdapter,
			logLevel: "fatal",
		});
		let second: AgentRuntime | undefined;
		try {
			await first.initialize({ skipMigrations: true });
			await firstAdapter.updateAgents([
				{ agentId, agent: { secrets: { POLICY_VALUE: ciphertext } } },
			]);
			await first.close();
			clearSaltCache();
			const secondAdapter = SQLiteDatabaseAdapter.create(database, agentId);
			second = new AgentRuntime({
				character: { name, bio: [], settings: {} },
				adapter: secondAdapter,
				logLevel: "fatal",
			});
			await second.initialize({ skipMigrations: true });
			expect(second.getSetting("POLICY_VALUE")).toBe(fullValue);
			expect(
				(await secondAdapter.getAgents()).find((agent) => agent.id === agentId)
					?.secrets?.POLICY_VALUE,
			).toBe(ciphertext);
			expect(ciphertext).not.toContain(fullValue);
		} finally {
			await first.close();
			await second?.close();
			await rm(directory, { recursive: true, force: true });
		}
	});

	it.each([
		{ label: "unset", salt: undefined },
		{ label: "historical", salt: "secretsalt" },
	])(
		"keeps one process-local development key for $label salt despite the retired override and cache clears",
		async ({ salt: configured }) => {
			vi.stubEnv("NODE_ENV", "development");
			vi.stubEnv("SECRET_SALT", configured);
			vi.stubEnv("ELIZA_ALLOW_DEFAULT_SECRET_SALT", "true");
			clearSaltCache();
			const salt = getSalt();
			expect(salt).toMatch(/^[a-f0-9]{64}$/);
			expect(salt).not.toBe("secretsalt");
			const ciphertext = encryptStringValue(fullValue, salt);
			clearSaltCache();
			expect(getSalt()).toBe(salt);
			const runtime = new AgentRuntime({
				character: {
					name: "SaltPolicyEphemeral",
					bio: [],
					secrets: { POLICY_VALUE: ciphertext },
				},
				logLevel: "fatal",
			});
			try {
				expect(runtime.getSetting("POLICY_VALUE")).toBe(fullValue);
			} finally {
				await runtime.stop({ fast: true });
			}
		},
	);
});
