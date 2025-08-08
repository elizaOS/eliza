import { describe, it, expect } from 'bun:test';
import teeStarterPlugin from '../plugin';

describe('Plugin Models', () => {
  it('should not have custom models (using plugin-tee and other plugins for model handling)', () => {
    // Our simplified plugin doesn't define custom models
    // Model handling is done by other plugins (openai, etc.)
    expect(teeStarterPlugin.models).toBeUndefined();
  });

  it('should rely on other plugins for model functionality', () => {
    // Verify the plugin is configured correctly
    expect(teeStarterPlugin.name).toBe('mr-tee-starter-plugin');
    expect(teeStarterPlugin.description).toBe(
      "Mr. TEE's starter plugin - using plugin-tee for attestation"
    );

    // Model functionality comes from character plugins
    expect(teeStarterPlugin.actions).toEqual([]);
    expect(teeStarterPlugin.providers).toEqual([]);
  });
});
