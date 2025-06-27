import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { getElizaCharacter } from '../../../src/characters/eliza';

describe('Character Plugin Ordering', () => {
  let originalEnv: Record<string, string | undefined>;

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
      expect(character.plugins[0]).toBe('@elizaos/plugin-sql');
    });

    it('should include bootstrap plugin by default (not ignored)', () => {
      const character = getElizaCharacter();
      expect(character.plugins).toContain('@elizaos/plugin-bootstrap');
    });

    it('should exclude bootstrap plugin when IGNORE_BOOTSTRAP is set', () => {
      process.env.IGNORE_BOOTSTRAP = 'true';
      const character = getElizaCharacter();
      expect(character.plugins).not.toContain('@elizaos/plugin-bootstrap');
    });
  });

  describe('Local AI Fallback Behavior', () => {
    it('should include local-ai when no AI providers are available', () => {
      const character = getElizaCharacter();
      expect(character.plugins).toContain('@elizaos/plugin-local-ai');
      // Should be the last plugin (after bootstrap)
      const lastPlugin = character.plugins[character.plugins.length - 1];
      expect(lastPlugin).toBe('@elizaos/plugin-local-ai');
    });

    it('should NOT include local-ai when OpenAI is available', () => {
      process.env.OPENAI_API_KEY = 'test-key';
      const character = getElizaCharacter();
      expect(character.plugins).not.toContain('@elizaos/plugin-local-ai');
      expect(character.plugins).toContain('@elizaos/plugin-openai');
    });

    it('should include local-ai when only Anthropic is available (text-only, no embeddings)', () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      const character = getElizaCharacter();
      expect(character.plugins).toContain('@elizaos/plugin-local-ai');
      expect(character.plugins).toContain('@elizaos/plugin-anthropic');
    });

    it('should NOT include local-ai when embedding-capable AI provider is available', () => {
      process.env.OLLAMA_API_ENDPOINT = 'http://localhost:11434';
      const character = getElizaCharacter();
      expect(character.plugins).not.toContain('@elizaos/plugin-local-ai');
      expect(character.plugins).toContain('@elizaos/plugin-ollama');
    });

    it('should include local-ai when only text-only providers are available', () => {
      process.env.ANTHROPIC_API_KEY = 'anthropic-key';
      process.env.OPENROUTER_API_KEY = 'openrouter-key';
      const character = getElizaCharacter();
      expect(character.plugins).toContain('@elizaos/plugin-local-ai');
      expect(character.plugins).toContain('@elizaos/plugin-anthropic');
      expect(character.plugins).toContain('@elizaos/plugin-openrouter');
    });
  });

  describe('Embedding Plugin Priority (Always Last)', () => {
    it('should place OpenAI after text-only plugins', () => {
      process.env.ANTHROPIC_API_KEY = 'anthropic-key';
      process.env.OPENAI_API_KEY = 'openai-key';

      const character = getElizaCharacter();
      const anthropicIndex = character.plugins.indexOf('@elizaos/plugin-anthropic');
      const openaiIndex = character.plugins.indexOf('@elizaos/plugin-openai');

      expect(anthropicIndex).toBeGreaterThan(-1);
      expect(openaiIndex).toBeGreaterThan(-1);
      expect(openaiIndex).toBeGreaterThan(anthropicIndex);
    });

    it('should place Ollama after text-only plugins', () => {
      process.env.ANTHROPIC_API_KEY = 'anthropic-key';
      process.env.OLLAMA_API_ENDPOINT = 'http://localhost:11434';

      const character = getElizaCharacter();
      const anthropicIndex = character.plugins.indexOf('@elizaos/plugin-anthropic');
      const ollamaIndex = character.plugins.indexOf('@elizaos/plugin-ollama');

      expect(anthropicIndex).toBeGreaterThan(-1);
      expect(ollamaIndex).toBeGreaterThan(-1);
      expect(ollamaIndex).toBeGreaterThan(anthropicIndex);
    });

    it('should place Google Generative AI after text-only plugins', () => {
      process.env.OPENROUTER_API_KEY = 'openrouter-key';
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'google-key';

      const character = getElizaCharacter();
      const openrouterIndex = character.plugins.indexOf('@elizaos/plugin-openrouter');
      const googleIndex = character.plugins.indexOf('@elizaos/plugin-google-genai');

      expect(openrouterIndex).toBeGreaterThan(-1);
      expect(googleIndex).toBeGreaterThan(-1);
      expect(googleIndex).toBeGreaterThan(openrouterIndex);
    });

    it('should place all embedding plugins after bootstrap', () => {
      process.env.OPENAI_API_KEY = 'openai-key';
      process.env.OLLAMA_API_ENDPOINT = 'http://localhost:11434';
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'google-key';

      const character = getElizaCharacter();
      const bootstrapIndex = character.plugins.indexOf('@elizaos/plugin-bootstrap');
      const openaiIndex = character.plugins.indexOf('@elizaos/plugin-openai');
      const ollamaIndex = character.plugins.indexOf('@elizaos/plugin-ollama');
      const googleIndex = character.plugins.indexOf('@elizaos/plugin-google-genai');

      expect(bootstrapIndex).toBeGreaterThan(-1);
      expect(openaiIndex).toBeGreaterThan(bootstrapIndex);
      expect(ollamaIndex).toBeGreaterThan(bootstrapIndex);
      expect(googleIndex).toBeGreaterThan(bootstrapIndex);
    });
  });

  describe('Complex Environment Combinations', () => {
    it('should handle Anthropic + OpenAI correctly (OpenAI last, no local-ai)', () => {
      process.env.ANTHROPIC_API_KEY = 'anthropic-key';
      process.env.OPENAI_API_KEY = 'openai-key';

      const character = getElizaCharacter();
      const expectedOrder = [
        '@elizaos/plugin-sql',
        '@elizaos/plugin-anthropic',
        '@elizaos/plugin-bootstrap',
        '@elizaos/plugin-openai',
      ];

      expect(character.plugins).toEqual(expectedOrder);
      expect(character.plugins).not.toContain('@elizaos/plugin-local-ai');
    });

    it('should handle OpenRouter + Ollama correctly (Ollama last)', () => {
      process.env.OPENROUTER_API_KEY = 'openrouter-key';
      process.env.OLLAMA_API_ENDPOINT = 'http://localhost:11434';

      const character = getElizaCharacter();
      const expectedOrder = [
        '@elizaos/plugin-sql',
        '@elizaos/plugin-openrouter',
        '@elizaos/plugin-bootstrap',
        '@elizaos/plugin-ollama',
      ];

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
      const anthropicIndex = character.plugins.indexOf('@elizaos/plugin-anthropic');
      const openrouterIndex = character.plugins.indexOf('@elizaos/plugin-openrouter');

      // Embedding plugins should come last
      const openaiIndex = character.plugins.indexOf('@elizaos/plugin-openai');
      const ollamaIndex = character.plugins.indexOf('@elizaos/plugin-ollama');
      const googleIndex = character.plugins.indexOf('@elizaos/plugin-google-genai');

      expect(anthropicIndex).toBeGreaterThan(-1);
      expect(openrouterIndex).toBeGreaterThan(-1);
      expect(openaiIndex).toBeGreaterThan(anthropicIndex);
      expect(openaiIndex).toBeGreaterThan(openrouterIndex);
      expect(ollamaIndex).toBeGreaterThan(anthropicIndex);
      expect(ollamaIndex).toBeGreaterThan(openrouterIndex);
      expect(googleIndex).toBeGreaterThan(anthropicIndex);
      expect(googleIndex).toBeGreaterThan(openrouterIndex);

      // Local AI should not be included when other providers exist
      expect(character.plugins).not.toContain('@elizaos/plugin-local-ai');
    });

    it('should handle platform plugins with AI providers', () => {
      process.env.ANTHROPIC_API_KEY = 'anthropic-key';
      process.env.OPENAI_API_KEY = 'openai-key';
      process.env.DISCORD_API_TOKEN = 'discord-token';
      process.env.TELEGRAM_BOT_TOKEN = 'telegram-token';

      const character = getElizaCharacter();

      // Platform plugins should be in the middle
      const discordIndex = character.plugins.indexOf('@elizaos/plugin-discord');
      const telegramIndex = character.plugins.indexOf('@elizaos/plugin-telegram');
      const anthropicIndex = character.plugins.indexOf('@elizaos/plugin-anthropic');
      const openaiIndex = character.plugins.indexOf('@elizaos/plugin-openai');

      expect(discordIndex).toBeGreaterThan(anthropicIndex);
      expect(telegramIndex).toBeGreaterThan(anthropicIndex);
      expect(openaiIndex).toBeGreaterThan(discordIndex);
      expect(openaiIndex).toBeGreaterThan(telegramIndex);

      // Should not include local-ai when embedding-capable provider (OpenAI) is available
      expect(character.plugins).not.toContain('@elizaos/plugin-local-ai');
    });

    it('should handle Twitter plugin with all required tokens', () => {
      process.env.ANTHROPIC_API_KEY = 'anthropic-key';
      process.env.OPENAI_API_KEY = 'openai-key';
      process.env.TWITTER_API_KEY = 'twitter-key';
      process.env.TWITTER_API_SECRET_KEY = 'twitter-secret';
      process.env.TWITTER_ACCESS_TOKEN = 'twitter-token';
      process.env.TWITTER_ACCESS_TOKEN_SECRET = 'twitter-token-secret';

      const character = getElizaCharacter();

      expect(character.plugins).toContain('@elizaos/plugin-twitter');

      const twitterIndex = character.plugins.indexOf('@elizaos/plugin-twitter');
      const anthropicIndex = character.plugins.indexOf('@elizaos/plugin-anthropic');
      const openaiIndex = character.plugins.indexOf('@elizaos/plugin-openai');

      expect(twitterIndex).toBeGreaterThan(anthropicIndex);
      expect(openaiIndex).toBeGreaterThan(twitterIndex);

      // Should not include local-ai when embedding-capable provider (OpenAI) is available
      expect(character.plugins).not.toContain('@elizaos/plugin-local-ai');
    });

    it('should NOT include Twitter plugin with incomplete tokens', () => {
      process.env.TWITTER_API_KEY = 'twitter-key';
      // Missing other required Twitter tokens

      const character = getElizaCharacter();
      expect(character.plugins).not.toContain('@elizaos/plugin-twitter');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty environment (only SQL, bootstrap, local-ai)', () => {
      const character = getElizaCharacter();
      const expectedPlugins = [
        '@elizaos/plugin-sql',
        '@elizaos/plugin-bootstrap',
        '@elizaos/plugin-local-ai',
      ];

      expect(character.plugins).toEqual(expectedPlugins);
    });

    it('should handle IGNORE_BOOTSTRAP with no AI providers', () => {
      process.env.IGNORE_BOOTSTRAP = 'true';

      const character = getElizaCharacter();
      const expectedPlugins = ['@elizaos/plugin-sql', '@elizaos/plugin-local-ai'];

      expect(character.plugins).toEqual(expectedPlugins);
    });

    it('should handle IGNORE_BOOTSTRAP with AI providers', () => {
      process.env.IGNORE_BOOTSTRAP = 'true';
      process.env.OPENAI_API_KEY = 'openai-key';

      const character = getElizaCharacter();
      const expectedPlugins = ['@elizaos/plugin-sql', '@elizaos/plugin-openai'];

      expect(character.plugins).toEqual(expectedPlugins);
    });
  });

  describe('Plugin Order Consistency', () => {
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
        expect(character.plugins[0]).toBe('@elizaos/plugin-sql');

        // Find embedding plugins
        const embeddingPlugins = [
          '@elizaos/plugin-openai',
          '@elizaos/plugin-ollama',
          '@elizaos/plugin-google-genai',
          '@elizaos/plugin-local-ai',
        ];

        const textOnlyPlugins = ['@elizaos/plugin-anthropic', '@elizaos/plugin-openrouter'];

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
});
