import { describe, expect, it } from 'bun:test';
import { addHeader, parseKeyValueXml, safeReplacer, validateUuid } from '../utils';

describe('utils extra', () => {
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
});
