import { describe, it, expect } from 'vitest';
import { teeStarterPlugin } from '../src/plugin';

describe('Plugin Configuration', () => {
  it('should not have custom configuration (relies on character settings)', () => {
    // Our simplified plugin doesn't define custom config
    expect(teeStarterPlugin.config).toBeUndefined();
    expect(teeStarterPlugin.init).toBeUndefined();
  });

  it('should have correct plugin metadata', () => {
    expect(teeStarterPlugin).toBeDefined();
    expect(teeStarterPlugin.name).toBe('mr-tee-starter-plugin');
    expect(teeStarterPlugin.description).toBe(
      "Mr. TEE's starter plugin - using plugin-tee for attestation"
    );
  });

  it('should be a minimal plugin focused on character definition', () => {
    // Verify all arrays are empty
    expect(teeStarterPlugin.actions).toEqual([]);
    expect(teeStarterPlugin.providers).toEqual([]);
    expect(teeStarterPlugin.evaluators).toEqual([]);
    expect(teeStarterPlugin.services).toEqual([]);
  });
});
