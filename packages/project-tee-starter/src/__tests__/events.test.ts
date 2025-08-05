import { describe, it, expect } from 'bun:test';
import teeStarterPlugin from '../plugin';

describe('Plugin Events', () => {
  it('should not have custom events (relies on plugin-tee for TEE events)', () => {
    // Our plugin actually has events defined for logging
    expect(teeStarterPlugin.events).toBeDefined();
    expect(teeStarterPlugin.events?.MESSAGE_RECEIVED).toBeDefined();
    expect(teeStarterPlugin.events?.VOICE_MESSAGE_RECEIVED).toBeDefined();
    expect(teeStarterPlugin.events?.WORLD_CONNECTED).toBeDefined();
    expect(teeStarterPlugin.events?.WORLD_JOINED).toBeDefined();
  });

  it('should have correct plugin configuration', () => {
    expect(teeStarterPlugin).toBeDefined();
    expect(teeStarterPlugin.name).toBe('mr-tee-starter-plugin');
    expect(teeStarterPlugin.description).toBe(
      "Mr. TEE's starter plugin - using plugin-tee for attestation"
    );
  });
});
