import { describe, expect, test } from 'bun:test';
import {
  filterNodesByIntegrationSupport,
  getNodeDefinition,
  searchNodes,
  simplifyNodeForLLM,
} from '../../src/utils/catalog';

describe('searchNodes', () => {
  test('returns empty array for empty keywords', () => {
    expect(searchNodes([])).toEqual([]);
  });

  test('finds supported HTTP node by keyword', () => {
    const results = searchNodes(['http', 'request']);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].node.name).toBe('workflows-nodes-base.httpRequest');
  });

  test('finds supported schedule trigger by keyword', () => {
    const results = searchNodes(['schedule', 'trigger']);
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.node.name === 'workflows-nodes-base.scheduleTrigger')).toBe(true);
  });

  test('respects limit parameter and sorts by score', () => {
    const results = searchNodes(['set', 'data'], 3);
    expect(results.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  test('filters out unsupported integration keywords', () => {
    expect(searchNodes(['gmail'])).toEqual([]);
    expect(searchNodes(['slack'])).toEqual([]);
    expect(searchNodes(['openai'])).toEqual([]);
  });

  test('handles case-insensitive lookup', () => {
    expect(searchNodes(['HTTP']).length).toBe(searchNodes(['http']).length);
  });
});

describe('filterNodesByIntegrationSupport', () => {
  test('keeps utility nodes without credentials', () => {
    const nodes = searchNodes(['set', 'if'], 10);
    const { remaining, removed } = filterNodesByIntegrationSupport(nodes, new Set<string>());

    expect(remaining.length).toBeGreaterThan(0);
    expect(removed).toEqual([]);
  });

  test('removes credentialed nodes when credentials are unsupported', () => {
    const httpNode = getNodeDefinition('workflows-nodes-base.httpRequest');
    expect(httpNode).toBeDefined();
    if (!httpNode) throw new Error('expected http node');

    const credentialed = {
      node: {
        ...httpNode,
        credentials: [{ name: 'httpHeaderAuth', required: true }],
      },
      score: 1,
      matchReason: 'test',
    };

    const { remaining, removed } = filterNodesByIntegrationSupport([credentialed], new Set());
    expect(remaining).toEqual([]);
    expect(removed).toEqual([credentialed]);
  });
});

describe('simplifyNodeForLLM', () => {
  test('strips notice and hidden properties', () => {
    const code = getNodeDefinition('workflows-nodes-base.code');
    expect(code).toBeDefined();
    expect(code?.properties.some((p) => p.type === 'notice' || p.type === 'hidden')).toBe(true);

    if (!code) throw new Error('expected code node');
    const simplified = simplifyNodeForLLM(code);
    expect(simplified.properties.every((p) => p.type !== 'notice')).toBe(true);
    expect(simplified.properties.every((p) => p.type !== 'hidden')).toBe(true);
  });

  test('removes transport/UI-only catalog metadata from properties', () => {
    const http = getNodeDefinition('workflows-nodes-base.httpRequest');
    expect(http).toBeDefined();
    if (!http) throw new Error('expected http node');

    const simplified = simplifyNodeForLLM(http);
    for (const prop of simplified.properties) {
      expect('routing' in prop ? prop.routing : undefined).toBeUndefined();
      expect('displayOptions' in prop ? prop.displayOptions : undefined).toBeUndefined();
      expect('typeOptions' in prop).toBe(false);
      expect('modes' in prop).toBe(false);
    }
  });

  test('preserves the node identity and usable fields', () => {
    const setNode = getNodeDefinition('workflows-nodes-base.set');
    expect(setNode).toBeDefined();
    if (!setNode) throw new Error('expected set node');

    const simplified = simplifyNodeForLLM(setNode);
    expect(simplified.name).toBe(setNode?.name);
    expect(simplified.properties.length).toBeGreaterThan(0);
    expect(simplified.properties.every((p) => p.name && p.displayName && p.type)).toBe(true);
  });
});
