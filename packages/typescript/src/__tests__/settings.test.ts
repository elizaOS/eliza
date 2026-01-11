// TODO: Try-catch review completed 2026-01-11. No try-catch blocks to review.
// Error handling is via expect().toThrow() patterns.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as entities from "../entities";
import * as logger_module from "../logger";
import {
  clearSaltCache,
  createSettingFromConfig,
  decryptedCharacter,
  decryptObjectValues,
  decryptSecret,
  decryptStringValue,
  encryptedCharacter,
  encryptObjectValues,
  encryptStringValue,
  getSalt,
  getWorldSettings,
  initializeOnboarding,
  saltSettingValue,
  saltWorldSettings,
  unsaltSettingValue,
  unsaltWorldSettings,
  updateWorldSettings,
} from "../settings";
import type {
  Character,
  IAgentRuntime,
  OnboardingConfig,
  Setting,
  UUID,
  World,
  WorldSettings,
} from "../types";
import { getEnvironment } from "../utils/environment";
import { cleanupTestRuntime, createTestRuntime } from "./test-utils";

// Remove global module mocks - they interfere with other tests

describe("settings utilities", () => {
  let runtime: IAgentRuntime;
  let mockWorld: World;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Create REAL runtime
    runtime = await createTestRuntime();

    // Set up scoped mocks for this test
    vi.spyOn(entities, "createUniqueUuid").mockImplementation(
      (_runtime, serverId) => `world-${serverId}` as UUID,
    );

    // Mock logger if it doesn't have the methods
    if (logger_module.logger) {
      const methods = ["error", "info", "warn", "debug"];
      methods.forEach((method) => {
        if (typeof logger_module.logger[method] === "function") {
          vi.spyOn(logger_module.logger, method).mockImplementation(() => {});
        } else {
          logger_module.logger[method] = vi.fn(() => {});
        }
      });
    }

    // Spy on runtime.logger methods
    vi.spyOn(runtime.logger, "error").mockImplementation(() => {});
    vi.spyOn(runtime.logger, "info").mockImplementation(() => {});
    vi.spyOn(runtime.logger, "warn").mockImplementation(() => {});
    vi.spyOn(runtime.logger, "debug").mockImplementation(() => {});

    // Mock process.env
    process.env.SECRET_SALT = "test-salt-value";
    // Clear environment cache after setting env var
    getEnvironment().clearCache();

    mockWorld = {
      id: "world-123" as UUID,
      name: "Test World",
      agentId: runtime.agentId,
      messageServerId: "server-123",
      metadata: {},
      createdAt: Date.now(),
    };
  });

  afterEach(async () => {
    vi.clearAllMocks();
    delete process.env.SECRET_SALT;
    getEnvironment().clearCache(); // Clear cache after cleanup
    await cleanupTestRuntime(runtime);
  });

  describe("createSettingFromConfig", () => {
    it("should create setting with all required fields", () => {
      const cfg = {
        name: "API_KEY",
        description: "API Key for service",
        usageDescription: "",
        required: true,
      };

      const setting = createSettingFromConfig(cfg);

      expect(setting).toEqual({
        name: "API_KEY",
        description: "API Key for service",
        usageDescription: "",
        value: null,
        required: true,
        validation: undefined,
        public: false,
        secret: false,
        dependsOn: [],
        onSetAction: undefined,
        visibleIf: undefined,
      });
    });

    it("should create setting with optional fields", () => {
      const validationFn = (value: string | boolean | null) => {
        if (typeof value === "string") {
          return /^[A-Z0-9]+$/.test(value);
        }
        return false;
      };
      const onSetActionFn = (_value: string | boolean | null) => "restart";
      const cfg = {
        name: "API_KEY",
        description: "API Key for service",
        usageDescription: "Enter your API key",
        required: false,
        validation: validationFn,
        public: true,
        secret: true,
        dependsOn: ["OTHER_SETTING"],
        onSetAction: onSetActionFn,
        visibleIf: (settings: Record<string, Setting>) => {
          const otherSetting = settings.OTHER_SETTING;
          return otherSetting?.value === "enabled";
        },
      };

      const setting = createSettingFromConfig(cfg);

      expect(setting.usageDescription).toBe("Enter your API key");
      expect(setting.validation).toBe(validationFn);
      expect(setting.public).toBe(true);
      expect(setting.secret).toBe(true);
      expect(setting.dependsOn).toEqual(["OTHER_SETTING"]);
      expect(setting.onSetAction).toBe(onSetActionFn);
      expect(setting.visibleIf).toBeInstanceOf(Function);
      expect(
        setting.visibleIf?.({
          OTHER_SETTING: {
            name: "OTHER_SETTING",
            description: "Other setting",
            usageDescription: "Other setting description",
            value: "enabled",
            required: true,
            secret: false,
          },
        }),
      ).toBe(true);
      expect(
        setting.visibleIf?.({
          OTHER_SETTING: {
            name: "OTHER_SETTING",
            description: "Other setting",
            usageDescription: "Other setting description",
            value: "disabled",
            required: true,
            secret: false,
          },
        }),
      ).toBe(false);
    });
  });

  describe("getSalt", () => {
    it("should return salt from environment variable", () => {
      const salt = getSalt();
      expect(salt).toBe("test-salt-value");
    });

    it("should use default salt when env variable is not set", () => {
      delete process.env.SECRET_SALT;
      getEnvironment().clearCache(); // Clear cache after deleting env var
      clearSaltCache(); // Clear salt cache to ensure fresh read
      const salt = getSalt();
      expect(salt).toBe("secretsalt");
    });

    it("should work with getSalt called multiple times", () => {
      // Test that getSalt returns consistent results across multiple calls
      const salt1 = getSalt();
      const salt2 = getSalt();
      expect(salt1).toBe(salt2);
      expect(typeof salt1).toBe("string");
      expect(salt1.length).toBeGreaterThan(0);
    });
  });

  describe("encryptStringValue", () => {
    const salt = "test-salt";

    it("should encrypt a string value", () => {
      const encrypted = encryptStringValue("secret-value", salt);

      expect(encrypted).not.toBe("secret-value");
      expect(encrypted).toContain(":"); // Should have iv:encrypted format
    });

    it("should return undefined/null values as is", () => {
      // Intentionally testing with invalid types to verify runtime handling
      expect(
        encryptStringValue(undefined as unknown as string, salt),
      ).toBeUndefined();
      expect(encryptStringValue(null as unknown as string, salt)).toBeNull();
    });

    it("should return boolean values as is", () => {
      // Intentionally testing with invalid types to verify runtime handling
      expect(encryptStringValue(true as unknown as string, salt)).toBe(true);
      expect(encryptStringValue(false as unknown as string, salt)).toBe(false);
    });

    it("should return number values as is", () => {
      // Intentionally testing with invalid types to verify runtime handling
      expect(encryptStringValue(123 as unknown as string, salt)).toBe(123);
      expect(encryptStringValue(0 as unknown as string, salt)).toBe(0);
    });

    it("should return non-string objects as is", () => {
      // Intentionally testing with invalid types to verify runtime handling
      const obj = { key: "value" };
      expect(encryptStringValue(obj as unknown as string, salt)).toBe(obj);
    });

    it("should not re-encrypt already encrypted values", () => {
      const encrypted = encryptStringValue("secret", salt);
      const doubleEncrypted = encryptStringValue(encrypted, salt);

      expect(doubleEncrypted).toBe(encrypted);
    });

    it("should encrypt values that look like encrypted format but have invalid IV", () => {
      const fakeEncrypted = "invalid:value";
      const encrypted = encryptStringValue(fakeEncrypted, salt);

      expect(encrypted).not.toBe(fakeEncrypted);
      expect(encrypted.split(":").length).toBe(2);
    });

    it("should handle values with colons that are not hex (e.g., URLs)", () => {
      // This is a regression test - BufferUtils.fromHex throws on non-hex strings
      // Without try/catch, this would crash
      const postgresUrl = "postgres://user:password@localhost:5432/db";
      const encrypted = encryptStringValue(postgresUrl, salt);

      expect(encrypted).not.toBe(postgresUrl);
      expect(encrypted).toContain(":");

      // Verify it can be decrypted back
      const decrypted = decryptStringValue(encrypted, salt);
      expect(decrypted).toBe(postgresUrl);
    });

    it("should handle connection strings with multiple colons", () => {
      const connectionString =
        "mongodb://admin:secret123@host1:27017,host2:27017/mydb";
      const encrypted = encryptStringValue(connectionString, salt);

      expect(encrypted).not.toBe(connectionString);

      const decrypted = decryptStringValue(encrypted, salt);
      expect(decrypted).toBe(connectionString);
    });
  });

  describe("decryptStringValue", () => {
    const salt = "test-salt";

    it("should decrypt an encrypted value", () => {
      const original = "secret-value";
      const encrypted = encryptStringValue(original, salt);
      const decrypted = decryptStringValue(encrypted, salt);

      expect(decrypted).toBe(original);
    });

    it("should return undefined/null values as is", () => {
      // Intentionally testing with invalid types to verify runtime handling
      expect(
        decryptStringValue(undefined as unknown as string, salt),
      ).toBeUndefined();
      expect(decryptStringValue(null as unknown as string, salt)).toBeNull();
    });

    it("should return boolean values as is", () => {
      // Intentionally testing with invalid types to verify runtime handling
      expect(decryptStringValue(true as unknown as string, salt)).toBe(true);
      expect(decryptStringValue(false as unknown as string, salt)).toBe(false);
    });

    it("should return number values as is", () => {
      // Intentionally testing with invalid types to verify runtime handling
      expect(decryptStringValue(123 as unknown as string, salt)).toBe(123);
    });

    it("should return non-string objects as is", () => {
      // Intentionally testing with invalid types to verify runtime handling
      const obj = { key: "value" };
      expect(decryptStringValue(obj as unknown as string, salt)).toBe(obj);
    });

    it("should return original value if not in encrypted format", () => {
      const plainValue = "not-encrypted";
      expect(decryptStringValue(plainValue, salt)).toBe(plainValue);
    });

    it("should return original value if IV length is invalid", () => {
      const invalidFormat = "shortiv:encrypted";
      expect(decryptStringValue(invalidFormat, salt)).toBe(invalidFormat);
    });

    it("should return original value on decryption error", () => {
      const invalidEncrypted = "0123456789abcdef0123456789abcdef:invalidhex";
      const result = decryptStringValue(invalidEncrypted, salt);
      expect(result).toBe(invalidEncrypted);
    });

    it("should handle empty IV gracefully", () => {
      const emptyIv = ":encrypted";
      expect(decryptStringValue(emptyIv, salt)).toBe(emptyIv);
    });
  });

  describe("saltSettingValue", () => {
    const salt = "test-salt";

    it("should encrypt secret string settings", () => {
      const setting: Setting = {
        name: "API_KEY",
        description: "API Key",
        usageDescription: "Enter API key",
        value: "my-secret-key",
        secret: true,
        required: true,
      };

      const salted = saltSettingValue(setting, salt);

      expect(salted.value).not.toBe("my-secret-key");
      expect(salted.value).toContain(":");
    });

    it("should not encrypt non-secret settings", () => {
      const setting: Setting = {
        name: "PUBLIC_URL",
        description: "Public URL",
        usageDescription: "Enter public URL",
        value: "https://example.com",
        secret: false,
        required: true,
      };

      const salted = saltSettingValue(setting, salt);

      expect(salted.value).toBe("https://example.com");
    });

    it("should not encrypt non-string values", () => {
      const setting: Setting = {
        name: "ENABLED",
        description: "Feature enabled",
        usageDescription: "Enable feature",
        value: true,
        secret: true,
        required: true,
      };

      const salted = saltSettingValue(setting, salt);

      expect(salted.value).toBe(true);
    });

    it("should not encrypt empty string values", () => {
      const setting: Setting = {
        name: "API_KEY",
        description: "API Key",
        usageDescription: "Enter API key",
        value: "",
        secret: true,
        required: false,
      };

      const salted = saltSettingValue(setting, salt);

      expect(salted.value).toBe("");
    });
  });

  describe("unsaltSettingValue", () => {
    const salt = "test-salt";

    it("should decrypt secret string settings", () => {
      const original = "my-secret-key";
      const encrypted = encryptStringValue(original, salt);
      const setting: Setting = {
        name: "API_KEY",
        description: "API Key",
        usageDescription: "Enter API key",
        value: encrypted,
        secret: true,
        required: true,
      };

      const unsalted = unsaltSettingValue(setting, salt);

      expect(unsalted.value).toBe(original);
    });

    it("should not decrypt non-secret settings", () => {
      const setting: Setting = {
        name: "PUBLIC_URL",
        description: "Public URL",
        usageDescription: "Enter public URL",
        value: "https://example.com",
        secret: false,
        required: true,
      };

      const unsalted = unsaltSettingValue(setting, salt);

      expect(unsalted.value).toBe("https://example.com");
    });
  });

  describe("saltWorldSettings", () => {
    const salt = "test-salt";

    it("should salt all secret settings in world settings", () => {
      const worldSettings: WorldSettings = {
        API_KEY: {
          name: "API_KEY",
          description: "API Key",
          usageDescription: "Enter API key",
          value: "secret1",
          secret: true,
          required: true,
        },
        DB_PASSWORD: {
          name: "DB_PASSWORD",
          description: "Database Password",
          usageDescription: "Enter database password",
          value: "secret2",
          secret: true,
          required: true,
        },
        PUBLIC_URL: {
          name: "PUBLIC_URL",
          description: "Public URL",
          usageDescription: "Enter public URL",
          value: "https://example.com",
          secret: false,
          required: true,
        },
      };

      const salted = saltWorldSettings(worldSettings, salt);

      expect(salted.API_KEY.value).not.toBe("secret1");
      expect(salted.API_KEY.value).toContain(":");
      expect(salted.DB_PASSWORD.value).not.toBe("secret2");
      expect(salted.DB_PASSWORD.value).toContain(":");
      expect(salted.PUBLIC_URL.value).toBe("https://example.com");
    });
  });

  describe("unsaltWorldSettings", () => {
    const salt = "test-salt";

    it("should unsalt all secret settings in world settings", () => {
      const encrypted1 = encryptStringValue("secret1", salt);
      const encrypted2 = encryptStringValue("secret2", salt);

      const worldSettings: WorldSettings = {
        API_KEY: {
          name: "API_KEY",
          description: "API Key",
          usageDescription: "Enter your API key",
          value: encrypted1,
          secret: true,
          required: true,
        },
        DB_PASSWORD: {
          name: "DB_PASSWORD",
          description: "Database Password",
          usageDescription: "Enter your database password",
          value: encrypted2,
          secret: true,
          required: true,
        },
      };

      const unsalted = unsaltWorldSettings(worldSettings, salt);

      expect(unsalted.API_KEY.value).toBe("secret1");
      expect(unsalted.DB_PASSWORD.value).toBe("secret2");
    });
  });

  describe("updateWorldSettings", () => {
    it("should update world settings successfully", async () => {
      const worldSettings: WorldSettings = {
        API_KEY: {
          name: "API_KEY",
          description: "API Key",
          usageDescription: "Enter your API key",
          value: "secret-key",
          secret: true,
          required: true,
        },
      };

      vi.spyOn(runtime, "getWorld").mockResolvedValue(mockWorld);
      vi.spyOn(runtime, "updateWorld").mockResolvedValue(undefined);

      const result = await updateWorldSettings(
        runtime,
        "server-123",
        worldSettings,
      );

      expect(result).toBe(true);
      expect(runtime.updateWorld).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            settings: expect.any(Object),
          }),
        }),
      );
    });

    it("should return false when world not found", async () => {
      vi.spyOn(runtime, "getWorld").mockResolvedValue(null);

      const result = await updateWorldSettings(runtime, "server-123", {});

      expect(result).toBe(false);
      expect(runtime.updateWorld).not.toHaveBeenCalled();
    });

    it("should initialize metadata if it does not exist", async () => {
      const worldWithoutMetadata = { ...mockWorld, metadata: undefined };
      vi.spyOn(runtime, "getWorld").mockResolvedValue(worldWithoutMetadata);
      vi.spyOn(runtime, "updateWorld").mockResolvedValue(undefined);

      const result = await updateWorldSettings(runtime, "server-123", {});

      expect(result).toBe(true);
      expect(runtime.updateWorld).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            settings: {},
          }),
        }),
      );
    });
  });

  describe("getWorldSettings", () => {
    it("should get and unsalt world settings", async () => {
      const salt = getSalt();
      const encrypted = encryptStringValue("secret-value", salt);

      mockWorld.metadata = {
        settings: {
          API_KEY: {
            name: "API_KEY",
            description: "API Key",
            usageDescription: "Enter your API key",
            value: encrypted,
            secret: true,
            required: true,
          },
        },
      };

      vi.spyOn(runtime, "getWorld").mockResolvedValue(mockWorld);

      const result = await getWorldSettings(runtime, "server-123");

      expect(result).not.toBeNull();
      const resultApiKey = result?.API_KEY;
      expect(resultApiKey?.value).toBe("secret-value");
    });

    it("should return null when world not found", async () => {
      vi.spyOn(runtime, "getWorld").mockResolvedValue(null);

      const result = await getWorldSettings(runtime, "server-123");

      expect(result).toBeNull();
    });

    it("should return null when world has no settings", async () => {
      vi.spyOn(runtime, "getWorld").mockResolvedValue(mockWorld);

      const result = await getWorldSettings(runtime, "server-123");

      expect(result).toBeNull();
    });
  });

  describe("initializeOnboarding", () => {
    it("should initialize settings from config", async () => {
      const config: OnboardingConfig = {
        settings: {
          API_KEY: {
            name: "API_KEY",
            description: "API Key",
            usageDescription: "Enter your API key",
            required: true,
            secret: true,
          },
          PUBLIC_URL: {
            name: "PUBLIC_URL",
            description: "Public URL",
            usageDescription: "Enter your public URL",
            required: false,
            secret: false,
          },
        },
      };

      vi.spyOn(runtime, "updateWorld").mockResolvedValue(undefined);

      const result = await initializeOnboarding(runtime, mockWorld, config);

      expect(result).not.toBeNull();
      const resultApiKey = result?.API_KEY;
      expect(resultApiKey).toBeDefined();
      expect(resultApiKey?.value).toBeNull();
      expect(resultApiKey?.secret).toBe(true);
      const resultPublicUrl = result?.PUBLIC_URL;
      expect(resultPublicUrl).toBeDefined();
      expect(resultPublicUrl?.secret).toBe(false);
    });

    it("should return existing settings if already initialized", async () => {
      const salt = getSalt();
      const encrypted = encryptStringValue("existing-secret", salt);

      mockWorld.metadata = {
        settings: {
          API_KEY: {
            name: "API_KEY",
            description: "API Key",
            usageDescription: "Enter your API key",
            value: encrypted,
            secret: true,
            required: true,
          },
        },
      };

      const config: OnboardingConfig = {
        settings: {
          NEW_KEY: {
            name: "NEW_KEY",
            description: "New Key",
            usageDescription: "Enter new key",
            required: true,
          },
        },
      };

      const result = await initializeOnboarding(runtime, mockWorld, config);

      expect(result).not.toBeNull();
      const resultApiKey = result?.API_KEY;
      expect(resultApiKey).toBeDefined();
      expect(resultApiKey?.value).toBe("existing-secret");
      expect(result?.NEW_KEY).toBeUndefined(); // Should not add new settings
    });

    it("should handle config without settings", async () => {
      const config: OnboardingConfig = { settings: {} };

      vi.spyOn(runtime, "updateWorld").mockResolvedValue(undefined);

      const result = await initializeOnboarding(runtime, mockWorld, config);

      expect(result).toEqual({});
      expect(runtime.updateWorld).toHaveBeenCalled();
    });
  });

  describe("encryptedCharacter", () => {
    it("should encrypt character settings.secrets", () => {
      const character: Character = {
        id: "char-123" as UUID,
        name: "Test Character",
        bio: "Test character bio",
        settings: {
          secrets: {
            API_KEY: "secret-api-key",
            PASSWORD: "secret-password",
          },
        },
      };

      const encrypted = encryptedCharacter(character);

      const encryptedSettings = encrypted.settings;
      const encryptedSettingsSecrets = encryptedSettings?.secrets;
      expect(encryptedSettingsSecrets?.API_KEY).not.toBe("secret-api-key");
      expect(encryptedSettingsSecrets?.API_KEY).toContain(":");
      expect(encryptedSettingsSecrets?.PASSWORD).not.toBe("secret-password");
      expect(encryptedSettingsSecrets?.PASSWORD).toContain(":");
    });

    it("should encrypt character.secrets", () => {
      const character: Character = {
        id: "char-123" as UUID,
        name: "Test Character",
        bio: "Test character bio",
        secrets: {
          TOKEN: "secret-token",
          KEY: "secret-key",
        },
      };

      const encrypted = encryptedCharacter(character);

      const encryptedSecrets = encrypted.secrets;
      expect(encryptedSecrets?.TOKEN).not.toBe("secret-token");
      expect(encryptedSecrets?.TOKEN).toContain(":");
      expect(encryptedSecrets?.KEY).not.toBe("secret-key");
      expect(encryptedSecrets?.KEY).toContain(":");
    });

    it("should handle character without secrets", () => {
      const character: Character = {
        id: "char-123" as UUID,
        name: "Test Character",
        bio: "Test character bio",
      };

      const encrypted = encryptedCharacter(character);

      expect(encrypted).toEqual(character);
    });

    it("should not modify original character", () => {
      const character: Character = {
        id: "char-123" as UUID,
        name: "Test Character",
        bio: "Test character bio",
        secrets: {
          TOKEN: "secret-token",
        },
      };

      const encrypted = encryptedCharacter(character);

      const characterSecrets = character.secrets;
      expect(characterSecrets?.TOKEN).toBe("secret-token");
      const encryptedSecrets = encrypted.secrets;
      expect(encryptedSecrets?.TOKEN).not.toBe("secret-token");
    });
  });

  describe("decryptedCharacter", () => {
    it("should decrypt character settings.secrets", () => {
      const salt = getSalt();
      const character: Character = {
        id: "char-123" as UUID,
        name: "Test Character",
        bio: "Test character bio",
        settings: {
          secrets: {
            API_KEY: encryptStringValue("secret-api-key", salt),
            PASSWORD: encryptStringValue("secret-password", salt),
          },
        },
      };

      const decrypted = decryptedCharacter(character, runtime);

      const decryptedSettings = decrypted.settings;
      const decryptedSettingsSecrets = decryptedSettings?.secrets;
      expect(decryptedSettingsSecrets?.API_KEY).toBe("secret-api-key");
      expect(decryptedSettingsSecrets?.PASSWORD).toBe("secret-password");
    });

    it("should decrypt character.secrets", () => {
      const salt = getSalt();
      const character: Character = {
        id: "char-123" as UUID,
        name: "Test Character",
        bio: "Test character bio",
        secrets: {
          TOKEN: encryptStringValue("secret-token", salt),
          KEY: encryptStringValue("secret-key", salt),
        },
      };

      const decrypted = decryptedCharacter(character, runtime);

      const decryptedSecrets = decrypted.secrets;
      expect(decryptedSecrets?.TOKEN).toBe("secret-token");
      expect(decryptedSecrets?.KEY).toBe("secret-key");
    });

    it("should handle character without secrets", () => {
      const character: Character = {
        id: "char-123" as UUID,
        name: "Test Character",
        bio: "Test character bio",
      };

      const decrypted = decryptedCharacter(character, runtime);

      expect(decrypted).toEqual(character);
    });
  });

  describe("encryptObjectValues", () => {
    const salt = "test-salt";

    it("should encrypt all string values in object", () => {
      const obj = {
        key1: "value1",
        key2: "value2",
        key3: 123,
        key4: true,
        key5: null,
        key6: "",
      };

      const encrypted = encryptObjectValues(obj, salt);

      expect(encrypted.key1).not.toBe("value1");
      expect(encrypted.key1).toContain(":");
      expect(encrypted.key2).not.toBe("value2");
      expect(encrypted.key2).toContain(":");
      expect(encrypted.key3).toBe(123);
      expect(encrypted.key4).toBe(true);
      expect(encrypted.key5).toBeNull();
      expect(encrypted.key6).toBe(""); // Empty strings are not encrypted
    });
  });

  describe("decryptObjectValues", () => {
    const salt = "test-salt";

    it("should decrypt all string values in object", () => {
      const obj = {
        key1: encryptStringValue("value1", salt),
        key2: encryptStringValue("value2", salt),
        key3: 123,
        key4: true,
      };

      const decrypted = decryptObjectValues(obj, salt);

      expect(decrypted.key1).toBe("value1");
      expect(decrypted.key2).toBe("value2");
      expect(decrypted.key3).toBe(123);
      expect(decrypted.key4).toBe(true);
    });
  });

  describe("decryptSecret alias", () => {
    it("should be an alias for decryptStringValue", () => {
      expect(decryptSecret).toBe(decryptStringValue);
    });
  });

  describe("Character settings merge with complex objects", () => {
    it("should handle complex character settings without corrupting them during .env merge", async () => {
      const { setDefaultSecretsFromEnv } = await import("../secrets");
      const { loadEnvFile } = await import("../utils/environment");
      const fs = await import("node:fs");
      const path = await import("node:path");
      const os = await import("node:os");

      const testDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "settings-complex-test-"),
      );
      const originalCwd = process.cwd();

      // Track keys we add to process.env for cleanup
      const testEnvKeys = new Set<string>();

      try {
        process.chdir(testDir);

        const envContent = `SIMPLE_KEY=simple-value
ANOTHER_KEY=another-value`;
        fs.writeFileSync(path.join(testDir, ".env"), envContent);

        // Load .env file into process.env
        loadEnvFile(path.join(testDir, ".env"));
        testEnvKeys.add("SIMPLE_KEY");
        testEnvKeys.add("ANOTHER_KEY");

        const character: Character = {
          name: "TestChar",
          bio: ["Test bio"],
          settings: {
            discord: {
              shouldIgnoreBotMessages: true,
              allowedChannelIds: ["123", "456"],
            },
            telegram: {
              botToken: "bot-token",
            },
            SIMPLE_KEY: "character-override", // Override .env
          },
        };

        await setDefaultSecretsFromEnv(character, { skipEnvMerge: false });

        // Verify complex objects are preserved
        const characterSettings = character.settings;
        expect(characterSettings?.discord).toEqual({
          shouldIgnoreBotMessages: true,
          allowedChannelIds: ["123", "456"],
        });
        expect(characterSettings?.telegram).toEqual({
          botToken: "bot-token",
        });

        // Verify existing settings root values are preserved
        expect(characterSettings?.SIMPLE_KEY).toBe("character-override");

        // Verify .env values are NOT merged into settings root (no duplication)
        expect(characterSettings?.ANOTHER_KEY).toBeUndefined();

        // Verify .env values are merged into settings.secrets
        const characterSettingsSecrets =
          characterSettings &&
          (characterSettings.secrets as Record<string, string>);
        expect(characterSettingsSecrets?.SIMPLE_KEY).toBe("simple-value");
        expect(characterSettingsSecrets?.ANOTHER_KEY).toBe("another-value");
      } finally {
        process.chdir(originalCwd);
        fs.rmSync(testDir, { recursive: true, force: true });

        // Clean up test environment variables
        for (const key of testEnvKeys) {
          delete process.env[key];
        }
      }
    });
  });
});
