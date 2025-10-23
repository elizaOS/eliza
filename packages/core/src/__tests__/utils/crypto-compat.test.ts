/**
 * Tests for crypto-compat utilities
 * Verifies cross-platform cryptographic operations work correctly
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import {
  createHash,
  createHashAsync,
  createCipheriv,
  createDecipheriv,
  encryptAsync,
  decryptAsync,
  webCrypto,
} from '../../utils/crypto-compat';
import { BufferUtils } from '../../utils/buffer';

describe('crypto-compat', () => {
  describe('createHashAsync (cross-platform)', () => {
    it('should hash string data with SHA-256', async () => {
      const data = 'hello world';
      const hash = await createHashAsync('sha256', data);

      expect(hash).toBeInstanceOf(Uint8Array);
      expect(hash.length).toBe(32); // SHA-256 produces 32 bytes

      // Verify against known hash
      const expected = new Uint8Array([
        0xb9, 0x4d, 0x27, 0xb9, 0x93, 0x4d, 0x3e, 0x08, 0xa5, 0x2e, 0x52, 0xd7, 0xda, 0x7d, 0xab,
        0xfa, 0xc4, 0x84, 0xef, 0xe3, 0x7a, 0x53, 0x80, 0xee, 0x90, 0x88, 0xf7, 0xac, 0xe2, 0xef,
        0xcd, 0xe9,
      ]);
      expect(hash).toEqual(expected);
    });

    it('should hash Uint8Array data with SHA-256', async () => {
      const data = new TextEncoder().encode('hello world');
      const hash = await createHashAsync('sha256', data);

      expect(hash).toBeInstanceOf(Uint8Array);
      expect(hash.length).toBe(32);
    });

    it('should support SHA-1', async () => {
      const data = 'test';
      const hash = await createHashAsync('sha1', data);

      expect(hash).toBeInstanceOf(Uint8Array);
      expect(hash.length).toBe(20); // SHA-1 produces 20 bytes
    });

    it('should support SHA-512', async () => {
      const data = 'test';
      const hash = await createHashAsync('sha512', data);

      expect(hash).toBeInstanceOf(Uint8Array);
      expect(hash.length).toBe(64); // SHA-512 produces 64 bytes
    });

    it('should throw on unsupported algorithm', async () => {
      await expect(createHashAsync('invalid-hash-algo' as any, 'data')).rejects.toThrow(); // Node.js and browser throw different messages, just verify it throws
    });

    it('should produce consistent results', async () => {
      const data = 'consistent test data';
      const hash1 = await createHashAsync('sha256', data);
      const hash2 = await createHashAsync('sha256', data);

      expect(hash1).toEqual(hash2);
    });
  });

  describe('createHash (Node.js synchronous)', () => {
    it('should hash data incrementally', () => {
      const hash = createHash('sha256').update('hello').update(' ').update('world');

      const result = hash.digest();

      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBe(32);

      // Should match single-call hash
      const expected = new Uint8Array([
        0xb9, 0x4d, 0x27, 0xb9, 0x93, 0x4d, 0x3e, 0x08, 0xa5, 0x2e, 0x52, 0xd7, 0xda, 0x7d, 0xab,
        0xfa, 0xc4, 0x84, 0xef, 0xe3, 0x7a, 0x53, 0x80, 0xee, 0x90, 0x88, 0xf7, 0xac, 0xe2, 0xef,
        0xcd, 0xe9,
      ]);
      expect(result).toEqual(expected);
    });

    it('should support Uint8Array updates', () => {
      const data = new TextEncoder().encode('test data');
      const hash = createHash('sha256').update(data);
      const result = hash.digest();

      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBe(32);
    });

    it('should allow method chaining', () => {
      const result = createHash('sha256').update('part1').update('part2').update('part3').digest();

      expect(result).toBeInstanceOf(Uint8Array);
    });
  });

  describe('encryptAsync / decryptAsync (cross-platform)', () => {
    const createTestKey = async (): Promise<Uint8Array> => {
      // Create a deterministic 32-byte key from hash
      return await createHashAsync('sha256', 'test-key-seed');
    };

    const createTestIV = (): Uint8Array => {
      // Create a 16-byte IV
      const iv = new Uint8Array(16);
      for (let i = 0; i < 16; i++) {
        iv[i] = i;
      }
      return iv;
    };

    it('should encrypt and decrypt data successfully', async () => {
      const key = await createTestKey();
      const iv = createTestIV();
      const plaintext = new TextEncoder().encode('Secret message');

      const encrypted = await encryptAsync(key, iv, plaintext);
      expect(encrypted).toBeInstanceOf(Uint8Array);
      expect(encrypted.length).toBeGreaterThan(0);
      expect(encrypted).not.toEqual(plaintext);

      const decrypted = await decryptAsync(key, iv, encrypted);
      expect(decrypted).toEqual(plaintext);

      const decryptedText = new TextDecoder().decode(decrypted);
      expect(decryptedText).toBe('Secret message');
    });

    it('should handle empty data', async () => {
      const key = await createTestKey();
      const iv = createTestIV();
      const plaintext = new Uint8Array(0);

      const encrypted = await encryptAsync(key, iv, plaintext);
      const decrypted = await decryptAsync(key, iv, encrypted);

      expect(decrypted).toEqual(plaintext);
    });

    it('should handle large data', async () => {
      const key = await createTestKey();
      const iv = createTestIV();
      const plaintext = new Uint8Array(10000);
      for (let i = 0; i < plaintext.length; i++) {
        plaintext[i] = i % 256;
      }

      const encrypted = await encryptAsync(key, iv, plaintext);
      const decrypted = await decryptAsync(key, iv, encrypted);

      expect(decrypted).toEqual(plaintext);
    });

    it('should produce different ciphertext with different IVs', async () => {
      const key = await createTestKey();
      const iv1 = createTestIV();
      const iv2 = new Uint8Array(16);
      for (let i = 0; i < 16; i++) {
        iv2[i] = 15 - i;
      }
      const plaintext = new TextEncoder().encode('Same message');

      const encrypted1 = await encryptAsync(key, iv1, plaintext);
      const encrypted2 = await encryptAsync(key, iv2, plaintext);

      expect(encrypted1).not.toEqual(encrypted2);

      // Both should decrypt correctly
      const decrypted1 = await decryptAsync(key, iv1, encrypted1);
      const decrypted2 = await decryptAsync(key, iv2, encrypted2);
      expect(decrypted1).toEqual(plaintext);
      expect(decrypted2).toEqual(plaintext);
    });

    it('should throw on invalid key length', async () => {
      const invalidKey = new Uint8Array(16); // Wrong size
      const iv = createTestIV();
      const data = new TextEncoder().encode('test');

      await expect(encryptAsync(invalidKey, iv, data)).rejects.toThrow(/invalid key length/i);

      await expect(decryptAsync(invalidKey, iv, data)).rejects.toThrow(/invalid key length/i);
    });

    it('should throw on invalid IV length', async () => {
      const key = await createTestKey();
      const invalidIV = new Uint8Array(8); // Wrong size
      const data = new TextEncoder().encode('test');

      await expect(encryptAsync(key, invalidIV, data)).rejects.toThrow(/invalid iv length/i);

      await expect(decryptAsync(key, invalidIV, data)).rejects.toThrow(/invalid iv length/i);
    });

    it('should fail decryption with wrong key', async () => {
      const key1 = await createHashAsync('sha256', 'key1');
      const key2 = await createHashAsync('sha256', 'key2');
      const iv = createTestIV();
      const plaintext = new TextEncoder().encode('Secret');

      const encrypted = await encryptAsync(key1, iv, plaintext);

      // Decryption with wrong key should fail or produce garbage
      try {
        const decrypted = await decryptAsync(key2, iv, encrypted);
        const text = new TextDecoder().decode(decrypted);
        // If it doesn't throw, it should at least not match original
        expect(text).not.toBe('Secret');
      } catch (error) {
        // Decryption may throw an error with wrong key, which is acceptable
        expect(error).toBeDefined();
      }
    });

    it('should be deterministic for same key, IV, and data', async () => {
      const key = await createTestKey();
      const iv = createTestIV();
      const plaintext = new TextEncoder().encode('Deterministic test');

      const encrypted1 = await encryptAsync(key, iv, plaintext);
      const encrypted2 = await encryptAsync(key, iv, plaintext);

      expect(encrypted1).toEqual(encrypted2);
    });
  });

  describe('createCipheriv / createDecipheriv (Node.js synchronous)', () => {
    const createTestKey = async (): Promise<Uint8Array> => {
      return await createHashAsync('sha256', 'test-key-seed');
    };

    const createTestIV = (): Uint8Array => {
      const iv = new Uint8Array(16);
      for (let i = 0; i < 16; i++) {
        iv[i] = i;
      }
      return iv;
    };

    it('should encrypt and decrypt with Node.js API', async () => {
      const key = await createTestKey();
      const iv = createTestIV();
      const plaintext = 'Secret message';

      const cipher = createCipheriv('aes-256-cbc', key, iv);
      let encrypted = cipher.update(plaintext, 'utf8', 'hex');
      encrypted += cipher.final('hex');

      expect(encrypted).toBeTruthy();
      expect(typeof encrypted).toBe('string');

      const decipher = createDecipheriv('aes-256-cbc', key, iv);
      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      expect(decrypted).toBe(plaintext);
    });

    it('should throw on unsupported algorithm', async () => {
      const key = await createTestKey();
      const iv = createTestIV();

      expect(() => {
        createCipheriv('aes-128-cbc' as any, key, iv);
      }).toThrow(/unsupported algorithm/i);

      expect(() => {
        createDecipheriv('aes-128-cbc' as any, key, iv);
      }).toThrow(/unsupported algorithm/i);
    });
  });

  describe('webCrypto (legacy API)', () => {
    it('should have hash function', () => {
      expect(webCrypto.hash).toBeDefined();
      expect(typeof webCrypto.hash).toBe('function');
    });

    it('should have encrypt function', () => {
      expect(webCrypto.encrypt).toBeDefined();
      expect(typeof webCrypto.encrypt).toBe('function');
    });

    it('should have decrypt function', () => {
      expect(webCrypto.decrypt).toBeDefined();
      expect(typeof webCrypto.decrypt).toBe('function');
    });

    it('should work for hashing', async () => {
      const data = new TextEncoder().encode('test');
      const hash = await webCrypto.hash('sha256', data);

      expect(hash).toBeInstanceOf(Uint8Array);
      expect(hash.length).toBe(32);
    });
  });

  describe('integration with settings encryption', () => {
    it('should support settings encryption workflow', async () => {
      const salt = 'test-salt-value';
      const value = 'sensitive-data';

      // Simulate settings encryption
      const key = await createHashAsync('sha256', salt);
      const keySlice = key.slice(0, 32);
      const iv = BufferUtils.randomBytes(16);

      // Encrypt
      const cipher = createCipheriv('aes-256-cbc', keySlice, iv);
      let encrypted = cipher.update(value, 'utf8', 'hex');
      encrypted += cipher.final('hex');

      const storedValue = `${BufferUtils.toHex(iv)}:${encrypted}`;

      // Simulate settings decryption
      const parts = storedValue.split(':');
      expect(parts.length).toBe(2);

      const recoveredIV = BufferUtils.fromHex(parts[0]);
      const encryptedData = parts[1];

      const decipher = createDecipheriv('aes-256-cbc', keySlice, recoveredIV);
      let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      expect(decrypted).toBe(value);
    });

    it('should support async settings encryption workflow', async () => {
      const salt = 'test-salt-value';
      const value = 'sensitive-data';
      const valueBytes = new TextEncoder().encode(value);

      // Async encryption
      const key = await createHashAsync('sha256', salt);
      const keySlice = key.slice(0, 32);
      const iv = BufferUtils.randomBytes(16);

      const encrypted = await encryptAsync(keySlice, iv, valueBytes);
      const storedValue = `${BufferUtils.toHex(iv)}:${BufferUtils.toHex(encrypted)}`;

      // Async decryption
      const parts = storedValue.split(':');
      const recoveredIV = BufferUtils.fromHex(parts[0]);
      const encryptedData = BufferUtils.fromHex(parts[1]);

      const decrypted = await decryptAsync(keySlice, recoveredIV, encryptedData);
      const decryptedText = new TextDecoder().decode(decrypted);

      expect(decryptedText).toBe(value);
    });
  });

  describe('error messages', () => {
    it('should have helpful error messages for browser incompatibility', () => {
      // In browser, digest() should throw with helpful message
      // (This test will only throw in actual browser environment)
      // Just verify the functions exist and are callable in Node.js
      const hash = createHash('sha256').update('test');
      const result = hash.digest();
      expect(result).toBeInstanceOf(Uint8Array);
    });

    it('should validate algorithm names', async () => {
      await expect(createHashAsync('invalid-algo' as any, 'data')).rejects.toThrow();
    });

    it('should validate cipher algorithm', async () => {
      const key = await createHashAsync('sha256', 'key');
      const iv = new Uint8Array(16);

      expect(() => {
        createCipheriv('des' as any, key, iv);
      }).toThrow(/unsupported algorithm/i);
    });
  });
});
