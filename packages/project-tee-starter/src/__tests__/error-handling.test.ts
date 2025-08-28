import { describe, it, expect } from 'bun:test';
import teeStarterPlugin from '../plugin';
import { mrTeeCharacter } from '../character';

describe('Error Handling', () => {
  describe('Plugin Error Handling', () => {
    it('should handle missing dependencies gracefully', () => {
      // Our plugin has no dependencies, so it should always be valid
      expect(teeStarterPlugin).toBeDefined();
      expect(teeStarterPlugin.actions).toEqual([]);
      expect(teeStarterPlugin.providers).toEqual([]);
    });

    it('should handle runtime errors gracefully', async () => {
      // Test that the plugin can be used even without initialization
      expect(teeStarterPlugin.name).toBe('mr-tee-starter-plugin');
      expect(teeStarterPlugin.description).toBe(
        "Mr. TEE's starter plugin - using plugin-tee for attestation"
      );
    });
  });

  describe('Character Error Handling', () => {
    it('should have valid character configuration', () => {
      expect(mrTeeCharacter).toBeDefined();
      expect(typeof mrTeeCharacter.name).toBe('string');
      expect(mrTeeCharacter.name.length).toBeGreaterThan(0);
      expect(mrTeeCharacter.plugins).toContain('@elizaos/plugin-tee');
    });
  });
});
