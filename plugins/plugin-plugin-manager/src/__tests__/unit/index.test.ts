import { describe, it, expect } from 'vitest';
import { pluginManagerPlugin } from '../../index';

describe('Plugin Manager Plugin', () => {
  it('should export a valid plugin structure', () => {
    expect(pluginManagerPlugin).toBeDefined();
    expect(pluginManagerPlugin.name).toBe('plugin-manager');
    expect(pluginManagerPlugin.description).toBeDefined();
  });

  it('should have required services', () => {
    expect(pluginManagerPlugin.services).toBeDefined();
    expect(pluginManagerPlugin.services?.length).toBeGreaterThan(0);

    // Check for core services by their serviceType property
    const serviceTypes = pluginManagerPlugin.services?.map((s: any) => s.serviceType) || [];
    expect(serviceTypes).toContain('plugin_manager');
    expect(serviceTypes).toContain('plugin_configuration');
  });

  it('should have core actions', () => {
    expect(pluginManagerPlugin.actions).toBeDefined();
    expect(pluginManagerPlugin.actions?.length).toBeGreaterThan(0);

    const actionNames = pluginManagerPlugin.actions?.map((a) => a.name) || [];
    expect(actionNames).toContain('LOAD_PLUGIN');
    expect(actionNames).toContain('UNLOAD_PLUGIN');
    expect(actionNames).toContain('SEARCH_PLUGINS');
    expect(actionNames).toContain('CLONE_PLUGIN');
    expect(actionNames).toContain('PUBLISH_PLUGIN');
    expect(actionNames).toContain('installPluginFromRegistry');
    expect(actionNames).toContain('GET_PLUGIN_DETAILS');
  });

  it('should have required providers', () => {
    expect(pluginManagerPlugin.providers).toBeDefined();
    expect(pluginManagerPlugin.providers?.length).toBeGreaterThan(0);

    const providerNames = pluginManagerPlugin.providers?.map((p) => p.name) || [];
    expect(providerNames).toContain('pluginState');
    expect(providerNames).toContain('pluginKnowledge');
    expect(providerNames).toContain('registryPlugins');
    expect(providerNames).toContain('pluginConfigurationStatus');
  });

  it('should have empty evaluators array', () => {
    expect(pluginManagerPlugin.evaluators).toBeDefined();
    expect(pluginManagerPlugin.evaluators).toHaveLength(0);
  });

  it('should have empty routes array', () => {
    expect(pluginManagerPlugin.routes).toBeDefined();
    expect(pluginManagerPlugin.routes).toHaveLength(0);
  });

  it('should have an init function', () => {
    expect(pluginManagerPlugin.init).toBeDefined();
    expect(typeof pluginManagerPlugin.init).toBe('function');
  });
});
