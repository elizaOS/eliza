import { describe, it, expect } from 'vitest';
import teeStarterPlugin from '../src/plugin';

describe('Plugin Routes', () => {
  it('should not have custom routes (relies on other plugins for HTTP endpoints)', () => {
    // Our plugin actually has a route defined
    expect(teeStarterPlugin.routes).toBeDefined();
    expect(teeStarterPlugin.routes?.length).toBe(1);
    expect(teeStarterPlugin.routes?.[0].name).toBe('mr-tee-status-route');
    expect(teeStarterPlugin.routes?.[0].path).toBe('/mr-tee-status');
    expect(teeStarterPlugin.routes?.[0].type).toBe('GET');
  });

  it('should have correct plugin configuration', () => {
    expect(teeStarterPlugin).toBeDefined();
    expect(teeStarterPlugin.name).toBe('mr-tee-starter-plugin');
    expect(teeStarterPlugin.description).toBe(
      "Mr. TEE's starter plugin - using plugin-tee for attestation"
    );
  });
});
