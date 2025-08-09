import { describe, it, expect } from 'bun:test';
import { findPluginPackageName } from '@/src/commands/plugins/utils/naming';

describe('Plugin Naming Utilities', () => {
  describe('findPluginPackageName', () => {
    it('should find exact match in dependencies', () => {
      const dependencies = {
        '@elizaos/plugin-openai': '^1.0.0',
        '@elizaos/plugin-mcp': '^1.0.0',
      };

      const result = findPluginPackageName('@elizaos/plugin-openai', dependencies);
      expect(result).toBe('@elizaos/plugin-openai');
    });

    it('should find package with @elizaos scope when given repo name', () => {
      const dependencies = {
        '@elizaos/plugin-discord': '^1.0.0',
        '@elizaos/plugin-openai': '^1.0.0',
      };

      const result = findPluginPackageName('plugin-discord', dependencies);
      expect(result).toBe('@elizaos/plugin-discord');
    });

    it('should find package when given name without plugin- prefix', () => {
      const dependencies = {
        '@elizaos/plugin-discord': '^1.0.0',
        '@elizaos/plugin-openai': '^1.0.0',
      };

      const result = findPluginPackageName('discord', dependencies);
      expect(result).toBe('@elizaos/plugin-discord');
    });

    it('should handle GitHub repo names that differ from package names', () => {
      const dependencies = {
        '@elizaos/plugin-morpheus': '^1.0.0', // actual package name
        '@elizaos/plugin-openai': '^1.0.0',
      };

      // Simulate searching for "morpheus-plugin" (GitHub repo name)
      // which is actually published as "@elizaos/plugin-morpheus"
      const result = findPluginPackageName('morpheus', dependencies);
      expect(result).toBe('@elizaos/plugin-morpheus');
    });

    it('should prioritize @elizaos scope over @elizaos scope', () => {
      const dependencies = {
        '@elizaos/plugin-test': '^1.0.0',
      };

      const result = findPluginPackageName('test', dependencies);
      expect(result).toBe('@elizaos/plugin-test');
    });

    it('should return null when package is not found', () => {
      const dependencies = {
        '@elizaos/plugin-openai': '^1.0.0',
        '@elizaos/plugin-mcp': '^1.0.0',
      };

      const result = findPluginPackageName('nonexistent', dependencies);
      expect(result).toBeNull();
    });

    it('should handle unscoped plugin packages', () => {
      const dependencies = {
        'plugin-custom': '^1.0.0',
        '@elizaos/plugin-openai': '^1.0.0',
      };

      const result = findPluginPackageName('custom', dependencies);
      expect(result).toBe('plugin-custom');
    });

    it('should handle packages from GitHub URLs', () => {
      const dependencies = {
        '@elizaos-plugins/plugin-video-understanding':
          'github:elizaos-plugins/plugin-video-understanding',
        '@elizaos/plugin-openai': '^1.0.0',
      };

      // Should find by exact match
      const result1 = findPluginPackageName(
        '@elizaos-plugins/plugin-video-understanding',
        dependencies
      );
      expect(result1).toBe('@elizaos-plugins/plugin-video-understanding');

      // The current implementation doesn't search all packages by owner/repo name pattern
      // It only searches for standard naming conventions with @elizaos/@elizaos scopes
      const result2 = findPluginPackageName('plugin-video-understanding', dependencies);
      expect(result2).toBeNull(); // This is the actual current behavior
    });

    it('should handle empty dependencies object', () => {
      const result = findPluginPackageName('test', {});
      expect(result).toBeNull();
    });

    it('should handle packages with different naming conventions', () => {
      const dependencies = {
        '@fleek-platform/eliza-plugin-mcp': '^1.0.0',
        '@elizaos/plugin-openai': '^1.0.0',
      };

      // Should not find this with standard naming convention
      const result1 = findPluginPackageName('mcp', dependencies);
      expect(result1).toBeNull();

      // But should find with exact match
      const result2 = findPluginPackageName('@fleek-platform/eliza-plugin-mcp', dependencies);
      expect(result2).toBe('@fleek-platform/eliza-plugin-mcp');
    });
  });
});
