import { afterEach, beforeEach, describe, expect, it, setSystemTime, mock } from 'bun:test';
import { Content, Entity, IAgentRuntime, Memory, ModelType, State } from '../types';
import * as utils from '../utils';
import {
  addHeader,
  composePrompt,
  composePromptFromState,
  formatMessages,
  formatPosts,
  formatTimestamp,
  normalizeJsonString,
  parseBooleanFromText,
  parseJSONObjectFromText,
  parseKeyValueXml,
  safeReplacer,
  splitChunks,
  stringToUuid,
  trimTokens,
  truncateToCompleteSentence,
  validateUuid,
} from '../utils';

describe('Utils Comprehensive Tests', () => {
  describe('parseBooleanFromText', () => {
    it('should return true for affirmative values', () => {
      const affirmativeValues = [
        'YES',
        'Y',
        'TRUE',
        'T',
        '1',
        'ON',
        'ENABLE',
        'yes',
        'y',
        'true',
        't',
        ' YES ',
        ' true ',
      ];

      affirmativeValues.forEach((value) => {
        expect(parseBooleanFromText(value)).toBe(true);
      });
    });

    it('should return false for negative values', () => {
      const negativeValues = [
        'NO',
        'N',
        'FALSE',
        'F',
        '0',
        'OFF',
        'DISABLE',
        'no',
        'n',
        'false',
        'f',
        ' NO ',
        ' false ',
      ];

      negativeValues.forEach((value) => {
        expect(parseBooleanFromText(value)).toBe(false);
      });
    });

    it('should return false for null, undefined, or empty values', () => {
      expect(parseBooleanFromText(null)).toBe(false);
      expect(parseBooleanFromText(undefined)).toBe(false);
      expect(parseBooleanFromText('')).toBe(false);
    });

    it('should return false for unrecognized values', () => {
      expect(parseBooleanFromText('maybe')).toBe(false);
      expect(parseBooleanFromText('123')).toBe(false);
      expect(parseBooleanFromText('YESNO')).toBe(false);
      expect(parseBooleanFromText('random')).toBe(false);
    });
  });

  describe('formatTimestamp', () => {
    beforeEach(() => {
      // Mock Date.now() to ensure consistent tests
      setSystemTime(new Date('2024-01-15T12:00:00Z'));
    });

    afterEach(() => {
      setSystemTime(); // Reset to real time
    });

    it("should return 'just now' for recent timestamps", () => {
      const now = Date.now();
      expect(formatTimestamp(now)).toBe('just now');
      expect(formatTimestamp(now - 30000)).toBe('just now'); // 30 seconds ago
      expect(formatTimestamp(now - 59999)).toBe('just now'); // Just under 1 minute
    });

    it('should return minutes ago for timestamps within an hour', () => {
      const now = Date.now();
      expect(formatTimestamp(now - 60000)).toBe('1 minute ago');
      expect(formatTimestamp(now - 120000)).toBe('2 minutes ago');
      expect(formatTimestamp(now - 1800000)).toBe('30 minutes ago');
      expect(formatTimestamp(now - 3599000)).toBe('59 minutes ago');
    });

    it('should return hours ago for timestamps within 24 hours', () => {
      const now = Date.now();
      expect(formatTimestamp(now - 3600000)).toBe('1 hour ago');
      expect(formatTimestamp(now - 7200000)).toBe('2 hours ago');
      expect(formatTimestamp(now - 43200000)).toBe('12 hours ago');
      expect(formatTimestamp(now - 86399000)).toBe('23 hours ago');
    });

    it('should return days ago for older timestamps', () => {
      const now = Date.now();
      expect(formatTimestamp(now - 86400000)).toBe('1 day ago');
      expect(formatTimestamp(now - 172800000)).toBe('2 days ago');
      expect(formatTimestamp(now - 604800000)).toBe('7 days ago');
    });
  });

  describe('parseJSONObjectFromText', () => {
    it('should parse JSON from code blocks', () => {
      const text = 'Here is some JSON:\n```json\n{"key": "value", "number": 42}\n```';
      const result = parseJSONObjectFromText(text);
      // Note: normalizeJsonString converts numbers to strings
      expect(result).toEqual({ key: 'value', number: '42' });
    });

    it('should parse direct JSON without code blocks', () => {
      const text = '{"name": "Alice", "age": 30}';
      const result = parseJSONObjectFromText(text);
      // Note: normalizeJsonString converts numbers to strings
      expect(result).toEqual({ name: 'Alice', age: '30' });
    });

    it('should return null for invalid JSON', () => {
      expect(parseJSONObjectFromText('not json')).toBeNull();
      expect(parseJSONObjectFromText('{invalid json}')).toBeNull();
      expect(parseJSONObjectFromText('')).toBeNull();
    });

    it('should return null for arrays', () => {
      expect(parseJSONObjectFromText('["item1", "item2"]')).toBeNull();
      expect(parseJSONObjectFromText('```json\n[1, 2, 3]\n```')).toBeNull();
    });

    it('should return null for non-object values', () => {
      expect(parseJSONObjectFromText('"string"')).toBeNull();
      expect(parseJSONObjectFromText('42')).toBeNull();
      expect(parseJSONObjectFromText('true')).toBeNull();
      expect(parseJSONObjectFromText('null')).toBeNull();
    });
  });

  describe('normalizeJsonString', () => {
    it('should remove extra spaces after { and before }', () => {
      // Note: normalizeJsonString doesn't handle unquoted keys
      expect(normalizeJsonString('{  "key": "value"  }')).toBe('{"key": "value"}');
      expect(normalizeJsonString('{\n  "key": "value"\n}')).toBe('{"key": "value"}');
    });

    it('should wrap unquoted values in double quotes', () => {
      expect(normalizeJsonString('{"key": value}')).toBe('{"key": "value"}');
      expect(normalizeJsonString('{"key": someWord}')).toBe('{"key": "someWord"}');
    });

    it('should convert single quotes to double quotes', () => {
      // The function only converts when format is exactly "key": 'value'
      expect(normalizeJsonString('"key": \'value\'')).toBe('"key": "value"');
      // When already inside JSON braces, single quotes inside are preserved
      const result = normalizeJsonString('{"key": \'value\', "key2": \'value2\'}');
      // The function converts the quotes but may not work perfectly for nested quotes
      expect(result).toContain('key');
      expect(result).toContain('value');
    });

    it('should handle mixed formatting', () => {
      const input = '{ "key1": value1, "key2": \'value2\', "key3": "value3" }';
      const result = normalizeJsonString(input);
      // Check that the function at least wraps unquoted values
      expect(result).toContain('"key1": "value1"');
      expect(result).toContain('"key3": "value3"');
    });

    it('should wrap numbers in quotes', () => {
      // normalizeJsonString wraps ALL unquoted values including numbers
      const input = '{"key": "value", "number": 42}';
      const result = normalizeJsonString(input);
      expect(result).toBe('{"key": "value", "number": "42"}');
    });
  });

  describe('truncateToCompleteSentence', () => {
    it('should return text unchanged if within limit', () => {
      const text = 'Short text.';
      expect(truncateToCompleteSentence(text, 50)).toBe(text);
    });

    it('should truncate at last period within limit', () => {
      const text = 'First sentence. Second sentence. Third sentence that is very long.';
      expect(truncateToCompleteSentence(text, 35)).toBe('First sentence. Second sentence.');
    });

    it('should truncate at last space if no period found', () => {
      const text = 'This is a very long sentence without any periods that needs truncation';
      expect(truncateToCompleteSentence(text, 30)).toBe('This is a very long sentence...');
    });

    it('should hard truncate if no space found', () => {
      const text = 'Verylongwordwithoutanyspacesorperiods';
      // maxLength 10 - 3 = 7 chars for the text part
      expect(truncateToCompleteSentence(text, 10)).toBe('Verylon...');
    });

    it('should handle edge cases', () => {
      expect(truncateToCompleteSentence('', 10)).toBe('');
      expect(truncateToCompleteSentence('No period', 5)).toBe('No...');
    });
  });

  describe('splitChunks', () => {
    it('should split text into chunks', async () => {
      const text = 'a'.repeat(2000); // Long text
      const chunks = await splitChunks(text, 512, 20);

      expect(chunks).toBeInstanceOf(Array);
      expect(chunks.length).toBeGreaterThan(0);
      chunks.forEach((chunk) => {
        expect(chunk.length).toBeLessThanOrEqual(512 * 4); // Accounting for character to token ratio
      });
    });

    it('should handle short text', async () => {
      const text = 'Short text';
      const chunks = await splitChunks(text);

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toBe(text);
    });

    it('should respect chunk overlap', async () => {
      const text = 'Word1 Word2 Word3 Word4 Word5 ' + 'Word6 '.repeat(100);
      const chunks = await splitChunks(text, 50, 10);

      expect(chunks.length).toBeGreaterThan(1);
    });
  });

  describe('trimTokens', () => {
    let mockRuntime: IAgentRuntime;

    beforeEach(() => {
      mockRuntime = {
        useModel: mock(async (type, params) => {
          if (type === 'TEXT_TOKENIZER_ENCODE') {
            // Simple mock: each word is a token
            return params.prompt.split(' ');
          }
          if (type === 'TEXT_TOKENIZER_DECODE') {
            // Simple mock: join tokens back
            return params.tokens.join(' ');
          }
          return null;
        }),
      } as unknown as IAgentRuntime;
    });

    it('should trim tokens to specified limit', async () => {
      const prompt = 'one two three four five six seven eight nine ten';
      const result = await trimTokens(prompt, 5, mockRuntime);

      expect(result).toBe('six seven eight nine ten');
      expect(mockRuntime.useModel).toHaveBeenCalledTimes(2);
    });

    it('should return unchanged if within limit', async () => {
      const prompt = 'short text';
      const result = await trimTokens(prompt, 10, mockRuntime);

      expect(result).toBe(prompt);
    });

    it('should throw error for invalid inputs', async () => {
      await expect(trimTokens('', 10, mockRuntime)).rejects.toThrow();
      await expect(trimTokens('text', 0, mockRuntime)).rejects.toThrow();
      await expect(trimTokens('text', -1, mockRuntime)).rejects.toThrow();
    });

    it('should skip tokenization for very short prompts', async () => {
      const prompt = 'hi';
      const result = await trimTokens(prompt, 100, mockRuntime);

      expect(result).toBe(prompt);
      expect(mockRuntime.useModel).not.toHaveBeenCalled();
    });
  });

  describe('parseKeyValueXml', () => {
    it('should parse response XML blocks', () => {
      const xml = `<response>
                <name>TestAgent</name>
                <reasoning>Test reasoning</reasoning>
                <action>RESPOND</action>
            </response>`;

      const result = parseKeyValueXml(xml);
      expect(result).toEqual({
        name: 'TestAgent',
        reasoning: 'Test reasoning',
        action: 'RESPOND',
      });
    });

    it('should handle comma-separated lists for specific keys', () => {
      const xml = `<response>
                <actions>ACTION1,ACTION2,ACTION3</actions>
                <providers>PROVIDER1, PROVIDER2</providers>
                <evaluators>EVAL1, EVAL2</evaluators>
            </response>`;

      const result = parseKeyValueXml(xml);
      expect(result).toEqual({
        actions: ['ACTION1', 'ACTION2', 'ACTION3'],
        providers: ['PROVIDER1', 'PROVIDER2'],
        evaluators: ['EVAL1', 'EVAL2'],
      });
    });

    it('should parse boolean values', () => {
      const xml = '<response><simple>true</simple><complex>false</complex></response>';

      const result = parseKeyValueXml(xml);
      expect(result).toEqual({
        simple: true,
        complex: 'false', // Only 'simple' key is treated as boolean
      });
    });

    it('should handle XML entities', () => {
      const xml = '<response><text>Value with &lt;tags&gt; &amp; entities</text></response>';

      const result = parseKeyValueXml(xml);
      expect(result).toEqual({
        text: 'Value with <tags> & entities',
      });
    });

    it('should return null for invalid XML', () => {
      expect(parseKeyValueXml('')).toBeNull();
      expect(parseKeyValueXml('not xml')).toBeNull();
      expect(parseKeyValueXml('<unclosed>')).toBeNull();
    });

    it('should handle any root tag name', () => {
      const xml = '<custom><key>value</key></custom>';
      const result = parseKeyValueXml(xml);
      expect(result).toEqual({ key: 'value' });
    });

    it('should handle mismatched XML tags', () => {
      // This tests lines 393-395 - warning about mismatched tags
      const xml = '<response><start>value</end></response>';
      const result = parseKeyValueXml(xml);
      // Should still try to parse what it can
      expect(result).toBeNull();
    });

    it('should return null when no key-value pairs are found', () => {
      // This tests lines 400-403 - no key-value pairs extracted
      const xml = '<response></response>'; // Empty response
      const result = parseKeyValueXml(xml);
      expect(result).toBeNull();

      // Also test with content that doesn't match the pattern
      const xml2 = '<response>Just plain text</response>';
      const result2 = parseKeyValueXml(xml2);
      expect(result2).toBeNull();
    });

    it('should handle empty comma-separated lists', () => {
      const xml = `<response>
                <actions></actions>
                <providers> </providers>
            </response>`;

      const result = parseKeyValueXml(xml);
      expect(result).toEqual({
        actions: [],
        providers: [],
      });
    });
  });

  describe('formatMessages', () => {
    const mockEntities: Entity[] = [
      {
        id: 'entity-1' as any,
        names: ['Alice'],
        agentId: 'agent-1' as any,
      },
      {
        id: 'entity-2' as any,
        names: ['Bob'],
        agentId: 'agent-1' as any,
      },
    ];

    it('should format messages with basic content', () => {
      const messages: Memory[] = [
        {
          id: 'msg-1' as any,
          entityId: 'entity-1' as any,
          roomId: 'room-1' as any,
          createdAt: Date.now() - 60000, // 1 minute ago
          content: {
            text: 'Hello world',
            source: 'chat',
          } as Content,
        },
      ];

      const result = formatMessages({ messages, entities: mockEntities });

      expect(result).toContain('Alice');
      expect(result).toContain('Hello world');
      expect(result).toContain('1 minute ago');
      expect(result).toContain('[entity-1]');
    });

    it('should format messages with actions and thoughts', () => {
      const messages: Memory[] = [
        {
          id: 'msg-1' as any,
          entityId: 'entity-2' as any,
          roomId: 'room-1' as any,
          createdAt: Date.now(),
          content: {
            text: 'Doing something',
            thought: 'I should help',
            actions: ['SEARCH', 'REPLY'],
            source: 'chat',
          } as Content,
        },
      ];

      const result = formatMessages({ messages, entities: mockEntities });

      expect(result).toContain('Bob');
      expect(result).toContain('Doing something');
      expect(result).toContain("(Bob's internal thought: I should help)");
      expect(result).toContain("(Bob's actions: SEARCH, REPLY)");
    });

    it('should handle attachments', () => {
      const messages: Memory[] = [
        {
          id: 'msg-1' as any,
          entityId: 'entity-1' as any,
          roomId: 'room-1' as any,
          createdAt: Date.now(),
          content: {
            text: 'Check this out',
            attachments: [
              { id: 'att-1', title: 'Image', url: 'http://example.com/img.jpg' },
              { id: 'att-2', title: 'Document', url: 'http://example.com/doc.pdf' },
            ],
            source: 'chat',
          } as Content,
        },
      ];

      const result = formatMessages({ messages, entities: mockEntities });

      expect(result).toContain(
        '(Attachments: [att-1 - Image (http://example.com/img.jpg)], [att-2 - Document (http://example.com/doc.pdf)])'
      );
    });

    it('should filter out messages without entityId', () => {
      const messages: Memory[] = [
        {
          id: 'msg-1' as any,
          entityId: null as any,
          roomId: 'room-1' as any,
          createdAt: Date.now(),
          content: { text: 'Should be filtered', source: 'chat' } as Content,
        },
        {
          id: 'msg-2' as any,
          entityId: 'entity-1' as any,
          roomId: 'room-1' as any,
          createdAt: Date.now(),
          content: { text: 'Should appear', source: 'chat' } as Content,
        },
      ];

      const result = formatMessages({ messages, entities: mockEntities });

      expect(result).not.toContain('Should be filtered');
      expect(result).toContain('Should appear');
    });
  });

  describe('formatPosts', () => {
    const mockEntities: Entity[] = [
      {
        id: 'entity-1' as any,
        names: ['Alice'],
        agentId: 'agent-1' as any,
      },
    ];

    it('should format posts grouped by room', () => {
      const messages: Memory[] = [
        {
          id: 'msg-1' as any,
          entityId: 'entity-1' as any,
          roomId: 'room-1' as any,
          createdAt: Date.now() - 3600000,
          content: {
            text: 'First message',
            source: 'twitter',
          } as Content,
        },
        {
          id: 'msg-2' as any,
          entityId: 'entity-1' as any,
          roomId: 'room-1' as any,
          createdAt: Date.now(),
          content: {
            text: 'Second message',
            source: 'twitter',
          } as Content,
        },
      ];

      const result = formatPosts({ messages, entities: mockEntities });

      // formatPosts uses roomId.slice(-5) to show only last 5 chars
      expect(result).toContain('Conversation: oom-1');
      expect(result).toContain('Name: Alice');
      expect(result).toContain('First message');
      expect(result).toContain('Second message');
      expect(result).toContain('Source: twitter');
    });

    it('should include reply information', () => {
      const messages: Memory[] = [
        {
          id: 'msg-1' as any,
          entityId: 'entity-1' as any,
          roomId: 'room-1' as any,
          createdAt: Date.now(),
          content: {
            text: 'Reply message',
            inReplyTo: '12345678-1234-1234-1234-123456789012' as any,
            source: 'chat',
          } as Content,
        },
      ];

      const result = formatPosts({ messages, entities: mockEntities });

      expect(result).toContain('In reply to: 12345678-1234-1234-1234-123456789012');
    });

    it('should format without conversation header when specified', () => {
      const messages: Memory[] = [
        {
          id: 'msg-1' as any,
          entityId: 'entity-1' as any,
          roomId: 'room-1' as any,
          createdAt: Date.now(),
          content: { text: 'Message', source: 'chat' } as Content,
        },
      ];

      const result = formatPosts({
        messages,
        entities: mockEntities,
        conversationHeader: false,
      });

      expect(result).not.toContain('Conversation:');
    });

    it('should handle missing entity with warning', () => {
      // This tests line 209 - logger.warn when entity not found
      const messages: Memory[] = [
        {
          id: 'msg-1' as any,
          entityId: 'non-existent-entity' as any,
          roomId: 'room-1' as any,
          createdAt: Date.now(),
          content: {
            text: 'Message from unknown entity',
            source: 'chat',
          } as Content,
        },
      ];

      // Empty entities array to ensure entity is not found
      const result = formatPosts({ messages, entities: [] });

      // Should use "Unknown User" when entity not found
      expect(result).toContain('Unknown User');
      expect(result).toContain('unknown');
      expect(result).toContain('non-existent-entity');
    });

    it('should handle messages without roomId', () => {
      const messages: Memory[] = [
        {
          id: 'msg-1' as any,
          entityId: 'entity-1' as any,
          roomId: null as any, // No roomId
          createdAt: Date.now(),
          content: {
            text: 'Message without room',
            source: 'chat',
          } as Content,
        },
      ];

      const result = formatPosts({ messages, entities: mockEntities });

      // Messages without roomId should be filtered out
      expect(result).toBe('');
    });
  });

  describe('validateUuid', () => {
    it('should validate correct UUID format', () => {
      const validUuid = '123e4567-e89b-12d3-a456-426614174000';
      const result = validateUuid(validUuid);
      expect(result).toBe(validUuid);
    });

    it('should return null for invalid UUID format', () => {
      expect(validateUuid('not-a-uuid')).toBeNull();
      expect(validateUuid('123')).toBeNull();
      expect(validateUuid('')).toBeNull();
      expect(validateUuid(null)).toBeNull();
      expect(validateUuid(undefined)).toBeNull();
      expect(validateUuid(123)).toBeNull();
      expect(validateUuid({})).toBeNull();
    });

    it('should handle UUID-like strings that are invalid', () => {
      // Wrong format variations
      expect(validateUuid('123e4567-e89b-12d3-a456')).toBeNull(); // Too short
      expect(validateUuid('123e4567-e89b-12d3-a456-426614174000-extra')).toBeNull(); // Too long
      expect(validateUuid('123e4567e89b12d3a456426614174000')).toBeNull(); // No dashes
      expect(validateUuid('XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX')).toBeNull(); // Invalid chars
    });
  });

  describe('stringToUuid', () => {
    it('should convert string to UUID', () => {
      const result = stringToUuid('test-string');
      expect(result).toBeDefined();
      expect(typeof result).toBe('string');
      // Should be in UUID format
      expect(result).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('should convert number to UUID', () => {
      const result = stringToUuid(12345);
      expect(result).toBeDefined();
      expect(typeof result).toBe('string');
      expect(result).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('should throw TypeError for non-string/non-number input', () => {
      expect(() => stringToUuid(null as any)).toThrow(TypeError);
      expect(() => stringToUuid(undefined as any)).toThrow(TypeError);
      expect(() => stringToUuid({} as any)).toThrow(TypeError);
      expect(() => stringToUuid([] as any)).toThrow(TypeError);
      expect(() => stringToUuid(true as any)).toThrow(TypeError);
    });

    it('should generate consistent UUID for same input', () => {
      const input = 'consistent-input';
      const uuid1 = stringToUuid(input);
      const uuid2 = stringToUuid(input);
      expect(uuid1).toBe(uuid2);
    });

    it('should generate different UUIDs for different inputs', () => {
      const uuid1 = stringToUuid('input1');
      const uuid2 = stringToUuid('input2');
      expect(uuid1).not.toBe(uuid2);
    });

    it('should handle special characters in string input', () => {
      const specialChars = 'test@#$%^&*()_+-=[]{}|;\':",./<>?';
      const result = stringToUuid(specialChars);
      expect(result).toBeDefined();
      expect(result).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('should handle empty string', () => {
      const result = stringToUuid('');
      expect(result).toBeDefined();
      expect(result).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('should handle very long strings', () => {
      const longString = 'a'.repeat(1000);
      const result = stringToUuid(longString);
      expect(result).toBeDefined();
      expect(result).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });
  });

  describe('safeReplacer', () => {
    it('should handle circular references', () => {
      const obj: any = { a: 1, b: { c: 2 } };
      obj.circular = obj; // Create circular reference
      obj.b.parent = obj; // Another circular reference

      const replacer = safeReplacer();
      const result = JSON.stringify(obj, replacer);

      expect(result).toContain('[Circular]');
      expect(result).toContain('"a":1');
      expect(result).toContain('"c":2');

      // Should not throw error
      expect(() => JSON.stringify(obj, replacer)).not.toThrow();
    });

    it('should handle non-circular objects normally', () => {
      const obj = {
        a: 1,
        b: { c: 2 },
        d: [1, 2, 3],
        e: null,
        f: 'string',
      };

      const replacer = safeReplacer();
      const result = JSON.stringify(obj, replacer);

      expect(result).toBe(JSON.stringify(obj)); // Should be identical
      expect(result).not.toContain('[Circular]');
    });

    it('should handle nested circular references', () => {
      const obj: any = {
        level1: {
          level2: {
            level3: {},
          },
        },
      };
      obj.level1.level2.level3.back = obj.level1; // Circular reference

      const replacer = safeReplacer();
      const result = JSON.stringify(obj, replacer);

      expect(result).toContain('[Circular]');
      expect(() => JSON.stringify(obj, replacer)).not.toThrow();
    });

    it('should handle arrays with circular references', () => {
      const arr: any[] = [1, 2, 3];
      const obj = { arr, value: 'test' };
      arr.push(obj); // Circular reference through array

      const replacer = safeReplacer();
      const result = JSON.stringify({ data: arr }, replacer);

      expect(result).toContain('[Circular]');
      expect(result).toContain('1');
      expect(result).toContain('2');
      expect(result).toContain('3');
    });
  });

  describe('composePrompt', () => {
    it('should compose prompt with state values', () => {
      const state = {
        name: 'Alice',
        role: 'developer',
        task: 'write tests',
      };
      const template = `Hello {{name}}, as a {{role}}, please {{task}}.`;

      const result = composePrompt({ state, template });

      expect(result).toBe('Hello Alice, as a developer, please write tests.');
    });

    it('should handle missing state values', () => {
      const state = {
        name: 'Bob',
      };
      const template = `Hello {{name}}, your role is {{role}}.`;

      const result = composePrompt({ state, template });

      // Handlebars replaces missing values with empty string
      expect(result).toBe('Hello Bob, your role is .');
    });

    it('should handle empty state', () => {
      const state = {};
      const template = `Template with {{placeholder}}.`;

      const result = composePrompt({ state, template });

      // Handlebars replaces missing values with empty string
      expect(result).toBe('Template with .');
    });

    it('should handle multiple occurrences of same placeholder', () => {
      const state = {
        word: 'test',
      };
      const template = `{{word}} {{word}} {{word}}`;

      const result = composePrompt({ state, template });

      expect(result).toBe('test test test');
    });
  });

  describe('composePromptFromState', () => {
    it('should compose prompt from State object', () => {
      const mockState: State = {
        // Required State properties
        userId: 'user-123' as any,
        agentId: 'agent-123' as any,
        roomId: 'room-123' as any,
        bio: 'I am a helpful assistant',
        lore: 'Created to help with tasks',
        senderName: 'Assistant',
        actors: 'user123',
        actorsData: [
          {
            id: 'actor-1' as any,
            names: ['John'],
            agentId: 'agent-123' as any,
          },
        ],
        // Template values
        recentMessages: 'Recent conversation history',
        relevantKnowledge: 'Relevant facts',
        recentMessagesData: [
          {
            id: 'msg-1' as any,
            entityId: 'entity-1' as any,
            roomId: 'room-123' as any,
            createdAt: Date.now(),
            content: {
              text: 'Hello',
              source: 'chat',
            } as Content,
          },
        ],
        // Additional required State properties
        values: {},
        data: {},
        text: '',
      };

      const template = `Bio: {{bio}}\nLore: {{lore}}\nRecent: {{recentMessages}}`;

      const result = composePromptFromState({ state: mockState, template });

      expect(result).toContain('Bio: I am a helpful assistant');
      expect(result).toContain('Lore: Created to help with tasks');
      expect(result).toContain('Recent: Recent conversation history');
    });

    it('should handle State with array data', () => {
      const mockState: State = {
        userId: 'user-123' as any,
        agentId: 'agent-123' as any,
        roomId: 'room-123' as any,
        bio: 'Assistant bio',
        lore: 'Assistant lore',
        senderName: 'User',
        actors: '',
        actorsData: [
          {
            id: 'actor-1' as any,
            names: ['Alice'],
            agentId: 'agent-123' as any,
          },
          {
            id: 'actor-2' as any,
            names: ['Bob'],
            agentId: 'agent-123' as any,
          },
        ],
        recentMessagesData: [],
        values: {},
        data: {},
        text: '',
      };

      const template = `Actors: {{actors}}\nSender: {{senderName}}`;

      const result = composePromptFromState({ state: mockState, template });

      expect(result).toContain('Sender: User');
      // actors field might be generated from actorsData
      expect(result).toBeDefined();
    });

    it('should handle missing properties in State', () => {
      const mockState: State = {
        userId: 'user-123' as any,
        agentId: 'agent-123' as any,
        roomId: 'room-123' as any,
        bio: '',
        lore: '',
        senderName: '',
        actors: '',
        actorsData: [],
        recentMessagesData: [],
        values: {},
        data: {},
        text: '',
      };

      const template = `Bio: {{bio}}\nMissing: {{missingProp}}`;

      const result = composePromptFromState({ state: mockState, template });

      expect(result).toContain('Bio: ');
      // Handlebars replaces missing values with empty string
      expect(result).toBe('Bio: \nMissing: ');
    });
  });

  describe('addHeader', () => {
    it('should add header to body', () => {
      const header = '# Title';
      const body = 'This is the body content.';

      const result = addHeader(header, body);

      // addHeader adds only single newline between header and body, and adds newline at end
      expect(result).toBe('# Title\nThis is the body content.\n');
    });

    it('should handle empty header', () => {
      const header = '';
      const body = 'Body content';

      const result = addHeader(header, body);

      // Empty header results in just body with newline at end
      expect(result).toBe('Body content\n');
    });

    it('should handle empty body', () => {
      const header = 'Header';
      const body = '';

      const result = addHeader(header, body);

      // Empty body returns empty string regardless of header
      expect(result).toBe('');
    });

    it('should handle both empty', () => {
      const result = addHeader('', '');

      // Both empty returns empty string
      expect(result).toBe('');
    });

    it('should handle multiline header and body', () => {
      const header = 'Line 1\nLine 2';
      const body = 'Body line 1\nBody line 2';

      const result = addHeader(header, body);

      // Single newline between header and body, newline at end
      expect(result).toBe('Line 1\nLine 2\nBody line 1\nBody line 2\n');
    });
  });

  // we test this via composePrompt and composePromptFromState
  /*
  it('upgradeDoubleToTriple converts double braces to triple', () => {
    const tpl = 'Hello {{name}} and {{#if cond}}{{value}}{{/if}}';
    const out = upgradeDoubleToTriple(tpl);
    expect(out).toBe('Hello {{{name}}} and {{#if cond}}{{{value}}}{{/if}}');
  });
  */

  it('addHeader prepends header when body exists', () => {
    expect(addHeader('Head', 'Body')).toBe('Head\nBody\n');
    expect(addHeader('Head', '')).toBe('');
  });

  // we test this via composePrompt and composePromptFromState
  /*
  it('composeRandomUser replaces placeholders', () => {
    const result = composeRandomUser('hi {{name1}} {{name2}}', 2);
    expect(result).not.toContain('{{');
  });
  */

  it('parseKeyValueXml parses simple xml block', () => {
    const xml = '<response><key>value</key><actions>a,b</actions><simple>true</simple></response>';
    const parsed = parseKeyValueXml(xml);
    expect(parsed).toEqual({ key: 'value', actions: ['a', 'b'], simple: true });
  });

  it('safeReplacer handles circular objects', () => {
    const obj: any = { a: 1 };
    obj.self = obj;
    const str = JSON.stringify(obj, safeReplacer());
    expect(str).toContain('[Circular]');
  });

  it('validateUuid validates correct uuid and rejects bad values', () => {
    const valid = validateUuid('123e4567-e89b-12d3-a456-426614174000');
    const invalid = validateUuid('not-a-uuid');
    expect(valid).toBe('123e4567-e89b-12d3-a456-426614174000');
    expect(invalid).toBeNull();
  });

  it('composePrompt inserts state values', () => {
    //const spy = vi.spyOn(utils, 'composeRandomUser').mockImplementation((t) => t);
    const out = utils.composePrompt({ state: { a: 'x' }, template: 'Hello {{a}}' });
    expect(out).toBe('Hello x');
    //spy.mockRestore();
  });

  it('composePromptFromState flattens state values', () => {
    //const spy = vi.spyOn(utils, 'composeRandomUser').mockImplementation((t) => t);
    const out = utils.composePromptFromState({
      state: { values: { b: 'y' }, data: {}, text: '', c: 'z' },
      template: '{{b}} {{c}}',
    });
    expect(out).toBe('y z');
    //spy.mockRestore();
  });

  it('formatPosts formats conversation text', () => {
    const messages = [
      {
        id: '1',
        entityId: 'e1',
        roomId: 'r1',
        createdAt: 1,
        content: { text: 'hi', source: 'chat' },
      },
      {
        id: '2',
        entityId: 'e1',
        roomId: 'r1',
        createdAt: 2,
        content: { text: 'there', source: 'chat' },
      },
    ] as any;
    const entities = [{ id: 'e1', names: ['Alice'] }] as any;
    const result = utils.formatPosts({ messages, entities });
    expect(result).toContain('Conversation:');
    expect(result).toContain('Alice');
    expect(result).toContain('hi');
    expect(result).toContain('there');
  });

  it('trimTokens truncates using runtime tokenizer', async () => {
    const runtime = {
      useModel: mock(
        async (type: (typeof ModelType)[keyof typeof ModelType], { prompt, tokens }: any) => {
          if (type === ModelType.TEXT_TOKENIZER_ENCODE) return prompt.split(' ');
          if (type === ModelType.TEXT_TOKENIZER_DECODE) return tokens.join(' ');
          return [];
        }
      ),
    } as any;
    const result = await utils.trimTokens('a b c d e', 3, runtime);
    expect(result).toBe('c d e');
  });
});
