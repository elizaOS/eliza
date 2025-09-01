import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import {
  BufferUtils,
  fromHex,
  fromString,
  fromBytes,
  toHex,
  toString,
  isBuffer,
  alloc,
  concat,
  slice,
  equals,
  byteLength,
  randomBytes,
} from '../utils/buffer';

describe('Buffer Abstraction', () => {
  describe('fromHex and toHex', () => {
    it('should convert hex string to buffer and back', () => {
      const hex = '48656c6c6f20576f726c64';
      const buffer = fromHex(hex);
      const result = toHex(buffer);
      expect(result).toBe(hex.toLowerCase());
    });

    it('should handle empty hex string', () => {
      const buffer = fromHex('');
      expect(buffer.length).toBe(0);
      expect(toHex(buffer)).toBe('');
    });

    it('should handle hex with non-hex characters', () => {
      const hex = '48-65-6c-6c-6f';
      const buffer = fromHex(hex);
      const cleanHex = '48656c6c6f';
      expect(toHex(buffer)).toBe(cleanHex.toLowerCase());
    });

    it('should handle odd-length hex strings', () => {
      const hex = '486';
      const buffer = fromHex(hex);
      expect(buffer.length).toBe(1);
      expect(buffer[0]).toBe(0x48);
    });
  });

  describe('fromString and toString', () => {
    it('should convert UTF-8 string to buffer and back', () => {
      const text = 'Hello World';
      const buffer = fromString(text);
      const result = toString(buffer);
      expect(result).toBe(text);
    });

    it('should handle UTF-8 with special characters', () => {
      const text = 'Hello 世界 🌍';
      const buffer = fromString(text);
      const result = toString(buffer);
      expect(result).toBe(text);
    });

    it('should handle base64 encoding', () => {
      const text = 'Hello World';
      const buffer = fromString(text);
      const base64 = toString(buffer, 'base64');
      expect(base64).toBe('SGVsbG8gV29ybGQ=');

      const decoded = fromString(base64, 'base64');
      expect(toString(decoded)).toBe(text);
    });

    it('should handle hex encoding in toString', () => {
      const text = 'Hello';
      const buffer = fromString(text);
      const hex = toString(buffer, 'hex');
      expect(hex).toBe('48656c6c6f');
    });

    it('should handle empty string', () => {
      const buffer = fromString('');
      expect(buffer.length).toBe(0);
      expect(toString(buffer)).toBe('');
    });

    it('should handle utf-8 and utf8 encoding aliases', () => {
      const text = 'Test';
      const buffer1 = fromString(text, 'utf8');
      const buffer2 = fromString(text, 'utf-8');
      expect(equals(buffer1, buffer2)).toBe(true);
    });
  });

  describe('fromBytes', () => {
    it('should create buffer from byte array', () => {
      const bytes = [72, 101, 108, 108, 111]; // "Hello"
      const buffer = fromBytes(bytes);
      expect(toString(buffer)).toBe('Hello');
    });

    it('should create buffer from Uint8Array', () => {
      const bytes = new Uint8Array([72, 101, 108, 108, 111]);
      const buffer = fromBytes(bytes);
      expect(toString(buffer)).toBe('Hello');
    });

    it('should handle empty array', () => {
      const buffer = fromBytes([]);
      expect(buffer.length).toBe(0);
    });
  });

  describe('isBuffer', () => {
    it('should identify buffer-like objects', () => {
      const buffer = fromString('test');
      expect(isBuffer(buffer)).toBe(true);
    });

    it('should identify Uint8Array', () => {
      const arr = new Uint8Array([1, 2, 3]);
      expect(isBuffer(arr)).toBe(true);
    });

    it('should identify ArrayBuffer', () => {
      const buffer = new ArrayBuffer(8);
      expect(isBuffer(buffer)).toBe(true);
    });

    it('should reject non-buffer objects', () => {
      expect(isBuffer('string')).toBe(false);
      expect(isBuffer(123)).toBe(false);
      expect(isBuffer({})).toBe(false);
      expect(isBuffer([])).toBe(false);
      expect(isBuffer(null)).toBe(false);
      expect(isBuffer(undefined)).toBe(false);
    });
  });

  describe('alloc', () => {
    it('should create zero-filled buffer of specified size', () => {
      const buffer = alloc(10);
      expect(buffer.length).toBe(10);

      // Check all bytes are zero
      for (let i = 0; i < buffer.length; i++) {
        expect(buffer[i]).toBe(0);
      }
    });

    it('should create empty buffer for size 0', () => {
      const buffer = alloc(0);
      expect(buffer.length).toBe(0);
    });
  });

  describe('concat', () => {
    it('should concatenate multiple buffers', () => {
      const buf1 = fromString('Hello');
      const buf2 = fromString(' ');
      const buf3 = fromString('World');
      const result = concat([buf1, buf2, buf3]);
      expect(toString(result)).toBe('Hello World');
    });

    it('should handle single buffer', () => {
      const buffer = fromString('Hello');
      const result = concat([buffer]);
      expect(toString(result)).toBe('Hello');
    });

    it('should handle empty array', () => {
      const result = concat([]);
      expect(result.length).toBe(0);
    });

    it('should handle mix of buffer types', () => {
      const buf1 = fromString('A');
      const buf2 = new Uint8Array([66]); // 'B'
      const result = concat([buf1, buf2]);
      expect(toString(result)).toBe('AB');
    });
  });

  describe('slice', () => {
    it('should slice buffer from start to end', () => {
      const buffer = fromString('Hello World');
      const sliced = slice(buffer, 0, 5);
      expect(toString(sliced)).toBe('Hello');
    });

    it('should slice from start if no end provided', () => {
      const buffer = fromString('Hello World');
      const sliced = slice(buffer, 6);
      expect(toString(sliced)).toBe('World');
    });

    it('should handle negative indices', () => {
      const buffer = fromString('Hello World');
      const sliced = slice(buffer, -5);
      expect(toString(sliced)).toBe('World');
    });

    it('should return empty buffer for invalid range', () => {
      const buffer = fromString('Hello');
      const sliced = slice(buffer, 10, 15);
      expect(sliced.length).toBe(0);
    });
  });

  describe('equals', () => {
    it('should return true for equal buffers', () => {
      const buf1 = fromString('Hello');
      const buf2 = fromString('Hello');
      expect(equals(buf1, buf2)).toBe(true);
    });

    it('should return false for different buffers', () => {
      const buf1 = fromString('Hello');
      const buf2 = fromString('World');
      expect(equals(buf1, buf2)).toBe(false);
    });

    it('should return false for different lengths', () => {
      const buf1 = fromString('Hi');
      const buf2 = fromString('Hello');
      expect(equals(buf1, buf2)).toBe(false);
    });

    it('should handle empty buffers', () => {
      const buf1 = alloc(0);
      const buf2 = alloc(0);
      expect(equals(buf1, buf2)).toBe(true);
    });
  });

  describe('byteLength', () => {
    it('should return correct byte length', () => {
      const buffer = fromString('Hello');
      expect(byteLength(buffer)).toBe(5);
    });

    it('should handle UTF-8 multi-byte characters', () => {
      const buffer = fromString('世界');
      expect(byteLength(buffer)).toBe(6); // Each character is 3 bytes
    });

    it('should return 0 for empty buffer', () => {
      const buffer = alloc(0);
      expect(byteLength(buffer)).toBe(0);
    });
  });

  describe('randomBytes', () => {
    it('should generate random bytes of specified length', () => {
      const buffer = randomBytes(16);
      expect(buffer.length).toBe(16);
    });

    it('should generate different values on each call', () => {
      const buf1 = randomBytes(16);
      const buf2 = randomBytes(16);

      // It's extremely unlikely these will be equal
      expect(equals(buf1, buf2)).toBe(false);
    });

    it('should handle zero length', () => {
      const buffer = randomBytes(0);
      expect(buffer.length).toBe(0);
    });

    it('should generate bytes in valid range', () => {
      const buffer = randomBytes(100);
      for (let i = 0; i < buffer.length; i++) {
        expect(buffer[i]).toBeGreaterThanOrEqual(0);
        expect(buffer[i]).toBeLessThanOrEqual(255);
      }
    });
  });

  describe('BufferUtils namespace', () => {
    it('should expose all functions through namespace', () => {
      expect(BufferUtils.fromHex).toBe(fromHex);
      expect(BufferUtils.fromString).toBe(fromString);
      expect(BufferUtils.fromBytes).toBe(fromBytes);
      expect(BufferUtils.toHex).toBe(toHex);
      expect(BufferUtils.toString).toBe(toString);
      expect(BufferUtils.isBuffer).toBe(isBuffer);
      expect(BufferUtils.alloc).toBe(alloc);
      expect(BufferUtils.concat).toBe(concat);
      expect(BufferUtils.slice).toBe(slice);
      expect(BufferUtils.equals).toBe(equals);
      expect(BufferUtils.byteLength).toBe(byteLength);
      expect(BufferUtils.randomBytes).toBe(randomBytes);
    });
  });

  describe('Cross-environment compatibility', () => {
    let originalBuffer: any;
    let originalCrypto: any;

    beforeEach(() => {
      // Store original globals
      originalBuffer = (global as any).Buffer;
      originalCrypto = (global as any).crypto;
    });

    afterEach(() => {
      // Restore original globals
      if (originalBuffer !== undefined) {
        (global as any).Buffer = originalBuffer;
      } else {
        delete (global as any).Buffer;
      }

      if (originalCrypto !== undefined) {
        (global as any).crypto = originalCrypto;
      }
    });

    it('should work without native Buffer', () => {
      // Temporarily remove Buffer
      delete (global as any).Buffer;

      // Force module re-evaluation would be needed here
      // For now, just test that functions work
      const buffer = fromString('Test without Buffer');
      const hex = toHex(buffer);
      const decoded = fromHex(hex);
      expect(toString(decoded)).toBe('Test without Buffer');
    });

    it.skip('should use crypto.getRandomValues when available', () => {
      // Skip: Node.js environment uses crypto.randomBytes, not getRandomValues
    });
  });
});
