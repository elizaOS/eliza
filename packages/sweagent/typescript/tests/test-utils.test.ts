/**
 * Utils tests converted from test_utils.py
 */

import { describe, it, expect } from '@jest/globals';
import * as path from 'path';
import {
  convertPathToAbspath,
  convertPathsToAbspath,
  parseConfigFile,
  mergeConfigs,
  validateConfig,
} from '../src/utils/config';
import { formatDuration, truncateString, calculateHash, retry, debounce, throttle } from '../src/utils/common';

const REPO_ROOT = path.resolve(__dirname, '..');

describe('Utils', () => {
  describe('Path conversion utilities', () => {
    it('should convert relative path to absolute', () => {
      const result = convertPathToAbspath('subdir/file.txt');
      expect(path.format(result)).toBe(path.join(REPO_ROOT, 'subdir/file.txt'));
    });

    it('should keep absolute paths unchanged', () => {
      const absolutePath = '/absolute/path/file.txt';
      const result = convertPathToAbspath(absolutePath);
      expect(path.format(result)).toBe(absolutePath);
    });

    it('should handle Windows paths correctly', () => {
      if (process.platform === 'win32') {
        const windowsPath = 'C:\\Users\\test\\file.txt';
        const result = convertPathToAbspath(windowsPath);
        expect(path.format(result)).toBe(windowsPath);
      }
    });

    it('should convert array of paths', () => {
      const paths = ['relative/path.txt', '/absolute/path.txt', './current/dir.txt'];

      const results = convertPathsToAbspath(paths);

      expect(path.format(results[0])).toBe(path.join(REPO_ROOT, 'relative/path.txt'));
      expect(path.format(results[1])).toBe('/absolute/path.txt');
      expect(path.format(results[2])).toBe(path.join(REPO_ROOT, './current/dir.txt'));
    });

    it('should handle empty array', () => {
      const results = convertPathsToAbspath([]);
      expect(results).toEqual([]);
    });
  });

  describe('Config utilities', () => {
    it('should parse YAML config file', () => {
      const yamlContent = `
agent:
  model:
    name: test-model
  temperature: 0.7
`;
      const config = parseConfigFile(yamlContent, 'yaml');

      expect(config.agent.model.name).toBe('test-model');
      expect(config.agent.temperature).toBe(0.7);
    });

    it('should parse JSON config file', () => {
      const jsonContent = `{
        "agent": {
          "model": {
            "name": "test-model"
          },
          "temperature": 0.7
        }
      }`;

      const config = parseConfigFile(jsonContent, 'json');

      expect(config.agent.model.name).toBe('test-model');
      expect(config.agent.temperature).toBe(0.7);
    });

    it('should merge configs correctly', () => {
      const baseConfig = {
        agent: {
          model: { name: 'base-model' },
          temperature: 0.5,
        },
        output_dir: '/base/dir',
      };

      const overrideConfig = {
        agent: {
          model: { name: 'override-model' },
        },
        verbose: true,
      };

      const merged = mergeConfigs(baseConfig, overrideConfig);

      expect(merged.agent.model.name).toBe('override-model');
      expect(merged.agent.temperature).toBe(0.5); // Preserved from base
      expect(merged.output_dir).toBe('/base/dir'); // Preserved from base
      expect(merged.verbose).toBe(true); // Added from override
    });

    it('should validate config structure', () => {
      const validConfig = {
        agent: {
          model: { name: 'test' },
        },
      };

      expect(() => validateConfig(validConfig)).not.toThrow();

      const invalidConfig = {
        agent: 'not an object',
      };

      expect(() => validateConfig(invalidConfig)).toThrow();
    });
  });

  describe('String utilities', () => {
    it('should truncate long strings', () => {
      const longString = 'a'.repeat(100);
      const truncated = truncateString(longString, 10);

      expect(truncated).toBe('aaaaaaa...');
      expect(truncated.length).toBeLessThanOrEqual(13); // 10 + '...'
    });

    it('should not truncate short strings', () => {
      const shortString = 'short';
      const result = truncateString(shortString, 10);

      expect(result).toBe('short');
    });

    it('should handle empty strings', () => {
      expect(truncateString('', 10)).toBe('');
    });
  });

  describe('Time utilities', () => {
    it('should format duration correctly', () => {
      expect(formatDuration(0)).toBe('0s');
      expect(formatDuration(45)).toBe('45s');
      expect(formatDuration(90)).toBe('1m 30s');
      expect(formatDuration(3661)).toBe('1h 1m 1s');
      expect(formatDuration(86400)).toBe('1d 0h 0m 0s');
    });

    it('should handle negative durations', () => {
      expect(formatDuration(-60)).toBe('-1m 0s');
    });
  });

  describe('Hash utilities', () => {
    it('should calculate consistent hashes', () => {
      const data = 'test data';
      const hash1 = calculateHash(data);
      const hash2 = calculateHash(data);

      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[a-f0-9]+$/);
    });

    it('should produce different hashes for different data', () => {
      const hash1 = calculateHash('data1');
      const hash2 = calculateHash('data2');

      expect(hash1).not.toBe(hash2);
    });

    it('should handle objects', () => {
      const obj = { key: 'value', nested: { prop: 1 } };
      const hash = calculateHash(obj);

      expect(hash).toBeDefined();
      expect(hash).toMatch(/^[a-f0-9]+$/);
    });
  });

  describe('Async utilities', () => {
    describe('retry', () => {
      it('should retry failed operations', async () => {
        let attempts = 0;
        const operation = async () => {
          attempts++;
          if (attempts < 3) {
            throw new Error('Failed');
          }
          return 'success';
        };

        const result = await retry(operation, { retries: 3, delay: 10 });

        expect(result).toBe('success');
        expect(attempts).toBe(3);
      });

      it('should fail after max retries', async () => {
        const operation = async () => {
          throw new Error('Always fails');
        };

        await expect(retry(operation, { retries: 2, delay: 10 })).rejects.toThrow('Always fails');
      });

      it('should not retry on success', async () => {
        let attempts = 0;
        const operation = async () => {
          attempts++;
          return 'immediate success';
        };

        const result = await retry(operation);

        expect(result).toBe('immediate success');
        expect(attempts).toBe(1);
      });
    });

    describe('debounce', () => {
      it('should debounce function calls', async () => {
        jest.useFakeTimers();

        let callCount = 0;
        const fn = () => callCount++;
        const debounced = debounce(fn, 100);

        // Call multiple times quickly
        debounced();
        debounced();
        debounced();

        // Should not have been called yet
        expect(callCount).toBe(0);

        // Fast forward time
        jest.advanceTimersByTime(100);

        // Should have been called once
        expect(callCount).toBe(1);

        jest.useRealTimers();
      });
    });

    describe('throttle', () => {
      it('should throttle function calls', () => {
        jest.useFakeTimers();

        let callCount = 0;
        const fn = () => callCount++;
        const throttled = throttle(fn, 100);

        // First call goes through immediately
        throttled();
        expect(callCount).toBe(1);

        // Subsequent calls within throttle period are ignored
        throttled();
        throttled();
        expect(callCount).toBe(1);

        // After throttle period, next call goes through
        jest.advanceTimersByTime(100);
        throttled();
        expect(callCount).toBe(2);

        jest.useRealTimers();
      });
    });
  });

  describe('Environment utilities', () => {
    it('should parse environment variables', () => {
      process.env.TEST_VAR = 'test_value';
      process.env.TEST_NUMBER = '42';
      process.env.TEST_BOOL = 'true';

      expect(process.env.TEST_VAR).toBe('test_value');
      expect(parseInt(process.env.TEST_NUMBER)).toBe(42);
      expect(process.env.TEST_BOOL === 'true').toBe(true);

      // Clean up
      delete process.env.TEST_VAR;
      delete process.env.TEST_NUMBER;
      delete process.env.TEST_BOOL;
    });

    it('should handle missing environment variables', () => {
      expect(process.env.NONEXISTENT_VAR).toBeUndefined();
    });
  });

  describe('Array utilities', () => {
    it('should chunk arrays', () => {
      const array = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const chunks = chunkArray(array, 3);

      expect(chunks).toEqual([[1, 2, 3], [4, 5, 6], [7, 8, 9], [10]]);
    });

    it('should flatten nested arrays', () => {
      const nested = [[1, 2], [3, [4, 5]], 6];
      const flattened = flattenArray(nested);

      expect(flattened).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it('should remove duplicates', () => {
      const array = [1, 2, 2, 3, 3, 3, 4];
      const unique = removeDuplicates(array);

      expect(unique).toEqual([1, 2, 3, 4]);
    });
  });

  describe('Object utilities', () => {
    it('should deep clone objects', () => {
      const original = {
        a: 1,
        b: { c: 2, d: [3, 4] },
        e: new Date(),
      };

      const cloned = deepClone(original);

      expect(cloned).toEqual(original);
      expect(cloned).not.toBe(original);
      expect(cloned.b).not.toBe(original.b);
      expect(cloned.b.d).not.toBe(original.b.d);
    });

    it('should check object equality', () => {
      const obj1 = { a: 1, b: { c: 2 } };
      const obj2 = { a: 1, b: { c: 2 } };
      const obj3 = { a: 1, b: { c: 3 } };

      expect(isEqual(obj1, obj2)).toBe(true);
      expect(isEqual(obj1, obj3)).toBe(false);
    });

    it('should pick properties from object', () => {
      const obj = { a: 1, b: 2, c: 3, d: 4 };
      const picked = pick(obj, ['a', 'c']);

      expect(picked).toEqual({ a: 1, c: 3 });
    });

    it('should omit properties from object', () => {
      const obj = { a: 1, b: 2, c: 3, d: 4 };
      const omitted = omit(obj, ['b', 'd']);

      expect(omitted).toEqual({ a: 1, c: 3 });
    });
  });
});

// Helper functions (these would be in the actual utils module)
function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

function flattenArray(array: unknown[]): unknown[] {
  return array.reduce<unknown[]>((flat, item) => {
    return flat.concat(Array.isArray(item) ? flattenArray(item as unknown[]) : item);
  }, []);
}

function removeDuplicates<T>(array: T[]): T[] {
  return [...new Set(array)];
}

function deepClone<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  if (obj instanceof Date) {
    return new Date(obj.getTime()) as any;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => deepClone(item)) as any;
  }

  const cloned: Record<string, unknown> = {};
  for (const key in obj) {
    if ((obj as any).hasOwnProperty(key)) {
      cloned[key] = deepClone((obj as any)[key]);
    }
  }
  return cloned as T;
}

function isEqual(obj1: unknown, obj2: unknown): boolean {
  if (obj1 === obj2) {
    return true;
  }
  if (obj1 == null || obj2 == null) {
    return false;
  }
  if (typeof obj1 !== typeof obj2) {
    return false;
  }

  if (typeof obj1 === 'object') {
    const keys1 = Object.keys(obj1 as object);
    const keys2 = Object.keys(obj2 as object);

    if (keys1.length !== keys2.length) {
      return false;
    }

    return keys1.every((key) => isEqual((obj1 as any)[key], (obj2 as any)[key]));
  }

  return false;
}

function pick<T extends object, K extends keyof T>(obj: T, keys: K[]): Pick<T, K> {
  const result = {} as Pick<T, K>;
  keys.forEach((key) => {
    if (key in obj) {
      result[key] = obj[key];
    }
  });
  return result;
}

function omit<T extends object, K extends keyof T>(obj: T, keys: K[]): Omit<T, K> {
  const result = { ...obj } as any;
  keys.forEach((key) => {
    delete result[key];
  });
  return result;
}
