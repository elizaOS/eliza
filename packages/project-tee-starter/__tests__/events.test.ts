import { describe, it, expect } from 'vitest';
import { teeStarterPlugin } from '../src/plugin';

describe('Plugin Events', () => {
  it('should not have custom events (relies on plugin-tee for TEE events)', () => {
    // Our simplified plugin doesn't define custom events
    expect(teeStarterPlugin.events).toBeUndefined();
  });

  it('should have correct plugin configuration', () => {
    expect(teeStarterPlugin).toBeDefined();
    expect(teeStarterPlugin.name).toBe('mr-tee-starter-plugin');
    expect(teeStarterPlugin.description).toBe(
      "Mr. TEE's starter plugin - using plugin-tee for attestation"
    );
  });
});
