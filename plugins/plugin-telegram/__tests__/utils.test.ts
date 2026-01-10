import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';

// Mock telegraf before importing
mock.module('telegraf', () => ({
  Markup: {
    button: {
      url: mock((text: string, url: string) => ({ text, url, type: 'url' })),
      login: mock((text: string, url: string) => ({ text, url, type: 'login' })),
    },
  },
}));

// Mock logger
const warnSpy = mock();
mock.module('@elizaos/core', () => ({
  logger: {
    debug: mock(),
    info: mock(),
    warn: warnSpy,
    error: mock(),
  },
}));

import {
  convertToTelegramButtons,
  convertMarkdownToTelegram,
  splitMessage,
  cleanText,
} from '../src/utils';
import type { Button } from '../src/types';

describe('Telegram Utils', () => {
  afterEach(() => {
    mock.restore();
  });

  describe('splitMessage', () => {
    it('should not split message within limit', () => {
      const message = 'Hello World';
      const chunks = splitMessage(message, 4096);
      expect(chunks).toEqual(['Hello World']);
    });

    it('should handle empty string', () => {
      const chunks = splitMessage('');
      expect(chunks).toEqual([]);
    });

    it('should split at line boundaries', () => {
      const line1 = 'a'.repeat(3000);
      const line2 = 'b'.repeat(2000);
      const message = `${line1}\n${line2}`;
      const chunks = splitMessage(message, 4096);
      expect(chunks.length).toBe(2);
      expect(chunks[0]).toBe(line1);
      expect(chunks[1]).toBe(line2);
    });
  });

  describe('convertMarkdownToTelegram', () => {
    it('should handle text without special characters', () => {
      const input = 'Hello World 123';
      expect(convertMarkdownToTelegram(input)).toBe(input);
    });

    it('should handle empty string', () => {
      expect(convertMarkdownToTelegram('')).toBe('');
    });

    it('should convert headers to bold text', () => {
      const result = convertMarkdownToTelegram('# Header 1');
      expect(result).toContain('*Header 1*');
    });

    it('should convert bold text correctly', () => {
      const result = convertMarkdownToTelegram('This is **bold text**');
      expect(result).toBe('This is *bold text*');
    });

    it('should convert italic text correctly', () => {
      const result = convertMarkdownToTelegram('This is *italic text*');
      expect(result).toBe('This is _italic text_');
    });

    it('should convert strikethrough text correctly', () => {
      const result = convertMarkdownToTelegram('This is ~~strikethrough text~~');
      expect(result).toBe('This is ~strikethrough text~');
    });

    it('should convert inline code correctly', () => {
      const result = convertMarkdownToTelegram('This is `inline code`');
      expect(result).toBe('This is `inline code`');
    });

    it('should escape special characters correctly', () => {
      const result = convertMarkdownToTelegram(
        'These chars: _ * [ ] ( ) ~ ` > # + - = | { } . ! \\'
      );
      expect(result).toBe(
        'These chars: \\_ \\* \\[ \\] \\( \\) \\~ \\` \\> \\# \\+ \\- \\= \\| \\{ \\} \\. \\! \\\\'
      );
    });

    it('should handle mixed formatting correctly', () => {
      const result = convertMarkdownToTelegram(
        '**Bold** and *italic* and `code` and ~~strikethrough~~'
      );
      expect(result).toBe('*Bold* and _italic_ and `code` and ~strikethrough~');
    });
  });

  describe('cleanText', () => {
    it('should remove NULL characters', () => {
      const result = cleanText('Hello\u0000World');
      expect(result).toBe('HelloWorld');
    });

    it('should handle empty strings', () => {
      expect(cleanText('')).toBe('');
      expect(cleanText(null)).toBe('');
      expect(cleanText(undefined)).toBe('');
    });
  });

  describe('convertToTelegramButtons', () => {
    it('should convert valid URL buttons correctly', () => {
      const buttons: Button[] = [{ kind: 'url', text: 'Click me', url: 'https://example.com' }];

      const result = convertToTelegramButtons(buttons);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        text: 'Click me',
        url: 'https://example.com',
        type: 'url',
      });
    });

    it('should convert valid login buttons correctly', () => {
      const buttons: Button[] = [
        { kind: 'login', text: 'Login', url: 'https://login.example.com' },
      ];

      const result = convertToTelegramButtons(buttons);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        text: 'Login',
        url: 'https://login.example.com',
        type: 'login',
      });
    });

    it('should handle multiple buttons', () => {
      const buttons: Button[] = [
        { kind: 'url', text: 'Button 1', url: 'https://example1.com' },
        { kind: 'url', text: 'Button 2', url: 'https://example2.com' },
        { kind: 'login', text: 'Login', url: 'https://login.com' },
      ];

      const result = convertToTelegramButtons(buttons);

      expect(result).toHaveLength(3);
    });

    // THE BUG WE FIXED: Unknown button kinds should not crash
    it('should handle unknown button kinds with default fallback', () => {
      const buttons: Button[] = [
        { kind: 'unknown' as any, text: 'Unknown Type', url: 'https://example.com' },
      ];

      const result = convertToTelegramButtons(buttons);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        text: 'Unknown Type',
        url: 'https://example.com',
        type: 'url', // Should default to URL button
      });
    });

    // THE BUG WE FIXED: Invalid buttons should be skipped, not crash
    it('should skip buttons with missing text', () => {
      const buttons: Button[] = [
        { kind: 'url', text: '', url: 'https://example.com' },
        { kind: 'url', text: 'Valid', url: 'https://example.com' },
      ];

      const result = convertToTelegramButtons(buttons);

      expect(result).toHaveLength(1);
      expect(result[0].text).toBe('Valid');
    });

    it('should skip buttons with missing url', () => {
      const buttons: Button[] = [
        { kind: 'url', text: 'Click', url: '' },
        { kind: 'url', text: 'Valid', url: 'https://example.com' },
      ];

      const result = convertToTelegramButtons(buttons);

      expect(result).toHaveLength(1);
      expect(result[0].text).toBe('Valid');
    });

    it('should skip null/undefined buttons in array', () => {
      const buttons: (Button | null | undefined)[] = [
        null,
        { kind: 'url', text: 'Valid', url: 'https://example.com' },
        undefined,
        { kind: 'url', text: 'Also Valid', url: 'https://example2.com' },
      ];

      const result = convertToTelegramButtons(buttons as Button[]);

      expect(result).toHaveLength(2);
    });

    it('should handle empty button array', () => {
      const result = convertToTelegramButtons([]);
      expect(result).toHaveLength(0);
    });

    it('should handle null input', () => {
      const result = convertToTelegramButtons(null);
      expect(result).toHaveLength(0);
    });

    it('should handle undefined input', () => {
      const result = convertToTelegramButtons(undefined);
      expect(result).toHaveLength(0);
    });

    // Edge case: All buttons invalid
    it('should return empty array when all buttons are invalid', () => {
      const buttons: Button[] = [
        { kind: 'url', text: '', url: 'https://example.com' },
        { kind: 'url', text: 'Click', url: '' },
        null as any,
      ];

      const result = convertToTelegramButtons(buttons);

      expect(result).toHaveLength(0);
    });
  });
});
