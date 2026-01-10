import { describe, it, expect } from 'bun:test';
import {
  knowledgePlugin,
  knowledgePluginCore,
  knowledgePluginHeadless,
  createKnowledgePlugin,
  KnowledgeService,
  knowledgeProvider,
  type KnowledgePluginConfig,
} from '../src/index';

describe('Knowledge Plugin Exports', () => {
  it('should export the default full plugin', () => {
    expect(knowledgePlugin).toBeDefined();
    expect(knowledgePlugin.name).toBe('knowledge');
    expect(knowledgePlugin.services).toBeDefined();
    expect(knowledgePlugin.providers).toBeDefined();
    expect(knowledgePlugin.routes).toBeDefined();
    expect(knowledgePlugin.actions).toBeDefined();
    expect(knowledgePlugin.tests).toBeDefined();
  });

  it('should export the core plugin (service + provider only)', () => {
    expect(knowledgePluginCore).toBeDefined();
    expect(knowledgePluginCore.name).toBe('knowledge');
    expect(knowledgePluginCore.services).toBeDefined();
    expect(knowledgePluginCore.providers).toBeDefined();
    expect(knowledgePluginCore.routes).toBeUndefined();
    expect(knowledgePluginCore.actions).toBeUndefined();
    expect(knowledgePluginCore.tests).toBeUndefined();
  });

  it('should export the headless plugin (service + provider + actions)', () => {
    expect(knowledgePluginHeadless).toBeDefined();
    expect(knowledgePluginHeadless.name).toBe('knowledge');
    expect(knowledgePluginHeadless.services).toBeDefined();
    expect(knowledgePluginHeadless.providers).toBeDefined();
    expect(knowledgePluginHeadless.actions).toBeDefined();
    expect(knowledgePluginHeadless.routes).toBeUndefined();
    expect(knowledgePluginHeadless.tests).toBeUndefined();
  });

  it('should export the createKnowledgePlugin factory function', () => {
    expect(createKnowledgePlugin).toBeDefined();
    expect(typeof createKnowledgePlugin).toBe('function');
  });

  it('should create a custom plugin with specific configuration', () => {
    const customPlugin = createKnowledgePlugin({
      enableUI: false,
      enableRoutes: false,
      enableActions: true,
      enableTests: false,
    });

    expect(customPlugin).toBeDefined();
    expect(customPlugin.name).toBe('knowledge');
    expect(customPlugin.services).toBeDefined();
    expect(customPlugin.providers).toBeDefined();
    expect(customPlugin.actions).toBeDefined();
    expect(customPlugin.routes).toBeUndefined();
    expect(customPlugin.tests).toBeUndefined();
  });

  it('should export KnowledgeService class', () => {
    expect(KnowledgeService).toBeDefined();
    expect(KnowledgeService.serviceType).toBe('knowledge');
  });

  it('should export knowledgeProvider', () => {
    expect(knowledgeProvider).toBeDefined();
    expect(knowledgeProvider.name).toBe('KNOWLEDGE');
  });

  it('should create plugin with all features enabled by default', () => {
    const defaultPlugin = createKnowledgePlugin();

    expect(defaultPlugin.services).toBeDefined();
    expect(defaultPlugin.providers).toBeDefined();
    expect(defaultPlugin.routes).toBeDefined();
    expect(defaultPlugin.actions).toBeDefined();
    expect(defaultPlugin.tests).toBeDefined();
  });

  it('should create plugin with only UI disabled', () => {
    const noUIPlugin = createKnowledgePlugin({
      enableUI: false,
      enableRoutes: true,
      enableActions: true,
      enableTests: true,
    });

    expect(noUIPlugin.routes).toBeDefined(); // Routes still enabled
    expect(noUIPlugin.actions).toBeDefined();
    expect(noUIPlugin.tests).toBeDefined();
  });

  it('should create plugin with no routes when both UI and routes disabled', () => {
    const noRoutesPlugin = createKnowledgePlugin({
      enableUI: false,
      enableRoutes: false,
    });

    expect(noRoutesPlugin.routes).toBeUndefined();
  });
});
