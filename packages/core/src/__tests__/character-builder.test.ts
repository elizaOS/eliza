import { describe, it, expect, beforeEach } from 'bun:test';
import { buildCharacterPlugins } from '../character';

describe('buildCharacterPlugins', () => {
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

  let testEnv: Record<string, string | undefined>;

  beforeEach(() => {
    // Start with clean environment for each test
    testEnv = {};
  });

  describe('Core Plugin Ordering', () => {
    it('should always include SQL plugin first', () => {
      const plugins = buildCharacterPlugins(testEnv);
      expect(plugins[0]).toBe(PLUGINS.SQL);
    });

    it('should include bootstrap plugin by default (not ignored)', () => {
      const plugins = buildCharacterPlugins(testEnv);
      expect(plugins).toContain(PLUGINS.BOOTSTRAP);
    });

    it('should exclude bootstrap plugin when IGNORE_BOOTSTRAP="true"', () => {
      testEnv.IGNORE_BOOTSTRAP = 'true';
      const plugins = buildCharacterPlugins(testEnv);
      expect(plugins).not.toContain(PLUGINS.BOOTSTRAP);
    });

    it('should exclude bootstrap plugin when IGNORE_BOOTSTRAP="1"', () => {
      testEnv.IGNORE_BOOTSTRAP = '1';
      const plugins = buildCharacterPlugins(testEnv);
      expect(plugins).not.toContain(PLUGINS.BOOTSTRAP);
    });

    it('should exclude bootstrap plugin when IGNORE_BOOTSTRAP="yes"', () => {
      testEnv.IGNORE_BOOTSTRAP = 'yes';
      const plugins = buildCharacterPlugins(testEnv);
      expect(plugins).not.toContain(PLUGINS.BOOTSTRAP);
    });

    it('should INCLUDE bootstrap plugin when IGNORE_BOOTSTRAP="false" (common mistake)', () => {
      testEnv.IGNORE_BOOTSTRAP = 'false';
      const plugins = buildCharacterPlugins(testEnv);
      expect(plugins).toContain(PLUGINS.BOOTSTRAP);
    });

    it('should INCLUDE bootstrap plugin when IGNORE_BOOTSTRAP="0"', () => {
      testEnv.IGNORE_BOOTSTRAP = '0';
      const plugins = buildCharacterPlugins(testEnv);
      expect(plugins).toContain(PLUGINS.BOOTSTRAP);
    });

    it('should INCLUDE bootstrap plugin when IGNORE_BOOTSTRAP="no"', () => {
      testEnv.IGNORE_BOOTSTRAP = 'no';
      const plugins = buildCharacterPlugins(testEnv);
      expect(plugins).toContain(PLUGINS.BOOTSTRAP);
    });

    it('should handle case-insensitive IGNORE_BOOTSTRAP values', () => {
      testEnv.IGNORE_BOOTSTRAP = 'TRUE';
      const plugins1 = buildCharacterPlugins(testEnv);
      expect(plugins1).not.toContain(PLUGINS.BOOTSTRAP);

      testEnv.IGNORE_BOOTSTRAP = 'Yes';
      const plugins2 = buildCharacterPlugins(testEnv);
      expect(plugins2).not.toContain(PLUGINS.BOOTSTRAP);
    });
  });

  describe('Ollama Fallback Behavior', () => {
    it('should include Ollama when no LLM providers are configured', () => {
      const plugins = buildCharacterPlugins(testEnv);
      expect(plugins).toContain(PLUGINS.OLLAMA);
    });

    it('should NOT include Ollama when OpenAI is available', () => {
      testEnv.OPENAI_API_KEY = 'test-key';
      const plugins = buildCharacterPlugins(testEnv);
      expect(plugins).not.toContain(PLUGINS.OLLAMA);
      expect(plugins).toContain(PLUGINS.OPENAI);
    });

    it('should NOT include Ollama when Anthropic is available', () => {
      testEnv.ANTHROPIC_API_KEY = 'test-key';
      const plugins = buildCharacterPlugins(testEnv);
      expect(plugins).not.toContain(PLUGINS.OLLAMA);
      expect(plugins).toContain(PLUGINS.ANTHROPIC);
    });

    it('should NOT include Ollama when Google GenAI is available', () => {
      testEnv.GOOGLE_GENERATIVE_AI_API_KEY = 'test-key';
      const plugins = buildCharacterPlugins(testEnv);
      expect(plugins).not.toContain(PLUGINS.OLLAMA);
      expect(plugins).toContain(PLUGINS.GOOGLE_GENAI);
    });

    it('should NOT include Ollama when only text-only providers are available', () => {
      testEnv.ANTHROPIC_API_KEY = 'anthropic-key';
      testEnv.OPENROUTER_API_KEY = 'openrouter-key';
      const plugins = buildCharacterPlugins(testEnv);
      expect(plugins).not.toContain(PLUGINS.OLLAMA);
      expect(plugins).toContain(PLUGINS.ANTHROPIC);
      expect(plugins).toContain(PLUGINS.OPENROUTER);
    });

    it('should NOT include Ollama when OpenRouter is available', () => {
      testEnv.OPENROUTER_API_KEY = 'test-key';
      const plugins = buildCharacterPlugins(testEnv);
      expect(plugins).not.toContain(PLUGINS.OLLAMA);
      expect(plugins).toContain(PLUGINS.OPENROUTER);
    });
  });

  describe('Plugin Priority Ordering', () => {
    it('should place text-only plugins before embedding-capable plugins', () => {
      testEnv.ANTHROPIC_API_KEY = 'anthropic-key';
      testEnv.OPENAI_API_KEY = 'openai-key';

      const plugins = buildCharacterPlugins(testEnv);
      const anthropicIndex = plugins.indexOf(PLUGINS.ANTHROPIC);
      const openaiIndex = plugins.indexOf(PLUGINS.OPENAI);

      expect(anthropicIndex).toBeGreaterThan(-1);
      expect(openaiIndex).toBeGreaterThan(-1);
      expect(openaiIndex).toBeGreaterThan(anthropicIndex);
    });

    it('should place Google Generative AI after text-only plugins', () => {
      testEnv.OPENROUTER_API_KEY = 'openrouter-key';
      testEnv.GOOGLE_GENERATIVE_AI_API_KEY = 'google-key';

      const plugins = buildCharacterPlugins(testEnv);
      const openrouterIndex = plugins.indexOf(PLUGINS.OPENROUTER);
      const googleIndex = plugins.indexOf(PLUGINS.GOOGLE_GENAI);

      expect(openrouterIndex).toBeGreaterThan(-1);
      expect(googleIndex).toBeGreaterThan(-1);
      expect(googleIndex).toBeGreaterThan(openrouterIndex);
    });

    it('should place embedding plugins before platform plugins', () => {
      testEnv.OPENAI_API_KEY = 'openai-key';
      testEnv.DISCORD_API_TOKEN = 'discord-token';

      const plugins = buildCharacterPlugins(testEnv);
      const openaiIndex = plugins.indexOf(PLUGINS.OPENAI);
      const discordIndex = plugins.indexOf(PLUGINS.DISCORD);

      expect(openaiIndex).toBeGreaterThan(-1);
      expect(discordIndex).toBeGreaterThan(-1);
      expect(discordIndex).toBeGreaterThan(openaiIndex);
    });

    it('should place platform plugins before bootstrap', () => {
      testEnv.DISCORD_API_TOKEN = 'discord-token';

      const plugins = buildCharacterPlugins(testEnv);
      const discordIndex = plugins.indexOf(PLUGINS.DISCORD);
      const bootstrapIndex = plugins.indexOf(PLUGINS.BOOTSTRAP);

      expect(discordIndex).toBeGreaterThan(-1);
      expect(bootstrapIndex).toBeGreaterThan(-1);
      expect(bootstrapIndex).toBeGreaterThan(discordIndex);
    });
  });

  describe('Complex Environment Combinations', () => {
    it('should handle Anthropic + OpenAI correctly', () => {
      testEnv.ANTHROPIC_API_KEY = 'anthropic-key';
      testEnv.OPENAI_API_KEY = 'openai-key';

      const plugins = buildCharacterPlugins(testEnv);
      const expectedOrder = [PLUGINS.SQL, PLUGINS.ANTHROPIC, PLUGINS.OPENAI, PLUGINS.BOOTSTRAP];

      expect(plugins).toEqual(expectedOrder);
    });

    it('should handle OpenRouter correctly (no Ollama)', () => {
      testEnv.OPENROUTER_API_KEY = 'openrouter-key';

      const plugins = buildCharacterPlugins(testEnv);
      const expectedOrder = [PLUGINS.SQL, PLUGINS.OPENROUTER, PLUGINS.BOOTSTRAP];

      expect(plugins).toEqual(expectedOrder);
    });

    it('should handle all AI providers with correct ordering', () => {
      testEnv.ANTHROPIC_API_KEY = 'anthropic-key';
      testEnv.OPENROUTER_API_KEY = 'openrouter-key';
      testEnv.OPENAI_API_KEY = 'openai-key';
      testEnv.GOOGLE_GENERATIVE_AI_API_KEY = 'google-key';

      const plugins = buildCharacterPlugins(testEnv);

      // Text-only plugins should come first
      const anthropicIndex = plugins.indexOf(PLUGINS.ANTHROPIC);
      const openrouterIndex = plugins.indexOf(PLUGINS.OPENROUTER);

      // Embedding plugins should come after text-only
      const openaiIndex = plugins.indexOf(PLUGINS.OPENAI);
      const googleIndex = plugins.indexOf(PLUGINS.GOOGLE_GENAI);

      expect(anthropicIndex).toBeGreaterThan(-1);
      expect(openrouterIndex).toBeGreaterThan(-1);
      expect(openaiIndex).toBeGreaterThan(anthropicIndex);
      expect(openaiIndex).toBeGreaterThan(openrouterIndex);
      expect(googleIndex).toBeGreaterThan(anthropicIndex);
      expect(googleIndex).toBeGreaterThan(openrouterIndex);
      expect(plugins).not.toContain(PLUGINS.OLLAMA);
    });

    it('should handle platform plugins with AI providers', () => {
      testEnv.ANTHROPIC_API_KEY = 'anthropic-key';
      testEnv.OPENAI_API_KEY = 'openai-key';
      testEnv.DISCORD_API_TOKEN = 'discord-token';
      testEnv.TELEGRAM_BOT_TOKEN = 'telegram-token';

      const plugins = buildCharacterPlugins(testEnv);

      // Platform plugins should be after AI plugins
      const discordIndex = plugins.indexOf(PLUGINS.DISCORD);
      const telegramIndex = plugins.indexOf(PLUGINS.TELEGRAM);
      const anthropicIndex = plugins.indexOf(PLUGINS.ANTHROPIC);
      const openaiIndex = plugins.indexOf(PLUGINS.OPENAI);

      expect(discordIndex).toBeGreaterThan(anthropicIndex);
      expect(telegramIndex).toBeGreaterThan(anthropicIndex);
      expect(discordIndex).toBeGreaterThan(openaiIndex);
      expect(telegramIndex).toBeGreaterThan(openaiIndex);
    });

    it('should handle Twitter plugin with all required tokens', () => {
      testEnv.ANTHROPIC_API_KEY = 'anthropic-key';
      testEnv.OPENAI_API_KEY = 'openai-key';
      testEnv.TWITTER_API_KEY = 'twitter-key';
      testEnv.TWITTER_API_SECRET_KEY = 'twitter-secret';
      testEnv.TWITTER_ACCESS_TOKEN = 'twitter-token';
      testEnv.TWITTER_ACCESS_TOKEN_SECRET = 'twitter-token-secret';

      const plugins = buildCharacterPlugins(testEnv);

      expect(plugins).toContain(PLUGINS.TWITTER);

      const twitterIndex = plugins.indexOf(PLUGINS.TWITTER);
      const anthropicIndex = plugins.indexOf(PLUGINS.ANTHROPIC);
      const openaiIndex = plugins.indexOf(PLUGINS.OPENAI);

      expect(twitterIndex).toBeGreaterThan(anthropicIndex);
      expect(twitterIndex).toBeGreaterThan(openaiIndex);
    });

    it('should NOT include Twitter plugin with incomplete tokens', () => {
      testEnv.TWITTER_API_KEY = 'twitter-key';
      // Missing other required Twitter tokens

      const plugins = buildCharacterPlugins(testEnv);
      expect(plugins).not.toContain(PLUGINS.TWITTER);
    });
  });

  describe('Error Handling', () => {
    it('should trim and accept keys with surrounding whitespace', () => {
      testEnv.OPENAI_API_KEY = '  valid-key  ';
      testEnv.ANTHROPIC_API_KEY = '\tvalid-key\n';

      const plugins = buildCharacterPlugins(testEnv);
      expect(plugins).toContain(PLUGINS.OPENAI);
      expect(plugins).toContain(PLUGINS.ANTHROPIC);
      expect(plugins).not.toContain(PLUGINS.OLLAMA);
    });

    it('should handle whitespace-only environment variables', () => {
      testEnv.OPENAI_API_KEY = '   ';
      testEnv.ANTHROPIC_API_KEY = '\t\n';

      const plugins = buildCharacterPlugins(testEnv);
      expect(plugins).toContain(PLUGINS.OLLAMA);
      expect(plugins).not.toContain(PLUGINS.OPENAI);
      expect(plugins).not.toContain(PLUGINS.ANTHROPIC);
    });

    it('should handle empty string environment variables', () => {
      testEnv.OPENAI_API_KEY = '';
      testEnv.ANTHROPIC_API_KEY = '';

      const plugins = buildCharacterPlugins(testEnv);
      expect(plugins).toContain(PLUGINS.OLLAMA);
      expect(plugins).not.toContain(PLUGINS.OPENAI);
      expect(plugins).not.toContain(PLUGINS.ANTHROPIC);
    });

    it('should handle malformed Twitter credentials', () => {
      testEnv.TWITTER_API_KEY = 'malformed';
      testEnv.TWITTER_API_SECRET_KEY = '';

      const plugins = buildCharacterPlugins(testEnv);
      expect(plugins).not.toContain(PLUGINS.TWITTER);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty environment (only SQL, bootstrap, Ollama)', () => {
      const plugins = buildCharacterPlugins(testEnv);
      const expectedPlugins = [PLUGINS.SQL, PLUGINS.BOOTSTRAP, PLUGINS.OLLAMA];

      expect(plugins).toEqual(expectedPlugins);
    });

    it('should handle IGNORE_BOOTSTRAP with no AI providers', () => {
      testEnv.IGNORE_BOOTSTRAP = 'true';

      const plugins = buildCharacterPlugins(testEnv);
      const expectedPlugins = [PLUGINS.SQL, PLUGINS.OLLAMA];

      expect(plugins).toEqual(expectedPlugins);
    });

    it('should ensure no duplicate plugins in any configuration', () => {
      testEnv.ANTHROPIC_API_KEY = 'key';
      testEnv.OPENAI_API_KEY = 'key';
      testEnv.GOOGLE_GENERATIVE_AI_API_KEY = 'key';

      const plugins = buildCharacterPlugins(testEnv);
      const uniquePlugins = [...new Set(plugins)];

      expect(plugins.length).toBe(uniquePlugins.length);
    });

    it('should maintain consistent order across multiple calls', () => {
      testEnv.ANTHROPIC_API_KEY = 'anthropic-key';
      testEnv.OPENAI_API_KEY = 'openai-key';
      testEnv.DISCORD_API_TOKEN = 'discord-token';

      const plugins1 = buildCharacterPlugins(testEnv);
      const plugins2 = buildCharacterPlugins(testEnv);

      expect(plugins1).toEqual(plugins2);
    });

    it('should ensure SQL is always first', () => {
      // Test with various combinations
      const testCases = [
        { OPENAI_API_KEY: 'key' },
        { ANTHROPIC_API_KEY: 'key' },
        { OPENROUTER_API_KEY: 'key', GOOGLE_GENERATIVE_AI_API_KEY: 'key' },
        { ANTHROPIC_API_KEY: 'key', OPENAI_API_KEY: 'key' },
      ];

      testCases.forEach((envVars) => {
        const plugins = buildCharacterPlugins(envVars);
        expect(plugins[0]).toBe(PLUGINS.SQL);
      });
    });
  });
});
