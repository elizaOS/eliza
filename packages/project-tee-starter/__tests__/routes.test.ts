import { describe, it, expect } from 'vitest';
import { teeStarterPlugin } from '../src/plugin';

describe('Plugin Routes', () => {
  it('should not have custom routes (relies on other plugins for HTTP endpoints)', () => {
    // Our simplified plugin doesn't define custom routes
    expect(teeStarterPlugin.routes).toBeUndefined();
  });

  it('should have correct plugin configuration', () => {
    expect(teeStarterPlugin).toBeDefined();
    expect(teeStarterPlugin.name).toBe('mr-tee-starter-plugin');
    expect(teeStarterPlugin.description).toBe(
      "Mr. TEE's starter plugin - using plugin-tee for attestation"
    );
  });
});
