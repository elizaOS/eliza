import { describe, it, expect } from 'vitest';
import { renderTemplate, findMapping, applyMapping, type HookMapping } from '../mappings.js';

describe('mappings', () => {
  describe('renderTemplate', () => {
    it('replaces simple placeholders', () => {
      const result = renderTemplate('Hello {{name}}!', { name: 'World' });
      expect(result).toBe('Hello World!');
    });

    it('replaces nested placeholders', () => {
      const result = renderTemplate('From: {{sender.name}}', {
        sender: { name: 'Alice' },
      });
      expect(result).toBe('From: Alice');
    });

    it('replaces array index placeholders', () => {
      const result = renderTemplate('First: {{items[0].label}}', {
        items: [{ label: 'Apple' }, { label: 'Banana' }],
      });
      expect(result).toBe('First: Apple');
    });

    it('leaves unresolved placeholders as-is', () => {
      const result = renderTemplate('Hi {{unknown}}', {});
      expect(result).toBe('Hi {{unknown}}');
    });

    it('handles multiple placeholders', () => {
      const result = renderTemplate('{{a}} and {{b}}', { a: '1', b: '2' });
      expect(result).toBe('1 and 2');
    });

    it('stringifies objects', () => {
      const result = renderTemplate('Data: {{obj}}', { obj: { x: 1 } });
      expect(result).toBe('Data: {"x":1}');
    });
  });

  describe('findMapping', () => {
    const mappings: HookMapping[] = [
      { match: { path: 'gmail' }, action: 'agent', name: 'Gmail' },
      { match: { path: 'github' }, action: 'wake', name: 'GitHub' },
      { match: { source: 'stripe' }, action: 'agent', name: 'Stripe' },
    ];

    it('finds by path', () => {
      const found = findMapping(mappings, 'gmail', {});
      expect(found?.name).toBe('Gmail');
    });

    it('finds by source in payload', () => {
      const found = findMapping(mappings, 'whatever', { source: 'stripe' });
      expect(found?.name).toBe('Stripe');
    });

    it('returns undefined when no match', () => {
      const found = findMapping(mappings, 'unknown', {});
      expect(found).toBeUndefined();
    });
  });

  describe('applyMapping', () => {
    it('applies wake mapping', () => {
      const mapping: HookMapping = {
        action: 'wake',
        textTemplate: 'New event: {{type}}',
        wakeMode: 'now',
      };
      const result = applyMapping(mapping, 'test', { type: 'push' });
      expect(result.action).toBe('wake');
      expect(result.text).toBe('New event: push');
      expect(result.wakeMode).toBe('now');
    });

    it('applies agent mapping with template', () => {
      const mapping: HookMapping = {
        action: 'agent',
        name: 'Gmail',
        messageTemplate: 'Email from {{from}}: {{subject}}',
        sessionKey: 'hook:gmail:{{id}}',
        deliver: true,
        channel: 'discord',
        to: 'channel:123',
      };
      const payload = { from: 'Alice', subject: 'Hi', id: 'msg-42' };
      const result = applyMapping(mapping, 'gmail', payload);
      expect(result.action).toBe('agent');
      expect(result.message).toBe('Email from Alice: Hi');
      expect(result.sessionKey).toBe('hook:gmail:msg-42');
      expect(result.deliver).toBe(true);
      expect(result.channel).toBe('discord');
      expect(result.to).toBe('channel:123');
    });

    it('defaults to agent action', () => {
      const mapping: HookMapping = {};
      const result = applyMapping(mapping, 'test', { message: 'hello' });
      expect(result.action).toBe('agent');
      expect(result.message).toBe('hello');
    });

    it('uses payload.text for wake when no template', () => {
      const mapping: HookMapping = { action: 'wake' };
      const result = applyMapping(mapping, 'test', { text: 'direct text' });
      expect(result.text).toBe('direct text');
    });
  });
});
