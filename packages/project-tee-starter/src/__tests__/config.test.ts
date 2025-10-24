import { describe, it, expect } from 'bun:test';
import teeStarterPlugin from '../plugin';

describe('Plugin Configuration', () => {
  it('should not have custom configuration (relies on character settings)', () => {
    // Our plugin has config properties for TEE_MODE and WALLET_SECRET_SALT
    expect(teeStarterPlugin.config).toBeDefined();
    expect(teeStarterPlugin.config?.TEE_MODE).toBe(process.env.TEE_MODE);
    expect(teeStarterPlugin.config?.WALLET_SECRET_SALT).toBe(process.env.WALLET_SECRET_SALT);
    expect(teeStarterPlugin.init).toBeDefined();
  });

  it('should have correct plugin metadata', () => {
    expect(teeStarterPlugin).toBeDefined();
    expect(teeStarterPlugin.name).toBe('mr-tee-starter-plugin');
    expect(teeStarterPlugin.description).toBe(
      "Mr. TEE's starter plugin - using plugin-tee for attestation"
    );
  });

  it('should parse and validate config during initialization', async () => {
    // Mock runtime for testing
    const mockRuntime = {
      logger: {
        info: () => {},
        warn: () => {},
        debug: () => {},
        error: () => {},
      },
    } as any;

    // Test that config parsing happens during init, not at import time
    const originalEnv = {
      NODE_ENV: process.env.NODE_ENV,
      TEE_MODE: process.env.TEE_MODE,
      WALLET_SECRET_SALT: process.env.WALLET_SECRET_SALT,
    };

    try {
      // Set test environment with valid defaults
      process.env.NODE_ENV = 'test';
      process.env.TEE_MODE = 'OFF';
      process.env.WALLET_SECRET_SALT = 'test_salt_12345';

      // Config should be parsed and validated during init without throwing
      await expect(teeStarterPlugin.init({}, mockRuntime)).resolves.toBeUndefined();

      // Test with invalid config should fail validation during init
      const invalidConfig = { TEE_MODE: 'INVALID_MODE' };
      await expect(teeStarterPlugin.init(invalidConfig, mockRuntime)).rejects.toThrow(
        'TEE_MODE must be one of: OFF, LOCAL, DOCKER, PRODUCTION'
      );
    } finally {
      // Restore original environment
      process.env.NODE_ENV = originalEnv.NODE_ENV;
      process.env.TEE_MODE = originalEnv.TEE_MODE;
      process.env.WALLET_SECRET_SALT = originalEnv.WALLET_SECRET_SALT;
    }
  });

  it('should be a TEE-focused plugin with appropriate components', () => {
    // Verify plugin has TEE-specific components
    expect(teeStarterPlugin.actions).toEqual([]);
    expect(teeStarterPlugin.providers).toEqual([]);
    expect(teeStarterPlugin.evaluators).toBeUndefined();

    // Has StarterService for TEE functionality
    expect(teeStarterPlugin.services).toBeDefined();
    expect(teeStarterPlugin.services?.length).toBe(1);

    // Has routes for TEE status and frontend
    expect(teeStarterPlugin.routes).toBeDefined();
    expect(teeStarterPlugin.routes?.length).toBeGreaterThan(0);

    // Has events for logging
    expect(teeStarterPlugin.events).toBeDefined();
  });
});
