import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  emoji,
  getEmoji,
  configureEmojis,
  getEmojiConfig,
  areEmojisEnabled,
  withEmoji,
  initializeEmojiSupport,
} from '../../../src/utils/emoji-handler';

// Store original platform value
const originalPlatform = process.platform;

// Helper to mock platform
const mockPlatform = (platform: NodeJS.Platform) => {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
    writable: true,
  });
};

const restorePlatform = () => {
  Object.defineProperty(process, 'platform', {
    value: originalPlatform,
    configurable: true,
    writable: true,
  });
};

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
    delete process.env.PSModulePath;
    delete process.env.POWERSHELL_TELEMETRY_OPTOUT;

    // Reset config to defaults
    configureEmojis({ enabled: true, forceDisable: false });
    restorePlatform();
  });

  afterEach(() => {
    restorePlatform();
  });

  describe('getEmoji', () => {
    it('should return emoji when supported', () => {
      mockPlatform('darwin');
      process.env.TERM = 'xterm-256color';

      expect(getEmoji('success')).toBe('✅');
      expect(getEmoji('error')).toBe('❌');
      expect(getEmoji('warning')).toBe('⚠️');
      expect(getEmoji('info')).toBe('ℹ️');
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
      mockPlatform('win32');

      expect(getEmoji('success')).toBe('[OK]');
    });

    it('should return emoji on Windows with VS Code terminal', () => {
      mockPlatform('win32');
      process.env.TERM_PROGRAM = 'vscode';

      expect(getEmoji('success')).toBe('✅');
    });

    it('should handle unknown emoji key', () => {
      const result = getEmoji('invalid-key' as Parameters<typeof getEmoji>[0]);
      expect(result).toBe('');
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
      mockPlatform('darwin');
      process.env.TERM = 'xterm-256color';

      expect(areEmojisEnabled()).toBe(true);
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
      mockPlatform('darwin');
      process.env.TERM = 'xterm-256color';

      expect(withEmoji('success', 'Test message')).toBe('✅ Test message');
      expect(withEmoji('error', 'Error message')).toBe('❌ Error message');
    });

    it('should format message with fallback when not supported', () => {
      configureEmojis({ forceDisable: true });

      expect(withEmoji('success', 'Test message')).toBe('[OK] Test message');
      expect(withEmoji('error', 'Error message')).toBe('[ERROR] Error message');
    });

    it('should handle spacing parameter', () => {
      mockPlatform('darwin');
      process.env.TERM = 'xterm-256color';

      expect(withEmoji('bullet', 'Item', false)).toBe('•Item');
      expect(withEmoji('bullet', 'Item', true)).toBe('• Item');
    });
  });

  describe('emoji utility functions', () => {
    beforeEach(() => {
      mockPlatform('darwin');
      process.env.TERM = 'xterm-256color';
    });

    it('should format success messages', () => {
      expect(emoji.success('Success.')).toBe('✅ Success.');
    });

    it('should format error messages', () => {
      expect(emoji.error('Error.')).toBe('❌ Error.');
    });

    it('should format warning messages', () => {
      expect(emoji.warning('Warning.')).toBe('⚠️ Warning.');
    });

    it('should format info messages', () => {
      expect(emoji.info('Info.')).toBe('ℹ️ Info.');
    });

    it('should format rocket messages', () => {
      expect(emoji.rocket('Launch.')).toBe('🚀 Launch.');
    });

    it('should format package messages', () => {
      expect(emoji.package('Package.')).toBe('📦 Package.');
    });

    it('should format link messages', () => {
      expect(emoji.link('Link.')).toBe('🔗 Link.');
    });

    it('should format tip messages', () => {
      expect(emoji.tip('Tip.')).toBe('💡 Tip.');
    });

    it('should format list messages', () => {
      expect(emoji.list('List.')).toBe('📋 List.');
    });

    it('should format penguin messages', () => {
      expect(emoji.penguin('Linux.')).toBe('🐧 Linux.');
    });

    it('should format bullet messages', () => {
      expect(emoji.bullet('Item')).toBe('• Item');
    });
  });

  describe('initializeEmojiSupport', () => {
    it('should not throw when called', () => {
      mockPlatform('darwin');
      process.env.TERM = 'xterm-256color';

      expect(() => initializeEmojiSupport()).not.toThrow();
    });

    it('should handle various environments gracefully', () => {
      // Test in CI mode
      process.env.CI = 'true';
      expect(() => initializeEmojiSupport()).not.toThrow();

      // Test with DEBUG enabled
      delete process.env.CI;
      process.env.DEBUG = 'true';
      expect(() => initializeEmojiSupport()).not.toThrow();
    });
  });

  describe('platform-specific emoji support', () => {
    it('should support emojis on Linux with proper terminal', () => {
      mockPlatform('linux');
      process.env.TERM = 'xterm-256color';

      expect(getEmoji('success')).toBe('✅');
    });

    it('should support emojis with COLORTERM set', () => {
      mockPlatform('linux');
      process.env.COLORTERM = 'truecolor';

      expect(getEmoji('success')).toBe('✅');
    });

    it('should detect Windows Terminal support', () => {
      mockPlatform('win32');
      process.env.WT_SESSION = 'some-session-id';

      expect(getEmoji('success')).toBe('✅');
    });

    it('should detect PowerShell 7+ support', () => {
      mockPlatform('win32');
      process.env.PSModulePath = 'C:\\Program Files\\PowerShell\\7\\Modules';
      process.env.POWERSHELL_TELEMETRY_OPTOUT = '1';

      expect(getEmoji('success')).toBe('✅');
    });

    it('should not support emojis in GitHub Actions', () => {
      process.env.GITHUB_ACTIONS = 'true';

      expect(getEmoji('success')).toBe('[OK]');
    });
  });
});
