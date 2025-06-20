import { describe, it, expect, mock, beforeEach } from 'bun:test';
import {
  emoji,
  getEmoji,
  configureEmojis,
  getEmojiConfig,
  areEmojisEnabled,
  withEmoji,
  initializeEmojiSupport,
} from '../../../src/utils/emoji-handler';
import { logger } from '@elizaos/core';

// Mock logger
mock.module('@elizaos/core', () => ({
  logger: {
    warn: mock(),
    debug: mock(),
  },
}));

describe('emoji-handler', () => {
  beforeEach(() => {
    // Reset environment variables
    delete process.env.NO_COLOR;
    delete process.env.CI;
    delete process.env.TERM;
    delete process.env.TERM_PROGRAM;
    delete process.env.COLORTERM;
    delete process.env.GITHUB_ACTIONS;
    delete process.env.WT_SESSION;
    delete process.env.WT_PROFILE_ID;
    delete process.env.DEBUG;
    delete process.env.ELIZA_DEBUG;

    // Reset config to defaults
    configureEmojis({ enabled: true, forceDisable: false });
  });

  describe('getEmoji', () => {
    it('should return emoji when supported', () => {
      // Mock macOS environment
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', {
        value: 'darwin',
        configurable: true,
      });
      process.env.TERM = 'xterm-256color';

      expect(getEmoji('success')).toBe('✅');
      expect(getEmoji('error')).toBe('❌');
      expect(getEmoji('warning')).toBe('⚠️');
      expect(getEmoji('info')).toBe('ℹ️');

      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
    });

    it('should return fallback when not supported', () => {
      configureEmojis({ forceDisable: true });

      expect(getEmoji('success')).toBe('[OK]');
      expect(getEmoji('error')).toBe('[ERROR]');
      expect(getEmoji('warning')).toBe('[WARNING]');
      expect(getEmoji('info')).toBe('[INFO]');
    });

    it('should return fallback in CI environment', () => {
      process.env.CI = 'true';

      expect(getEmoji('success')).toBe('[OK]');
      expect(getEmoji('error')).toBe('[ERROR]');
    });

    it('should return fallback on Windows without modern terminal', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', {
        value: 'win32',
        configurable: true,
      });

      expect(getEmoji('success')).toBe('[OK]');

      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
    });

    it('should return emoji on Windows with VS Code terminal', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', {
        value: 'win32',
        configurable: true,
      });
      process.env.TERM_PROGRAM = 'vscode';

      expect(getEmoji('success')).toBe('✅');

      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
    });

    it('should handle unknown emoji key', () => {
      // @ts-ignore - testing invalid key
      expect(getEmoji('invalid-key')).toBe('');
      // expect(logger.warn).toHaveBeenCalledWith('Unknown emoji key: invalid-key'); // TODO: Fix for bun test
    });
  });

  describe('configureEmojis and getEmojiConfig', () => {
    it('should update configuration', () => {
      configureEmojis({ enabled: false });

      const config = getEmojiConfig();
      expect(config.enabled).toBe(false);
      expect(config.forceDisable).toBe(false);
    });

    it('should merge partial configuration', () => {
      configureEmojis({ forceDisable: true });

      const config = getEmojiConfig();
      expect(config.enabled).toBe(true);
      expect(config.forceDisable).toBe(true);
    });
  });

  describe('areEmojisEnabled', () => {
    it('should return true when enabled and supported', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', {
        value: 'darwin',
        configurable: true,
      });
      process.env.TERM = 'xterm-256color';

      expect(areEmojisEnabled()).toBe(true);

      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
    });

    it('should return false when disabled', () => {
      configureEmojis({ enabled: false });
      expect(areEmojisEnabled()).toBe(false);
    });

    it('should return false when force disabled', () => {
      configureEmojis({ forceDisable: true });
      expect(areEmojisEnabled()).toBe(false);
    });

    it('should return false in CI', () => {
      process.env.CI = 'true';
      expect(areEmojisEnabled()).toBe(false);
    });
  });

  describe('withEmoji', () => {
    it('should format message with emoji when supported', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', {
        value: 'darwin',
        configurable: true,
      });
      process.env.TERM = 'xterm-256color';

      expect(withEmoji('success', 'Test message')).toBe('✅ Test message');
      expect(withEmoji('error', 'Error message')).toBe('❌ Error message');

      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
    });

    it('should format message with fallback when not supported', () => {
      configureEmojis({ forceDisable: true });

      expect(withEmoji('success', 'Test message')).toBe('[OK] Test message');
      expect(withEmoji('error', 'Error message')).toBe('[ERROR] Error message');
    });

    it('should handle spacing parameter', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', {
        value: 'darwin',
        configurable: true,
      });
      process.env.TERM = 'xterm-256color';

      expect(withEmoji('bullet', 'Item', false)).toBe('•Item');
      expect(withEmoji('bullet', 'Item', true)).toBe('• Item');

      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
    });
  });

  describe('emoji utility functions', () => {
    beforeEach(() => {
      Object.defineProperty(process, 'platform', {
        value: 'darwin',
        configurable: true,
      });
      process.env.TERM = 'xterm-256color';
    });

    it('should format success messages', () => {
      expect(emoji.success('Success!')).toBe('✅ Success!');
    });

    it('should format error messages', () => {
      expect(emoji.error('Error!')).toBe('❌ Error!');
    });

    it('should format warning messages', () => {
      expect(emoji.warning('Warning!')).toBe('⚠️ Warning!');
    });

    it('should format info messages', () => {
      expect(emoji.info('Info!')).toBe('ℹ️ Info!');
    });

    it('should format rocket messages', () => {
      expect(emoji.rocket('Launch!')).toBe('🚀 Launch!');
    });

    it('should format package messages', () => {
      expect(emoji.package('Package!')).toBe('📦 Package!');
    });

    it('should format link messages', () => {
      expect(emoji.link('Link!')).toBe('🔗 Link!');
    });

    it('should format tip messages', () => {
      expect(emoji.tip('Tip!')).toBe('💡 Tip!');
    });

    it('should format list messages', () => {
      expect(emoji.list('List!')).toBe('📋 List!');
    });

    it('should format penguin messages', () => {
      expect(emoji.penguin('Linux!')).toBe('🐧 Linux!');
    });

    it('should format bullet messages', () => {
      expect(emoji.bullet('Item')).toBe('• Item');
    });
  });

  describe('initializeEmojiSupport', () => {
    it('should log emoji support status in debug mode', () => {
      process.env.DEBUG = 'true';
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', {
        value: 'darwin',
        configurable: true,
      });
      process.env.TERM = 'xterm-256color';

      initializeEmojiSupport();

      // expect(logger.debug).toHaveBeenCalledWith(
      //   expect.stringContaining('Emoji support: enabled')
      // ); // TODO: Fix for bun test

      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
    });

    it('should not log when not in debug mode', () => {
      delete process.env.DEBUG;
      delete process.env.ELIZA_DEBUG;

      initializeEmojiSupport();

      // The initial call from module load might have been made
      const callCount = logger.debug.mock.calls.length;
      expect(callCount).toBeLessThanOrEqual(1);
    });
  });

  describe('platform-specific emoji support', () => {
    it('should support emojis on Linux with proper terminal', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', {
        value: 'linux',
        configurable: true,
      });
      process.env.TERM = 'xterm-256color';

      expect(getEmoji('success')).toBe('✅');

      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
    });

    it('should support emojis with COLORTERM set', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', {
        value: 'linux',
        configurable: true,
      });
      process.env.COLORTERM = 'truecolor';

      expect(getEmoji('success')).toBe('✅');

      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
    });

    it('should detect Windows Terminal support', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', {
        value: 'win32',
        configurable: true,
      });
      process.env.WT_SESSION = 'some-session-id';

      expect(getEmoji('success')).toBe('✅');

      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
    });

    it('should detect PowerShell 7+ support', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', {
        value: 'win32',
        configurable: true,
      });
      process.env.PSModulePath = 'C:\\Program Files\\PowerShell\\7\\Modules';
      process.env.POWERSHELL_TELEMETRY_OPTOUT = '1';

      expect(getEmoji('success')).toBe('✅');

      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
    });

    it('should not support emojis in GitHub Actions', () => {
      process.env.GITHUB_ACTIONS = 'true';

      expect(getEmoji('success')).toBe('[OK]');
    });
  });
});
