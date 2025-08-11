import { describe, it, expect } from 'vitest';

describe('Block Number Parsing', () => {
  describe('text extraction', () => {
    it('should extract block numbers from various text formats', () => {
      const testCases = [
        {
          text: 'get logs for the block 22627906',
          expected: 22627906,
        },
        {
          text: 'show me block 12345',
          expected: 12345,
        },
        {
          text: 'fetch logs for block 999999',
          expected: 999999,
        },
        {
          text: 'get logs from block 100 to block 200',
          expected: 100, // Should extract first block number
        },
      ];

      testCases.forEach(({ text, expected }) => {
        const specificBlockMatch = text.match(/(?:for\s+(?:the\s+)?block|block)\s+(\d+)/i);
        if (specificBlockMatch) {
          const blockNumber = parseInt(specificBlockMatch[1]);
          expect(blockNumber).toBe(expected);
        }
      });
    });

    it('should extract block ranges', () => {
      const text = 'get logs from block 100 to block 200';

      const fromBlockMatch = text.match(/from\s+block\s+(\d+)/i);
      const toBlockMatch = text.match(/to\s+block\s+(\d+)/i);

      expect(fromBlockMatch).toBeTruthy();
      expect(toBlockMatch).toBeTruthy();

      if (fromBlockMatch && toBlockMatch) {
        expect(parseInt(fromBlockMatch[1])).toBe(100);
        expect(parseInt(toBlockMatch[1])).toBe(200);
      }
    });

    it('should handle missing block numbers gracefully', () => {
      const text = 'get logs for contract address';

      const specificBlockMatch = text.match(/(?:for\s+(?:the\s+)?block|block)\s+(\d+)/i);
      expect(specificBlockMatch).toBeNull();
    });
  });

  describe('hex conversion', () => {
    it('should convert decimal to hex format', () => {
      const testCases = [
        { decimal: 22627906, hex: '0x1594642' },
        { decimal: 12345, hex: '0x3039' },
        { decimal: 999999, hex: '0xf423f' },
        { decimal: 1000000, hex: '0xf4240' },
      ];

      testCases.forEach(({ decimal, hex }) => {
        const result = `0x${decimal.toString(16)}`;
        expect(result).toBe(hex);
      });
    });

    it('should convert hex to decimal format', () => {
      const testCases = [
        { hex: '0x1594642', decimal: 22627906 },
        { hex: '0x3039', decimal: 12345 },
        { hex: '0xf423f', decimal: 999999 },
        { hex: '0xf4240', decimal: 1000000 },
      ];

      testCases.forEach(({ hex, decimal }) => {
        const result = parseInt(hex, 16);
        expect(result).toBe(decimal);
      });
    });

    it('should handle invalid hex values', () => {
      const invalidHex = '0xzzzz';
      const result = parseInt(invalidHex, 16);
      expect(isNaN(result)).toBe(true);
    });
  });

  describe('block tag handling', () => {
    it('should recognize special block tags', () => {
      const blockTags = ['latest', 'earliest', 'pending'];

      blockTags.forEach((tag) => {
        const isValidTag = /^(latest|earliest|pending)$/i.test(tag);
        expect(isValidTag).toBe(true);
      });
    });

    it('should validate numeric block numbers', () => {
      const validNumbers = ['123', '0', '999999'];
      const invalidNumbers = ['abc', '-1', '1.5'];

      validNumbers.forEach((num) => {
        const isValid = /^\d+$/.test(num);
        expect(isValid).toBe(true);
      });

      invalidNumbers.forEach((num) => {
        const isValid = /^\d+$/.test(num);
        expect(isValid).toBe(false);
      });
    });
  });

  describe('range validation', () => {
    it('should validate block ranges', () => {
      const ranges = [
        { from: 100, to: 200, valid: true },
        { from: 200, to: 100, valid: false }, // Invalid: from > to
        { from: 100, to: 100, valid: true }, // Valid: same block
        { from: 0, to: 999999, valid: true },
      ];

      ranges.forEach(({ from, to, valid }) => {
        const isValid = from <= to;
        expect(isValid).toBe(valid);
      });
    });

    it('should limit range size for performance', () => {
      const maxRangeSize = 10000;

      const ranges = [
        { from: 100, to: 200, withinLimit: true },
        { from: 100, to: 20000, withinLimit: false },
        { from: 0, to: 5000, withinLimit: true },
      ];

      ranges.forEach(({ from, to, withinLimit }) => {
        const rangeSize = to - from;
        const isWithinLimit = rangeSize <= maxRangeSize;
        expect(isWithinLimit).toBe(withinLimit);
      });
    });
  });
});
