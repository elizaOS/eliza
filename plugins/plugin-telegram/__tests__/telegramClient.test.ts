import { describe, expect, it } from 'bun:test';

describe('TelegramService', () => {
  describe('module exports', () => {
    it('should export TelegramService', async () => {
      const serviceModule = await import('../src/service');
      expect(serviceModule.TelegramService).toBeDefined();
      expect(typeof serviceModule.TelegramService).toBe('function');
    });
  });

  describe('plugin export', () => {
    it('should export telegram plugin', async () => {
      const pluginModule = await import('../src/index');
      expect(pluginModule.default).toBeDefined();
      expect(pluginModule.default.name).toBe('telegram');
      expect(pluginModule.default.description).toBe('Telegram client plugin');
    });
  });
});
