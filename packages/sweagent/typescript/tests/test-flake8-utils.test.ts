/**
 * Tests for Flake8 utilities
 * Converted from tests/tools/test_split_string.py
 */

import { describe, it, expect } from '@jest/globals';
import { Flake8ErrorClass, formatFlake8Output } from '../src/tools/flake8-utils';

describe('Flake8 Utils', () => {
  describe('Flake8Error parsing', () => {
    it('should parse flake8 error line correctly', () => {
      const line = 'existing_lint error.py:12:41: E999 SyntaxError: invalid syntax';
      const error = Flake8ErrorClass.fromLine(line);

      expect(error.file).toBe('existing_lint error.py');
      expect(error.line).toBe(12);
      expect(error.column).toBe(41);
      expect(error.message).toBe('E999 SyntaxError: invalid syntax');
    });

    it('should handle file paths with spaces', () => {
      const line = 'my file.py:5:10: E301 expected 1 blank line';
      const error = Flake8ErrorClass.fromLine(line);

      expect(error.file).toBe('my file.py');
      expect(error.line).toBe(5);
      expect(error.column).toBe(10);
      expect(error.message).toBe('E301 expected 1 blank line');
    });

    it('should throw on invalid line format', () => {
      const invalidLine = 'not a valid flake8 line';

      expect(() => Flake8ErrorClass.fromLine(invalidLine)).toThrow();
    });
  });

  describe('formatFlake8Output', () => {
    it('should return empty string when no new errors', () => {
      const result = formatFlake8Output('a:12:41: e', 'a:12:41: e', [50, 51], 10, false);

      expect(result).toBe('');
    });

    it('should return empty string when error outside replacement window', () => {
      const result = formatFlake8Output('a:12:41: e', 'a:13:41: e', [1, 2], 1, false);

      expect(result).toBe('');
    });

    it('should return empty string without line numbers', () => {
      const result = formatFlake8Output('a:12:41: e', 'a:13:41: e', [1, 2], 1, false);

      expect(result).toBe('');
    });

    it('should format new error without line numbers', () => {
      const result = formatFlake8Output('a:12:41: e', 'a:13:41: e', [12, 13], 10, false);

      expect(result).toBe('- e');
    });

    it('should format new error with line numbers', () => {
      const result = formatFlake8Output('a:12:41: e', 'a:13:41: e', [12, 13], 10, true);

      expect(result).toBe('- line 12 col 41: e');
    });

    it('should handle multiple errors', () => {
      const currentErrors = `file.py:10:5: E301 expected 1 blank line
file.py:15:10: W292 no newline at end of file
file.py:20:1: E302 expected 2 blank lines`;

      const previousErrors = `file.py:10:5: E301 expected 1 blank line`;

      const result = formatFlake8Output(currentErrors, previousErrors, [14, 16], 3, true);

      // Line 15 is in the replacement window, should show new errors
      const lines = result.split('\n');
      expect(lines.length).toBeGreaterThan(0);
      expect(result).toContain('E302');
    });

    it('should adjust line numbers after replacement', () => {
      const currentErrors = 'file.py:25:1: E302 expected 2 blank lines';
      const previousErrors = 'file.py:20:1: E302 expected 2 blank lines';

      // Replaced lines 10-12 (3 lines) with 8 lines (net +5 lines)
      const result = formatFlake8Output(currentErrors, previousErrors, [10, 12], 8, true);

      // Previous error at line 20 should now be at line 25 (20 + 5)
      // So current error at line 25 matches adjusted previous error
      expect(result).toBe('');
    });
  });
});
