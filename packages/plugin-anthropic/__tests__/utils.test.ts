import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger to silence debug output during tests
vi.mock('@elizaos/core', () => ({ logger: { debug: vi.fn() } }));

// We'll swap jsonrepair mock per test
let jsonrepairImpl = (x: string) => x;
vi.mock('jsonrepair', () => ({ jsonrepair: (x: string) => jsonrepairImpl(x) }));

import { extractAndParseJSON, ensureReflectionProperties } from '../src/utils';

describe('extractAndParseJSON', () => {
  beforeEach(() => {
    jsonrepairImpl = (x: string) => x;
  });

  it('parses valid JSON directly', () => {
    const input = '{"foo": "bar"}';
    expect(extractAndParseJSON(input)).toEqual({ foo: 'bar' });
  });

  it('repairs and parses broken JSON', () => {
    jsonrepairImpl = (x: string) => '{"foo": "bar"}';
    const input = '{foo: "bar"}';
    expect(extractAndParseJSON(input)).toEqual({ foo: 'bar' });
  });

  it('handles JSON with markdown code blocks', () => {
    const input = '{"code": "```js\\nconsole.log(1);\\n```"}';
    expect(extractAndParseJSON(input)).toEqual({ code: '```js\nconsole.log(1);\n```' });
  });

  it('returns structured object for thought/message pattern', () => {
    const input = '"thought": "Think!", "message": "Hello"';
    const result = extractAndParseJSON(input);
    expect(result).toMatchObject({
      type: 'reconstructed_response',
      thought: 'Think!',
      message: 'Hello',
    });
  });

  it('returns unstructured_response for unparseable input', () => {
    const input = 'Not JSON at all';
    const result = extractAndParseJSON(input);
    expect(result).toMatchObject({ type: 'unstructured_response', content: input });
  });
});

describe('ensureReflectionProperties', () => {
  it('adds missing reflection properties when isReflection is true', () => {
    const input = { foo: 'bar' };
    const result = ensureReflectionProperties(input, true);
    expect(result).toMatchObject({
      foo: 'bar',
      thought: '',
      facts: [],
      relationships: [],
    });
  });

  it('does not modify object if isReflection is false', () => {
    const input = { foo: 'bar' };
    expect(ensureReflectionProperties(input, false)).toEqual(input);
  });

  it('preserves existing reflection properties', () => {
    const input = { thought: 'a', facts: [1], relationships: [2] };
    const result = ensureReflectionProperties(input, true);
    expect(result).toMatchObject({
      thought: 'a',
      facts: [1],
      relationships: [2],
    });
  });
});
