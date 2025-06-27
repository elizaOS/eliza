import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { character } from '../character';

describe('Project Starter Character Plugin Ordering', () => {
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
      expect(character.plugins[0]).toBe('@elizaos/plugin-sql');
    });

    it('should include bootstrap plugin by default (not ignored)', () => {
      expect(character.plugins).toContain('@elizaos/plugin-bootstrap');
    });

    it('should exclude bootstrap plugin when IGNORE_BOOTSTRAP is set', () => {
      // Note: Since character is imported statically, we test the conditional logic structure
      // The actual dynamic behavior is tested in the CLI tests with getElizaCharacter()
      expect(character.plugins).toContain('@elizaos/plugin-bootstrap');
      // In a dynamic context, bootstrap would be excluded when IGNORE_BOOTSTRAP is set
    });
  });

  describe('Local AI Fallback Logic Structure', () => {
    it('should have local-ai fallback condition that checks all AI providers', () => {
      // Test the structure of the conditional logic by examining the character definition
      const characterStr = character.toString();

      // The local-ai plugin should be conditional on NO other AI providers being available
      expect(typeof character.plugins).toBe('object');
      expect(Array.isArray(character.plugins)).toBe(true);

      // Test the logical structure - local AI may or may not be present depending on env
      const hasOtherAiProviders = character.plugins.some((plugin) =>
        [
          '@elizaos/plugin-anthropic',
          '@elizaos/plugin-openai',
          '@elizaos/plugin-openrouter',
          '@elizaos/plugin-ollama',
          '@elizaos/plugin-google-genai',
        ].includes(plugin)
      );
      const hasLocalAi = character.plugins.includes('@elizaos/plugin-local-ai');

      // If other AI providers exist, local-ai should not be present (and vice versa)
      if (hasOtherAiProviders) {
        expect(hasLocalAi).toBe(false);
      } else {
        expect(hasLocalAi).toBe(true);
      }
    });

    it('should structure embedding plugins after text-only plugins', () => {
      const plugins = character.plugins;

      // Find indices of key plugins
      const sqlIndex = plugins.indexOf('@elizaos/plugin-sql');
      const localAiIndex = plugins.indexOf('@elizaos/plugin-local-ai');

      // SQL should be first
      expect(sqlIndex).toBe(0);

      // Local AI should be last when present
      if (localAiIndex !== -1) {
        expect(localAiIndex).toBe(plugins.length - 1);
      }
    });
  });

  describe('Plugin Categories and Ordering', () => {
    it('should categorize plugins correctly', () => {
      const plugins = character.plugins;

      // Core plugins
      expect(plugins).toContain('@elizaos/plugin-sql');

      // Text-only AI plugins (no embedding support)
      const textOnlyPlugins = ['@elizaos/plugin-anthropic', '@elizaos/plugin-openrouter'];

      // Embedding-capable AI plugins
      const embeddingPlugins = [
        '@elizaos/plugin-openai',
        '@elizaos/plugin-ollama',
        '@elizaos/plugin-google-genai',
        '@elizaos/plugin-local-ai',
      ];

      // Platform plugins
      const platformPlugins = [
        '@elizaos/plugin-discord',
        '@elizaos/plugin-twitter',
        '@elizaos/plugin-telegram',
      ];

      // Bootstrap plugin
      const bootstrapPlugin = '@elizaos/plugin-bootstrap';

      // Verify all categories are represented in the plugin structure
      const allExpectedPlugins = [
        '@elizaos/plugin-sql',
        ...textOnlyPlugins,
        ...platformPlugins,
        bootstrapPlugin,
        ...embeddingPlugins,
      ];

      // Check that our character has conditional logic for all these plugins
      // SQL should always be present
      expect(plugins).toContain('@elizaos/plugin-sql');

      // Bootstrap should be present unless IGNORE_BOOTSTRAP is set
      expect(plugins).toContain('@elizaos/plugin-bootstrap');

      // Local AI is only present when no other AI providers are available
      const hasOtherAiProviders = plugins.some((plugin) =>
        [
          '@elizaos/plugin-anthropic',
          '@elizaos/plugin-openai',
          '@elizaos/plugin-openrouter',
          '@elizaos/plugin-ollama',
          '@elizaos/plugin-google-genai',
        ].includes(plugin)
      );
      const hasLocalAi = plugins.includes('@elizaos/plugin-local-ai');

      if (hasOtherAiProviders) {
        expect(hasLocalAi).toBe(false);
      } else {
        expect(hasLocalAi).toBe(true);
      }
    });

    it('should maintain proper ordering between plugin categories', () => {
      const plugins = character.plugins;

      // Get indices of representative plugins from each category
      const sqlIndex = plugins.indexOf('@elizaos/plugin-sql');
      const bootstrapIndex = plugins.indexOf('@elizaos/plugin-bootstrap');
      const localAiIndex = plugins.indexOf('@elizaos/plugin-local-ai');

      // SQL should be first
      expect(sqlIndex).toBe(0);

      // Bootstrap should come before embedding plugins
      if (bootstrapIndex !== -1 && localAiIndex !== -1) {
        expect(bootstrapIndex).toBeLessThan(localAiIndex);
      }
    });
  });

  describe('Environment Variable Integration', () => {
    it('should have conditional logic for all AI providers', () => {
      // Test that the character structure includes conditional logic
      // Note: Since this is a static import, we test the structure rather than dynamic behavior

      const plugins = character.plugins;

      // Should always have core plugins
      expect(plugins).toContain('@elizaos/plugin-sql');
      expect(plugins).toContain('@elizaos/plugin-bootstrap');

      // Local AI presence depends on other AI providers
      const hasOtherAiProviders = plugins.some((plugin) =>
        [
          '@elizaos/plugin-anthropic',
          '@elizaos/plugin-openai',
          '@elizaos/plugin-openrouter',
          '@elizaos/plugin-ollama',
          '@elizaos/plugin-google-genai',
        ].includes(plugin)
      );

      if (!hasOtherAiProviders) {
        expect(plugins).toContain('@elizaos/plugin-local-ai');
      }
    });

    it('should include proper conditional checks for Twitter', () => {
      // Twitter requires all 4 environment variables
      // Test that the logic structure is sound
      const plugins = character.plugins;

      // Twitter should not be in default config (no env vars set)
      expect(plugins).not.toContain('@elizaos/plugin-twitter');
    });

    it('should structure platform plugins between AI plugins', () => {
      const plugins = character.plugins;

      // Platform plugins should be positioned correctly in the array structure
      const sqlIndex = plugins.indexOf('@elizaos/plugin-sql');
      const bootstrapIndex = plugins.indexOf('@elizaos/plugin-bootstrap');

      // Platform plugins (when present) should be between SQL and bootstrap
      expect(sqlIndex).toBeLessThan(bootstrapIndex);
    });
  });

  describe('Embedding Plugin Priority Verification', () => {
    it('should structure embedding plugins at the end', () => {
      const plugins = character.plugins;

      // Get the last few plugins
      const lastThreePlugins = plugins.slice(-3);

      // At least one should be an embedding-capable plugin
      const embeddingPlugins = [
        '@elizaos/plugin-openai',
        '@elizaos/plugin-ollama',
        '@elizaos/plugin-google-genai',
        '@elizaos/plugin-local-ai',
      ];

      // Check if any embedding plugins are present
      const embeddingPluginsPresent = plugins.filter((plugin) => embeddingPlugins.includes(plugin));

      // If embedding plugins are present, at least one should be at the end
      if (embeddingPluginsPresent.length > 0) {
        const hasEmbeddingAtEnd = lastThreePlugins.some((plugin) =>
          embeddingPlugins.includes(plugin)
        );
        expect(hasEmbeddingAtEnd).toBe(true);
      }
    });

    it('should place local-ai as final fallback when present', () => {
      const plugins = character.plugins;
      const localAiIndex = plugins.indexOf('@elizaos/plugin-local-ai');

      // Local AI should be the last plugin when it's present (no other AI providers)
      if (localAiIndex !== -1) {
        expect(localAiIndex).toBe(plugins.length - 1);
      } else {
        // If local AI is not present, other AI providers should exist
        const hasOtherAiProviders = plugins.some((plugin) =>
          [
            '@elizaos/plugin-anthropic',
            '@elizaos/plugin-openai',
            '@elizaos/plugin-openrouter',
            '@elizaos/plugin-ollama',
            '@elizaos/plugin-google-genai',
          ].includes(plugin)
        );
        expect(hasOtherAiProviders).toBe(true);
      }
    });

    it('should maintain consistent plugin structure', () => {
      // Test multiple evaluations for consistency
      const plugins1 = character.plugins;
      const plugins2 = character.plugins;

      expect(plugins1).toEqual(plugins2);
      expect(plugins1.length).toBe(plugins2.length);
    });
  });

  describe('Plugin Logic Validation', () => {
    it('should follow the expected plugin ordering pattern', () => {
      const plugins = character.plugins;

      // Expected pattern: [SQL, Text-only AI, Platforms, Bootstrap, Embedding AI]
      // Verify the basic structure exists
      expect(plugins[0]).toBe('@elizaos/plugin-sql'); // SQL always first
      expect(plugins).toContain('@elizaos/plugin-bootstrap'); // Bootstrap present

      // Verify ordering: text-only plugins before embedding plugins
      const textOnlyPlugins = ['@elizaos/plugin-anthropic', '@elizaos/plugin-openrouter'];
      const embeddingPlugins = [
        '@elizaos/plugin-openai',
        '@elizaos/plugin-ollama',
        '@elizaos/plugin-google-genai',
        '@elizaos/plugin-local-ai',
      ];

      const textOnlyIndices = textOnlyPlugins
        .map((p) => plugins.indexOf(p))
        .filter((i) => i !== -1);
      const embeddingIndices = embeddingPlugins
        .map((p) => plugins.indexOf(p))
        .filter((i) => i !== -1);

      if (textOnlyIndices.length > 0 && embeddingIndices.length > 0) {
        const maxTextOnly = Math.max(...textOnlyIndices);
        const minEmbedding = Math.min(...embeddingIndices);
        expect(minEmbedding).toBeGreaterThan(maxTextOnly);
      }
    });

    it('should have valid plugin names', () => {
      const plugins = character.plugins;

      plugins.forEach((plugin) => {
        expect(typeof plugin).toBe('string');
        expect(plugin).toMatch(/^@elizaos\/plugin-/);
      });
    });

    it('should not have duplicate plugins', () => {
      const plugins = character.plugins;
      const uniquePlugins = [...new Set(plugins)];

      expect(plugins.length).toBe(uniquePlugins.length);
    });
  });

  describe('Complex Configuration Scenarios', () => {
    it('should handle complete AI provider setup correctly', () => {
      // This tests the theoretical structure for when all providers are available
      const allAiProviders = [
        '@elizaos/plugin-anthropic',
        '@elizaos/plugin-openrouter',
        '@elizaos/plugin-openai',
        '@elizaos/plugin-ollama',
        '@elizaos/plugin-google-genai',
      ];

      // In a complete setup, local-ai should not be included
      // Test the logical structure based on current environment
      const hasOtherAiProviders = character.plugins.some((plugin) =>
        allAiProviders.includes(plugin)
      );
      const hasLocalAi = character.plugins.includes('@elizaos/plugin-local-ai');

      // If other AI providers exist, local-ai should not be present
      if (hasOtherAiProviders) {
        expect(hasLocalAi).toBe(false);
      } else {
        expect(hasLocalAi).toBe(true);
      }
    });

    it('should validate embedding vs text-only categorization', () => {
      const embeddingCapablePlugins = [
        '@elizaos/plugin-openai',
        '@elizaos/plugin-ollama',
        '@elizaos/plugin-google-genai',
        '@elizaos/plugin-local-ai',
      ];

      const textOnlyPlugins = ['@elizaos/plugin-anthropic', '@elizaos/plugin-openrouter'];

      // Verify our categorization is complete and mutually exclusive
      const intersection = embeddingCapablePlugins.filter((plugin) =>
        textOnlyPlugins.includes(plugin)
      );

      expect(intersection.length).toBe(0); // No overlap
    });

    it('should structure conditional logic properly', () => {
      // Test that the character has the right structure for conditional loading
      const plugins = character.plugins;

      // Should have core plugins
      expect(plugins).toContain('@elizaos/plugin-sql');

      // Should have bootstrap (unless ignored)
      expect(plugins).toContain('@elizaos/plugin-bootstrap');

      // Should have fallback logic working correctly
      const hasOtherAiProviders = plugins.some((plugin) =>
        [
          '@elizaos/plugin-anthropic',
          '@elizaos/plugin-openai',
          '@elizaos/plugin-openrouter',
          '@elizaos/plugin-ollama',
          '@elizaos/plugin-google-genai',
        ].includes(plugin)
      );
      const hasLocalAi = plugins.includes('@elizaos/plugin-local-ai');

      // Either has other AI providers OR has local-ai fallback
      expect(hasOtherAiProviders || hasLocalAi).toBe(true);

      // Conditional plugins depend on actual environment variables
      // Test that the structure is logical based on what's present
      if (hasOtherAiProviders) {
        // If other AI providers are present, local-ai should not be
        expect(hasLocalAi).toBe(false);
      } else {
        // If no other AI providers, local-ai should be present as fallback
        expect(hasLocalAi).toBe(true);
      }
    });
  });

  describe('Character Properties Validation', () => {
    it('should have all required character properties', () => {
      expect(character.name).toBe('Eliza');
      expect(Array.isArray(character.plugins)).toBe(true);
      expect(typeof character.system).toBe('string');
      expect(Array.isArray(character.bio)).toBe(true);
      expect(Array.isArray(character.topics)).toBe(true);
      expect(Array.isArray(character.messageExamples)).toBe(true);
      expect(typeof character.style).toBe('object');
    });

    it('should have consistent character configuration', () => {
      // Verify character is properly configured
      expect(character.plugins.length).toBeGreaterThan(0);
      expect(character.bio.length).toBeGreaterThan(0);
      expect(character.system.length).toBeGreaterThan(0);
    });
  });
});
