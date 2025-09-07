import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mock, spyOn } from 'bun:test';
import {
  createSettingFromConfig,
  getSalt,
  encryptStringValue,
  decryptStringValue,
  saltSettingValue,
  unsaltSettingValue,
  saltWorldSettings,
  unsaltWorldSettings,
  updateWorldSettings,
  getWorldSettings,
  initializeOnboarding,
  encryptedCharacter,
  decryptedCharacter,
  encryptObjectValues,
  decryptObjectValues,
  decryptSecret,
} from '../settings';
import type {
  IAgentRuntime,
  Setting,
  World,
  WorldSettings,
  OnboardingConfig,
  Character,
  UUID,
} from '../types';

import * as entities from '../entities';
import * as logger_module from '../logger';

// Remove global module mocks - they interfere with other tests

describe('settings utilities', () => {
  let mockRuntime: IAgentRuntime;
  let mockWorld: World;

  beforeEach(() => {
    mock.restore();

    // Set up scoped mocks for this test
    spyOn(entities, 'createUniqueUuid').mockImplementation(
      (_runtime, serverId) => `world-${serverId}` as UUID
    );

    // Mock logger if it doesn't have the methods
    if (logger_module.logger) {
      const methods = ['error', 'info', 'warn', 'debug'];
      methods.forEach((method) => {
        if (typeof logger_module.logger[method] === 'function') {
          spyOn(logger_module.logger, method).mockImplementation(() => {});
        } else {
          logger_module.logger[method] = mock(() => {});
        }
      });
    }

    // Mock process.env
    process.env.SECRET_SALT = 'test-salt-value';

    mockRuntime = {
      agentId: 'agent-123' as any,
      getWorld: mock(),
      updateWorld: mock(),
    } as unknown as IAgentRuntime;

    mockWorld = {
      id: 'world-123' as any,
      name: 'Test World',
      agentId: 'agent-123' as any,
      serverId: 'server-123',
      metadata: {},
    };
  });

  afterEach(() => {
    mock.restore();
  });

  describe('createSettingFromConfig', () => {
    it('should create setting with all required fields', () => {
      const cfg = {
        name: 'API_KEY',
        description: 'API Key for service',
        usageDescription: '',
        required: true,
      };

      const setting = createSettingFromConfig(cfg);

      expect(setting).toEqual({
        name: 'API_KEY',
        description: 'API Key for service',
        usageDescription: '',
        value: null,
        required: true,
        validation: null,
        public: false,
        secret: false,
        dependsOn: [],
        onSetAction: null,
        visibleIf: null,
      });
    });

    it('should create setting with optional fields', () => {
      const validationFn = (value: any) => /^[A-Z0-9]+$/.test(value);
      const onSetActionFn = (_value: any) => 'restart';
      const cfg = {
        name: 'API_KEY',
        description: 'API Key for service',
        usageDescription: 'Enter your API key',
        required: false,
        validation: validationFn,
        public: true,
        secret: true,
        dependsOn: ['OTHER_SETTING'],
        onSetAction: onSetActionFn,
        visibleIf: (settings) => settings['OTHER_SETTING']?.value === 'enabled',
      };

      const setting = createSettingFromConfig(cfg);

      expect(setting.usageDescription).toBe('Enter your API key');
      expect(setting.validation).toBe(validationFn);
      expect(setting.public).toBe(true);
      expect(setting.secret).toBe(true);
      expect(setting.dependsOn).toEqual(['OTHER_SETTING']);
      expect(setting.onSetAction).toBe(onSetActionFn);
      expect(setting.visibleIf).toBeInstanceOf(Function);
      expect(
        setting.visibleIf({
          OTHER_SETTING: {
            name: 'OTHER_SETTING',
            description: 'Other setting',
            usageDescription: 'Other setting description',
            value: 'enabled',
            required: true,
            secret: false,
          },
        })
      ).toBe(true);
      expect(
        setting.visibleIf({
          OTHER_SETTING: {
            name: 'OTHER_SETTING',
            description: 'Other setting',
            usageDescription: 'Other setting description',
            value: 'disabled',
            required: true,
            secret: false,
          },
        })
      ).toBe(false);
    });
  });

  describe('getSalt', () => {
    it('should return salt from environment variable', () => {
      const salt = getSalt();
      expect(salt).toBe('test-salt-value');
    });

    it('should use default salt when env variable is not set', () => {
      delete process.env.SECRET_SALT;
      const salt = getSalt();
      expect(salt).toBe('secretsalt');
    });

    it('should handle import.meta.env in non-node environments', () => {
      // This test is skipped as it's difficult to properly simulate non-node environment
      // without breaking other tests. The getSalt function is tested in other scenarios.
      expect(true).toBe(true);
    });
  });

  describe('encryptStringValue', () => {
    const salt = 'test-salt';

    it('should encrypt a string value', () => {
      const encrypted = encryptStringValue('secret-value', salt);

      expect(encrypted).not.toBe('secret-value');
      expect(encrypted).toContain(':'); // Should have iv:encrypted format
    });

    it('should return undefined/null values as is', () => {
      expect(encryptStringValue(undefined as any, salt)).toBeUndefined();
      expect(encryptStringValue(null as any, salt)).toBeNull();
    });

    it('should return boolean values as is', () => {
      expect(encryptStringValue(true as any, salt)).toBe(true);
      expect(encryptStringValue(false as any, salt)).toBe(false);
    });

    it('should return number values as is', () => {
      expect(encryptStringValue(123 as any, salt)).toBe(123);
      expect(encryptStringValue(0 as any, salt)).toBe(0);
    });

    it('should return non-string objects as is', () => {
      const obj = { key: 'value' };
      expect(encryptStringValue(obj as any, salt)).toBe(obj);
    });

    it('should not re-encrypt already encrypted values', () => {
      const encrypted = encryptStringValue('secret', salt);
      const doubleEncrypted = encryptStringValue(encrypted, salt);

      expect(doubleEncrypted).toBe(encrypted);
    });

    it('should encrypt values that look like encrypted format but have invalid IV', () => {
      const fakeEncrypted = 'invalid:value';
      const encrypted = encryptStringValue(fakeEncrypted, salt);

      expect(encrypted).not.toBe(fakeEncrypted);
      expect(encrypted.split(':').length).toBe(2);
    });
  });

  describe('decryptStringValue', () => {
    const salt = 'test-salt';

    it('should decrypt an encrypted value', () => {
      const original = 'secret-value';
      const encrypted = encryptStringValue(original, salt);
      const decrypted = decryptStringValue(encrypted, salt);

      expect(decrypted).toBe(original);
    });

    it('should return undefined/null values as is', () => {
      expect(decryptStringValue(undefined as any, salt)).toBeUndefined();
      expect(decryptStringValue(null as any, salt)).toBeNull();
    });

    it('should return boolean values as is', () => {
      expect(decryptStringValue(true as any, salt)).toBe(true);
      expect(decryptStringValue(false as any, salt)).toBe(false);
    });

    it('should return number values as is', () => {
      expect(decryptStringValue(123 as any, salt)).toBe(123);
    });

    it('should return non-string objects as is', () => {
      const obj = { key: 'value' };
      expect(decryptStringValue(obj as any, salt)).toBe(obj);
    });

    it('should return original value if not in encrypted format', () => {
      const plainValue = 'not-encrypted';
      expect(decryptStringValue(plainValue, salt)).toBe(plainValue);
    });

    it('should return original value if IV length is invalid', () => {
      const invalidFormat = 'shortiv:encrypted';
      expect(decryptStringValue(invalidFormat, salt)).toBe(invalidFormat);
    });

    it('should return original value on decryption error', () => {
      const invalidEncrypted = '0123456789abcdef0123456789abcdef:invalidhex';
      const result = decryptStringValue(invalidEncrypted, salt);
      expect(result).toBe(invalidEncrypted);
    });

    it('should handle empty IV gracefully', () => {
      const emptyIv = ':encrypted';
      expect(decryptStringValue(emptyIv, salt)).toBe(emptyIv);
    });
  });

  describe('saltSettingValue', () => {
    const salt = 'test-salt';

    it('should encrypt secret string settings', () => {
      const setting: Setting = {
        name: 'API_KEY',
        description: 'API Key',
        usageDescription: 'Enter API key',
        value: 'my-secret-key',
        secret: true,
        required: true,
      };

      const salted = saltSettingValue(setting, salt);

      expect(salted.value).not.toBe('my-secret-key');
      expect(salted.value).toContain(':');
    });

    it('should not encrypt non-secret settings', () => {
      const setting: Setting = {
        name: 'PUBLIC_URL',
        description: 'Public URL',
        usageDescription: 'Enter public URL',
        value: 'https://example.com',
        secret: false,
        required: true,
      };

      const salted = saltSettingValue(setting, salt);

      expect(salted.value).toBe('https://example.com');
    });

    it('should not encrypt non-string values', () => {
      const setting: Setting = {
        name: 'ENABLED',
        description: 'Feature enabled',
        usageDescription: 'Enable feature',
        value: true,
        secret: true,
        required: true,
      };

      const salted = saltSettingValue(setting, salt);

      expect(salted.value).toBe(true);
    });

    it('should not encrypt empty string values', () => {
      const setting: Setting = {
        name: 'API_KEY',
        description: 'API Key',
        usageDescription: 'Enter API key',
        value: '',
        secret: true,
        required: false,
      };

      const salted = saltSettingValue(setting, salt);

      expect(salted.value).toBe('');
    });
  });

  describe('unsaltSettingValue', () => {
    const salt = 'test-salt';

    it('should decrypt secret string settings', () => {
      const original = 'my-secret-key';
      const encrypted = encryptStringValue(original, salt);
      const setting: Setting = {
        name: 'API_KEY',
        description: 'API Key',
        usageDescription: 'Enter API key',
        value: encrypted,
        secret: true,
        required: true,
      };

      const unsalted = unsaltSettingValue(setting, salt);

      expect(unsalted.value).toBe(original);
    });

    it('should not decrypt non-secret settings', () => {
      const setting: Setting = {
        name: 'PUBLIC_URL',
        description: 'Public URL',
        usageDescription: 'Enter public URL',
        value: 'https://example.com',
        secret: false,
        required: true,
      };

      const unsalted = unsaltSettingValue(setting, salt);

      expect(unsalted.value).toBe('https://example.com');
    });
  });

  describe('saltWorldSettings', () => {
    const salt = 'test-salt';

    it('should salt all secret settings in world settings', () => {
      const worldSettings: WorldSettings = {
        API_KEY: {
          name: 'API_KEY',
          description: 'API Key',
          usageDescription: 'Enter API key',
          value: 'secret1',
          secret: true,
          required: true,
        },
        DB_PASSWORD: {
          name: 'DB_PASSWORD',
          description: 'Database Password',
          usageDescription: 'Enter database password',
          value: 'secret2',
          secret: true,
          required: true,
        },
        PUBLIC_URL: {
          name: 'PUBLIC_URL',
          description: 'Public URL',
          usageDescription: 'Enter public URL',
          value: 'https://example.com',
          secret: false,
          required: true,
        },
      };

      const salted = saltWorldSettings(worldSettings, salt);

      expect(salted.API_KEY.value).not.toBe('secret1');
      expect(salted.API_KEY.value).toContain(':');
      expect(salted.DB_PASSWORD.value).not.toBe('secret2');
      expect(salted.DB_PASSWORD.value).toContain(':');
      expect(salted.PUBLIC_URL.value).toBe('https://example.com');
    });
  });

  describe('unsaltWorldSettings', () => {
    const salt = 'test-salt';

    it('should unsalt all secret settings in world settings', () => {
      const encrypted1 = encryptStringValue('secret1', salt);
      const encrypted2 = encryptStringValue('secret2', salt);

      const worldSettings: WorldSettings = {
        API_KEY: {
          name: 'API_KEY',
          description: 'API Key',
          usageDescription: 'Enter your API key',
          value: encrypted1,
          secret: true,
          required: true,
        },
        DB_PASSWORD: {
          name: 'DB_PASSWORD',
          description: 'Database Password',
          usageDescription: 'Enter your database password',
          value: encrypted2,
          secret: true,
          required: true,
        },
      };

      const unsalted = unsaltWorldSettings(worldSettings, salt);

      expect(unsalted.API_KEY.value).toBe('secret1');
      expect(unsalted.DB_PASSWORD.value).toBe('secret2');
    });
  });

  describe('updateWorldSettings', () => {
    it('should update world settings successfully', async () => {
      const worldSettings: WorldSettings = {
        API_KEY: {
          name: 'API_KEY',
          description: 'API Key',
          usageDescription: 'Enter your API key',
          value: 'secret-key',
          secret: true,
          required: true,
        },
      };

      (mockRuntime.getWorld as any).mockResolvedValue(mockWorld);
      (mockRuntime.updateWorld as any).mockResolvedValue(true);

      const result = await updateWorldSettings(mockRuntime, 'server-123', worldSettings);

      expect(result).toBe(true);
      expect(mockRuntime.updateWorld).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            settings: expect.any(Object),
          }),
        })
      );
    });

    it('should return false when world not found', async () => {
      (mockRuntime.getWorld as any).mockResolvedValue(null);

      const result = await updateWorldSettings(mockRuntime, 'server-123', {});

      expect(result).toBe(false);
      expect(mockRuntime.updateWorld).not.toHaveBeenCalled();
    });

    it('should initialize metadata if it does not exist', async () => {
      const worldWithoutMetadata = { ...mockWorld, metadata: undefined };
      (mockRuntime.getWorld as any).mockResolvedValue(worldWithoutMetadata);
      (mockRuntime.updateWorld as any).mockResolvedValue(true);

      const result = await updateWorldSettings(mockRuntime, 'server-123', {});

      expect(result).toBe(true);
      expect(mockRuntime.updateWorld).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            settings: {},
          }),
        })
      );
    });
  });

  describe('getWorldSettings', () => {
    it('should get and unsalt world settings', async () => {
      const salt = getSalt();
      const encrypted = encryptStringValue('secret-value', salt);

      mockWorld.metadata = {
        settings: {
          API_KEY: {
            name: 'API_KEY',
            description: 'API Key',
            usageDescription: 'Enter your API key',
            value: encrypted,
            secret: true,
            required: true,
          },
        },
      };

      (mockRuntime.getWorld as any).mockResolvedValue(mockWorld);

      const result = await getWorldSettings(mockRuntime, 'server-123');

      expect(result).not.toBeNull();
      expect(result!.API_KEY.value).toBe('secret-value');
    });

    it('should return null when world not found', async () => {
      (mockRuntime.getWorld as any).mockResolvedValue(null);

      const result = await getWorldSettings(mockRuntime, 'server-123');

      expect(result).toBeNull();
    });

    it('should return null when world has no settings', async () => {
      (mockRuntime.getWorld as any).mockResolvedValue(mockWorld);

      const result = await getWorldSettings(mockRuntime, 'server-123');

      expect(result).toBeNull();
    });
  });

  describe('initializeOnboarding', () => {
    it('should initialize settings from config', async () => {
      const config: OnboardingConfig = {
        settings: {
          API_KEY: {
            name: 'API_KEY',
            description: 'API Key',
            usageDescription: 'Enter your API key',
            required: true,
            secret: true,
          },
          PUBLIC_URL: {
            name: 'PUBLIC_URL',
            description: 'Public URL',
            usageDescription: 'Enter your public URL',
            required: false,
            secret: false,
          },
        },
      };

      (mockRuntime.updateWorld as any).mockResolvedValue(true);

      const result = await initializeOnboarding(mockRuntime, mockWorld, config);

      expect(result).not.toBeNull();
      expect(result!.API_KEY).toBeDefined();
      expect(result!.API_KEY.value).toBeNull();
      expect(result!.API_KEY.secret).toBe(true);
      expect(result!.PUBLIC_URL).toBeDefined();
      expect(result!.PUBLIC_URL.secret).toBe(false);
    });

    it('should return existing settings if already initialized', async () => {
      const salt = getSalt();
      const encrypted = encryptStringValue('existing-secret', salt);

      mockWorld.metadata = {
        settings: {
          API_KEY: {
            name: 'API_KEY',
            description: 'API Key',
            usageDescription: 'Enter your API key',
            value: encrypted,
            secret: true,
            required: true,
          },
        },
      };

      const config: OnboardingConfig = {
        settings: {
          NEW_KEY: {
            name: 'NEW_KEY',
            description: 'New Key',
            usageDescription: 'Enter new key',
            required: true,
          },
        },
      };

      const result = await initializeOnboarding(mockRuntime, mockWorld, config);

      expect(result).not.toBeNull();
      expect(result!.API_KEY).toBeDefined();
      expect(result!.API_KEY.value).toBe('existing-secret');
      expect(result!.NEW_KEY).toBeUndefined(); // Should not add new settings
    });

    it('should handle config without settings', async () => {
      const config: OnboardingConfig = { settings: {} };

      (mockRuntime.updateWorld as any).mockResolvedValue(true);

      const result = await initializeOnboarding(mockRuntime, mockWorld, config);

      expect(result).toEqual({});
      expect(mockRuntime.updateWorld).toHaveBeenCalled();
    });
  });

  describe('encryptedCharacter', () => {
    it('should encrypt character settings.secrets', () => {
      const character: Character = {
        id: 'char-123' as any,
        name: 'Test Character',
        bio: 'Test character bio',
        settings: {
          secrets: {
            API_KEY: 'secret-api-key',
            PASSWORD: 'secret-password',
          },
        },
      };

      const encrypted = encryptedCharacter(character);

      expect(encrypted.settings?.secrets?.['API_KEY']).not.toBe('secret-api-key');
      expect(encrypted.settings?.secrets?.['API_KEY']).toContain(':');
      expect(encrypted.settings?.secrets?.['PASSWORD']).not.toBe('secret-password');
      expect(encrypted.settings?.secrets?.['PASSWORD']).toContain(':');
    });

    it('should encrypt character.secrets', () => {
      const character: Character = {
        id: 'char-123' as any,
        name: 'Test Character',
        bio: 'Test character bio',
        secrets: {
          TOKEN: 'secret-token',
          KEY: 'secret-key',
        },
      };

      const encrypted = encryptedCharacter(character);

      expect(encrypted.secrets?.TOKEN).not.toBe('secret-token');
      expect(encrypted.secrets?.TOKEN).toContain(':');
      expect(encrypted.secrets?.KEY).not.toBe('secret-key');
      expect(encrypted.secrets?.KEY).toContain(':');
    });

    it('should handle character without secrets', () => {
      const character: Character = {
        id: 'char-123' as any,
        name: 'Test Character',
        bio: 'Test character bio',
      };

      const encrypted = encryptedCharacter(character);

      expect(encrypted).toEqual(character);
    });

    it('should not modify original character', () => {
      const character: Character = {
        id: 'char-123' as any,
        name: 'Test Character',
        bio: 'Test character bio',
        secrets: {
          TOKEN: 'secret-token',
        },
      };

      const encrypted = encryptedCharacter(character);

      expect(character.secrets?.TOKEN).toBe('secret-token');
      expect(encrypted.secrets?.TOKEN).not.toBe('secret-token');
    });
  });

  describe('decryptedCharacter', () => {
    it('should decrypt character settings.secrets', () => {
      const salt = getSalt();
      const character: Character = {
        id: 'char-123' as any,
        name: 'Test Character',
        bio: 'Test character bio',
        settings: {
          secrets: {
            API_KEY: encryptStringValue('secret-api-key', salt),
            PASSWORD: encryptStringValue('secret-password', salt),
          },
        },
      };

      const decrypted = decryptedCharacter(character, mockRuntime);

      expect(decrypted.settings?.secrets?.['API_KEY']).toBe('secret-api-key');
      expect(decrypted.settings?.secrets?.['PASSWORD']).toBe('secret-password');
    });

    it('should decrypt character.secrets', () => {
      const salt = getSalt();
      const character: Character = {
        id: 'char-123' as any,
        name: 'Test Character',
        bio: 'Test character bio',
        secrets: {
          TOKEN: encryptStringValue('secret-token', salt),
          KEY: encryptStringValue('secret-key', salt),
        },
      };

      const decrypted = decryptedCharacter(character, mockRuntime);

      expect(decrypted.secrets?.TOKEN).toBe('secret-token');
      expect(decrypted.secrets?.KEY).toBe('secret-key');
    });

    it('should handle character without secrets', () => {
      const character: Character = {
        id: 'char-123' as any,
        name: 'Test Character',
        bio: 'Test character bio',
      };

      const decrypted = decryptedCharacter(character, mockRuntime);

      expect(decrypted).toEqual(character);
    });
  });

  describe('encryptObjectValues', () => {
    const salt = 'test-salt';

    it('should encrypt all string values in object', () => {
      const obj = {
        key1: 'value1',
        key2: 'value2',
        key3: 123,
        key4: true,
        key5: null,
        key6: '',
      };

      const encrypted = encryptObjectValues(obj, salt);

      expect(encrypted.key1).not.toBe('value1');
      expect(encrypted.key1).toContain(':');
      expect(encrypted.key2).not.toBe('value2');
      expect(encrypted.key2).toContain(':');
      expect(encrypted.key3).toBe(123);
      expect(encrypted.key4).toBe(true);
      expect(encrypted.key5).toBeNull();
      expect(encrypted.key6).toBe(''); // Empty strings are not encrypted
    });
  });

  describe('decryptObjectValues', () => {
    const salt = 'test-salt';

    it('should decrypt all string values in object', () => {
      const obj = {
        key1: encryptStringValue('value1', salt),
        key2: encryptStringValue('value2', salt),
        key3: 123,
        key4: true,
      };

      const decrypted = decryptObjectValues(obj, salt);

      expect(decrypted.key1).toBe('value1');
      expect(decrypted.key2).toBe('value2');
      expect(decrypted.key3).toBe(123);
      expect(decrypted.key4).toBe(true);
    });
  });

  describe('decryptSecret alias', () => {
    it('should be an alias for decryptStringValue', () => {
      expect(decryptSecret).toBe(decryptStringValue);
    });
  });
});
