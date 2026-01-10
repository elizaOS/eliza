import { describe, expect, it } from 'bun:test';
import { stagehandPlugin } from '../index';
import { BrowserSession } from '../service';

describe('Stagehand Plugin Simple Tests', () => {
  describe('Plugin Structure', () => {
    it('should have correct plugin metadata', () => {
      expect(stagehandPlugin.name).toBe('plugin-stagehand');
      expect(stagehandPlugin.description).toBeDefined();
      expect(stagehandPlugin.actions).toBeDefined();
      expect(stagehandPlugin.providers).toBeDefined();
      expect(stagehandPlugin.services).toBeDefined();
    });

    it('should have BROWSER_NAVIGATE action', () => {
      const action = stagehandPlugin.actions?.find((a) => a.name === 'BROWSER_NAVIGATE');
      expect(action).toBeDefined();
      expect(action?.similes).toContain('GO_TO_URL');
      expect(action?.similes).toContain('OPEN_WEBSITE');
      expect(action?.validate).toBeDefined();
      expect(action?.handler).toBeDefined();
    });

    it('should have BROWSER_STATE provider', () => {
      const provider = stagehandPlugin.providers?.find((p) => p.name === 'BROWSER_STATE');
      expect(provider).toBeDefined();
      expect(provider?.get).toBeDefined();
      expect(provider?.description).toContain('browser state');
    });

    it('should have examples for BROWSER_NAVIGATE', () => {
      const action = stagehandPlugin.actions?.find((a) => a.name === 'BROWSER_NAVIGATE');
      expect(action?.examples).toBeDefined();
      expect(Array.isArray(action?.examples)).toBe(true);
      expect(action?.examples?.length).toBeGreaterThan(0);

      const example = action?.examples?.[0];
      expect(Array.isArray(example)).toBe(true);
      expect(example?.[0].name).toBe('{{user}}');
      expect(example?.[1].name).toBe('{{agent}}');
      expect(example?.[1].content.actions).toContain('BROWSER_NAVIGATE');
    });
  });

  describe('BrowserSession', () => {
    it('should create a session with correct properties', () => {
      const session = new BrowserSession('test-123');
      expect(session.id).toBe('test-123');
      expect(session.createdAt).toBeInstanceOf(Date);
    });
  });

  describe('URL Validation', () => {
    it('should validate URLs in action', async () => {
      const action = stagehandPlugin.actions?.find((a) => a.name === 'BROWSER_NAVIGATE');

      const mockRuntime = {
        getService: () => ({ getCurrentSession: async () => ({ id: 'test' }) }),
        getSetting: () => 'true',
      };

      const validMessage = {
        content: { text: 'Navigate to https://google.com', source: 'test' },
      };

      const invalidMessage = {
        content: { text: 'Just some text without URL', source: 'test' },
      };

      expect(await action?.validate(mockRuntime as any, validMessage as any, {} as any)).toBe(true);
      expect(await action?.validate(mockRuntime as any, invalidMessage as any, {} as any)).toBe(
        false
      );
    });
  });
});
