import { describe, it, expect } from 'vitest';
import teeStarterPlugin from '../src/plugin';

describe('Plugin Configuration', () => {
  it('should not have custom configuration (relies on character settings)', () => {
    // Our plugin has config properties for TEE_MODE and WALLET_SECRET_SALT
    expect(teeStarterPlugin.config).toBeDefined();
    expect(teeStarterPlugin.config?.TEE_MODE).toBe(process.env.TEE_MODE);
    expect(teeStarterPlugin.config?.WALLET_SECRET_SALT).toBe(process.env.WALLET_SECRET_SALT);
    expect(teeStarterPlugin.init).toBeDefined();
  });

  it('should have correct plugin metadata', () => {
    expect(teeStarterPlugin).toBeDefined();
    expect(teeStarterPlugin.name).toBe('mr-tee-starter-plugin');
    expect(teeStarterPlugin.description).toBe(
      "Mr. TEE's starter plugin - using plugin-tee for attestation"
    );
  });

  it('should be a minimal plugin focused on character definition', () => {
    // Verify arrays exist but are empty (except routes and events)
    expect(teeStarterPlugin.actions).toEqual([]);
    expect(teeStarterPlugin.providers).toEqual([]);
    expect(teeStarterPlugin.evaluators).toBeUndefined();
    expect(teeStarterPlugin.services).toEqual([]);
    expect(teeStarterPlugin.routes).toBeDefined();
    expect(teeStarterPlugin.routes?.length).toBeGreaterThan(0);
    expect(teeStarterPlugin.events).toBeDefined();
  });
});
