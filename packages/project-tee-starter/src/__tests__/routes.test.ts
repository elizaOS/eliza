import { describe, it, expect } from 'bun:test';
import teeStarterPlugin from '../plugin';

describe('Plugin Routes', () => {
  it('should have TEE-specific routes for status and frontend', () => {
    // Our plugin has routes for TEE status and frontend panels
    expect(teeStarterPlugin.routes).toBeDefined();
    expect(teeStarterPlugin.routes?.length).toBe(2);

    // Check for mr-tee-status route
    const statusRoute = teeStarterPlugin.routes?.find((r) => r.name === 'mr-tee-status-route');
    expect(statusRoute).toBeDefined();
    expect(statusRoute?.path).toBe('/mr-tee-status');
    expect(statusRoute?.type).toBe('GET');

    // Check for TEE Status panel route
    const panelRoute = teeStarterPlugin.routes?.find((r) => r.name === 'TEE Status');
    expect(panelRoute).toBeDefined();
    expect(panelRoute?.path).toBe('/public/tee-status');
    expect(panelRoute?.type).toBe('GET');
  });

  it('should have correct plugin configuration', () => {
    expect(teeStarterPlugin).toBeDefined();
    expect(teeStarterPlugin.name).toBe('mr-tee-starter-plugin');
    expect(teeStarterPlugin.description).toBe(
      "Mr. TEE's starter plugin - using plugin-tee for attestation"
    );
  });
});
