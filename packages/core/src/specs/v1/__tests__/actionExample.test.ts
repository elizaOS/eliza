import { describe, expect, it } from 'bun:test';
import { Content } from '../types';
import { Content as ContentV2, ActionExample as ActionExampleV2 } from '../../v2';
import {
  ActionExample,
  convertContentToV1,
  convertContentToV2,
  fromV2ActionExample,
  toV2ActionExample,
} from '../actionExample';

describe('ActionExample Module', () => {
  // Common test data
  const v1Example: ActionExample = {
    user: 'TestUser',
    content: {
      text: 'Hello world',
      action: 'ACTION1',
    } as Content,
  };

  // Equivalent v2 example
  const v2Example: ActionExampleV2 = {
    name: 'TestUser',
    content: {
      text: 'Hello world',
      actions: ['ACTION1'],
    } as ContentV2,
  };

  describe('convertContentToV1', () => {
    it('should convert V2 content to V1 content', () => {
      const v2Content: ContentV2 = {
        text: 'Test content',
        actions: ['ACTION1'],
        metadata: { timestamp: 12345 },
      } as ContentV2;

      const result = convertContentToV1(v2Content);

      expect(result.text).toBe('Test content');
      expect(result.action).toBe('ACTION1');
      // Type assertion to access the metadata property
      expect((result as any).metadata.timestamp).toBe(12345);
    });

    it('should handle empty actions array', () => {
      const v2Content: ContentV2 = {
        text: 'Test content',
        actions: [],
      } as ContentV2;

      const result = convertContentToV1(v2Content);

      expect(result.text).toBe('Test content');
      expect(result.action).toBeUndefined();
    });

    it('should handle null or undefined content', () => {
      // @ts-ignore - testing null content
      const result1 = convertContentToV1(null);
      // @ts-ignore - testing undefined content
      const result2 = convertContentToV1(undefined);

      expect(result1.text).toBe('');
      expect(result2.text).toBe('');
    });
  });

  describe('convertContentToV2', () => {
    it('should convert V1 content to V2 content', () => {
      const v1Content = {
        text: 'Test content',
        action: 'ACTION1',
        thought: 'Private thought',
      } as Content;

      const result = convertContentToV2(v1Content);

      expect(result.text).toBe('Test content');
      expect(result.actions).toEqual(['ACTION1']);
      // Access with type assertion
      expect((result as any).thought).toBe('Private thought');
    });

    it('should handle undefined action field', () => {
      const v1Content = {
        text: 'Test content',
        action: undefined,
      } as Content;

      const result = convertContentToV2(v1Content);

      expect(result.text).toBe('Test content');
      expect(result.actions).toEqual([]);
    });

    it('should handle null or undefined content', () => {
      // @ts-ignore - testing null content
      const result1 = convertContentToV2(null);
      // @ts-ignore - testing undefined content
      const result2 = convertContentToV2(undefined);

      expect(result1.text).toBe('');
      expect(result2.text).toBe('');
    });
  });

  describe('fromV2ActionExample', () => {
    it('should convert v2 ActionExample to v1 ActionExample', () => {
      const result = fromV2ActionExample(v2Example);

      expect(result.user).toBe(v2Example.name);
      expect(result.content.text).toBe(v2Example.content.text);
      expect(result.content.action).toBe(v2Example.content.actions[0]);
    });

    it('should handle v2 example with minimal content', () => {
      const minimalV2Example: ActionExampleV2 = {
        name: 'TestUser',
        content: {
          text: 'Minimal example',
        } as ContentV2,
      };

      const result = fromV2ActionExample(minimalV2Example);

      expect(result.user).toBe('TestUser');
      expect(result.content.text).toBe('Minimal example');
      expect(result.content.action).toBeUndefined();
    });

    it('should handle empty strings and arrays', () => {
      const emptyV2Example: ActionExampleV2 = {
        name: '',
        content: {
          text: '',
          actions: [],
        } as ContentV2,
      };

      const result = fromV2ActionExample(emptyV2Example);

      expect(result.user).toBe('');
      expect(result.content.text).toBe('');
      expect(result.content.action).toBeUndefined();
    });

    it('should handle null or undefined example', () => {
      // @ts-ignore - testing null example
      const result1 = fromV2ActionExample(null);
      // @ts-ignore - testing undefined example
      const result2 = fromV2ActionExample(undefined);

      expect(result1.user).toBe('');
      expect(result1.content.text).toBe('');
      expect(result2.user).toBe('');
      expect(result2.content.text).toBe('');
    });
  });

  describe('toV2ActionExample', () => {
    it('should convert v1 ActionExample to v2 ActionExample', () => {
      const result = toV2ActionExample(v1Example);

      expect(result.name).toBe(v1Example.user);
      expect(result.content.text).toBe(v1Example.content.text);
      expect(result.content.actions).toEqual([v1Example.content.action]);
    });

    it('should handle v1 example with minimal content', () => {
      const minimalV1Example: ActionExample = {
        user: 'TestUser',
        content: {
          text: 'Minimal example',
        } as Content,
      };

      const result = toV2ActionExample(minimalV1Example);

      expect(result.name).toBe('TestUser');
      expect(result.content.text).toBe('Minimal example');
      expect(result.content.actions).toEqual([]);
    });

    it('should handle complex content structures', () => {
      const complexV1Example: ActionExample = {
        user: 'ComplexUser',
        content: {
          text: 'Complex example',
          action: 'ACTION1',
          metadata: {
            timestamp: 123456789,
            source: 'test',
            nested: {
              field1: 'value1',
              field2: 'value2',
            },
          },
        } as unknown as Content,
      };

      const result = toV2ActionExample(complexV1Example);

      expect(result.name).toBe('ComplexUser');
      expect(result.content.text).toBe('Complex example');
      expect(result.content.actions).toEqual(['ACTION1']);
      // Use type assertions to access the nested properties
      const metadata = (result.content as any).metadata;
      expect(metadata.timestamp).toBe(123456789);
      expect(metadata.nested.field1).toBe('value1');
    });

    it('should handle null or undefined example', () => {
      // @ts-ignore - testing null example
      const result1 = toV2ActionExample(null);
      // @ts-ignore - testing undefined example
      const result2 = toV2ActionExample(undefined);

      expect(result1.name).toBe('');
      expect(result1.content.text).toBe('');
      expect(result2.name).toBe('');
      expect(result2.content.text).toBe('');
    });
  });

  describe('ActionExample type', () => {
    it('should match the expected structure', () => {
      const example: ActionExample = {
        user: 'User1',
        content: {
          text: 'Sample text',
        } as Content,
      };

      expect(example).toHaveProperty('user');
      expect(example).toHaveProperty('content');
      expect(typeof example.user).toBe('string');
    });
  });
});
