/**
 * Tests for secrets.ts env var filtering functionality
 *
 * These tests verify that:
 * 1. setAllowedEnvVars properly filters what gets captured into secrets
 * 2. Shell environment leakage is prevented when filter is set
 * 3. All vars are captured when filter is null (default behavior)
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  setAllowedEnvVars,
  getAllowedEnvVars,
  setDefaultSecretsFromEnv,
  hasCharacterSecrets,
} from '../secrets';
import type { Character } from '../types';

describe('Secrets Environment Variable Filtering', () => {
  // Store original process.env
  const originalEnv = { ...process.env };

  // Store original filter state
  let originalFilter: Set<string> | null = null;

  beforeEach(() => {
    // Save current filter state
    originalFilter = getAllowedEnvVars();

    // Reset filter to null (allow all)
    setAllowedEnvVars(null);

    // Set up test environment variables
    process.env.TEST_ALLOWED_VAR = 'allowed-value';
    process.env.TEST_SHELL_VAR = 'shell-leaked-value';
    process.env.TEST_ANOTHER_VAR = 'another-value';
  });

  afterEach(() => {
    // Restore original filter
    setAllowedEnvVars(originalFilter);

    // Restore original env
    delete process.env.TEST_ALLOWED_VAR;
    delete process.env.TEST_SHELL_VAR;
    delete process.env.TEST_ANOTHER_VAR;
  });

  describe('setAllowedEnvVars and getAllowedEnvVars', () => {
    it('should set and get the allowed env vars filter', () => {
      const filter = new Set(['VAR1', 'VAR2']);
      setAllowedEnvVars(filter);

      const result = getAllowedEnvVars();
      expect(result).toBe(filter);
      expect(result?.has('VAR1')).toBe(true);
      expect(result?.has('VAR2')).toBe(true);
    });

    it('should allow clearing the filter with null', () => {
      setAllowedEnvVars(new Set(['VAR1']));
      expect(getAllowedEnvVars()).not.toBeNull();

      setAllowedEnvVars(null);
      expect(getAllowedEnvVars()).toBeNull();
    });
  });

  describe('setDefaultSecretsFromEnv with filtering', () => {
    it('should capture all env vars when filter is null', async () => {
      setAllowedEnvVars(null);

      const character: Character = {
        name: 'test-character',
        settings: {},
      };

      await setDefaultSecretsFromEnv(character);

      // All test vars should be captured
      expect(character.settings?.secrets?.TEST_ALLOWED_VAR).toBe('allowed-value');
      expect(character.settings?.secrets?.TEST_SHELL_VAR).toBe('shell-leaked-value');
      expect(character.settings?.secrets?.TEST_ANOTHER_VAR).toBe('another-value');
    });

    it('should only capture allowed vars when filter is set', async () => {
      const allowedVars = new Set(['TEST_ALLOWED_VAR', 'TEST_ANOTHER_VAR']);
      setAllowedEnvVars(allowedVars);

      const character: Character = {
        name: 'test-character',
        settings: {},
      };

      await setDefaultSecretsFromEnv(character);

      // Only allowed vars should be captured
      expect(character.settings?.secrets?.TEST_ALLOWED_VAR).toBe('allowed-value');
      expect(character.settings?.secrets?.TEST_ANOTHER_VAR).toBe('another-value');
      // Shell leaked var should NOT be captured
      expect(character.settings?.secrets?.TEST_SHELL_VAR).toBeUndefined();
    });

    it('should preserve existing character secrets with higher priority', async () => {
      setAllowedEnvVars(new Set(['TEST_ALLOWED_VAR']));

      const character: Character = {
        name: 'test-character',
        settings: {
          secrets: {
            TEST_ALLOWED_VAR: 'character-override-value',
            EXISTING_SECRET: 'existing-value',
          },
        },
      };

      await setDefaultSecretsFromEnv(character);

      // Character's existing value should take priority
      expect(character.settings?.secrets?.TEST_ALLOWED_VAR).toBe('character-override-value');
      // Existing secrets should be preserved
      expect(character.settings?.secrets?.EXISTING_SECRET).toBe('existing-value');
    });

    it('should not capture system vars when they are not in allowed set', async () => {
      // Only allow a specific var
      setAllowedEnvVars(new Set(['TEST_ALLOWED_VAR']));

      const character: Character = {
        name: 'test-character',
        settings: {},
      };

      await setDefaultSecretsFromEnv(character);

      // System vars should not be captured (they're not in allowed set)
      expect(character.settings?.secrets?.PATH).toBeUndefined();
      expect(character.settings?.secrets?.HOME).toBeUndefined();
      // Only the allowed var should be captured
      expect(character.settings?.secrets?.TEST_ALLOWED_VAR).toBe('allowed-value');
    });

    it('should handle empty filter set', async () => {
      setAllowedEnvVars(new Set());

      const character: Character = {
        name: 'test-character',
        settings: {},
      };

      await setDefaultSecretsFromEnv(character);

      // No env vars should be captured with empty filter
      expect(character.settings?.secrets?.TEST_ALLOWED_VAR).toBeUndefined();
      expect(character.settings?.secrets?.TEST_SHELL_VAR).toBeUndefined();
    });

    it('should skip env merge when skipEnvMerge option is true', async () => {
      setAllowedEnvVars(null); // Allow all

      const character: Character = {
        name: 'test-character',
        settings: {},
      };

      const result = await setDefaultSecretsFromEnv(character, { skipEnvMerge: true });

      expect(result).toBe(false);
      expect(character.settings?.secrets).toBeUndefined();
    });
  });

  describe('hasCharacterSecrets', () => {
    it('should return true when character has secrets', () => {
      const character: Character = {
        name: 'test',
        settings: {
          secrets: {
            API_KEY: 'value',
          },
        },
      };

      expect(hasCharacterSecrets(character)).toBe(true);
    });

    it('should return false when character has no secrets', () => {
      const character: Character = {
        name: 'test',
        settings: {},
      };

      expect(hasCharacterSecrets(character)).toBe(false);
    });

    it('should return false when character has empty secrets object', () => {
      const character: Character = {
        name: 'test',
        settings: {
          secrets: {},
        },
      };

      expect(hasCharacterSecrets(character)).toBe(false);
    });
  });

  describe('Real-world Scenario: Shell Leakage Prevention', () => {
    it('should prevent shell API keys from being captured', async () => {
      // Simulate shell environment with personal API keys
      process.env.ANTHROPIC_API_KEY = 'sk-ant-personal-key-from-zshrc';
      process.env.OPENAI_API_KEY = 'sk-openai-personal-key-from-zshrc';
      process.env.OPENROUTER_API_KEY = 'sk-or-project-key-from-dotenv';

      // Set filter to only allow project's intended vars
      const allowedVars = new Set(['OPENROUTER_API_KEY', 'POSTGRES_URL', 'LOG_LEVEL']);
      setAllowedEnvVars(allowedVars);

      const character: Character = {
        name: 'my-agent',
        settings: {},
      };

      await setDefaultSecretsFromEnv(character);

      // Only the project's intended var should be captured
      expect(character.settings?.secrets?.OPENROUTER_API_KEY).toBe('sk-or-project-key-from-dotenv');

      // Shell-leaked personal keys should NOT be captured
      expect(character.settings?.secrets?.ANTHROPIC_API_KEY).toBeUndefined();
      expect(character.settings?.secrets?.OPENAI_API_KEY).toBeUndefined();

      // Clean up
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENROUTER_API_KEY;
    });
  });
});
