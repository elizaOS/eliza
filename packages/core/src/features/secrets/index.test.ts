/**
 * Pins the runtime composition of the secrets feature barrel: every export
 * group resolves to a live implementation and behaves correctly when driven
 * through `./index` — crypto roundtrips and failure modes, the validation
 * registry lifecycle, setup-flow ordering rules, memory and composite storage
 * scoping, display masking, and the plugin's action/provider/service wiring.
 *
 * Harness: deterministic unit suite. The real module runs unmocked; no network
 * is reachable because format-only validation is enforced (VALIDATE_API_KEYS
 * is cleared for the duration of the run).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import defaultExport, {
	ALGORITHM_GCM,
	CompositeSecretStorage,
	createKeyDerivationParams,
	createSetupConfig,
	DEFAULT_PBKDF2_ITERATIONS,
	DEFAULT_SALT_LENGTH,
	decrypt,
	deriveKeyPbkdf2,
	deriveKeyScrypt,
	type EncryptedSecret,
	EncryptionError,
	encrypt,
	encryptGcm,
	generateKey,
	generateSalt,
	generateSecureToken,
	generateSettingPrompt,
	getNextSetting,
	getUnconfiguredOptional,
	getUnconfiguredRequired,
	hashValue,
	IV_LENGTH,
	inferValidationStrategy,
	isEncryptedSecret,
	isSetupComplete,
	KEY_LENGTH,
	KeyManager,
	MemorySecretStorage,
	maskSecretValue,
	missingSecretsProvider,
	PLUGIN_ACTIVATOR_SERVICE_TYPE,
	PluginActivatorService,
	registerValidator,
	SECRETS_SERVICE_TYPE,
	SETUP_SERVICE_TYPE,
	type SecretContext,
	SecretsService,
	SetupService,
	secretsAction,
	secretsManagerPlugin,
	secretsStatusProvider,
	secureCompare,
	unregisterValidator,
	updateSettingsAction,
	validateSecret,
} from "./index";

const previousValidateFlag = process.env.VALIDATE_API_KEYS;

beforeAll(() => {
	delete process.env.VALIDATE_API_KEYS;
});

afterAll(() => {
	if (previousValidateFlag !== undefined) {
		process.env.VALIDATE_API_KEYS = previousValidateFlag;
	}
});

describe("secrets feature barrel", () => {
	describe("crypto", () => {
		it("round-trips plaintext through encrypt/decrypt with a fresh key", () => {
			const key = generateKey();
			expect(key.length).toBe(KEY_LENGTH);

			const sealed = encrypt("hunter2-😀", key);
			expect(isEncryptedSecret(sealed)).toBe(true);
			expect(sealed.algorithm).toBe(ALGORITHM_GCM);
			expect(Buffer.from(sealed.iv, "base64").length).toBe(IV_LENGTH);

			expect(decrypt(sealed, key)).toBe("hunter2-😀");
		});

		it("round-trips an empty plaintext", () => {
			const key = generateKey();
			const sealed = encrypt("", key);
			expect(decrypt(sealed, key)).toBe("");
		});

		it("fails authentication when decrypted with the wrong key or tampered bytes", () => {
			const key = generateKey();
			const sealed = encrypt("tamper-target", key);

			expect(() => decrypt(sealed, generateKey())).toThrow();

			const tampered = {
				...sealed,
				value: `${sealed.value.slice(0, -4)}AAAA`,
			};
			expect(() => decrypt(tampered, key)).toThrow();
		});

		it("rejects malformed keys and unsupported algorithms with typed errors", () => {
			const key = generateKey();

			expect(() => encryptGcm("x", key.subarray(0, KEY_LENGTH - 1))).toThrow(
				EncryptionError,
			);
			expect(() =>
				decrypt(
					{ value: "aQ==", iv: "aXY=", algorithm: "aes-256-gcm", keyId: "k" },
					key.subarray(0, 16),
				),
			).toThrow(EncryptionError);

			const foreignAlgorithm = {
				...encrypt("x", key),
				algorithm: "aes-256-cbc",
			} as EncryptedSecret;
			expect(() => decrypt(foreignAlgorithm, key)).toThrow(EncryptionError);
		});

		it("derives reproducible keys from passwords and diverges otherwise", () => {
			const salt = generateSalt();

			expect(
				deriveKeyPbkdf2("passphrase", salt).equals(
					deriveKeyPbkdf2("passphrase", salt),
				),
			).toBe(true);
			expect(
				deriveKeyPbkdf2("passphrase", salt).equals(
					deriveKeyPbkdf2("other-passphrase", salt),
				),
			).toBe(false);
			expect(
				deriveKeyPbkdf2("passphrase", salt).equals(
					deriveKeyPbkdf2("passphrase", salt, 1000),
				),
			).toBe(false);
			expect(deriveKeyPbkdf2("passphrase", salt).length).toBe(KEY_LENGTH);

			expect(
				deriveKeyScrypt("passphrase", salt).equals(
					deriveKeyScrypt("passphrase", salt),
				),
			).toBe(true);
			expect(deriveKeyScrypt("passphrase", salt).length).toBe(KEY_LENGTH);
		});

		it("creates derivation params with defaults and honors explicit ones", () => {
			const params = createKeyDerivationParams();
			expect(params.iterations).toBe(DEFAULT_PBKDF2_ITERATIONS);
			expect(params.keyLength).toBe(KEY_LENGTH);
			expect(params.algorithm).toBe("pbkdf2-sha256");
			expect(Buffer.from(params.salt, "base64").length).toBe(
				DEFAULT_SALT_LENGTH,
			);
			expect(createKeyDerivationParams().salt).not.toBe(params.salt);

			const custom = createKeyDerivationParams("abc", 1234);
			expect(custom.salt).toBe("abc");
			expect(custom.iterations).toBe(1234);
		});

		it("generates unique hex tokens of the requested byte length", () => {
			const token = generateSecureToken();
			expect(token).toMatch(/^[0-9a-f]{64}$/);
			expect(generateSecureToken(8)).toMatch(/^[0-9a-f]{16}$/);
			expect(token).not.toBe(generateSecureToken());
		});

		it("hashes values with sha256 by default and sha512 on request", () => {
			expect(hashValue("abc")).toBe(
				"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
			);
			const sha512 = hashValue("abc", "sha512");
			expect(sha512).toHaveLength(128);
			expect(sha512).not.toBe(hashValue("abc"));
		});

		it("compares strings in constant time", () => {
			expect(secureCompare("same", "same")).toBe(true);
			expect(secureCompare("same", "sane")).toBe(false);
			expect(secureCompare("same", "sam")).toBe(false);
			expect(secureCompare("", "")).toBe(true);
		});

		it("recognizes encrypted containers structurally", () => {
			const key = generateKey();
			expect(isEncryptedSecret(encrypt("v", key))).toBe(true);
			expect(
				isEncryptedSecret({
					value: "v",
					iv: "aXY=",
					algorithm: "aes-256-gcm",
				}),
			).toBe(true);
			expect(isEncryptedSecret("sk-plain-string")).toBe(false);
			expect(isEncryptedSecret(null)).toBe(false);
			expect(isEncryptedSecret({ value: "v", algorithm: "aes-256-gcm" })).toBe(
				false,
			);
			expect(
				isEncryptedSecret({ value: "v", iv: "aXY=", algorithm: "aes-128-gcm" }),
			).toBe(false);
		});
	});

	describe("KeyManager", () => {
		it("refuses to encrypt before any key exists", () => {
			const manager = new KeyManager();
			expect(manager.getDerivationParams()).toBeNull();
			expect(() => manager.getCurrentKey()).toThrow(EncryptionError);
		});

		it("initializes from a password and round-trips under the default key id", () => {
			const manager = new KeyManager();
			manager.initializeFromPassword("passphrase", "fixed-salt");

			expect(manager.getCurrentKeyId()).toBe("default");
			expect(manager.getDerivationParams()?.salt).toBe("fixed-salt");

			const sealed = manager.encrypt("guarded");
			expect(sealed.keyId).toBe("default");
			expect(manager.decrypt(sealed)).toBe("guarded");
		});

		it("rotates keys while older ciphertexts remain decryptable", () => {
			const manager = new KeyManager({
				primaryKey: generateKey(),
				primaryKeyId: "k1",
			});
			const beforeRotation = manager.encrypt("rotate-me");

			manager.addKey("k2", generateKey());
			manager.setCurrentKey("k2");
			expect(manager.getCurrentKeyId()).toBe("k2");

			const afterRotation = manager.encrypt("rotate-me");
			expect(afterRotation.keyId).toBe("k2");
			expect(manager.decrypt(beforeRotation)).toBe("rotate-me");

			const rotated = manager.reencrypt(beforeRotation);
			expect(rotated.keyId).toBe("k2");
			expect(rotated.value).not.toBe(beforeRotation.value);
			expect(manager.decrypt(rotated)).toBe("rotate-me");

			expect(() => manager.setCurrentKey("missing-id")).toThrow(
				EncryptionError,
			);
		});

		it("zeroes and drops every key on clear()", () => {
			const primaryKey = generateKey();
			const manager = new KeyManager({ primaryKey });

			manager.clear();

			expect(manager.getKey("default")).toBeUndefined();
			expect(() => manager.getCurrentKey()).toThrow(EncryptionError);
			expect(primaryKey.every((byte) => byte === 0)).toBe(true);
		});
	});

	describe("validation registry", () => {
		it("passes anything under the default strategy and rejects unknown strategies", async () => {
			expect((await validateSecret("ANY", "whatever")).isValid).toBe(true);

			const unknown = await validateSecret("ANY", "whatever", "does-not-exist");
			expect(unknown.isValid).toBe(false);
			expect(unknown.error).toContain("Unknown validation strategy");
		});

		it("enforces provider key formats without network verification", async () => {
			const openai = await validateSecret(
				"OPENAI_API_KEY",
				`sk-${"x".repeat(17)}`,
				"api_key:openai",
			);
			expect(openai.isValid).toBe(true);

			const wrongPrefix = await validateSecret(
				"OPENAI_API_KEY",
				`ac-${"x".repeat(20)}`,
				"api_key:openai",
			);
			expect(wrongPrefix.isValid).toBe(false);
			expect(wrongPrefix.error).toContain('start with "sk-"');

			const tooShort = await validateSecret(
				"OPENAI_API_KEY",
				"sk-12345",
				"api_key:openai",
			);
			expect(tooShort.isValid).toBe(false);
			expect(tooShort.error).toContain("too short");

			const anthropic = await validateSecret(
				"ANTHROPIC_API_KEY",
				`sk-ant-${"x".repeat(23)}`,
				"api_key:anthropic",
			);
			expect(anthropic.isValid).toBe(true);

			const anthropicTooShort = await validateSecret(
				"ANTHROPIC_API_KEY",
				"sk-ant-x",
				"api_key:anthropic",
			);
			expect(anthropicTooShort.isValid).toBe(false);

			const groq = await validateSecret(
				"GROQ_API_KEY",
				`gsk_${"x".repeat(16)}`,
				"api_key:groq",
			);
			expect(groq.isValid).toBe(true);
			expect(
				(
					await validateSecret(
						"GROQ_API_KEY",
						`nope_${"x".repeat(16)}`,
						"api_key:groq",
					)
				).isValid,
			).toBe(false);
		});

		it("validates URL format without probing the network", async () => {
			expect(
				(await validateSecret("API_URL", "https://example.com/x", "url:valid"))
					.isValid,
			).toBe(true);

			const invalid = await validateSecret("API_URL", "not a url", "url:valid");
			expect(invalid.isValid).toBe(false);
			expect(invalid.error).toBe("Invalid URL format");
		});

		it("dispatches custom validators per key, then shared, then fails closed", async () => {
			const seen: string[][] = [];
			registerValidator("TEST_STRATEGY_KEY", async (key, value) => {
				seen.push([key, value]);
				return { isValid: true, validatedAt: 1 };
			});

			const perKey = await validateSecret(
				"TEST_STRATEGY_KEY",
				"value-a",
				"custom",
			);
			expect(perKey.isValid).toBe(true);
			expect(seen).toEqual([["TEST_STRATEGY_KEY", "value-a"]]);
			expect(unregisterValidator("TEST_STRATEGY_KEY")).toBe(true);

			registerValidator("custom", async () => ({
				isValid: false,
				error: "shared validator rejected",
				validatedAt: 2,
			}));
			const shared = await validateSecret("OTHER", "v", "custom");
			expect(shared.isValid).toBe(false);
			expect(shared.error).toBe("shared validator rejected");
			expect(unregisterValidator("custom")).toBe(true);

			const orphaned = await validateSecret("OTHER", "v", "custom");
			expect(orphaned.isValid).toBe(false);
			expect(orphaned.error).toContain("No custom validator registered");

			expect(unregisterValidator("was-never-registered")).toBe(false);
		});

		it("infers strategies from key names, providers before URLs, case-insensitively", () => {
			expect(inferValidationStrategy("OPENAI_API_KEY")).toBe("api_key:openai");
			expect(inferValidationStrategy("my_openai_key")).toBe("api_key:openai");
			expect(inferValidationStrategy("ANTHROPIC_API_KEY")).toBe(
				"api_key:anthropic",
			);
			expect(inferValidationStrategy("GROQ_API_KEY")).toBe("api_key:groq");
			expect(inferValidationStrategy("GOOGLE_API_KEY")).toBe("api_key:google");
			expect(inferValidationStrategy("MISTRAL_API_KEY")).toBe(
				"api_key:mistral",
			);
			expect(inferValidationStrategy("COHERE_API_KEY")).toBe("api_key:cohere");
			expect(inferValidationStrategy("WEBHOOK_ENDPOINT")).toBe("url:valid");
			expect(inferValidationStrategy("OPENAI_API_KEY_URL")).toBe(
				"api_key:openai",
			);
			expect(inferValidationStrategy("PLAIN_SECRET")).toBe("none");
		});
	});

	describe("setup flow", () => {
		it("builds settings from presets, falling back for unknown keys", () => {
			const config = createSetupConfig(
				["OPENAI_API_KEY", "MY_TOKEN"],
				["TELEGRAM_BOT_TOKEN"],
			);

			const openai = config.settings.OPENAI_API_KEY;
			expect(openai.required).toBe(true);
			expect(openai.envVar).toBe("OPENAI_API_KEY");
			expect(openai.validationMethod).toBe("openai");
			expect(openai.value).toBeNull();

			const unknown = config.settings.MY_TOKEN;
			expect(unknown.name).toBe("MY_TOKEN");
			expect(unknown.description).toBe("Configure MY_TOKEN");
			expect(unknown.type).toBe("api_key");
			expect(unknown.secret).toBe(true);

			expect(config.settings.TELEGRAM_BOT_TOKEN.required).toBe(false);
			expect(config.settings.TELEGRAM_BOT_TOKEN.validationMethod).toBe(
				"telegram",
			);
		});

		it("applies custom setting overrides while preserving preset defaults", () => {
			const config = createSetupConfig(["OPENAI_API_KEY"], [], {
				OPENAI_API_KEY: { description: "team-shared key" },
			});
			expect(config.settings.OPENAI_API_KEY.description).toBe(
				"team-shared key",
			);
			expect(config.settings.OPENAI_API_KEY.envVar).toBe("OPENAI_API_KEY");
		});

		it("tracks completion against required settings only", () => {
			const config = createSetupConfig(["REQ_A"], ["OPT_B"]);

			expect(getUnconfiguredRequired(config).map(([k]) => k)).toEqual([
				"REQ_A",
			]);
			expect(getUnconfiguredOptional(config).map(([k]) => k)).toEqual([
				"OPT_B",
			]);
			expect(isSetupComplete(config)).toBe(false);

			config.settings.REQ_A.value = "done";
			expect(isSetupComplete(config)).toBe(true);
			expect(getUnconfiguredRequired(config)).toHaveLength(0);
			expect(getUnconfiguredOptional(config).map(([k]) => k)).toEqual([
				"OPT_B",
			]);
		});

		it("orders required settings ahead of optionals and respects dependencies", () => {
			const config = createSetupConfig([
				"TWITTER_USERNAME",
				"TWITTER_PASSWORD",
			]);

			expect(getNextSetting(config)?.[0]).toBe("TWITTER_USERNAME");

			config.settings.TWITTER_USERNAME.value = "handle";
			expect(getNextSetting(config)?.[0]).toBe("TWITTER_PASSWORD");

			config.settings.TWITTER_PASSWORD.value = "secret";
			expect(getNextSetting(config)).toBeNull();
		});

		it("offers an optional setting only when nothing required remains", () => {
			const optionalOnly = createSetupConfig([], ["TELEGRAM_BOT_TOKEN"]);
			expect(getNextSetting(optionalOnly)?.[0]).toBe("TELEGRAM_BOT_TOKEN");

			const blockedOptional = createSetupConfig([], ["TWITTER_2FA_SECRET"]);
			expect(getNextSetting(blockedOptional)).toBeNull();
		});

		it("skips required settings hidden by their visibleIf without completing setup", () => {
			const config = createSetupConfig(["HIDDEN_REQ"]);
			config.settings.HIDDEN_REQ.visibleIf = () => true;

			expect(getNextSetting(config)).toBeNull();
			expect(isSetupComplete(config)).toBe(false);

			config.settings.HIDDEN_REQ.visibleIf = () => false;
			expect(getNextSetting(config)?.[0]).toBe("HIDDEN_REQ");
		});

		it("renders collection prompts from the setting definition", () => {
			const config = createSetupConfig(["OPENAI_API_KEY"]);
			const setting = {
				...config.settings.OPENAI_API_KEY,
				usageDescription: "your key starts with sk-",
			};

			const prompt = generateSettingPrompt("OPENAI_API_KEY", setting, "Rex");
			expect(prompt).toContain("Rex");
			expect(prompt).toContain("(Required)");
			expect(prompt).toContain("OpenAI API Key");
			expect(prompt).toContain("your key starts with sk-");

			const optionalPrompt = generateSettingPrompt(
				"OPT",
				createSetupConfig([], ["TELEGRAM_BOT_TOKEN"]).settings
					.TELEGRAM_BOT_TOKEN,
				"Rex",
			);
			expect(optionalPrompt).toContain("(Optional)");
		});
	});

	describe("storage", () => {
		const globalCtx = (): SecretContext => ({
			level: "global",
			agentId: "agent-1",
		});

		it("stores, overwrites, lists and deletes scoped entries", async () => {
			const store = new MemorySecretStorage();
			await store.initialize();
			expect(store.storageType).toBe("memory");

			expect(await store.get("KEY", globalCtx())).toBeNull();
			expect(await store.exists("KEY", globalCtx())).toBe(false);
			expect(await store.delete("KEY", globalCtx())).toBe(false);

			expect(
				await store.set("KEY", "v1", globalCtx(), { description: "d" }),
			).toBe(true);
			expect(await store.exists("KEY", globalCtx())).toBe(true);
			expect(await store.get("KEY", globalCtx())).toBe("v1");

			expect(await store.set("KEY", "v2", globalCtx())).toBe(true);
			expect(await store.get("KEY", globalCtx())).toBe("v2");

			const metadata = await store.list(globalCtx());
			expect(metadata.KEY.description).toBe("d");

			expect(await store.delete("KEY", globalCtx())).toBe(true);
			expect(await store.get("KEY", globalCtx())).toBeNull();
		});

		it("keeps global, world and user scopes isolated", async () => {
			const store = new MemorySecretStorage();
			const worldCtx: SecretContext = {
				level: "world",
				agentId: "agent-1",
				worldId: "w1",
			};
			const userCtx = (userId: string): SecretContext => ({
				level: "user",
				agentId: "agent-1",
				userId,
			});

			await store.set("TOKEN", "global-value", globalCtx());
			await store.set("TOKEN", "world-value", worldCtx);
			await store.set("TOKEN", "user-one", userCtx("u1"));
			await store.set("TOKEN", "user-two", userCtx("u2"));

			expect(await store.get("TOKEN", globalCtx())).toBe("global-value");
			expect(await store.get("TOKEN", worldCtx)).toBe("world-value");
			expect(await store.get("TOKEN", userCtx("u1"))).toBe("user-one");
			expect(await store.get("TOKEN", userCtx("u2"))).toBe("user-two");

			const userList = await store.list(userCtx("u1"));
			expect(Object.keys(userList)).toEqual(["TOKEN"]);
			expect(await store.list(globalCtx()).then((m) => Object.keys(m))).toEqual(
				["TOKEN"],
			);
		});

		it("evicts expired entries on read instead of returning them", async () => {
			const store = new MemorySecretStorage();
			await store.set("EPHEMERAL", "stale", globalCtx(), {
				expiresAt: Date.now() - 1000,
			});

			expect(await store.get("EPHEMERAL", globalCtx())).toBeNull();
			expect(await store.exists("EPHEMERAL", globalCtx())).toBe(false);
			expect(store.size()).toBe(0);
		});

		it("updates configuration only for existing entries", async () => {
			const store = new MemorySecretStorage();
			expect(await store.updateConfig("ABSENT", globalCtx(), {})).toBe(false);
			expect(await store.getConfig("ABSENT", globalCtx())).toBeNull();

			await store.set("K", "v", globalCtx());
			expect(
				await store.updateConfig("K", globalCtx(), { required: true }),
			).toBe(true);
			expect((await store.getConfig("K", globalCtx()))?.required).toBe(true);
		});

		it("routes composite operations to the backend owning the context level", async () => {
			const globalStore = new MemorySecretStorage();
			const worldStore = new MemorySecretStorage();
			const userStore = new MemorySecretStorage();
			const composite = new CompositeSecretStorage({
				globalStorage: globalStore,
				worldStorage: worldStore,
				userStorage: userStore,
			});
			await composite.initialize();

			const globalCtx: SecretContext = { level: "global", agentId: "a" };
			const worldCtx: SecretContext = {
				level: "world",
				agentId: "a",
				worldId: "w",
			};
			const userCtx: SecretContext = {
				level: "user",
				agentId: "a",
				userId: "u",
			};

			await composite.set("TOKEN", "from-global", globalCtx);
			await composite.set("TOKEN", "from-world", worldCtx);
			await composite.set("TOKEN", "from-user", userCtx);

			expect(await composite.get("TOKEN", globalCtx)).toBe("from-global");
			expect(await composite.get("TOKEN", worldCtx)).toBe("from-world");
			expect(await composite.get("TOKEN", userCtx)).toBe("from-user");

			expect(await globalStore.get("TOKEN", globalCtx)).toBe("from-global");
			expect(await worldStore.get("TOKEN", globalCtx)).toBeNull();
			expect(await worldStore.get("TOKEN", worldCtx)).toBe("from-world");

			expect(await composite.delete("TOKEN", userCtx)).toBe(true);
			expect(await userStore.get("TOKEN", userCtx)).toBeNull();
			expect(await composite.get("TOKEN", globalCtx)).toBe("from-global");
		});
	});

	describe("action surface", () => {
		it("masks values shorter than nine characters entirely", () => {
			expect(maskSecretValue("short")).toBe("****");
			expect(maskSecretValue("12345678")).toBe("****");
		});

		it("reveals only the first and last four characters, capping the mask", () => {
			expect(maskSecretValue("abcdefghijklmnop")).toBe("abcd********mnop");
			expect(maskSecretValue("sk-abcdef123456")).toBe("sk-a*******3456");
			expect(maskSecretValue("a".repeat(40))).toBe(`aaaa${"*".repeat(20)}aaaa`);
		});
	});

	describe("plugin composition", () => {
		it("assembles the live bindings into the plugin definition", () => {
			expect(secretsManagerPlugin.name).toBe("secrets");
			expect(secretsManagerPlugin.actions).toContain(secretsAction);
			expect(secretsManagerPlugin.actions).toContain(updateSettingsAction);
			expect(secretsManagerPlugin.providers).toContain(secretsStatusProvider);
			expect(secretsManagerPlugin.providers).toContain(missingSecretsProvider);
			expect(secretsManagerPlugin.services).toEqual([
				SecretsService,
				PluginActivatorService,
				SetupService,
			]);
			expect(defaultExport).toBe(secretsManagerPlugin);
		});

		it("binds service classes to their runtime lookup ids", () => {
			expect(SecretsService.serviceType).toBe(SECRETS_SERVICE_TYPE);
			expect(SECRETS_SERVICE_TYPE).toBe("SECRETS");
			expect(PluginActivatorService.serviceType).toBe(
				PLUGIN_ACTIVATOR_SERVICE_TYPE,
			);
			expect(SetupService.serviceType).toBe(SETUP_SERVICE_TYPE);
		});
	});
});
