import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { getElizaCharacter } from '../../../src/characters/eliza';

describe('Character Plugin Ordering', () => {
  // Plugin name constants for better maintainability
  const PLUGINS = {
    SQL: '@elizaos/plugin-sql',
    BOOTSTRAP: '@elizaos/plugin-bootstrap',
    OLLAMA: '@elizaos/plugin-ollama',
    ANTHROPIC: '@elizaos/plugin-anthropic',
    OPENAI: '@elizaos/plugin-openai',
    OPENROUTER: '@elizaos/plugin-openrouter',
    GOOGLE_GENAI: '@elizaos/plugin-google-genai',
    DISCORD: '@elizaos/plugin-discord',
    TWITTER: '@elizaos/plugin-twitter',
    TELEGRAM: '@elizaos/plugin-telegram',
  };
  let originalEnv: Record<string, string | undefined>;

  // Helper function to set up test environment
  const setupTestEnvironment = (config: Record<string, string>) => {
    Object.keys(originalEnv).forEach((key) => delete process.env[key]);
    Object.entries(config).forEach(([key, value]) => {
      process.env[key] = value;
    });
  };

  // Helper function to verify plugin ordering
  const verifyPluginOrder = (plugins: string[], expectedBefore: string, expectedAfter: string) => {
    const beforeIndex = plugins.indexOf(expectedBefore);
    const afterIndex = plugins.indexOf(expectedAfter);
    expect(beforeIndex).toBeGreaterThan(-1);
    expect(afterIndex).toBeGreaterThan(-1);
    expect(afterIndex).toBeGreaterThan(beforeIndex);
  };
  beforeEach(() => {
    // Save original environment
    originalEnv = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      OLLAMA_API_ENDPOINT: process.env.OLLAMA_API_ENDPOINT,
      GOOGLE_GENERATIVE_AI_API_KEY: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
      DISCORD_API_TOKEN: process.env.DISCORD_API_TOKEN,
      TWITTER_API_KEY: process.env.TWITTER_API_KEY,
      TWITTER_API_SECRET_KEY: process.env.TWITTER_API_SECRET_KEY,
      TWITTER_ACCESS_TOKEN: process.env.TWITTER_ACCESS_TOKEN,
      TWITTER_ACCESS_TOKEN_SECRET: process.env.TWITTER_ACCESS_TOKEN_SECRET,
      TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
      IGNORE_BOOTSTRAP: process.env.IGNORE_BOOTSTRAP,
    };

    // Clear all environment variables
    Object.keys(originalEnv).forEach((key) => {
      delete process.env[key];
    });
  });

  afterEach(() => {
    // Restore original environment
    Object.entries(originalEnv).forEach(([key, value]) => {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });
  });

  describe('Core Plugin Ordering', () => {
    it('should always include SQL plugin first', () => {
      const character = getElizaCharacter();
      expect(character.plugins?.[0]).toBe(PLUGINS.SQL);
    });

    it('should include bootstrap plugin by default (not ignored)', () => {
      const character = getElizaCharacter();
      expect(character.plugins).toContain(PLUGINS.BOOTSTRAP);
    });

    it('should exclude bootstrap plugin when IGNORE_BOOTSTRAP is set', () => {
      process.env.IGNORE_BOOTSTRAP = 'true';
      const character = getElizaCharacter();
      expect(character.plugins).not.toContain(PLUGINS.BOOTSTRAP);
    });
  });

  describe('Ollama Fallback Behavior', () => {
    it('should always include Ollama plugin as universal fallback regardless of other AI providers', () => {
      const character = getElizaCharacter();
      expect(character.plugins).toContain(PLUGINS.OLLAMA);
    });

    it('should include Ollama fallback when OpenAI is the primary provider', () => {
      process.env.OPENAI_API_KEY = 'test-key';
      const character = getElizaCharacter();
      expect(character.plugins).toContain(PLUGINS.OLLAMA);
      expect(character.plugins).toContain(PLUGINS.OPENAI);
    });

    it('should include ollama when only Anthropic is available', () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      const character = getElizaCharacter();
      expect(character.plugins).toContain(PLUGINS.OLLAMA);
      expect(character.plugins).toContain(PLUGINS.ANTHROPIC);
    });

    it('should include ollama when Google GenAI is available', () => {
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'test-key';
      const character = getElizaCharacter();
      expect(character.plugins).toContain(PLUGINS.OLLAMA);
      expect(character.plugins).toContain(PLUGINS.GOOGLE_GENAI);
    });

    it('should include ollama when only text-only providers are available', () => {
      process.env.ANTHROPIC_API_KEY = 'anthropic-key';
      process.env.OPENROUTER_API_KEY = 'openrouter-key';
      const character = getElizaCharacter();
      expect(character.plugins).toContain(PLUGINS.OLLAMA);
      expect(character.plugins).toContain(PLUGINS.ANTHROPIC);
      expect(character.plugins).toContain(PLUGINS.OPENROUTER);
    });
  });

  describe('Embedding Plugin Priority (Always Last)', () => {
    it('should place OpenAI after text-only plugins', () => {
      process.env.ANTHROPIC_API_KEY = 'anthropic-key';
      process.env.OPENAI_API_KEY = 'openai-key';

      const character = getElizaCharacter();
      const anthropicIndex = character.plugins.indexOf(PLUGINS.ANTHROPIC);
      const openaiIndex = character.plugins.indexOf(PLUGINS.OPENAI);

      expect(anthropicIndex).toBeGreaterThan(-1);
      expect(openaiIndex).toBeGreaterThan(-1);
      expect(openaiIndex).toBeGreaterThan(anthropicIndex);
    });

    it('should always place Ollama last as universal fallback', () => {
      process.env.ANTHROPIC_API_KEY = 'anthropic-key';

      const character = getElizaCharacter();
      const anthropicIndex = character.plugins.indexOf(PLUGINS.ANTHROPIC);
      const ollamaIndex = character.plugins.indexOf(PLUGINS.OLLAMA);

      // Ollama should always be included and always be last
      expect(ollamaIndex).toBe(character.plugins.length - 1);
      expect(ollamaIndex).toBeGreaterThan(anthropicIndex);
    });

    it('should place Google Generative AI after text-only plugins', () => {
      process.env.OPENROUTER_API_KEY = 'openrouter-key';
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'google-key';

      const character = getElizaCharacter();
      const openrouterIndex = character.plugins.indexOf(PLUGINS.OPENROUTER);
      const googleIndex = character.plugins.indexOf(PLUGINS.GOOGLE_GENAI);

      expect(openrouterIndex).toBeGreaterThan(-1);
      expect(googleIndex).toBeGreaterThan(-1);
      expect(googleIndex).toBeGreaterThan(openrouterIndex);
    });

    it('should place OpenAI and Google plugins before bootstrap, Ollama after', () => {
      process.env.OPENAI_API_KEY = 'openai-key';
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'google-key';

      const character = getElizaCharacter();
      const bootstrapIndex = character.plugins.indexOf(PLUGINS.BOOTSTRAP);
      const openaiIndex = character.plugins.indexOf(PLUGINS.OPENAI);
      const ollamaIndex = character.plugins.indexOf(PLUGINS.OLLAMA);
      const googleIndex = character.plugins.indexOf(PLUGINS.GOOGLE_GENAI);

      expect(bootstrapIndex).toBeGreaterThan(-1);
      expect(bootstrapIndex).toBeGreaterThan(openaiIndex);
      expect(bootstrapIndex).toBeGreaterThan(googleIndex);
      expect(ollamaIndex).toBeGreaterThan(bootstrapIndex); // Ollama is after bootstrap
    });
  });

  describe('Complex Environment Combinations', () => {
    it('should handle Anthropic + OpenAI correctly (Ollama always last)', () => {
      process.env.ANTHROPIC_API_KEY = 'anthropic-key';
      process.env.OPENAI_API_KEY = 'openai-key';

      const character = getElizaCharacter();
      const expectedOrder = [
        PLUGINS.SQL,
        PLUGINS.ANTHROPIC,
        PLUGINS.OPENAI,
        PLUGINS.BOOTSTRAP,
        PLUGINS.OLLAMA,
      ];

      expect(character.plugins).toEqual(expectedOrder);
    });

    it('should handle OpenRouter correctly (Ollama always last)', () => {
      process.env.OPENROUTER_API_KEY = 'openrouter-key';

      const character = getElizaCharacter();
      const expectedOrder = [PLUGINS.SQL, PLUGINS.OPENROUTER, PLUGINS.BOOTSTRAP, PLUGINS.OLLAMA];

      expect(character.plugins).toEqual(expectedOrder);
    });

    it('should handle all AI providers (embedding plugins last)', () => {
      process.env.ANTHROPIC_API_KEY = 'anthropic-key';
      process.env.OPENROUTER_API_KEY = 'openrouter-key';
      process.env.OPENAI_API_KEY = 'openai-key';
      process.env.OLLAMA_API_ENDPOINT = 'http://localhost:11434';
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'google-key';

      const character = getElizaCharacter();

      // Text-only plugins should come first
      const anthropicIndex = character.plugins.indexOf(PLUGINS.ANTHROPIC);
      const openrouterIndex = character.plugins.indexOf(PLUGINS.OPENROUTER);

      // Embedding plugins should come last
      const openaiIndex = character.plugins.indexOf(PLUGINS.OPENAI);
      const ollamaIndex = character.plugins.indexOf(PLUGINS.OLLAMA);
      const googleIndex = character.plugins.indexOf(PLUGINS.GOOGLE_GENAI);

      expect(anthropicIndex).toBeGreaterThan(-1);
      expect(openrouterIndex).toBeGreaterThan(-1);
      expect(openaiIndex).toBeGreaterThan(anthropicIndex);
      expect(openaiIndex).toBeGreaterThan(openrouterIndex);
      expect(ollamaIndex).toBeGreaterThan(anthropicIndex);
      expect(ollamaIndex).toBeGreaterThan(openrouterIndex);
      expect(googleIndex).toBeGreaterThan(anthropicIndex);
      expect(googleIndex).toBeGreaterThan(openrouterIndex);
    });

    it('should handle platform plugins with AI providers', () => {
      process.env.ANTHROPIC_API_KEY = 'anthropic-key';
      process.env.OPENAI_API_KEY = 'openai-key';
      process.env.DISCORD_API_TOKEN = 'discord-token';
      process.env.TELEGRAM_BOT_TOKEN = 'telegram-token';

      const character = getElizaCharacter();

      // Platform plugins should be in the middle
      const discordIndex = character.plugins.indexOf(PLUGINS.DISCORD);
      const telegramIndex = character.plugins.indexOf(PLUGINS.TELEGRAM);
      const anthropicIndex = character.plugins.indexOf(PLUGINS.ANTHROPIC);
      const openaiIndex = character.plugins.indexOf(PLUGINS.OPENAI);

      expect(discordIndex).toBeGreaterThan(anthropicIndex);
      expect(telegramIndex).toBeGreaterThan(anthropicIndex);
      expect(discordIndex).toBeGreaterThan(openaiIndex);
      expect(telegramIndex).toBeGreaterThan(openaiIndex);
    });

    it('should handle Twitter plugin with all required tokens', () => {
      process.env.ANTHROPIC_API_KEY = 'anthropic-key';
      process.env.OPENAI_API_KEY = 'openai-key';
      process.env.TWITTER_API_KEY = 'twitter-key';
      process.env.TWITTER_API_SECRET_KEY = 'twitter-secret';
      process.env.TWITTER_ACCESS_TOKEN = 'twitter-token';
      process.env.TWITTER_ACCESS_TOKEN_SECRET = 'twitter-token-secret';

      const character = getElizaCharacter();

      expect(character.plugins).toContain(PLUGINS.TWITTER);

      const twitterIndex = character.plugins.indexOf(PLUGINS.TWITTER);
      const anthropicIndex = character.plugins.indexOf(PLUGINS.ANTHROPIC);
      const openaiIndex = character.plugins.indexOf(PLUGINS.OPENAI);

      expect(twitterIndex).toBeGreaterThan(anthropicIndex);
      expect(twitterIndex).toBeGreaterThan(openaiIndex);
    });

    it('should NOT include Twitter plugin with incomplete tokens', () => {
      process.env.TWITTER_API_KEY = 'twitter-key';
      // Missing other required Twitter tokens

      const character = getElizaCharacter();
      expect(character.plugins).not.toContain(PLUGINS.TWITTER);
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid environment variable values gracefully', () => {
      process.env.OLLAMA_API_ENDPOINT = 'invalid-url';
      process.env.OPENAI_API_KEY = '';

      const character = getElizaCharacter();
      expect(character.plugins).toContain(PLUGINS.OLLAMA);
    });

    it('should handle malformed Twitter credentials', () => {
      process.env.TWITTER_API_KEY = 'malformed';
      process.env.TWITTER_API_SECRET_KEY = '';

      const character = getElizaCharacter();
      expect(character.plugins).not.toContain(PLUGINS.TWITTER);
    });

    it('should handle whitespace-only environment variables', () => {
      process.env.OPENAI_API_KEY = '   ';
      process.env.ANTHROPIC_API_KEY = '\t\n';

      const character = getElizaCharacter();
      expect(character.plugins).toContain(PLUGINS.OLLAMA);
      expect(character.plugins).not.toContain(PLUGINS.OPENAI);
      expect(character.plugins).not.toContain(PLUGINS.ANTHROPIC);
    });
  });
  describe('Edge Cases', () => {
    it('should handle empty environment (only SQL, bootstrap, ollama)', () => {
      const character = getElizaCharacter();
      const expectedPlugins = [PLUGINS.SQL, PLUGINS.BOOTSTRAP, PLUGINS.OLLAMA];

      expect(character.plugins).toEqual(expectedPlugins);
    });

    it('should handle IGNORE_BOOTSTRAP with no AI providers', () => {
      process.env.IGNORE_BOOTSTRAP = 'true';

      const character = getElizaCharacter();
      const expectedPlugins = [PLUGINS.SQL, PLUGINS.OLLAMA];

      expect(character.plugins).toEqual(expectedPlugins);
    });
  });

  describe('Plugin Order Consistency', () => {
    it('should ensure no duplicate plugins in any configuration', () => {
      setupTestEnvironment({
        ANTHROPIC_API_KEY: 'key',
        OPENAI_API_KEY: 'key',
        OLLAMA_API_ENDPOINT: 'http://localhost:11434',
        GOOGLE_GENERATIVE_AI_API_KEY: 'key',
      });

      const character = getElizaCharacter();
      const uniquePlugins = [...new Set(character.plugins)];

      expect(character.plugins.length).toBe(uniquePlugins.length);
    });

    it('should maintain performance with large environment variable sets', () => {
      const startTime = Date.now();

      // Set many environment variables to test performance
      for (let i = 0; i < 100; i++) {
        process.env[`TEST_VAR_${i}`] = `value_${i}`;
      }

      const character = getElizaCharacter();
      const endTime = Date.now();

      expect(character.plugins).toContain(PLUGINS.SQL);
      expect(character.plugins).toContain(PLUGINS.OLLAMA);
      expect(endTime - startTime).toBeLessThan(1000); // Should complete within 1 second
    });
    it('should maintain consistent order across multiple calls', () => {
      process.env.ANTHROPIC_API_KEY = 'anthropic-key';
      process.env.OPENAI_API_KEY = 'openai-key';
      process.env.DISCORD_API_TOKEN = 'discord-token';

      const character1 = getElizaCharacter();
      const character2 = getElizaCharacter();

      expect(character1.plugins).toEqual(character2.plugins);
    });

    it('should ensure SQL is always first and embedding plugins are always at the end', () => {
      // Test with various combinations
      const testCases = [
        { OPENAI_API_KEY: 'key' },
        { ANTHROPIC_API_KEY: 'key', OLLAMA_API_ENDPOINT: 'endpoint' },
        { OPENROUTER_API_KEY: 'key', GOOGLE_GENERATIVE_AI_API_KEY: 'key' },
        { ANTHROPIC_API_KEY: 'key', OPENAI_API_KEY: 'key', OLLAMA_API_ENDPOINT: 'endpoint' },
      ];

      testCases.forEach((envVars) => {
        // Clear environment
        Object.keys(originalEnv).forEach((key) => {
          delete process.env[key];
        });

        // Set test environment
        Object.entries(envVars).forEach(([key, value]) => {
          process.env[key] = value;
        });

        const character = getElizaCharacter();

        // SQL should always be first
        expect(character.plugins[0]).toBe(PLUGINS.SQL);

        // Find embedding plugins
        const embeddingPlugins = [PLUGINS.OPENAI, PLUGINS.OLLAMA, PLUGINS.GOOGLE_GENAI];

        const textOnlyPlugins = [PLUGINS.ANTHROPIC, PLUGINS.OPENROUTER];

        // Get indices of embedding and text-only plugins
        const embeddingIndices = embeddingPlugins
          .map((plugin) => character.plugins.indexOf(plugin))
          .filter((index) => index !== -1);

        const textOnlyIndices = textOnlyPlugins
          .map((plugin) => character.plugins.indexOf(plugin))
          .filter((index) => index !== -1);

        // All embedding plugins should come after all text-only plugins
        if (textOnlyIndices.length > 0 && embeddingIndices.length > 0) {
          const maxTextOnlyIndex = Math.max(...textOnlyIndices);
          const minEmbeddingIndex = Math.min(...embeddingIndices);
          expect(minEmbeddingIndex).toBeGreaterThan(maxTextOnlyIndex);
        }
      });
    });
  });

  describe('Integration Tests', () => {
    it('should match expected plugin installation behavior from setup.ts', () => {
      // This test ensures alignment between character plugin loading and setup installation
      setupTestEnvironment({ ANTHROPIC_API_KEY: 'test-key' });

      const character = getElizaCharacter();

      // Verify that plugins expected to be installed are actually included
      expect(character.plugins).toContain(PLUGINS.ANTHROPIC);
      expect(character.plugins).toContain(PLUGINS.OLLAMA); // Should always be fallback

      // Verify ordering requirements from PR #5556
      verifyPluginOrder(character.plugins, PLUGINS.ANTHROPIC, PLUGINS.OLLAMA);
    });

    it('should ensure Ollama is always included regardless of primary AI provider', () => {
      const testConfigs = [
        { OPENAI_API_KEY: 'key' },
        { ANTHROPIC_API_KEY: 'key' },
        { GOOGLE_GENERATIVE_AI_API_KEY: 'key' },
        { OPENROUTER_API_KEY: 'key' },
        {}, // No AI provider
      ];

      testConfigs.forEach((config) => {
        setupTestEnvironment(config);
        const character = getElizaCharacter();
        expect(character.plugins).toContain(PLUGINS.OLLAMA);
      });
    });
  });
});
