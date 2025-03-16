import { describe, expect, it } from 'vitest';
import { escapeMarkdown, splitMessage } from '../src/utils';

describe('Telegram Utils', () => {
  describe('escapeMarkdown', () => {
    it('should escape markdown special characters', () => {
      const input = '*bold* _italic_ `code`';
      const escaped = escapeMarkdown(input);
      expect(escaped).toBe('\\*bold\\* \\_italic\\_ \\`code\\`');
    });

    it('should handle text without special characters', () => {
      const input = 'Hello World 123';
      expect(escapeMarkdown(input)).toBe(input);
    });

    it('should handle empty string', () => {
      expect(escapeMarkdown('')).toBe('');
    });
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

    it('should keep message intact if shorter than maxLength', () => {
      const message = 'Hello World';
      const chunks = splitMessage(message, 6);
      expect(chunks).toEqual(['Hello World']);
    });
  });
});
