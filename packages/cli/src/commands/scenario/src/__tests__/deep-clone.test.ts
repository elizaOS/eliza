import { describe, it, expect, beforeEach } from 'bun:test';
import {
  deepClone,
  shallowClone,
  hasCircularReference,
  deepCloneWithLimit,
  jsonClone,
  advancedDeepClone,
  clearCloneCache,
  CloneOptions,
} from '../deep-clone';

describe('Deep Clone', () => {
  beforeEach(() => {
    clearCloneCache();
  });

  describe('deepClone', () => {
    it('should clone primitive values', () => {
      expect(deepClone(42)).toBe(42);
      expect(deepClone('hello')).toBe('hello');
      expect(deepClone(true)).toBe(true);
      expect(deepClone(null)).toBe(null);
      expect(deepClone(undefined)).toBe(undefined);
    });

    it('should clone simple objects', () => {
      const original = { name: 'test', value: 42 };
      const cloned = deepClone(original);

      expect(cloned).toEqual(original);
      expect(cloned).not.toBe(original);

      // Modify clone to ensure independence
      cloned.name = 'modified';
      expect(original.name).toBe('test');
    });

    it('should clone nested objects', () => {
      const original = {
        user: {
          name: 'John',
          settings: {
            theme: 'dark',
            notifications: true,
          },
        },
      };

      const cloned = deepClone(original);

      expect(cloned).toEqual(original);
      expect(cloned.user).not.toBe(original.user);
      expect(cloned.user.settings).not.toBe(original.user.settings);

      // Test independence
      cloned.user.settings.theme = 'light';
      expect(original.user.settings.theme).toBe('dark');
    });

    it('should clone arrays', () => {
      const original = [1, 2, { nested: 'value' }];
      const cloned = deepClone(original);

      expect(cloned).toEqual(original);
      expect(cloned).not.toBe(original);
      expect(cloned[2]).not.toBe(original[2]);

      // Test independence
      cloned[2].nested = 'modified';
      expect(original[2].nested).toBe('value');
    });

    it('should clone Date objects', () => {
      const original = new Date('2024-01-01');
      const cloned = deepClone(original);

      expect(cloned).toBeInstanceOf(Date);
      expect(cloned.getTime()).toBe(original.getTime());
      expect(cloned).not.toBe(original);
    });

    it('should clone RegExp objects', () => {
      const original = /test/gi;
      const cloned = deepClone(original);

      expect(cloned).toBeInstanceOf(RegExp);
      expect(cloned.source).toBe(original.source);
      expect(cloned.flags).toBe(original.flags);
      expect(cloned).not.toBe(original);
    });

    it('should clone Error objects', () => {
      const original = new Error('Test error');
      original.stack = 'custom stack';

      const cloned = deepClone(original);

      expect(cloned).toBeInstanceOf(Error);
      expect(cloned.message).toBe(original.message);
      expect(cloned.name).toBe(original.name);
      expect(cloned.stack).toBe(original.stack);
      expect(cloned).not.toBe(original);
    });

    it('should handle complex nested structures', () => {
      const original = {
        string: 'test',
        number: 42,
        boolean: true,
        date: new Date('2024-01-01'),
        regex: /test/g,
        array: [1, 2, { nested: 'value' }],
        nested: {
          deep: {
            value: 'nested',
          },
        },
      };

      const cloned = deepClone(original);

      expect(cloned).toEqual(original);
      expect(cloned).not.toBe(original);
      expect(cloned.date).not.toBe(original.date);
      expect(cloned.regex).not.toBe(original.regex);
      expect(cloned.array).not.toBe(original.array);
      expect(cloned.nested).not.toBe(original.nested);
    });

    it('should throw error on circular references', () => {
      const obj: any = { name: 'test' };
      obj.self = obj;

      expect(() => deepClone(obj)).toThrow('Circular reference detected');
    });
  });

  describe('shallowClone', () => {
    it('should perform shallow clone of objects', () => {
      const original = {
        name: 'test',
        nested: { value: 42 },
      };

      const cloned = shallowClone(original);

      expect(cloned).toEqual(original);
      expect(cloned).not.toBe(original);
      expect(cloned.nested).toBe(original.nested); // Shallow clone
    });

    it('should perform shallow clone of arrays', () => {
      const original = [1, { nested: 'value' }];
      const cloned = shallowClone(original);

      expect(cloned).toEqual(original);
      expect(cloned).not.toBe(original);
      expect(cloned[1]).toBe(original[1]); // Shallow clone
    });

    it('should clone Date objects even in shallow mode', () => {
      const original = new Date();
      const cloned = shallowClone(original);

      expect(cloned).toBeInstanceOf(Date);
      expect(cloned).not.toBe(original);
    });
  });

  describe('hasCircularReference', () => {
    it('should detect circular references', () => {
      const obj: any = { name: 'test' };
      obj.self = obj;

      expect(hasCircularReference(obj)).toBe(true);
    });

    it('should detect deeper circular references', () => {
      const obj: any = {
        level1: {
          level2: {
            name: 'test',
          },
        },
      };
      obj.level1.level2.back = obj;

      expect(hasCircularReference(obj)).toBe(true);
    });

    it('should return false for non-circular objects', () => {
      const obj = {
        name: 'test',
        nested: {
          value: 42,
          array: [1, 2, 3],
        },
      };

      expect(hasCircularReference(obj)).toBe(false);
    });

    it('should handle arrays with circular references', () => {
      const arr: any[] = [1, 2];
      arr.push(arr);

      expect(hasCircularReference(arr)).toBe(true);
    });
  });

  describe('deepCloneWithLimit', () => {
    it('should respect depth limits', () => {
      const deepObj = {
        level1: {
          level2: {
            level3: {
              level4: {
                value: 'deep',
              },
            },
          },
        },
      };

      const cloned = deepCloneWithLimit(deepObj, 2);

      // Should have shallow copy at depth limit
      expect(cloned.level1.level2).toBe(deepObj.level1.level2);
    });

    it('should handle arrays at depth limit', () => {
      const deepArray = [[[['deep']]]];
      const cloned = deepCloneWithLimit(deepArray, 2);

      // At depth limit, should be shallow
      expect(cloned[0][0]).toBe(deepArray[0][0]);
    });
  });

  describe('jsonClone', () => {
    it('should clone JSON-serializable objects', () => {
      const original = {
        string: 'test',
        number: 42,
        boolean: true,
        array: [1, 2, 3],
        nested: {
          value: 'nested',
        },
      };

      const cloned = jsonClone(original);

      expect(cloned).toEqual(original);
      expect(cloned).not.toBe(original);
    });

    it('should throw error for non-JSON-serializable objects', () => {
      const original = {
        date: new Date(),
        func: () => 'test',
      };

      expect(() => jsonClone(original)).toThrow('Object is not JSON-serializable');
    });
  });

  describe('advancedDeepClone', () => {
    it('should use default options', () => {
      const original = { name: 'test', nested: { value: 42 } };
      const cloned = advancedDeepClone(original);

      expect(cloned).toEqual(original);
      expect(cloned).not.toBe(original);
      expect(cloned.nested).not.toBe(original.nested);
    });

    it('should respect maxDepth option', () => {
      const deepObj = {
        level1: {
          level2: {
            level3: 'deep',
          },
        },
      };

      const cloned = advancedDeepClone(deepObj, { maxDepth: 1 });

      // Should be original object at depth limit
      expect(cloned.level1).toBe(deepObj.level1);
    });

    it('should handle circular references when enabled', () => {
      const obj: any = { name: 'test' };
      obj.self = obj;

      const cloned = advancedDeepClone(obj, { handleCircular: true });

      expect(cloned.name).toBe('test');
      expect(cloned.self).toBe(cloned); // Circular reference preserved
    });

    it('should not preserve types when disabled', () => {
      const original = {
        date: new Date(),
        regex: /test/g,
      };

      const cloned = advancedDeepClone(original, { preserveTypes: false });

      expect(cloned.date).not.toBeInstanceOf(Date);
      expect(cloned.regex).not.toBeInstanceOf(RegExp);
    });

    it('should use custom cloners', () => {
      class CustomClass {
        constructor(public value: string) {}
      }

      const customCloners = new Map();
      customCloners.set(CustomClass, (obj: CustomClass) => new CustomClass(`cloned-${obj.value}`));

      const original = new CustomClass('test');
      const cloned = advancedDeepClone(original, { customCloners });

      expect(cloned).toBeInstanceOf(CustomClass);
      expect(cloned.value).toBe('cloned-test');
    });
  });

  describe('Edge Cases', () => {
    it('should handle null and undefined', () => {
      expect(deepClone(null)).toBe(null);
      expect(deepClone(undefined)).toBe(undefined);
    });

    it('should handle empty objects and arrays', () => {
      expect(deepClone({})).toEqual({});
      expect(deepClone([])).toEqual([]);
    });

    it('should handle objects with null prototype', () => {
      const obj = Object.create(null);
      obj.name = 'test';

      const cloned = deepClone(obj);
      expect(cloned.name).toBe('test');
    });

    it('should handle very large objects', () => {
      const largeObj: any = {};
      for (let i = 0; i < 1000; i++) {
        largeObj[`prop${i}`] = { value: i, nested: { deep: i * 2 } };
      }

      const cloned = deepClone(largeObj);
      expect(Object.keys(cloned)).toHaveLength(1000);
      expect(cloned.prop500.nested.deep).toBe(1000);
    });
  });

  describe('Performance', () => {
    it('should clone objects efficiently', () => {
      const obj = {
        name: 'test',
        values: Array(100)
          .fill(0)
          .map((_, i) => ({ id: i, data: `item-${i}` })),
        nested: {
          deep: {
            value: 'test',
          },
        },
      };

      const startTime = Date.now();

      for (let i = 0; i < 100; i++) {
        deepClone(obj);
      }

      const endTime = Date.now();
      const duration = endTime - startTime;

      // Should complete 100 clones in reasonable time
      expect(duration).toBeLessThan(500);
    });
  });
});
